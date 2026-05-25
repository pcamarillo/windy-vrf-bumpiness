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
    import { buildWorldAlignedGrid, gridViewKey } from './bumpinessGrid';
    import { HazardSymbolLayer } from './bumpinessMarkers';
    import { enterBumpinessMapMode, restoreBumpinessMapMode } from './bumpinessMapMode';
    import { forceEndHiddenOverlaySampling } from './bumpinessOverlaySampling';
    import {
        clearForecastCache,
        fetchPointBumpinessInputs,
        isSamplingWeatherOverlays,
        sampleBumpinessGrid,
        withTimeout,
        type GridSampleResult,
    } from './bumpinessSampler';

    import type { LatLon } from '@windy/interfaces';
    import type { Products } from '@windy/rootScope.d';

    const title = 'VFR Bumpiness Analysis';
    const pluginName = config.name;

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
    const symbolLayer = new HazardSymbolLayer();
    const legend = getBumpinessLegend();
    const POINT_ANALYSIS_TIMEOUT_MS = 12000;

    function locationKey(lat: number, lon: number): string {
        return `${lat.toFixed(4)}:${lon.toFixed(4)}`;
    }

    function applyBumpiness(inputs: BumpinessInputs) {
        data = inputs;
    }

    async function analyzePoint(lat: number, lon: number, updateHeatmap = true) {
        const token = ++analysisToken;
        lastLocation = { lat, lon };
        status = 'Loading forecast…';

        const useOverlays = !heatmapBusy && !isSamplingWeatherOverlays();

        try {
            const inputs = await withTimeout(
                fetchPointBumpinessInputs(
                    normalizeProduct(selectedModel),
                    lat,
                    lon,
                    altitudeFeet,
                    pluginName,
                    { useOverlays },
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
                deltaV: 0,
                shear: 0,
                cape: 0,
                cclM: 0,
                vvel: 0,
                rainMm: 0,
                convPrecip: 0,
            });
            status =
                error instanceof Error && error.message.includes('timed out')
                    ? 'Forecast timed out — try again.'
                    : 'Could not load forecast for this point.';
        }
    }

    function viewKeyForHeatmap(): string {
        const bounds = map.getBounds();
        const spec = buildWorldAlignedGrid(
            bounds.getSouth(),
            bounds.getWest(),
            bounds.getNorth(),
            bounds.getEast(),
        );
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

    function paintHeatmapSample(
        sample: GridSampleResult,
        gridSpec: ReturnType<typeof buildWorldAlignedGrid>,
    ): boolean {
        const dataUrl = buildSmoothHeatmapDataUrl(
            sample.scores,
            sample.cols,
            sample.rows,
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
            opacity: 0.95,
            interactive: false,
            className: 'vfr-bumpiness-overlay',
            pane,
        });
        heatmapOverlay.addTo(map);
        raiseBumpinessOverlay(heatmapOverlay, map);
        symbolLayer.render(sample.cells, params, altitudeFeet);

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
            const bounds = map.getBounds();
            const south = bounds.getSouth();
            const west = bounds.getWest();
            const north = bounds.getNorth();
            const east = bounds.getEast();
            const gridSpec = buildWorldAlignedGrid(south, west, north, east);
            gridCols = gridSpec.cols;
            gridRows = gridSpec.rows;

            const sample = await sampleBumpinessGrid(
                model,
                altitudeFeet,
                pluginName,
                gridSpec.points,
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
        forceEndHiddenOverlaySampling();
        restoreBumpinessMapMode();
    };

    onMount(() => {
        enterBumpinessMapMode(normalizeProduct(selectedModel));
        ensureBumpinessPane(map);
        syncAltitudeLevel();

        const pickerSubId = store.on('pickerLocation', loc => {
            if (loc) {
                handlePickerLocation(loc);
            }
        });

        const timestampSubId = store.on('timestamp', () => {
            clearForecastCache();
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
        clearForecastCache();
        restoreBumpinessMapMode();
    });

    function onAltitudeChanged() {
        syncAltitudeLevel();
        clearForecastCache();
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
        Plugin para detectar <b>bumpiness (turbulencia percibida)</b> en vuelo
        <b>VFR</b> con aviación ligera (ULM / GA). Combina rachas, cizalladura,
        CAPE, capa CCL/Térmicas de Windy, lluvia y turbulencia a la altitud seleccionada.
    </p>

    <label>Altitud (ft): <b>{altitudeFeet}</b></label>
    <input
        type="range"
        min="1000"
        max="15000"
        step="500"
        bind:value={altitudeFeet}
        on:input={onAltitudeChanged}
    />

    <div class="meter" style="background-color: {bumpinessColor(bumpiness)}">
        Bumpiness: {bumpiness.toFixed(1)}/10
        {#if hazardDetail.primary}
            <div class="meter-cause">{HAZARD_CAUSE_LABELS[hazardDetail.primary]}</div>
        {/if}
        {#if hazardDetail.secondary}
            <div class="meter-cause meter-cause--secondary">
                También: {HAZARD_CAUSE_LABELS[hazardDetail.secondary]}
            </div>
        {/if}
    </div>

    <div class="breakdown">
        <div>
            Viento: {data.surfaceWindKt.toFixed(0)} kt · Racha: {data.gustKt.toFixed(0)} kt
            <span>(Δ {data.deltaV.toFixed(0)} kt, peso {Math.round(subscores.deltaV * 100)}%)</span>
        </div>
        <div>Shear: {(data.shear).toFixed(0)} kt <span>({Math.round(subscores.shear * 100)}%)</span></div>
        <div>CAPE: {(data.cape).toFixed(0)} J/kg <span>({Math.round(subscores.cape * 100)}%)</span></div>
        <div>CCL/Térmicas: {(data.cclM).toFixed(0)} m <span>({Math.round(subscores.cclM * 100)}%)</span></div>
        <div>Lluvia: {(data.rainMm).toFixed(1)} mm/h</div>
        <div>Turb: {(data.vvel).toFixed(1)} <span>({Math.round(subscores.vvel * 100)}%)</span></div>
    </div>

    <p class="status">{status}</p>

    <section class="legend">
        <h4>Leyenda — colores (bumpiness ≥ 2/10)</h4>
        <ul class="legend-colors">
            {#each legend as item}
                <li>
                    <span class="swatch" style="background: {item.color}"></span>
                    {item.label}
                </li>
            {/each}
        </ul>
        <h4>Símbolos en mapa</h4>
        <ul class="legend-symbols">
            <li><span class="sym-preview sym-preview--thermic">SS</span> {HAZARD_CAUSE_LABELS.thermic}</li>
            <li><span class="sym-preview sym-preview--convective">⛈</span> {HAZARD_CAUSE_LABELS.convective}</li>
            <li><span class="sym-preview sym-preview--orographic">⛰</span> {HAZARD_CAUSE_LABELS.orographic}</li>
        </ul>
        <p class="legend-note">
            SS con CCL/Térmicas (o CAPE) y sin lluvia. ⛈ convección húmeda con precipitación.
        </p>
    </section>

    <details>
        <summary>⚙️ Configuración</summary>

        <p class="hint">
            Base: capa de lluvia (u otra con línea temporal) para poder avanzar días.
            Encima: tinte bumpiness y símbolos. Al cerrar el plugin se restaura tu vista.
        </p>

        <div class="row">
            <label>Modelo Meteorológico:</label>
            <select bind:value={selectedModel} on:change={onModelChanged}>
                {#each models as m}
                    <option value={m}>{m.toUpperCase()}</option>
                {/each}
            </select>
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
                        clearForecastCache();
                        scheduleHeatmapUpdate();
                    }}
                />
            </div>
        {/each}
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
    :global(body.vfr-bumpiness-hide-weather #map-container .vfr-bumpiness-overlay) {
        visibility: visible !important;
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
        margin: 0 0 12px;
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
