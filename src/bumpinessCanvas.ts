import { bumpinessMapPixel } from './bumpiness';

const CANVAS_SIZE = 768;

/** Above weather tiles; city labels (GridLayer) typically sit higher in the stack. */
export const BUMPINESS_MAP_PANE = 'bumpinessPane';
const BUMPINESS_PANE_Z = '680';

function bilinearSample(
    grid: Float32Array,
    gridW: number,
    gridH: number,
    gx: number,
    gy: number,
): number {
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, gridW - 1);
    const y1 = Math.min(y0 + 1, gridH - 1);
    const tx = gx - x0;
    const ty = gy - y0;

    const v00 = grid[y0 * gridW + x0];
    const v10 = grid[y0 * gridW + x1];
    const v01 = grid[y1 * gridW + x0];
    const v11 = grid[y1 * gridW + x1];

    const top = v00 * (1 - tx) + v10 * tx;
    const bottom = v01 * (1 - tx) + v11 * tx;
    return top * (1 - ty) + bottom * ty;
}

export function ensureBumpinessPane(map: L.Map): string {
    const name = BUMPINESS_MAP_PANE;
    let pane = map.getPane(name);
    if (!pane) {
        pane = map.createPane(name);
    }
    const mapPane = map.getPane('mapPane');
    if (mapPane && pane.parentElement !== mapPane) {
        mapPane.appendChild(pane);
    }
    pane.style.zIndex = BUMPINESS_PANE_Z;
    return name;
}

/**
 * Smooth hazard field: transparent where calm, colored only above MAP_DISPLAY_MIN_SCORE.
 */
export function buildSmoothHeatmapDataUrl(
    scores: Float32Array,
    gridW: number,
    gridH: number,
): string {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return '';
    }

    const imageData = ctx.createImageData(CANVAS_SIZE, CANVAS_SIZE);
    const pixels = imageData.data;

    for (let py = 0; py < CANVAS_SIZE; py++) {
        const gy = (py / (CANVAS_SIZE - 1)) * (gridH - 1);
        for (let px = 0; px < CANVAS_SIZE; px++) {
            const gx = (px / (CANVAS_SIZE - 1)) * (gridW - 1);
            const score = bilinearSample(scores, gridW, gridH, gx, gy);
            const [r, g, b, a] = bumpinessMapPixel(score);
            const i = (py * CANVAS_SIZE + px) * 4;
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
            pixels[i + 3] = a;
        }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
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
        el.style.zIndex = BUMPINESS_PANE_Z;
    }
    const pane = map.getPane(BUMPINESS_MAP_PANE);
    if (pane?.parentElement) {
        pane.parentElement.appendChild(pane);
    }
}
