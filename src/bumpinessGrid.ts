import type { GridPoint } from './bumpinessSampler';

/** Fixed geographic cell size (~17 km at mid-latitudes) so zoom does not change hazard values. */
export const GRID_CELL_DEG = 0.15;

const MAX_COLS = 36;
const MAX_ROWS = 28;

export type WorldGridSpec = {
    points: GridPoint[];
    cols: number;
    rows: number;
    south: number;
    west: number;
    north: number;
    east: number;
};

/**
 * Sample points on a global lat/lon lattice so the same location keeps the same
 * forecast sample when panning or zooming.
 */
export function buildWorldAlignedGrid(
    viewSouth: number,
    viewWest: number,
    viewNorth: number,
    viewEast: number,
    cellDeg = GRID_CELL_DEG,
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

    const points: GridPoint[] = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const lat = minLat + (row + 0.5) * latStep;
            const lon = minLon + (col + 0.5) * lonStep;
            if (lat < viewSouth || lat > viewNorth || lon < viewWest || lon > viewEast) {
                continue;
            }
            points.push({ lat, lon, col, row });
        }
    }

    if (!points.length) {
        const lat = (viewSouth + viewNorth) / 2;
        const lon = (viewWest + viewEast) / 2;
        points.push({ lat, lon, col: Math.floor(cols / 2), row: Math.floor(rows / 2) });
    }

    return {
        points,
        cols,
        rows,
        south: minLat,
        west: minLon,
        north: maxLat,
        east: maxLon,
    };
}

export function gridViewKey(
    model: string,
    altitudeFeet: number,
    timestamp: number,
    spec: WorldGridSpec,
): string {
    return `${model}|${altitudeFeet}|${timestamp}|${GRID_CELL_DEG}|${spec.south.toFixed(2)},${spec.west.toFixed(2)},${spec.north.toFixed(2)},${spec.east.toFixed(2)}`;
}
