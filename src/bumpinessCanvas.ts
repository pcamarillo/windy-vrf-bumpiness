import { bumpinessMapPixel, MAP_DISPLAY_MIN_SCORE } from './bumpiness';

const CANVAS_SIZE = 768;
const HEATMAP_BLUR_PX = 11;

export type HeatmapPaintCell = {
    lat: number;
    lon: number;
    score: number;
};

/** Heatmap tint layer. */
export const BUMPINESS_MAP_PANE = 'bumpinessPane';
const BUMPINESS_MAP_Z = '680';

/** SS / ⛈ / ⛰ markers — above heatmap. */
export const BUMPINESS_SYMBOLS_PANE = 'bumpinessSymbolsPane';
const BUMPINESS_SYMBOLS_Z = '725';

/** Analyzed-point pin — above hazard symbols. */
export const BUMPINESS_PICKER_PANE = 'bumpinessPickerPane';
const BUMPINESS_PICKER_Z = '735';

function ensurePane(map: L.Map, name: string, zIndex: string): HTMLElement {
    let pane = map.getPane(name);
    if (!pane) {
        pane = map.createPane(name);
    }
    const mapPane = map.getPane('mapPane');
    if (mapPane && pane.parentElement !== mapPane) {
        mapPane.appendChild(pane);
    }
    pane.style.zIndex = zIndex;
    return pane;
}

export function ensureBumpinessPane(map: L.Map): string {
    ensurePane(map, BUMPINESS_MAP_PANE, BUMPINESS_MAP_Z);
    return BUMPINESS_MAP_PANE;
}

export function ensureBumpinessSymbolsPane(map: L.Map): string {
    ensurePane(map, BUMPINESS_SYMBOLS_PANE, BUMPINESS_SYMBOLS_Z);
    return BUMPINESS_SYMBOLS_PANE;
}

export function ensureBumpinessPickerPane(map: L.Map): string {
    ensurePane(map, BUMPINESS_PICKER_PANE, BUMPINESS_PICKER_Z);
    return BUMPINESS_PICKER_PANE;
}

/**
 * Soft hazard field painted at fixed geographic cell centres (stable when panning),
 * then light blur so neighbouring colours blend.
 */
export function buildSmoothHeatmapDataUrl(
    cells: HeatmapPaintCell[],
    south: number,
    west: number,
    north: number,
    east: number,
    latStep: number,
    lonStep: number,
): string {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx || !cells.length) {
        return '';
    }

    const latSpan = north - south;
    const lonSpan = east - west;
    if (latSpan <= 0 || lonSpan <= 0) {
        return '';
    }

    const pxLat = (latStep / latSpan) * CANVAS_SIZE;
    const pxLon = (lonStep / lonSpan) * CANVAS_SIZE;
    const radius = Math.max(pxLat, pxLon) * 0.95;

    const toX = (lon: number) => ((lon - west) / lonSpan) * CANVAS_SIZE;
    const toY = (lat: number) => ((north - lat) / latSpan) * CANVAS_SIZE;

    for (const { lat, lon, score } of cells) {
        if (score < MAP_DISPLAY_MIN_SCORE) {
            continue;
        }

        const cx = toX(lon);
        const cy = toY(lat);
        const [r, g, b, a] = bumpinessMapPixel(score);
        if (a <= 0) {
            continue;
        }

        const alpha = a / 255;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
        grad.addColorStop(0.45, `rgba(${r},${g},${b},${alpha * 0.5})`);
        grad.addColorStop(0.78, `rgba(${r},${g},${b},${alpha * 0.15})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    const blurred = document.createElement('canvas');
    blurred.width = CANVAS_SIZE;
    blurred.height = CANVAS_SIZE;
    const bctx = blurred.getContext('2d');
    if (!bctx) {
        return canvas.toDataURL('image/png');
    }

    bctx.filter = `blur(${HEATMAP_BLUR_PX}px)`;
    bctx.drawImage(canvas, 0, 0);
    bctx.filter = 'none';

    return blurred.toDataURL('image/png');
}

export function gridSizeForZoom(zoom: number): { cols: number; rows: number } {
    if (zoom >= 11) {
        return { cols: 40, rows: 30 };
    }
    if (zoom >= 10) {
        return { cols: 32, rows: 24 };
    }
    if (zoom >= 8) {
        return { cols: 26, rows: 20 };
    }
    if (zoom >= 6) {
        return { cols: 20, rows: 16 };
    }
    return { cols: 14, rows: 11 };
}

/** Image overlay must not steal wheel/drag from the map (LeafletGL). */
export function makeOverlayNonInteractive(overlay: L.ImageOverlay): void {
    const el = overlay.getElement();
    if (!el) {
        return;
    }
    el.style.pointerEvents = 'none';
}

export async function mapPool<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    async function runWorker() {
        while (index < items.length) {
            const i = index++;
            results[i] = await worker(items[i], i);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
    );
    return results;
}

export function raiseBumpinessOverlay(overlay: L.ImageOverlay, map: L.Map): void {
    makeOverlayNonInteractive(overlay);
    if (typeof overlay.bringToFront === 'function') {
        overlay.bringToFront();
    }
    const el = overlay.getElement();
    if (el) {
        el.style.zIndex = BUMPINESS_MAP_Z;
    }
    const pane = map.getPane(BUMPINESS_MAP_PANE);
    if (pane?.parentElement) {
        pane.parentElement.appendChild(pane);
    }
}
