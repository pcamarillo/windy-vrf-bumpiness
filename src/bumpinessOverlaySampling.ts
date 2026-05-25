import store from '@windy/store';

import type { Overlays, Products } from '@windy/rootScope.d';

const overlayValueCache = new Map<string, number>();

let hiddenSamplingDepth = 0;

/** Overlays required for thermics; rain/turbulence come from point forecast API. */
export const THERMIC_OVERLAYS: Overlays[] = ['cape', 'ccl'];

export function clearOverlayValueCache(): void {
    overlayValueCache.clear();
}

export function overlayCacheKey(
    model: Products,
    overlay: Overlays,
    lat: number,
    lon: number,
): string {
    const ts = store.get('timestamp');
    return `${model}:${ts}:${overlay}:${lat.toFixed(3)}:${lon.toFixed(3)}`;
}

export function getCachedOverlayValue(key: string): number | undefined {
    return overlayValueCache.get(key);
}

export function setCachedOverlayValue(key: string, value: number): void {
    overlayValueCache.set(key, value);
}

/** Hide Windy weather tiles while sampling overlays (user keeps rain timeline + our heatmap). */
export function beginHiddenOverlaySampling(): void {
    hiddenSamplingDepth++;
    if (hiddenSamplingDepth === 1) {
        document.body.classList.add('vfr-bumpiness-hide-weather');
    }
}

export function endHiddenOverlaySampling(): void {
    hiddenSamplingDepth = Math.max(0, hiddenSamplingDepth - 1);
    if (hiddenSamplingDepth === 0) {
        document.body.classList.remove('vfr-bumpiness-hide-weather');
    }
}

/** If the plugin closes mid-sample, restore visible weather layers. */
export function forceEndHiddenOverlaySampling(): void {
    hiddenSamplingDepth = 0;
    document.body.classList.remove('vfr-bumpiness-hide-weather');
}
