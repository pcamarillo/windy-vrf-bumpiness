import { computeBumpiness, type BumpinessInputs, type BumpinessParam } from './bumpiness';
import { worldCellKey } from './bumpinessGrid';

export type WorldCellData = {
    latIdx: number;
    lonIdx: number;
    lat: number;
    lon: number;
    score: number;
    inputs: BumpinessInputs;
    hazardInputs: BumpinessInputs;
};

const cache = new Map<string, WorldCellData>();
let cacheContext = '';

export function worldCellCacheContext(
    model: string,
    timestamp: number,
    altitudeFeet: number,
    latStep: number,
    lonStep: number,
    zoom: number,
    viewGridCellCount: number,
): string {
    return `${model}|${timestamp}|${altitudeFeet}|z${zoom}|n${viewGridCellCount}|${latStep.toFixed(5)}|${lonStep.toFixed(5)}`;
}

export function ensureWorldCellCacheContext(context: string): void {
    if (cacheContext !== context) {
        cache.clear();
        cacheContext = context;
    }
}

export function clearWorldCellCache(): void {
    cache.clear();
    cacheContext = '';
}

export function getWorldCell(latIdx: number, lonIdx: number): WorldCellData | undefined {
    return cache.get(worldCellKey(latIdx, lonIdx));
}

export function setWorldCell(data: WorldCellData): void {
    cache.set(worldCellKey(data.latIdx, data.lonIdx), data);
}

export function recomputeWorldCellScores(params: BumpinessParam[]): void {
    for (const cell of cache.values()) {
        cell.score = computeBumpiness(cell.inputs, params);
    }
}
