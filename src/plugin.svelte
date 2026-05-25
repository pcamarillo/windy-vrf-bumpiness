<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import store from '@windy/store';
    import { singleclick } from '@windy/singleclick';
    import { map } from '@windy/map';

    import config from './pluginConfig';
    import {
        bumpinessColor,
        computeBumpiness,
        DEFAULT_BUMPINESS_PARAMS,
        factorSubscores,
        feetToPressureLevel,
        getBumpinessLegend,
        getHazardCauseDetail,
        HAZARD_CAUSE_LABELS,
        normalizeProduct,
        type BumpinessInputs,
        type BumpinessParam,
    } from './bumpiness';
    import {
        buildSmoothHeatmapDataUrl,
        ensureBumpinessPane,
        raiseBumpinessOverlay,
    } from './bumpinessCanvas';
    import {
        clearWorldCellCache,
        getWorldCell,
        recomputeWorldCellScores,
    } from './bumpinessCellCache';
    import {
        approximateCellSideKm,
        buildViewFixedGrid,
        DEFAULT_VIEW_GRID_CELLS,
        gridViewKey,
        latLonToWorldCellIndex,
        SAMPLES_PER_CELL,
        VIEW_GRID_CELLS_MAX,
        VIEW_GRID_CELLS_MIN,
        VIEW_GRID_CELLS_STEP,
        type WorldGridSpec,
    } from './bumpinessGrid';
    import { HazardSymbolLayer, type GridCellSample } from './bumpinessMarkers';
    import { BumpinessPickerPin } from './bumpinessPickerPin';
    import { enterBumpinessMapMode, restoreBumpinessMapMode } from './bumpinessMapMode';
    import { forceEndHiddenOverlaySampling } from './bumpinessOverlaySampling';
    import {
        clearForecastCache,
        fetchPointBumpinessInputs,
        isSamplingWeatherOverlays,
        sampleBumpinessGridCached,
        withTimeout,
        type GridSampleResult,
    } from './bumpinessSampler';

    import type { LatLon } from '@windy/interfaces';
    import type { Products } from '@windy/rootScope.d';

    const title = 'VFR Bumpiness Analysis';
    const pluginName = config.name;
    const pluginVersion = config.version;

    let altitudeFeet = 3000;
    let bumpiness = 0;
    let status = 'Click the map to analyze bumpiness.';
    let data: BumpinessInputs = {
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

    let selectedModel: Products = 'ecmwf';
    const models: Products[] = ['ecmwf', 'gfs', 'iconEu', 'iconD2'];

    let params: BumpinessParam[] = DEFAULT_BUMPINESS_PARAMS.map(p => ({ ...p }));

    let viewGridCells = DEFAULT_VIEW_GRID_CELLS;
    let resolvedGridCols = 0;
    let resolvedGridRows = 0;
    let activeLatStep = 0;
    let activeLonStep = 0;
    let displayCellKm = 0;
    let displayLatStep = 0;
    let displayLonStep = 0;
    let estimatedCellCount = viewGridCells;

    let heatmapOverlay: L.ImageOverlay | null = null;
    let heatmapTimer: ReturnType<typeof setTimeout> | null = null;
    let heatmapToken = 0;
    let analysisToken = 0;
    let lastLocation: LatLon | null = null;
    let gridCols = 0;
    let gridRows = 0;
    let heatmapBusy = false;
    let suppressMapRefresh = 0;
    let lastHeatmapViewKey = '';
    let lastPickerKey = '';
    let lastHeatmapCells: GridCellSample[] = [];
    let mapCellBumpiness: number | null = null;
    const symbolLayer = new HazardSymbolLayer();
    const pickerPin = new BumpinessPickerPin();
    const legend = getBumpinessLegend();
    const POINT_ANALYSIS_TIMEOUT_MS = 12000;

    function locationKey(lat: number, lon: number): string {
        return `${lat.toFixed(4)}:${lon.toFixed(4)}`;
    }

    function applyBumpiness(inputs: BumpinessInputs) {
        data = inputs;
        mapCellBumpiness = nearestGridBumpiness(lastLocation?.lat, lastLocation?.lon);
        if (lastLocation) {
            const score = computeBumpiness(inputs, params);
            pickerPin.update(lastLocation.lat, lastLocation.lon, score);
        }
    }

    function buildGridSpecFromMap(): WorldGridSpec {
        const bounds = map.getBounds();
        return buildViewFixedGrid(
            bounds.getSouth(),
            bounds.getWest(),
            bounds.getNorth(),
            bounds.getEast(),
            viewGridCells,
            map.getZoom(),
        );
    }

    function applyGridSpecMetrics(spec: WorldGridSpec): void {
        resolvedGridCols = spec.viewGridCols;
        resolvedGridRows = spec.viewGridRows;
        estimatedCellCount = resolvedGridCols * resolvedGridRows;
        displayCellKm = approximateCellSideKm(spec.latStep, spec.lonStep, mapCenterLat());
        displayLatStep = spec.latStep;
        displayLonStep = spec.lonStep;
    }

    function nearestGridBumpiness(lat?: number, lon?: number): number | null {
        if (lat === undefined || lon === undefined) {
            return null;
        }
        if (activeLatStep > 0 && activeLonStep > 0) {
            const { latIdx, lonIdx } = latLonToWorldCellIndex(
                lat,
                lon,
                activeLatStep,
                activeLonStep,
            );
            const cached = getWorldCell(latIdx, lonIdx);
            if (cached) {
                return computeBumpiness(cached.inputs, params);
            }
        }
        if (!lastHeatmapCells.length) {
            return null;
        }
        let best: number | null = null;
        let bestDist = Infinity;
        for (const { point, inputs } of lastHeatmapCells) {
            const dLat = point.lat - lat;
            const dLon = point.lon - lon;
            const dist = dLat * dLat + dLon * dLon;
            if (dist < bestDist) {
                bestDist = dist;
                best = computeBumpiness(inputs, params);
            }
        }
        const matchLat = activeLatStep > 0 ? activeLatStep : displayLatStep;
        const matchLon = activeLonStep > 0 ? activeLonStep : displayLonStep;
        const matchRadius = Math.min(matchLat, matchLon) * 0.85;
        if (bestDist > matchRadius * matchRadius) {
            return null;
        }
        return best;
    }

    function mapCenterLat(): number {
        try {
            return map.getCenter().lat;
        } catch {
            return lastLocation?.lat ?? 40;
        }
    }

    function refreshResolutionEstimate() {
        try {
            const spec = buildGridSpecFromMap();
            applyGridSpecMetrics(spec);
        } catch {
            estimatedCellCount = viewGridCells;
            resolvedGridCols = 0;
            resolvedGridRows = 0;
            displayCellKm = 0;
            displayLatStep = 0;
            displayLonStep = 0;
        }
    }

    function onGridConfigChanged() {
        clearForecastCache();
        clearWorldCellCache();
        lastHeatmapViewKey = '';
        refreshResolutionEstimate();
        scheduleHeatmapUpdate();
    }

    async function analyzePoint(lat: number, lon: number, updateHeatmap = true) {
        const token = ++analysisToken;
        lastLocation = { lat, lon };
        status = 'Loading forecast…';

        try {
            const inputs = await withTimeout(
                fetchPointBumpinessInputs(
                    normalizeProduct(selectedModel),
                    lat,
                    lon,
                    altitudeFeet,
                    pluginName,
                    { useOverlays: true },
                ),
                POINT_ANALYSIS_TIMEOUT_MS,
                'Point forecast',
            );
            if (token !== analysisToken) {
                return;
            }

            applyBumpiness(inputs);
            status = `Analyzed ${lat.toFixed(2)}°, ${lon.toFixed(2)}° at ${altitudeFeet} ft`;

            if (updateHeatmap) {
                scheduleHeatmapUpdate();
            }
        } catch (error) {
            if (token !== analysisToken) {
                return;
            }
            console.error(error);
            applyBumpiness({
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
            });
            status =
                error instanceof Error && error.message.includes('timed out')
                    ? 'Forecast timed out — try again.'
                    : 'Could not load forecast for this point.';
        }
    }

    function viewKeyForHeatmap(): string {
        const spec = buildGridSpecFromMap();
        return gridViewKey(
            normalizeProduct(selectedModel),
            altitudeFeet,
            store.get('timestamp'),
            spec,
        );
    }

    function scheduleHeatmapUpdate() {
        if (heatmapBusy || isSamplingWeatherOverlays() || suppressMapRefresh > 0) {
            return;
        }
        if (heatmapTimer) {
            clearTimeout(heatmapTimer);
        }
        heatmapTimer = setTimeout(() => {
            heatmapTimer = null;
            void updateHeatmap();
        }, 400);
    }

    function onMapViewChanged() {
        refreshResolutionEstimate();
        if (heatmapBusy || isSamplingWeatherOverlays() || suppressMapRefresh > 0) {
            return;
        }
        const key = viewKeyForHeatmap();
        if (key === lastHeatmapViewKey) {
            return;
        }
        scheduleHeatmapUpdate();
    }

    function syncAltitudeLevel() {
        store.set('level', feetToPressureLevel(altitudeFeet));
    }

    function onModelChanged() {
        clearForecastCache();
        clearWorldCellCache();
        lastHeatmapViewKey = '';
        store.set('product', normalizeProduct(selectedModel));
        if (lastLocation) {
            void analyzePoint(lastLocation.lat, lastLocation.lon);
        } else {
            scheduleHeatmapUpdate();
        }
    }

    function removeHeatmapOverlay() {
        symbolLayer.clear();
        if (heatmapOverlay) {
            map.removeLayer(heatmapOverlay);
            heatmapOverlay = null;
        }
    }

    function paintHeatmapSample(sample: GridSampleResult, gridSpec: WorldGridSpec): boolean {
        activeLatStep = gridSpec.latStep;
        activeLonStep = gridSpec.lonStep;
        applyGridSpecMetrics(gridSpec);

        const paintCells = sample.cells.map(cell => ({
            lat: cell.point.lat,
            lon: cell.point.lon,
            score: computeBumpiness(cell.inputs, params),
        }));
        const dataUrl = buildSmoothHeatmapDataUrl(
            paintCells,
            gridSpec.south,
            gridSpec.west,
            gridSpec.north,
            gridSpec.east,
            gridSpec.latStep,
            gridSpec.lonStep,
        );
        if (!dataUrl) {
            return false;
        }

        const leafletBounds: L.LatLngBoundsExpression = [
            [gridSpec.south, gridSpec.west],
            [gridSpec.north, gridSpec.east],
        ];

        const pane = ensureBumpinessPane(map);
        removeHeatmapOverlay();
        heatmapOverlay = L.imageOverlay(dataUrl, leafletBounds, {
            opacity: 0.72,
            interactive: false,
            className: 'vfr-bumpiness-overlay',
            pane,
        });
        heatmapOverlay.addTo(map);
        raiseBumpinessOverlay(heatmapOverlay, map);
        lastHeatmapCells = sample.cells;
        symbolLayer.render(sample.cells, params, altitudeFeet);
        if (lastLocation) {
            mapCellBumpiness = nearestGridBumpiness(lastLocation.lat, lastLocation.lon);
        }

        const wheelZoom = map.scrollWheelZoom;
        if (wheelZoom && typeof wheelZoom.enable === 'function' && !wheelZoom.enabled()) {
            wheelZoom.enable();
        }

        return true;
    }

    async function updateHeatmap() {
        if (heatmapBusy) {
            return;
        }
        heatmapBusy = true;
        suppressMapRefresh++;
        const token = ++heatmapToken;
        const model = normalizeProduct(selectedModel);
        const viewKey = viewKeyForHeatmap();
        status = 'Loading bumpiness (wind & shear)…';

        try {
            const gridSpec = buildGridSpecFromMap();
            gridCols = gridSpec.cols;
            gridRows = gridSpec.rows;

            const sample = await sampleBumpinessGridCached(
                model,
                altitudeFeet,
                pluginName,
                gridSpec,
                params,
                18,
                {
                    onQuickReady: quick => {
                        if (token !== heatmapToken) {
                            return;
                        }
                        if (paintHeatmapSample(quick, gridSpec)) {
                            status = 'Map preview — loading CAPE/CCL in background…';
                        }
                    },
                },
            );

            if (token !== heatmapToken) {
                return;
            }

            if (!paintHeatmapSample(sample, gridSpec)) {
                return;
            }

            lastHeatmapViewKey = viewKey;

            if (lastLocation) {
                status = `Map ${gridCols}×${gridRows} · ${lastLocation.lat.toFixed(2)}°, ${lastLocation.lon.toFixed(2)}°`;
            } else {
                status = `Bumpiness map ${gridCols}×${gridRows} — click for detail`;
            }
        } catch (error) {
            console.error('Heatmap update failed:', error);
            status = 'Could not render bumpiness map.';
        } finally {
            heatmapBusy = false;
            suppressMapRefresh--;
        }
    }

    /** Map click: always refresh the point readout (no full heatmap rebuild). */
    function handleSingleClick(loc: LatLon) {
        lastPickerKey = locationKey(loc.lat, loc.lon);
        void analyzePoint(loc.lat, loc.lon, false);
    }

    /** Picker drag / move: update readout when coordinates actually change. */
    function handlePickerLocation(loc: LatLon) {
        const key = locationKey(loc.lat, loc.lon);
        if (key === lastPickerKey) {
            return;
        }
        lastPickerKey = key;
        void analyzePoint(loc.lat, loc.lon, false);
    }

    export const onopen = () => {
        enterBumpinessMapMode(normalizeProduct(selectedModel));
        ensureBumpinessPane(map);
        syncAltitudeLevel();
        refreshResolutionEstimate();
        const loc = store.get('pickerLocation');
        if (loc) {
            lastPickerKey = locationKey(loc.lat, loc.lon);
            void analyzePoint(loc.lat, loc.lon, true);
        } else {
            scheduleHeatmapUpdate();
        }
    };

    export const onclose = () => {
        removeHeatmapOverlay();
        pickerPin.clear();
        forceEndHiddenOverlaySampling();
        restoreBumpinessMapMode();
    };

    onMount(() => {
        enterBumpinessMapMode(normalizeProduct(selectedModel));
        ensureBumpinessPane(map);
        syncAltitudeLevel();
        refreshResolutionEstimate();

        const pickerSubId = store.on('pickerLocation', loc => {
            if (loc) {
                handlePickerLocation(loc);
            }
        });

        const timestampSubId = store.on('timestamp', () => {
            clearForecastCache();
            clearWorldCellCache();
            lastHeatmapViewKey = '';
            if (lastLocation) {
                void analyzePoint(lastLocation.lat, lastLocation.lon, false);
            }
            scheduleHeatmapUpdate();
        });

        singleclick.on(pluginName, handleSingleClick);
        map.on('moveend', onMapViewChanged);
        map.on('zoomend', onMapViewChanged);

        if (!lastLocation) {
            scheduleHeatmapUpdate();
        }

        return () => {
            store.off(pickerSubId);
            store.off(timestampSubId);
            singleclick.off(pluginName, handleSingleClick);
            map.off('moveend', onMapViewChanged);
            map.off('zoomend', onMapViewChanged);
        };
    });

    onDestroy(() => {
        if (heatmapTimer) {
            clearTimeout(heatmapTimer);
        }
        removeHeatmapOverlay();
        pickerPin.clear();
        clearForecastCache();
        clearWorldCellCache();
        restoreBumpinessMapMode();
    });

    function onAltitudeChanged() {
        syncAltitudeLevel();
        clearForecastCache();
        clearWorldCellCache();
        if (lastLocation) {
            void analyzePoint(lastLocation.lat, lastLocation.lon);
        } else {
            scheduleHeatmapUpdate();
        }
    }

    $: bumpiness = computeBumpiness(data, params);
    $: subscores = factorSubscores(data);
    $: hazardDetail = getHazardCauseDetail(data, params, altitudeFeet);
</script>

<div class="plugin__content">
    <h3>{title}</h3>

    <p class="intro">
        Detects <b>bumpiness (perceived turbulence)</b> for <b>VFR</b> light aircraft
        (ULM / GA). Combines gusts, wind shear, CAPE, Windy CCL/thermals layer, rain,
        and model turbulence at the selected altitude.
    </p>
    <p class="grid-info">
        Map grid: <b>{resolvedGridCols || '…'}×{resolvedGridRows || '…'}</b>
        ({estimatedCellCount || viewGridCells} cells). At this zoom each cell ≈
        <b>{displayCellKm || '…'} km</b>
        {#if displayLatStep > 0}
            ({displayLatStep.toFixed(2)}° × {displayLonStep.toFixed(2)}°)
        {/if}
        — zoom in for finer resolution.
    </p>

    <label>Altitude (ft): <b>{altitudeFeet}</b></label>
    <input
        type="range"
        min="1000"
        max="15000"
        step="500"
        bind:value={altitudeFeet}
        on:input={onAltitudeChanged}
    />

    <div class="meter" style="background-color: {bumpinessColor(bumpiness)}">
        Bumpiness (point): {bumpiness.toFixed(1)}/10
        {#if mapCellBumpiness !== null}
            <div class="meter-map-cell">
                Nearest grid centre: {mapCellBumpiness.toFixed(1)}/10
                {#if Math.abs(mapCellBumpiness - bumpiness) >= 0.6}
                    <span> — can differ from click (grid cell ~{displayCellKm || '…'} km at this zoom)</span>
                {/if}
            </div>
        {/if}
        {#if hazardDetail.primary}
            <div class="meter-cause">{HAZARD_CAUSE_LABELS[hazardDetail.primary]}</div>
        {/if}
        {#if hazardDetail.secondary}
            <div class="meter-cause meter-cause--secondary">
                Also: {HAZARD_CAUSE_LABELS[hazardDetail.secondary]}
            </div>
        {/if}
    </div>

    <div class="breakdown">
        <div>
            Wind: {data.surfaceWindKt.toFixed(0)} kt · Gust: {data.gustKt.toFixed(0)} kt
            <span>(Δ {data.deltaV.toFixed(0)} kt, weight {Math.round(subscores.deltaV * 100)}%)</span>
        </div>
        <div>Shear: {(data.shear).toFixed(0)} kt <span>({Math.round(subscores.shear * 100)}%)</span></div>
        <div>CAPE: {(data.cape).toFixed(0)} J/kg <span>({Math.round(subscores.cape * 100)}%)</span></div>
        <div>CCL/Thermals: {(data.cclM).toFixed(0)} m <span>({Math.round(subscores.cclM * 100)}%)</span></div>
        <div>Rain: {(data.rainMm).toFixed(1)} mm/h</div>
        <div>Turb: {(data.vvel).toFixed(1)} <span>({Math.round(subscores.vvel * 100)}%)</span></div>
    </div>

    <p class="status">{status}</p>

    <section class="legend">
        <h4>Legend — colors (bumpiness ≥ 2/10)</h4>
        <ul class="legend-colors">
            {#each legend as item}
                <li>
                    <span class="swatch" style="background: {item.color}"></span>
                    {item.label}
                </li>
            {/each}
        </ul>
        <h4>Map symbols</h4>
        <ul class="legend-symbols">
            <li><span class="sym-preview sym-preview--thermic">SS</span> {HAZARD_CAUSE_LABELS.thermic}</li>
            <li><span class="sym-preview sym-preview--convective">⛈</span> {HAZARD_CAUSE_LABELS.convective}</li>
            <li><span class="sym-preview sym-preview--orographic">⛰</span> {HAZARD_CAUSE_LABELS.orographic}</li>
        </ul>
        <p class="legend-note">
            Target <b>{viewGridCells}</b> cells → {resolvedGridCols}×{resolvedGridRows} from screen shape; size
            adapts to zoom (~{displayCellKm || '…'} km now). Colours stay stable when panning. Panel = exact click.
        </p>
        <p class="legend-note">
            Symbols use <b>peak</b> rain/CAPE inside each cell (no SS in storms). ⛈ and ⛰ at local maxima.
        </p>
    </section>

    <details>
        <summary>⚙️ Settings</summary>

        <p class="hint">
            Base layer: rain (or another timeline-capable overlay) so you can scrub the forecast.
            On top: bumpiness tint and hazard symbols. Closing the plugin restores your previous view.
        </p>

        <div class="row">
            <label>Weather model:</label>
            <select bind:value={selectedModel} on:change={onModelChanged}>
                {#each models as m}
                    <option value={m}>{m.toUpperCase()}</option>
                {/each}
            </select>
        </div>

        <div class="row">
            <label>
                Grid cells: <b>{viewGridCells}</b>
                <small
                    >→ {resolvedGridCols || '…'}×{resolvedGridRows || '…'} on screen · ~{displayCellKm ||
                        '…'} km/cell at this zoom</small
                >
            </label>
            <input
                type="range"
                min={VIEW_GRID_CELLS_MIN}
                max={VIEW_GRID_CELLS_MAX}
                step={VIEW_GRID_CELLS_STEP}
                bind:value={viewGridCells}
                on:input={onGridConfigChanged}
            />
            <small class="resolution-hint">
                Total cells ({VIEW_GRID_CELLS_MIN}–{VIEW_GRID_CELLS_MAX}). Rows/columns follow the map aspect
                ratio. More cells = finer detail (slower); zoom in to shrink each cell.
            </small>
        </div>

        {#each params as p}
            <div class="row">
                <label>{p.label} ({p.weight}): <small>{p.desc}</small></label>
                <input
                    type="range"
                    min="0"
                    max="3"
                    step="0.1"
                    bind:value={p.weight}
                    on:change={() => {
                        recomputeWorldCellScores(params);
                        scheduleHeatmapUpdate();
                    }}
                />
            </div>
        {/each}

        <p class="plugin-version">Version {pluginVersion}</p>
    </details>
</div>

<style>
    :global(.vfr-bumpiness-overlay),
    :global(.vfr-bumpiness-overlay img),
    :global(.leaflet-image-layer.vfr-bumpiness-overlay) {
        pointer-events: none !important;
    }
    /* Hide Windy weather tiles while sampling CAPE/CCL (no layer flicker). */
    :global(body.vfr-bumpiness-hide-weather #map-container .leaflet-tile-pane),
    :global(body.vfr-bumpiness-hide-weather #map-container .leaflet-overlay-pane),
    :global(body.vfr-bumpiness-hide-weather #map-container canvas.maplibregl-canvas) {
        visibility: hidden !important;
    }
    :global(body.vfr-bumpiness-hide-weather #map-container .leaflet-pane[name='bumpinessPane']),
    :global(body.vfr-bumpiness-hide-weather #map-container .leaflet-pane[name='bumpinessSymbolsPane']),
    :global(body.vfr-bumpiness-hide-weather #map-container .leaflet-pane[name='bumpinessPickerPane']),
    :global(body.vfr-bumpiness-hide-weather #map-container .vfr-bumpiness-overlay) {
        visibility: visible !important;
    }
    :global(.vfr-bump-pin-wrap) {
        background: transparent;
        border: none;
    }
    :global(.vfr-bump-pin) {
        display: flex;
        flex-direction: column;
        align-items: center;
        filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.45));
    }
    :global(.vfr-bump-pin__badge) {
        min-width: 36px;
        padding: 4px 8px;
        border-radius: 8px;
        border: 2px solid rgba(255, 255, 255, 0.95);
        color: #111;
        font-size: 14px;
        font-weight: 800;
        line-height: 1.1;
        text-align: center;
        white-space: nowrap;
    }
    :global(.vfr-bump-pin__tail) {
        width: 0;
        height: 0;
        margin-top: -1px;
        border-left: 7px solid transparent;
        border-right: 7px solid transparent;
        border-top: 10px solid rgba(255, 255, 255, 0.95);
    }
    :global(.leaflet-pane[name='bumpinessSymbolsPane']) {
        z-index: 725 !important;
    }
    :global(.leaflet-pane[name='bumpinessPickerPane']) {
        z-index: 735 !important;
    }
    :global(.vfr-hazard-marker) {
        background: transparent;
        border: none;
    }
    :global(.vfr-hazard-sym) {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        font-weight: 800;
        font-size: 11px;
        line-height: 1;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.55);
        border: 2px solid rgba(255, 255, 255, 0.9);
    }
    :global(.vfr-hazard-sym--thermic) {
        background: #ff9800;
        color: #1a1a1a;
    }
    :global(.vfr-hazard-sym--convective) {
        background: #1565c0;
        color: #fff;
        font-size: 14px;
    }
    :global(.vfr-hazard-sym--orographic) {
        background: #5d4037;
        color: #fff;
        font-size: 14px;
        border-radius: 6px;
    }
    .plugin__content {
        padding: 15px;
        color: #fff;
        font-family: sans-serif;
    }
    .intro {
        font-size: 12px;
        line-height: 1.45;
        opacity: 0.9;
        margin: 0 0 8px;
    }
    .grid-info {
        font-size: 11px;
        line-height: 1.4;
        opacity: 0.85;
        margin: 0 0 12px;
        padding: 8px 10px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 6px;
    }
    .legend {
        font-size: 11px;
        margin-bottom: 14px;
        padding: 10px;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 8px;
    }
    .legend h4 {
        margin: 8px 0 6px;
        font-size: 11px;
        font-weight: 700;
    }
    .legend h4:first-child {
        margin-top: 0;
    }
    .legend-colors,
    .legend-symbols {
        list-style: none;
        padding: 0;
        margin: 0 0 6px;
    }
    .legend-colors li,
    .legend-symbols li {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
    }
    .swatch {
        width: 18px;
        height: 12px;
        border-radius: 3px;
        flex-shrink: 0;
        border: 1px solid rgba(255, 255, 255, 0.35);
    }
    .sym-preview {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        flex-shrink: 0;
        font-weight: 800;
        font-size: 10px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.7);
    }
    .sym-preview--thermic {
        background: #ff9800;
        color: #1a1a1a;
    }
    .sym-preview--convective {
        background: #1565c0;
        color: #fff;
        font-size: 12px;
    }
    .sym-preview--orographic {
        background: #5d4037;
        color: #fff;
        border-radius: 4px;
        font-size: 12px;
    }
    .legend-note {
        margin: 6px 0 0;
        opacity: 0.7;
        line-height: 1.35;
    }
    .meter {
        padding: 20px;
        text-align: center;
        font-weight: bold;
        margin: 15px 0 8px;
        border-radius: 15px;
        transition: 0.3s;
    }
    .meter-cause {
        font-size: 11px;
        font-weight: 600;
        margin-top: 8px;
        opacity: 0.95;
    }
    .meter-cause--secondary {
        font-size: 10px;
        font-weight: 500;
        opacity: 0.85;
    }
    .meter-map-cell {
        font-size: 10px;
        font-weight: 600;
        margin-top: 6px;
        opacity: 0.92;
    }
    .breakdown {
        font-size: 11px;
        opacity: 0.9;
        line-height: 1.5;
        margin-bottom: 8px;
    }
    .breakdown span {
        opacity: 0.65;
    }
    .status {
        font-size: 12px;
        opacity: 0.85;
        margin: 0 0 10px;
    }
    .resolution-hint {
        display: block;
        font-size: 10px;
        opacity: 0.7;
        line-height: 1.35;
        margin-top: 4px;
    }
    .plugin-version {
        font-size: 10px;
        opacity: 0.65;
        margin: 12px 0 4px;
        text-align: center;
    }
    .hint {
        font-size: 11px;
        opacity: 0.75;
        line-height: 1.4;
        margin: 0 0 12px;
    }
    .row {
        margin-bottom: 15px;
        display: flex;
        flex-direction: column;
        border-bottom: 1px solid #444;
        padding-bottom: 5px;
    }
    summary {
        cursor: pointer;
        padding: 10px;
        background: #333;
        border-radius: 8px;
        margin-bottom: 10px;
    }
    select {
        background: #444;
        color: white;
        padding: 5px;
        border-radius: 5px;
    }
</style>
