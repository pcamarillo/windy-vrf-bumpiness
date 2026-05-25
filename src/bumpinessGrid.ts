import type { GridPoint } from './bumpinessSampler';

/** Approximate km per degree of latitude (WGS84 mean). */
export const KM_PER_DEG_LAT = 111;

/** Target number of cells on screen (cols × rows, aspect-adjusted). */
export const DEFAULT_VIEW_GRID_CELLS = 384;
export const VIEW_GRID_CELLS_MIN = 96;
export const VIEW_GRID_CELLS_MAX = 768;
export const VIEW_GRID_CELLS_STEP = 32;

const MAX_GRID_COLS = 48;
const MAX_GRID_ROWS = 36;
const MIN_GRID_SIDE = 4;

/** @deprecated Use DEFAULT_VIEW_GRID_CELLS */
export const DEFAULT_VIEW_GRID_COLS = 24;
/** @deprecated Use DEFAULT_VIEW_GRID_CELLS */
export const DEFAULT_VIEW_GRID_ROWS = 16;

/**
 * Split target cell count into cols×rows matching the view aspect ratio (width/height).
 */
export function gridDimensionsFromAspect(
    targetCells: number,
    latSpan: number,
    lonSpan: number,
): { cols: number; rows: number } {
    const aspect = lonSpan / Math.max(latSpan, 1e-6);
    let cols = Math.round(Math.sqrt(targetCells * aspect));
    cols = Math.min(MAX_GRID_COLS, Math.max(MIN_GRID_SIDE, cols));
    let rows = Math.round(targetCells / cols);
    rows = Math.min(MAX_GRID_ROWS, Math.max(MIN_GRID_SIDE, rows));

    if (rows > MAX_GRID_ROWS) {
        rows = MAX_GRID_ROWS;
        cols = Math.min(
            MAX_GRID_COLS,
            Math.max(MIN_GRID_SIDE, Math.round(targetCells / rows)),
        );
    }
    if (cols > MAX_GRID_COLS) {
        cols = MAX_GRID_COLS;
        rows = Math.min(
            MAX_GRID_ROWS,
            Math.max(MIN_GRID_SIDE, Math.round(targetCells / cols)),
        );
    }

    return { cols, rows };
}

/** Forecast samples per cell (centre + 2 offsets); values are averaged. */
export const SAMPLES_PER_CELL = 3;

/** Offsets as fractions of cell size (applied to latStep / lonStep). */
const SUBCELL_OFFSETS: { dLat: number; dLon: number }[] = [
    { dLat: 0, dLon: 0 },
    { dLat: 0.28, dLon: 0 },
    { dLat: -0.15, dLon: 0.26 },
];

export type WorldGridSpec = {
    points: GridPoint[];
    cols: number;
    rows: number;
    south: number;
    west: number;
    north: number;
    east: number;
    /** Latitude step (°) — shrinks when zooming in. */
    latStep: number;
    /** Longitude step (°) — shrinks when zooming in. */
    lonStep: number;
    viewGridCellCount: number;
    viewGridCols: number;
    viewGridRows: number;
    samplesPerCell: number;
    zoom: number;
};

export function worldCellKey(latIdx: number, lonIdx: number): string {
    return `${latIdx},${lonIdx}`;
}

export function latLonToWorldCellIndex(
    lat: number,
    lon: number,
    latStep: number,
    lonStep: number,
): { latIdx: number; lonIdx: number } {
    return {
        latIdx: Math.floor(lat / latStep),
        lonIdx: Math.floor(lon / lonStep),
    };
}

export function worldCellCenter(
    latIdx: number,
    lonIdx: number,
    latStep: number,
    lonStep: number,
): { lat: number; lon: number } {
    return {
        lat: (latIdx + 0.5) * latStep,
        lon: (lonIdx + 0.5) * lonStep,
    };
}

/**
 * Approximate cell side length (km) at a latitude for display.
 */
export function approximateCellSideKm(
    latStep: number,
    lonStep: number,
    latitudeDeg: number,
): number {
    const latRad = (latitudeDeg * Math.PI) / 180;
    const kmLat = latStep * KM_PER_DEG_LAT;
    const kmLon = lonStep * KM_PER_DEG_LAT * Math.cos(latRad);
    return Math.round(Math.sqrt(kmLat * kmLon));
}

/**
 * Build a fixed cols×rows grid over the current view. Cell size (latStep/lonStep)
 * adapts to zoom; world indices stay stable when panning at the same zoom.
 */
export function buildViewFixedGrid(
    viewSouth: number,
    viewWest: number,
    viewNorth: number,
    viewEast: number,
    viewGridCellCount: number,
    zoom: number,
    samplesPerCell = SAMPLES_PER_CELL,
): WorldGridSpec {
    const latSpan = Math.max(viewNorth - viewSouth, 1e-6);
    const lonSpan = Math.max(viewEast - viewWest, 1e-6);
    const { cols: viewGridCols, rows: viewGridRows } = gridDimensionsFromAspect(
        viewGridCellCount,
        latSpan,
        lonSpan,
    );
    const latStep = latSpan / viewGridRows;
    const lonStep = lonSpan / viewGridCols;

    const sampleCount = Math.max(1, Math.min(SAMPLES_PER_CELL, samplesPerCell));

    const points: GridPoint[] = [];
    for (let row = 0; row < viewGridRows; row++) {
        for (let col = 0; col < viewGridCols; col++) {
            const centerLat = viewSouth + (row + 0.5) * latStep;
            const centerLon = viewWest + (col + 0.5) * lonStep;
            const latIdx = Math.floor(centerLat / latStep);
            const lonIdx = Math.floor(centerLon / lonStep);

            for (let sub = 0; sub < sampleCount; sub++) {
                const off = SUBCELL_OFFSETS[sub] ?? SUBCELL_OFFSETS[0];
                const lat = centerLat + off.dLat * latStep;
                const lon = centerLon + off.dLon * lonStep;
                points.push({ lat, lon, col, row, sub, latIdx, lonIdx });
            }
        }
    }

    return {
        points,
        cols: viewGridCols,
        rows: viewGridRows,
        south: viewSouth,
        west: viewWest,
        north: viewNorth,
        east: viewEast,
        latStep,
        lonStep,
        viewGridCellCount,
        viewGridCols,
        viewGridRows,
        samplesPerCell: sampleCount,
        zoom,
    };
}

/** @deprecated Use buildViewFixedGrid */
export function buildWorldAlignedGrid(
    viewSouth: number,
    viewWest: number,
    viewNorth: number,
    viewEast: number,
    _cellDeg?: number,
): WorldGridSpec {
    return buildViewFixedGrid(
        viewSouth,
        viewWest,
        viewNorth,
        viewEast,
        DEFAULT_VIEW_GRID_CELLS,
        0,
    );
}

export function gridViewKey(
    model: string,
    altitudeFeet: number,
    timestamp: number,
    spec: WorldGridSpec,
): string {
    return `${model}|${altitudeFeet}|${timestamp}|z${spec.zoom}|n${spec.viewGridCellCount}|${spec.viewGridCols}x${spec.viewGridRows}|s${spec.samplesPerCell}|${spec.latStep.toFixed(5)},${spec.lonStep.toFixed(5)}|${spec.south.toFixed(3)},${spec.west.toFixed(3)},${spec.north.toFixed(3)},${spec.east.toFixed(3)}`;
}

/** Unique grid cells (not raw sample count). */
export function countGridCells(points: { latIdx: number; lonIdx: number }[]): number {
    const keys = new Set(points.map(p => worldCellKey(p.latIdx, p.lonIdx)));
    return keys.size;
}
