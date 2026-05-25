import { getPointForecastData } from '@windy/fetch';
import { getLatLonInterpolator } from '@windy/interpolator';
import store from '@windy/store';

import {
    averageBumpinessInputs,
    computeBumpiness,
    peakBumpinessInputs,
    extractInputsFromForecast,
    getForecastDataHash,
    normalizeProduct,
    type BumpinessInputs,
    type BumpinessParam,
} from './bumpiness';
import {
    ensureWorldCellCacheContext,
    getWorldCell,
    setWorldCell,
    worldCellCacheContext,
} from './bumpinessCellCache';
import { worldCellCenter, worldCellKey, type WorldGridSpec } from './bumpinessGrid';
import {
    beginHiddenOverlaySampling,
    clearOverlayValueCache,
    endHiddenOverlaySampling,
    getCachedOverlayValue,
    overlayCacheKey,
    setCachedOverlayValue,
    THERMIC_OVERLAYS,
} from './bumpinessOverlaySampling';

import type { Overlays, Products } from '@windy/rootScope.d';
import type { CoordsInterpolationFun } from '@windy/interpolator';
import { bumpinessDisplayOverlay } from './bumpinessMapMode';
import { mapPool } from './bumpinessCanvas';

const forecastCache = new Map<string, BumpinessInputs>();

let samplingWeatherOverlays = 0;
let overlaySamplingChain: Promise<void> = Promise.resolve();

const OVERLAY_SAMPLE_TIMEOUT_MS = 14000;
const POINT_OVERLAY_TIMEOUT_MS = 7000;
const INTERPOLATOR_POLL_MS = 45;
const INTERPOLATOR_MAX_WAIT_MS = 520;

export function isSamplingWeatherOverlays(): boolean {
    return samplingWeatherOverlays > 0;
}

export type GridSampleOptions = {
    /** Paint map from forecast-only data before overlay pass finishes. */
    onQuickReady?: (result: GridSampleResult) => void;
    forecastConcurrency?: number;
};

function cacheKey(model: Products, lat: number, lon: number, altitudeFeet: number): string {
    const ts = store.get('timestamp');
    return `${model}:${ts}:${lat.toFixed(2)}:${lon.toFixed(2)}:${altitudeFeet}`;
}

const EMPTY_INPUTS: BumpinessInputs = {
    surfaceWindKt: 0,
    gustKt: 0,
    deltaV: 0,
    shear: 0,
    cape: 0,
    cclM: 0,
    vvel: 0,
    rainMm: 0,
    convPrecip: 0,
    isDay: 1,
};

export function clearForecastCache(): void {
    forecastCache.clear();
    clearOverlayValueCache();
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        promise
            .then(value => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

async function runExclusiveOverlayTask<T>(task: () => Promise<T>): Promise<T> {
    const previous = overlaySamplingChain;
    let release!: () => void;
    overlaySamplingChain = new Promise<void>(resolve => {
        release = resolve;
    });
    await previous;
    try {
        return await task();
    } finally {
        release();
    }
}

async function fetchForecastInputs(
    model: Products,
    lat: number,
    lon: number,
    altitudeFeet: number,
    pluginName: string,
): Promise<BumpinessInputs> {
    const key = cacheKey(model, lat, lon, altitudeFeet);
    const cached = forecastCache.get(key);
    if (cached) {
        return { ...cached };
    }

    const timestamp = store.get('timestamp');
    const payload = await getPointForecastData(model, { lat, lon }, pluginName);
    const forecast = getForecastDataHash(payload);
    const inputs = extractInputsFromForecast(forecast, timestamp, altitudeFeet);
    forecastCache.set(key, inputs);
    return { ...inputs };
}

async function awaitStoreOverlay(overlay: Overlays): Promise<void> {
    if (store.get('overlay') === overlay) {
        return;
    }
    const result = store.set('overlay', overlay);
    if (result instanceof Promise) {
        try {
            await withTimeout(result, 6000, `overlay ${overlay}`);
        } catch {
            /* fall through — interpolator poll may still succeed */
        }
    }
}

async function waitForInterpolatorReady(): Promise<CoordsInterpolationFun | null> {
    const deadline = Date.now() + INTERPOLATOR_MAX_WAIT_MS;
    while (Date.now() < deadline) {
        const fn = await getLatLonInterpolator();
        if (fn) {
            return fn;
        }
        await new Promise(resolve => setTimeout(resolve, INTERPOLATOR_POLL_MS));
    }
    return getLatLonInterpolator();
}

function mergeOverlayIntoInputs(
    base: BumpinessInputs,
    cape: number,
    ccl: number,
): BumpinessInputs {
    return {
        ...base,
        cape: Math.max(base.cape, cape),
        cclM: Math.max(base.cclM, ccl),
    };
}

function buildGridResult(
    points: GridPoint[],
    forecastInputs: BumpinessInputs[],
    capeValues: number[],
    cclValues: number[],
    params: BumpinessParam[],
    cols: number,
    rows: number,
): GridSampleResult {
    const grid = new Float32Array(cols * rows);
    const cells: GridCellResult[] = [];

    const buckets = new Map<
        string,
        {
            col: number;
            row: number;
            latIdx: number;
            lonIdx: number;
            latSum: number;
            lonSum: number;
            merged: BumpinessInputs[];
        }
    >();

    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const key = worldCellKey(p.latIdx, p.lonIdx);
        const merged = mergeOverlayIntoInputs(
            forecastInputs[i],
            capeValues[i] ?? 0,
            cclValues[i] ?? 0,
        );

        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = {
                col: p.col,
                row: p.row,
                latIdx: p.latIdx,
                lonIdx: p.lonIdx,
                latSum: 0,
                lonSum: 0,
                merged: [],
            };
            buckets.set(key, bucket);
        }
        bucket.latSum += p.lat;
        bucket.lonSum += p.lon;
        bucket.merged.push(merged);
    }

    for (const bucket of buckets.values()) {
        const n = bucket.merged.length;
        const inputs = averageBumpinessInputs(bucket.merged);
        const hazardInputs = peakBumpinessInputs(bucket.merged);
        const score = computeBumpiness(inputs, params);
        grid[bucket.row * cols + bucket.col] = score;
        cells.push({
            point: {
                lat: bucket.latSum / n,
                lon: bucket.lonSum / n,
                col: bucket.col,
                row: bucket.row,
                sub: 0,
                latIdx: bucket.latIdx,
                lonIdx: bucket.lonIdx,
            },
            inputs,
            hazardInputs,
        });
    }

    return { scores: grid, cells, cols, rows };
}

async function sampleThermicOverlaysHidden(
    model: Products,
    points: { lat: number; lon: number }[],
    concurrency: number,
): Promise<{ capeValues: number[]; cclValues: number[] }> {
    return runExclusiveOverlayTask(async () => {
        samplingWeatherOverlays++;
        beginHiddenOverlaySampling();
        try {
            const restoreOverlay = bumpinessDisplayOverlay();
            const capeValues = new Array<number>(points.length).fill(0);
            const cclValues = new Array<number>(points.length).fill(0);

            const missesByOverlay: Record<'cape' | 'ccl', number[]> = {
                cape: [],
                ccl: [],
            };

            for (let i = 0; i < points.length; i++) {
                const { lat, lon } = points[i];
                for (const overlay of THERMIC_OVERLAYS) {
                    const key = overlayCacheKey(model, overlay, lat, lon);
                    const cached = getCachedOverlayValue(key);
                    if (cached !== undefined) {
                        if (overlay === 'cape') {
                            capeValues[i] = cached;
                        } else {
                            cclValues[i] = cached;
                        }
                    } else {
                        missesByOverlay[overlay].push(i);
                    }
                }
            }

            for (const overlay of THERMIC_OVERLAYS) {
                const missIndices = missesByOverlay[overlay];
                if (!missIndices.length) {
                    continue;
                }

                await awaitStoreOverlay(overlay);
                const interpolate = await waitForInterpolatorReady();
                if (!interpolate) {
                    continue;
                }

                let cursor = 0;
                async function worker() {
                    while (cursor < missIndices.length) {
                        const mi = missIndices[cursor++];
                        const { lat, lon } = points[mi];
                        const value = await interpolate({ lat, lon });
                        let n = 0;
                        if (
                            Array.isArray(value) &&
                            typeof value[0] === 'number' &&
                            Number.isFinite(value[0])
                        ) {
                            n = value[0];
                        }
                        const key = overlayCacheKey(model, overlay, lat, lon);
                        setCachedOverlayValue(key, n);
                        if (overlay === 'cape') {
                            capeValues[mi] = n;
                        } else {
                            cclValues[mi] = n;
                        }
                    }
                }

                await Promise.all(
                    Array.from(
                        { length: Math.min(concurrency, missIndices.length) },
                        () => worker(),
                    ),
                );
            }

            if (store.get('overlay') !== restoreOverlay) {
                await awaitStoreOverlay(restoreOverlay);
            }

            return { capeValues, cclValues };
        } finally {
            endHiddenOverlaySampling();
            samplingWeatherOverlays--;
        }
    });
}

export type GridPoint = {
    lat: number;
    lon: number;
    col: number;
    row: number;
    /** 0 = centre; 1–2 = offset samples averaged into the cell. */
    sub: number;
    /** Fixed world grid index (stable when panning). */
    latIdx: number;
    lonIdx: number;
};

export type GridCellResult = {
    point: GridPoint;
    inputs: BumpinessInputs;
    hazardInputs: BumpinessInputs;
};

export type GridSampleResult = {
    scores: Float32Array;
    cells: GridCellResult[];
    cols: number;
    rows: number;
};

export async function sampleBumpinessGrid(
    model: Products,
    altitudeFeet: number,
    pluginName: string,
    points: GridPoint[],
    params: BumpinessParam[],
    forecastConcurrency = 18,
    options?: GridSampleOptions,
): Promise<GridSampleResult> {
    if (!points.length) {
        return { scores: new Float32Array(0), cells: [], cols: 0, rows: 0 };
    }

    const cols = Math.max(...points.map(p => p.col)) + 1;
    const rows = Math.max(...points.map(p => p.row)) + 1;
    const basePoints = points.map(({ lat, lon }) => ({ lat, lon }));

    const forecastInputs = await mapPool(points, forecastConcurrency, async point => {
        try {
            return await fetchForecastInputs(
                model,
                point.lat,
                point.lon,
                altitudeFeet,
                pluginName,
            );
        } catch {
            return { ...EMPTY_INPUTS };
        }
    });

    const zeroOverlays = basePoints.map(() => 0);
    const quick = buildGridResult(
        points,
        forecastInputs,
        zeroOverlays,
        zeroOverlays,
        params,
        cols,
        rows,
    );
    options?.onQuickReady?.(quick);

    let capeValues = zeroOverlays;
    let cclValues = zeroOverlays;
    try {
        const sampled = await withTimeout(
            sampleThermicOverlaysHidden(model, basePoints, 22),
            OVERLAY_SAMPLE_TIMEOUT_MS,
            'Grid overlay',
        );
        capeValues = sampled.capeValues;
        cclValues = sampled.cclValues;
    } catch {
        /* keep forecast-only scores */
    }

    return buildGridResult(points, forecastInputs, capeValues, cclValues, params, cols, rows);
}

function pointsForMissingWorldCells(points: GridPoint[]): GridPoint[] {
    const missingKeys = new Set<string>();
    for (const p of points) {
        if (!getWorldCell(p.latIdx, p.lonIdx)) {
            missingKeys.add(worldCellKey(p.latIdx, p.lonIdx));
        }
    }
    return points.filter(p => missingKeys.has(worldCellKey(p.latIdx, p.lonIdx)));
}

function storeWorldCellsFromResult(
    result: GridSampleResult,
    latStep: number,
    lonStep: number,
    params: BumpinessParam[],
): void {
    for (const cell of result.cells) {
        const center = worldCellCenter(cell.point.latIdx, cell.point.lonIdx, latStep, lonStep);
        setWorldCell({
            latIdx: cell.point.latIdx,
            lonIdx: cell.point.lonIdx,
            lat: center.lat,
            lon: center.lon,
            score: computeBumpiness(cell.inputs, params),
            inputs: cell.inputs,
            hazardInputs: cell.hazardInputs,
        });
    }
}

function assembleGridFromWorldCache(
    spec: WorldGridSpec,
    params: BumpinessParam[],
): GridSampleResult {
    const { cols, rows, latStep, lonStep, south, west } = spec;
    const grid = new Float32Array(cols * rows);
    const cells: GridCellResult[] = [];

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const centerLat = south + (row + 0.5) * latStep;
            const centerLon = west + (col + 0.5) * lonStep;
            const latIdx = Math.floor(centerLat / latStep);
            const lonIdx = Math.floor(centerLon / lonStep);
            const cached = getWorldCell(latIdx, lonIdx);
            if (!cached) {
                continue;
            }
            const score = computeBumpiness(cached.inputs, params);
            grid[row * cols + col] = score;
            cells.push({
                point: {
                    lat: centerLat,
                    lon: centerLon,
                    col,
                    row,
                    sub: 0,
                    latIdx,
                    lonIdx,
                },
                inputs: cached.inputs,
                hazardInputs: cached.hazardInputs,
            });
        }
    }

    return { scores: grid, cells, cols, rows };
}

export async function sampleBumpinessGridCached(
    model: Products,
    altitudeFeet: number,
    pluginName: string,
    spec: WorldGridSpec,
    params: BumpinessParam[],
    forecastConcurrency = 18,
    options?: GridSampleOptions,
): Promise<GridSampleResult> {
    const { points, latStep, lonStep, zoom, viewGridCellCount } = spec;
    if (!points.length) {
        return { scores: new Float32Array(0), cells: [], cols: 0, rows: 0 };
    }

    ensureWorldCellCacheContext(
        worldCellCacheContext(
            model,
            store.get('timestamp'),
            altitudeFeet,
            latStep,
            lonStep,
            zoom,
            viewGridCellCount,
        ),
    );

    const missingPoints = pointsForMissingWorldCells(points);
    if (missingPoints.length) {
        const sampled = await sampleBumpinessGrid(
            model,
            altitudeFeet,
            pluginName,
            missingPoints,
            params,
            forecastConcurrency,
            options?.onQuickReady
                ? {
                      onQuickReady: quick => {
                          storeWorldCellsFromResult(quick, latStep, lonStep, params);
                          options.onQuickReady?.(assembleGridFromWorldCache(spec, params));
                      },
                  }
                : undefined,
        );
        storeWorldCellsFromResult(sampled, latStep, lonStep, params);
    } else if (options?.onQuickReady) {
        options.onQuickReady(assembleGridFromWorldCache(spec, params));
    }

    return assembleGridFromWorldCache(spec, params);
}

export async function fetchPointBumpinessInputs(
    model: Products,
    lat: number,
    lon: number,
    altitudeFeet: number,
    pluginName: string,
    options?: { useOverlays?: boolean },
): Promise<BumpinessInputs> {
    const base = await fetchForecastInputs(model, lat, lon, altitudeFeet, pluginName);

    if (options?.useOverlays === false) {
        return { ...base };
    }

    const point = [{ lat, lon }];
    try {
        const { capeValues, cclValues } = await withTimeout(
            sampleThermicOverlaysHidden(model, point, 1),
            POINT_OVERLAY_TIMEOUT_MS,
            'Point overlay',
        );
        return mergeOverlayIntoInputs(base, capeValues[0] ?? 0, cclValues[0] ?? 0);
    } catch {
        return { ...base };
    }
}
