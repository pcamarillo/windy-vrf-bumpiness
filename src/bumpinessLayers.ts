import type { Overlays } from '@windy/rootScope.d';

import type { BumpinessInputs, BumpinessParam } from './bumpiness';

export type BumpinessLayerOptions = {
    /** Gust excess vs mean wind. */
    gusts: boolean;
    /** Vertical wind shear. */
    shear: boolean;
    /** Windy CCL / thermals overlay + scoring. */
    cclThermals: boolean;
    /** Windy CAPE overlay + scoring (slow extra overlay pass). */
    cape: boolean;
    /** Model turbulence field from forecast. */
    turbulence: boolean;
    /** Rain / convective precip from forecast (storm ⛈ detection). */
    rainConvection: boolean;
    /** Coloured bumpiness heatmap on the map. */
    heatmap: boolean;
    /** SS / ⛈ / ⛰ hazard symbols. */
    hazardSymbols: boolean;
    /** Average 3 forecast points per cell (slower, smoother). */
    multiSample: boolean;
};

/** Iberian VFR: CCL + gust/shear matter most; CAPE overlay & model turb are slow / low value. */
export const DEFAULT_LAYER_OPTIONS: BumpinessLayerOptions = {
    gusts: true,
    shear: true,
    cclThermals: true,
    cape: false,
    turbulence: false,
    rainConvection: true,
    heatmap: true,
    hazardSymbols: true,
    multiSample: true,
};

export type LayerOptionMeta = {
    key: keyof BumpinessLayerOptions;
    label: string;
    desc: string;
    group: 'factor' | 'display' | 'perf';
    /** Extra overlay/API cost when enabled. */
    slow?: boolean;
};

export const LAYER_OPTION_META: LayerOptionMeta[] = [
    {
        key: 'gusts',
        label: 'Gusts (Δ)',
        desc: 'Gust excess vs mean wind — very noticeable in light aircraft',
        group: 'factor',
    },
    {
        key: 'shear',
        label: 'Wind shear',
        desc: 'Vertical wind difference (critical for low VFR)',
        group: 'factor',
    },
    {
        key: 'cclThermals',
        label: 'CCL / thermals',
        desc: 'Windy thermals layer (dry thermal bumpiness, SS symbols)',
        group: 'factor',
        slow: true,
    },
    {
        key: 'cape',
        label: 'CAPE overlay',
        desc: 'Convective energy overlay — slow; often redundant with CCL in Spain',
        group: 'factor',
        slow: true,
    },
    {
        key: 'turbulence',
        label: 'Model turbulence',
        desc: 'Model-reported turbulence field — often noisy at VFR altitudes',
        group: 'factor',
    },
    {
        key: 'rainConvection',
        label: 'Rain / convection',
        desc: 'Precip from forecast — storm cells & ⛈ symbols (no extra overlay)',
        group: 'factor',
    },
    {
        key: 'heatmap',
        label: 'Bumpiness heatmap',
        desc: 'Coloured tint on the map',
        group: 'display',
    },
    {
        key: 'hazardSymbols',
        label: 'Hazard symbols',
        desc: 'SS / ⛈ / ⛰ markers at activity peaks',
        group: 'display',
    },
    {
        key: 'multiSample',
        label: '3-point cell average',
        desc: '3 forecast samples per cell — smoother but ~3× slower',
        group: 'perf',
        slow: true,
    },
];

const PARAM_ENABLED: Record<
    BumpinessParam['id'],
    keyof BumpinessLayerOptions | null
> = {
    deltaV: 'gusts',
    shear: 'shear',
    cape: 'cape',
    cclM: 'cclThermals',
    vvel: 'turbulence',
    surfaceWindKt: null,
    gustKt: null,
    rainMm: null,
    convPrecip: null,
    isDay: null,
};

export function applyLayerOptionsToParams(
    params: BumpinessParam[],
    options: BumpinessLayerOptions,
): BumpinessParam[] {
    return params.map(p => {
        const layerKey = PARAM_ENABLED[p.id];
        const enabled = layerKey ? options[layerKey] : true;
        return { ...p, weight: enabled ? p.weight : 0 };
    });
}

export function maskInputsForLayers(
    inputs: BumpinessInputs,
    options: BumpinessLayerOptions,
): BumpinessInputs {
    return {
        ...inputs,
        deltaV: options.gusts ? inputs.deltaV : 0,
        gustKt: options.gusts ? inputs.gustKt : inputs.surfaceWindKt,
        shear: options.shear ? inputs.shear : 0,
        cape: options.cape ? inputs.cape : 0,
        cclM: options.cclThermals ? inputs.cclM : 0,
        vvel: options.turbulence ? inputs.vvel : 0,
        rainMm: options.rainConvection ? inputs.rainMm : 0,
        convPrecip: options.rainConvection ? inputs.convPrecip : 0,
    };
}

export function overlaysToSample(options: BumpinessLayerOptions): Overlays[] {
    const overlays: Overlays[] = [];
    if (options.cape) {
        overlays.push('cape');
    }
    if (options.cclThermals) {
        overlays.push('ccl');
    }
    return overlays;
}

export function samplesPerCellForOptions(options: BumpinessLayerOptions): number {
    return options.multiSample ? 3 : 1;
}

export function needsGridSampling(options: BumpinessLayerOptions): boolean {
    return options.heatmap || options.hazardSymbols;
}

export function isParamLayerEnabled(
    id: BumpinessParam['id'],
    options: BumpinessLayerOptions,
): boolean {
    const layerKey = PARAM_ENABLED[id];
    return layerKey ? options[layerKey] : true;
}

export function layerOptionsCacheKey(options: BumpinessLayerOptions): string {
    return Object.entries(options)
        .map(([k, v]) => `${k}:${v ? 1 : 0}`)
        .join('|');
}
