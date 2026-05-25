import store from '@windy/store';

import type { Overlays, Products } from '@windy/rootScope.d';

/** Overlays that support Windy's timeline / forecast calendar. */
export const TIMELINE_OVERLAYS: Overlays[] = ['rain', 'thunder', 'ptype', 'rainAccu'];

export const BUMPINESS_DEFAULT_OVERLAY = 'rain' as Overlays;

export type BumpinessMapSavedState = {
    overlay: Overlays;
    product: Products;
    particlesAnim: 'on' | 'off' | 'intensive';
    isolinesOn: boolean;
};

let saved: BumpinessMapSavedState | null = null;

export function enterBumpinessMapMode(weatherModel: Products): void {
    if (!saved) {
        saved = {
            overlay: store.get('overlay'),
            product: store.get('product'),
            particlesAnim: store.get('particlesAnim'),
            isolinesOn: store.get('isolinesOn'),
        };
    }
    store.set('particlesAnim', 'off');
    store.set('isolinesOn', false);

    const overlay = store.get('overlay');
    if (!TIMELINE_OVERLAYS.includes(overlay)) {
        store.set('overlay', BUMPINESS_DEFAULT_OVERLAY);
    }
    store.set('product', weatherModel);
}

export function restoreBumpinessMapMode(): void {
    if (!saved) {
        return;
    }
    store.set('overlay', saved.overlay);
    store.set('product', saved.product);
    store.set('particlesAnim', saved.particlesAnim);
    store.set('isolinesOn', saved.isolinesOn);
    saved = null;
}

/** Overlay shown while bumpiness is drawn (keeps timeline usable). */
export function bumpinessDisplayOverlay(): Overlays {
    const overlay = store.get('overlay');
    if (TIMELINE_OVERLAYS.includes(overlay)) {
        return overlay;
    }
    return BUMPINESS_DEFAULT_OVERLAY;
}
