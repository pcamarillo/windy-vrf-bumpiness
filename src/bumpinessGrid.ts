import type { GridPoint } from './bumpinessSampler';

/** Approximate km per degree of latitude (WGS84 mean). */
export const KM_PER_DEG_LAT = 111;

/** Default cell size (~22 km at mid-latitudes). */
export const DEFAULT_GRID_CELL_DEG = 0.2;

/** @deprecated Use DEFAULT_GRID_CELL_DEG — kept for imports. */
export const GRID_CELL_DEG = DEFAULT_GRID_CELL_DEG;

/** Resolution slider range (km per cell side, mid-latitude approximation). */
export const GRID_CELL_KM_MIN = 10;
export const GRID_CELL_KM_MAX = 30;
export const GRID_CELL_KM_STEP = 1;
export const DEFAULT_GRID_CELL_KM = Math.round(DEFAULT_GRID_CELL_DEG * KM_PER_DEG_LAT);

export const GRID_CELL_DEG_MIN = GRID_CELL_KM_MIN / KM_PER_DEG_LAT;
export const GRID_CELL_DEG_MAX = GRID_CELL_KM_MAX / KM_PER_DEG_LAT;
/** @deprecated Use GRID_CELL_KM_STEP — kept for imports. */
export const GRID_CELL_DEG_STEP = GRID_CELL_KM_STEP / KM_PER_DEG_LAT;

export function cellDegFromKm(km: number): number {
    return km / KM_PER_DEG_LAT;
}

export function cellKmFromDeg(cellDeg: number): number {
    return Math.round(cellDeg * KM_PER_DEG_LAT);
}

/** Forecast samples per cell (centre + 2 offsets); values are averaged. */
export const SAMPLES_PER_CELL = 3;

/** Offsets as fractions of cell width/height (triangle inside each cell). */
const SUBCELL_OFFSETS: { dLat: number; dLon: number }[] = [
    { dLat: 0, dLon: 0 },
    { dLat: 0.28, dLon: 0 },
    { dLat: -0.15, dLon: 0.26 },
];

const MAX_COLS = 48;
const MAX_ROWS = 36;

export type WorldGridSpec = {
    points: GridPoint[];
    cols: number;
    rows: number;
    south: number;
    west: number;
    north: number;
    east: number;
    cellDeg: number;
};

/**
 * Approximate cell side length (km) for display in the resolution slider.
 */
export function approximateCellSideKm(cellDeg: number, latitudeDeg: number): number {
    const latRad = (latitudeDeg * Math.PI) / 180;
    const kmLat = cellDeg * 111;
    const kmLon = cellDeg * 111 * Math.cos(latRad);
    return Math.round(Math.sqrt(kmLat * kmLon));
}

/**
 * Sample points on a global lat/lon lattice so the same location keeps the same
 * forecast sample when panning or zooming.
 */
export function buildWorldAlignedGrid(
    viewSouth: number,
    viewWest: number,
    viewNorth: number,
    viewEast: number,
    cellDeg = DEFAULT_GRID_CELL_DEG,
): WorldGridSpec {
    const minLat = Math.floor(viewSouth / cellDeg) * cellDeg;
    const minLon = Math.floor(viewWest / cellDeg) * cellDeg;
    const maxLat = Math.ceil(viewNorth / cellDeg) * cellDeg;
    const maxLon = Math.ceil(viewEast / cellDeg) * cellDeg;

    let cols = Math.max(1, Math.round((maxLon - minLon) / cellDeg));
    let rows = Math.max(1, Math.round((maxLat - minLat) / cellDeg));
    cols = Math.min(cols, MAX_COLS);
    rows = Math.min(rows, MAX_ROWS);

    const lonStep = (maxLon - minLon) / cols;
    const latStep = (maxLat - minLat) / rows;

    const inView = (lat: number, lon: number) =>
        lat >= viewSouth && lat <= viewNorth && lon >= viewWest && lon <= viewEast;

    const points: GridPoint[] = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const latC = minLat + (row + 0.5) * latStep;
            const lonC = minLon + (col + 0.5) * lonStep;
            if (!inView(latC, lonC)) {
                continue;
            }

            for (let sub = 0; sub < SAMPLES_PER_CELL; sub++) {
                const off = SUBCELL_OFFSETS[sub];
                const lat = latC + off.dLat * latStep;
                const lon = lonC + off.dLon * lonStep;
                if (!inView(lat, lon)) {
                    continue;
                }
                points.push({ lat, lon, col, row, sub });
            }
        }
    }

    if (!points.length) {
        const lat = (viewSouth + viewNorth) / 2;
        const lon = (viewWest + viewEast) / 2;
        for (let sub = 0; sub < SAMPLES_PER_CELL; sub++) {
            points.push({ lat, lon, col: Math.floor(cols / 2), row: Math.floor(rows / 2), sub });
        }
    }

    return {
        points,
        cols,
        rows,
        south: minLat,
        west: minLon,
        north: maxLat,
        east: maxLon,
        cellDeg,
    };
}

export function gridViewKey(
    model: string,
    altitudeFeet: number,
    timestamp: number,
    cellDeg: number,
    spec: WorldGridSpec,
): string {
    return `${model}|${altitudeFeet}|${timestamp}|${cellDeg}|s${SAMPLES_PER_CELL}|${spec.south.toFixed(2)},${spec.west.toFixed(2)},${spec.north.toFixed(2)},${spec.east.toFixed(2)}`;
}

/** Unique grid cells (not raw sample count). */
export function countGridCells(points: { col: number; row: number }[]): number {
    const keys = new Set(points.map(p => `${p.col},${p.row}`));
    return keys.size;
}
