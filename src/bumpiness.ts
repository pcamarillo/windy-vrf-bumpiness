import type { DataHash, WeatherDataPayload } from '@windy/interfaces.d';
import type { Levels, Products } from '@windy/rootScope.d';
import type { Timestamp } from '@windy/types.d';
import type { HttpPayload } from '@windy/http.d';

const PRESSURE_LEVELS: Levels[] = [
    '975h',
    '950h',
    '925h',
    '900h',
    '850h',
    '800h',
    '700h',
    '600h',
    '500h',
    '400h',
    '300h',
    '250h',
    '200h',
    '150h',
    '10h',
];

/**
 * Map pixels with scores below this stay fully transparent (calm air).
 * Light aircraft: start tinting from ~2/10 upward.
 */
/** Calm air: no tint on map below this score. */
export const MAP_DISPLAY_MIN_SCORE = 2;

/** Discrete map palette — wide hue steps so 2–8 are easy to tell apart. */
const MAP_COLOR_STOPS: [number, [number, number, number]][] = [
    [2, [120, 195, 130]],
    [3, [200, 235, 90]],
    [4, [255, 235, 55]],
    [5, [255, 195, 35]],
    [6, [255, 140, 25]],
    [7, [255, 75, 35]],
    [8, [225, 35, 70]],
    [9, [175, 15, 115]],
    [10, [105, 0, 135]],
];

/** Default weights tuned for light aircraft (lower inertia, more felt gust/shear). */
export const DEFAULT_BUMPINESS_PARAMS = [
    {
        id: 'deltaV' as const,
        label: 'Δ Gust',
        weight: 2.5,
        desc: 'Gust excess vs mean wind (very noticeable in light aircraft)',
    },
    {
        id: 'shear' as const,
        label: 'Wind Shear',
        weight: 3.0,
        desc: 'Vertical wind shear (critical for low VFR)',
    },
    {
        id: 'cape' as const,
        label: 'CAPE',
        weight: 1.8,
        desc: 'Convective energy (J/kg)',
    },
    {
        id: 'cclM' as const,
        label: 'CCL / Thermals',
        weight: 1.6,
        desc: 'Windy thermal top height (m) — Thermals layer',
    },
    {
        id: 'vvel' as const,
        label: 'Turbulence',
        weight: 1.2,
        desc: 'Model-reported turbulence',
    },
];

export type BumpinessInputs = {
    /** Surface mean wind (kt) — used to damp spurious gust excess when calm. */
    surfaceWindKt: number;
    /** Peak gust (kt) from forecast. */
    gustKt: number;
    /** Gust excess (kt): gust − mean wind. */
    deltaV: number;
    shear: number;
    cape: number;
    /** Thermal top / CCL height from Windy overlay `ccl` (meters). */
    cclM: number;
    vvel: number;
    /** Precipitation rate (mm/h) from model or rain overlay. */
    rainMm: number;
    /** Convective fraction of precip (0–1) from point forecast when available. */
    convPrecip: number;
    /** 1 = daytime slot in model (soaring thermals), 0 = night. */
    isDay: number;
};

export type HazardCause =
    | 'thermic'
    | 'convective'
    | 'orographic'
    | 'gust'
    | 'turbulence'
    | 'mixed';

export const HAZARD_CAUSE_LABELS: Record<HazardCause, string> = {
    thermic: 'Dry thermals (SS) — CCL/CAPE, no rain',
    convective: 'Convection with rain (⛈)',
    orographic: 'Orographic / terrain shear (⛰)',
    gust: 'Gusts / wind gusts',
    turbulence: 'Model turbulence',
    mixed: 'Mixed',
};

/** Minimum CAPE (J/kg) for thermic detection when CCL is weak. */
export const THERMIC_CAPE_MIN = 40;

/** Minimum CCL / thermal height (m) from Windy overlay. */
export const THERMIC_CCL_MIN_M = 300;

/** Rain below this (mm/h) counts as dry thermal environment. */
export const THERMIC_RAIN_MAX_MM = 0.12;

/** Surface wind below this (kt): gust excess is heavily damped in scoring. */
const CALM_SURFACE_WIND_KT = 6;

export function feetToMeters(feet: number): number {
    return feet * 0.3048;
}

export type BumpinessParam = {
    id: keyof BumpinessInputs;
    label: string;
    weight: number;
    desc: string;
};

export const MS_TO_KT = 1.94384;

/**
 * Normalize a physical value to 0–1 using VFR-relevant breakpoints.
 * Based on: AIM turbulence categories, ~6 kt/1000 ft shear guidance, and typical
 * light-aircraft convective avoidance (CAPE thresholds).
 */
function normalizeFactor(value: number, breakpoints: [number, number][]): number {
    const v = Math.max(0, value);
    if (v <= breakpoints[0][0]) {
        return breakpoints[0][1];
    }

    for (let i = 1; i < breakpoints.length; i++) {
        const [x0, y0] = breakpoints[i - 1];
        const [x1, y1] = breakpoints[i];
        if (v <= x1) {
            const t = (v - x0) / (x1 - x0);
            return y0 + t * (y1 - y0);
        }
    }

    return breakpoints[breakpoints.length - 1][1];
}

/**
 * Gust excess for bumpiness scoring. With calm surface wind, models often report
 * high gust fields that are not the main VFR bump driver vs dry thermals.
 */
function scoringGustExcessKt(inputs: BumpinessInputs): number {
    const raw = inputs.deltaV;
    if (inputs.surfaceWindKt < CALM_SURFACE_WIND_KT) {
        return raw * 0.2;
    }
    if (inputs.surfaceWindKt < 10) {
        return raw * 0.5;
    }
    return raw;
}

/** Wet / stormy cell — blocks dry-thermal SS. */
export function isStormyEnvironment(inputs: BumpinessInputs): boolean {
    return (
        inputs.rainMm >= 0.15 ||
        inputs.convPrecip >= 0.05 ||
        inputs.vvel >= 1.2 ||
        (inputs.cape >= 350 && inputs.rainMm >= 0.08)
    );
}

/** 0–1 thermic activity (CCL, CAPE, dry daytime) — independent of total bumpiness. */
export function thermicActivityScore(
    inputs: BumpinessInputs,
    sub: Record<keyof BumpinessInputs, number>,
): number {
    if (isStormyEnvironment(inputs)) {
        return 0;
    }

    if (inputs.rainMm >= THERMIC_RAIN_MAX_MM || inputs.convPrecip >= 0.08) {
        return 0;
    }

    let score = 0;

    if (inputs.cclM >= THERMIC_CCL_MIN_M) {
        score += 0.22 + sub.cclM * 0.55;
    } else if (sub.cclM >= 0.08) {
        score += sub.cclM * 0.4;
    }

    if (inputs.cape >= THERMIC_CAPE_MIN) {
        score += 0.12 + sub.cape * 0.42;
    } else if (sub.cape >= 0.08) {
        score += sub.cape * 0.28;
    }

    if (inputs.isDay >= 0.5 && inputs.rainMm < 0.25) {
        score += 0.14;
    }

    // Overlay CCL missing: Iberian dry summer still often thermic from CAPE alone
    if (inputs.cclM < 200 && inputs.cape >= 80 && inputs.rainMm < 0.15) {
        score += 0.28;
    }

    return Math.min(1, score);
}

/** Per-factor 0–1 subscores (breakpoints biased for light aircraft). */
export function factorSubscores(inputs: BumpinessInputs): Record<keyof BumpinessInputs, number> {
    return {
        surfaceWindKt: 0,
        gustKt: 0,
        isDay: 0,
        // Gust excess (kt): light aircraft feels ~3 kt; uncomfortable ~8; severe ~15
        deltaV: normalizeFactor(scoringGustExcessKt(inputs), [
            [0, 0],
            [3, 0.2],
            [7, 0.45],
            [12, 0.7],
            [18, 0.9],
            [25, 1],
        ]),
        // Shear (kt): meaningful from ~5 kt between surface and cruise altitude
        shear: normalizeFactor(inputs.shear, [
            [0, 0],
            [5, 0.2],
            [10, 0.45],
            [15, 0.65],
            [22, 0.85],
            [32, 1],
        ]),
        // CAPE (J/kg): Iberian dry thermals often 100–800; storms 1500+
        cape: normalizeFactor(inputs.cape, [
            [0, 0],
            [80, 0.18],
            [200, 0.38],
            [450, 0.58],
            [900, 0.78],
            [1500, 0.92],
            [3000, 1],
        ]),
        // CCL / thermal height (m AMSL-ish): Iberian summer often 900–2200 m
        cclM: normalizeFactor(inputs.cclM, [
            [0, 0],
            [500, 0.15],
            [900, 0.32],
            [1400, 0.5],
            [2000, 0.68],
            [2800, 0.85],
            [4000, 1],
        ]),
        // Turbulence index (overlay-dependent; high values in storms/CAT)
        vvel: normalizeFactor(inputs.vvel, [
            [0, 0],
            [1, 0.25],
            [3, 0.5],
            [6, 0.75],
            [10, 0.9],
            [20, 1],
        ]),
        rainMm: normalizeFactor(inputs.rainMm, [
            [0, 0],
            [0.3, 0.25],
            [1, 0.5],
            [3, 0.75],
            [8, 1],
        ]),
        convPrecip: normalizeFactor(inputs.convPrecip, [
            [0, 0],
            [0.1, 0.35],
            [0.3, 0.65],
            [0.6, 1],
        ]),
    };
}

/** Mean of several samples in the same grid cell (inputs merged, then one score). */
export function averageBumpinessInputs(samples: BumpinessInputs[]): BumpinessInputs {
    if (!samples.length) {
        throw new Error('averageBumpinessInputs requires at least one sample');
    }
    if (samples.length === 1) {
        return { ...samples[0] };
    }

    const n = samples.length;
    let surfaceWindKt = 0;
    let gustKt = 0;
    let deltaV = 0;
    let shear = 0;
    let cape = 0;
    let cclM = 0;
    let vvel = 0;
    let rainMm = 0;
    let convPrecip = 0;
    let isDay = 0;

    for (const s of samples) {
        surfaceWindKt += s.surfaceWindKt;
        gustKt += s.gustKt;
        deltaV += s.deltaV;
        shear += s.shear;
        cape += s.cape;
        cclM += s.cclM;
        vvel += s.vvel;
        rainMm += s.rainMm;
        convPrecip += s.convPrecip;
        isDay += s.isDay;
    }

    return {
        surfaceWindKt: surfaceWindKt / n,
        gustKt: gustKt / n,
        deltaV: deltaV / n,
        shear: shear / n,
        cape: cape / n,
        cclM: cclM / n,
        vvel: vvel / n,
        rainMm: rainMm / n,
        convPrecip: convPrecip / n,
        isDay: isDay / n >= 0.5 ? 1 : 0,
    };
}

/** Peak values inside a cell — used for hazard symbols (storms are not diluted by averaging). */
export function peakBumpinessInputs(samples: BumpinessInputs[]): BumpinessInputs {
    const mean = averageBumpinessInputs(samples);
    if (samples.length === 1) {
        return mean;
    }
    return {
        ...mean,
        cape: Math.max(...samples.map(s => s.cape)),
        cclM: Math.max(...samples.map(s => s.cclM)),
        vvel: Math.max(...samples.map(s => s.vvel)),
        rainMm: Math.max(...samples.map(s => s.rainMm)),
        convPrecip: Math.max(...samples.map(s => s.convPrecip)),
    };
}

export function computeBumpiness(
    inputs: BumpinessInputs,
    params: BumpinessParam[],
): number {
    const sub = factorSubscores(inputs);
    const totalWeight = params.reduce((acc, p) => acc + p.weight, 0) || 1;
    const weighted =
        params.reduce((acc, p) => acc + sub[p.id] * p.weight, 0) / totalWeight;
    const peak = Math.max(...params.map(p => sub[p.id]));
    const blended = 0.72 * weighted + 0.28 * peak;
    const curved = Math.pow(blended, 0.92);
    return Math.min(10, Math.max(0, curved * 10));
}

function interpolateColorStops(score: number): [number, number, number] {
    const s = Math.min(10, Math.max(MAP_DISPLAY_MIN_SCORE, score));
    for (let i = 0; i < MAP_COLOR_STOPS.length - 1; i++) {
        const [s0, c0] = MAP_COLOR_STOPS[i];
        const [s1, c1] = MAP_COLOR_STOPS[i + 1];
        if (s >= s0 && s <= s1) {
            const t = (s - s0) / (s1 - s0);
            return [
                Math.round(c0[0] + t * (c1[0] - c0[0])),
                Math.round(c0[1] + t * (c1[1] - c0[1])),
                Math.round(c0[2] + t * (c1[2] - c0[2])),
            ];
        }
    }
    return MAP_COLOR_STOPS[MAP_COLOR_STOPS.length - 1][1];
}

function isConvectiveRain(inputs: BumpinessInputs): boolean {
    if (inputs.rainMm >= 0.4 && inputs.cape >= 40) {
        return true;
    }
    if (inputs.convPrecip >= 0.08 && inputs.cape >= 50) {
        return true;
    }
    if (isStormyEnvironment(inputs) && inputs.cape >= 80) {
        return true;
    }
    const sub = factorSubscores(inputs);
    const rainy = inputs.rainMm >= 0.15 || inputs.convPrecip >= 0.05;
    return rainy && sub.cape >= 0.2 && inputs.cape >= 80;
}

/** Map symbol driver (SS / ⛈ / ⛰) — ranked causes, thermics vs calm gust artefact. */
export function classifyHazardCause(
    inputs: BumpinessInputs,
    params: BumpinessParam[],
    altitudeFeet = 3000,
): HazardCause | null {
    if (isConvectiveRain(inputs)) {
        return 'convective';
    }

    if (isStormyEnvironment(inputs)) {
        const subStorm = factorSubscores(inputs);
        if (subStorm.cape >= 0.12 || inputs.rainMm >= 0.2) {
            return 'convective';
        }
        if (subStorm.vvel >= 0.28) {
            return 'turbulence';
        }
    }

    const sub = factorSubscores(inputs);
    const thermicS = thermicActivityScore(inputs, sub);
    const gustS = sub.deltaV;
    const orogS = sub.shear >= 0.38 && inputs.shear >= 6 ? sub.shear * 0.85 : 0;
    const turbS = sub.vvel >= 0.32 ? sub.vvel * 0.75 : 0;

    const ranked = (
        [
            { cause: 'thermic' as const, score: thermicS },
            { cause: 'gust' as const, score: gustS },
            { cause: 'orographic' as const, score: orogS },
            { cause: 'turbulence' as const, score: turbS },
        ] satisfies { cause: HazardCause; score: number }[]
    ).sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (!best || best.score < 0.25) {
        const bump = computeBumpiness(inputs, params);
        return bump >= MAP_DISPLAY_MIN_SCORE ? 'mixed' : null;
    }

    const gust = ranked.find(c => c.cause === 'gust');
    const thermic = ranked.find(c => c.cause === 'thermic');
    if (
        best.cause === 'gust' &&
        thermic &&
        gust &&
        thermic.score >= 0.3 &&
        thermic.score >= gust.score * 0.55 &&
        inputs.rainMm < THERMIC_RAIN_MAX_MM
    ) {
        return 'thermic';
    }

    if (thermicS >= 0.3 && best.cause === 'thermic') {
        return 'thermic';
    }

    return best.cause;
}

/** Primary label + optional secondary (e.g. thermics when gust won bumpiness). */
export function getHazardCauseDetail(
    inputs: BumpinessInputs,
    params: BumpinessParam[],
    altitudeFeet = 3000,
): { primary: HazardCause | null; secondary: HazardCause | null } {
    const primary = classifyHazardCause(inputs, params, altitudeFeet);
    const sub = factorSubscores(inputs);
    const thermicS = thermicActivityScore(inputs, sub);

    let secondary: HazardCause | null = null;
    if (
        primary &&
        primary !== 'thermic' &&
        primary !== 'convective' &&
        thermicS >= 0.28
    ) {
        secondary = 'thermic';
    }

    return { primary, secondary };
}

export function bumpinessColor(bumpiness: number): string {
    if (bumpiness < MAP_DISPLAY_MIN_SCORE) {
        const t = Math.max(0, bumpiness / MAP_DISPLAY_MIN_SCORE);
        const [r, g, b] = interpolateColorStops(MAP_DISPLAY_MIN_SCORE);
        const mix = (a: number, b: number) => Math.round(a + (b - a) * (1 - t * 0.65));
        return `rgb(${mix(144, r)},${mix(164, g)},${mix(174, b)})`;
    }
    const [r, g, b] = interpolateColorStops(bumpiness);
    return `rgb(${r},${g},${b})`;
}

/** RGBA for map tiles: transparent below threshold, stepped high-contrast palette. */
export function bumpinessMapPixel(score: number): [number, number, number, number] {
    if (score < MAP_DISPLAY_MIN_SCORE) {
        return [0, 0, 0, 0];
    }

    const t = Math.min(1, (score - MAP_DISPLAY_MIN_SCORE) / (10 - MAP_DISPLAY_MIN_SCORE));
    const [r, g, b] = interpolateColorStops(score);
    const alpha = Math.round(85 + t * 75);
    return [r, g, b, alpha];
}

/**
 * Mild contrast stretch for map colours only (0 = raw scores, 1 = full stretch).
 * Keeps purple from dominating when most cells are 4–6 raw.
 */
export function stretchGridScoresForMap(
    scores: Float32Array,
    strength = 0.42,
): Float32Array {
    const out = new Float32Array(scores.length);
    const vals = Array.from(scores)
        .filter(s => s >= MAP_DISPLAY_MIN_SCORE - 0.3)
        .sort((a, b) => a - b);

    if (vals.length < 4 || strength <= 0) {
        out.set(scores);
        return out;
    }

    const lo = vals[Math.floor(vals.length * 0.1)] ?? vals[0];
    const hi = vals[Math.floor(vals.length * 0.9)] ?? vals[vals.length - 1];
    const span = Math.max(1.2, hi - lo);

    for (let i = 0; i < scores.length; i++) {
        const raw = scores[i];
        if (raw < MAP_DISPLAY_MIN_SCORE - 0.4) {
            out[i] = raw;
            continue;
        }
        const norm = Math.min(1, Math.max(0, (raw - lo) / span));
        const stretched = MAP_DISPLAY_MIN_SCORE + norm * (10 - MAP_DISPLAY_MIN_SCORE);
        out[i] = raw * (1 - strength) + stretched * strength;
    }

    return out;
}

export function feetToPressureLevel(altitudeFeet: number): Levels {
    if (altitudeFeet < 500) {
        return 'surface';
    }

    const targetHPa = 1013 - altitudeFeet / 30;
    let closest: Levels = '850h';
    let minDiff = Infinity;

    for (const level of PRESSURE_LEVELS) {
        const hPa = parseInt(level, 10);
        const diff = Math.abs(hPa - targetHPa);
        if (diff < minDiff) {
            minDiff = diff;
            closest = level;
        }
    }

    return closest;
}

export function indexForTimestamp(
    timestamps: Timestamp[] | undefined,
    target: Timestamp,
): number {
    if (!timestamps?.length) {
        return 0;
    }

    let best = 0;
    let bestDiff = Infinity;

    for (let i = 0; i < timestamps.length; i++) {
        const diff = Math.abs(timestamps[i] - target);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = i;
        }
    }

    return best;
}

export function getForecastDataHash(
    payload: HttpPayload<WeatherDataPayload<DataHash>>,
): DataHash {
    const table = payload.data?.data;
    if (!table?.ts?.length || !table?.wind?.length) {
        throw new Error('Forecast response is missing time-series wind data.');
    }
    return table;
}

export function extractInputsFromForecast(
    data: DataHash,
    timestamp: Timestamp,
    altitudeFeet: number,
): BumpinessInputs {
    const i = indexForTimestamp(data.ts, timestamp);
    const level = feetToPressureLevel(altitudeFeet);

    const surfaceWind = data.wind[i] ?? 0;
    const gust = data.gust?.[i] ?? surfaceWind;
    const surfaceWindKt = surfaceWind * MS_TO_KT;
    const gustKt = gust * MS_TO_KT;
    const levelWindKey = `${level}/wind` as keyof DataHash;
    const levelWind = (data[levelWindKey] as number[] | undefined)?.[i] ?? surfaceWind;
    const turbulence = data.turbulence?.[i] ?? 0;

    const mm = data.mm?.[i] ?? 0;
    const conv = data.convPrecip?.[i] ?? 0;
    const rainFlag = data.rain?.[i] ?? 0;
    const daySlot = data.isDay?.[i];

    return {
        surfaceWindKt,
        gustKt,
        deltaV: Math.max(0, gustKt - surfaceWindKt),
        shear: Math.abs(levelWind - surfaceWind) * MS_TO_KT,
        cape: 0,
        cclM: 0,
        vvel: Math.abs(turbulence),
        rainMm: Math.max(mm, rainFlag > 0 ? 0.2 : 0),
        convPrecip: Math.max(0, conv),
        isDay: daySlot === undefined ? 1 : daySlot > 0.5 ? 1 : 0,
    };
}

/** Color swatches for the sidebar legend (score 3–10). */
export function getBumpinessLegend(): { score: number; label: string; color: string }[] {
    return [
        { score: 2, label: '2 — Very light', color: bumpinessColor(2) },
        { score: 3, label: '3 — Light', color: bumpinessColor(3) },
        { score: 4, label: '4 — Mild+', color: bumpinessColor(4) },
        { score: 5, label: '5 — Moderate', color: bumpinessColor(5) },
        { score: 6, label: '6 — Notable', color: bumpinessColor(6) },
        { score: 8, label: '8 — Strong', color: bumpinessColor(8) },
        { score: 10, label: '10 — Severe', color: bumpinessColor(10) },
    ];
}

export function normalizeProduct(model: string): Products {
    const map: Record<string, Products> = {
        ecmwf: 'ecmwf',
        gfs: 'gfs',
        iconEU: 'iconEu',
        iconEu: 'iconEu',
        iconD2: 'iconD2',
    };

    return map[model] ?? 'ecmwf';
}
