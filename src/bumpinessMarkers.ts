import { map } from '@windy/map';

import {
    classifyHazardCause,
    computeBumpiness,
    factorSubscores,
    isStormyEnvironment,
    MAP_DISPLAY_MIN_SCORE,
    thermicActivityScore,
    type BumpinessInputs,
    type BumpinessParam,
    type HazardCause,
} from './bumpiness';
import { ensureBumpinessSymbolsPane } from './bumpinessCanvas';
import type { GridPoint } from './bumpinessSampler';

const MAX_THERMIC_SYMBOLS = 22;
const MAX_OTHER_SYMBOLS = 14;
const MIN_SYMBOL_SPACING_DEG = 0.28;

const THERMIC_MIN_ACTIVITY = 0.48;
const THERMIC_MIN_BUMPINESS = 3;
const HAZARD_MIN_BUMPINESS = 4;

function symbolHtml(cause: HazardCause): string {
    if (cause === 'thermic') {
        return '<span class="vfr-hazard-sym vfr-hazard-sym--thermic" title="Dry thermals">SS</span>';
    }
    if (cause === 'convective') {
        return '<span class="vfr-hazard-sym vfr-hazard-sym--convective" title="Convection with rain">⛈</span>';
    }
    if (cause === 'orographic') {
        return '<span class="vfr-hazard-sym vfr-hazard-sym--orographic" title="Orographic">⛰</span>';
    }
    return '';
}

export type GridCellSample = {
    point: GridPoint;
    /** Mean of sub-samples — bumpiness score. */
    inputs: BumpinessInputs;
    /** Peak rain/CAPE/etc. inside cell — hazard symbols. */
    hazardInputs: BumpinessInputs;
};

type CellMetrics = {
    cell: GridCellSample;
    cause: HazardCause;
    bump: number;
    thermicS: number;
};

function cellKey(col: number, row: number): string {
    return `${col},${row}`;
}

function isLocalPeak(
    metrics: Map<string, CellMetrics>,
    col: number,
    row: number,
    value: number,
    compare: (m: CellMetrics) => number,
): boolean {
    const neighbors = [
        [col, row - 1],
        [col, row + 1],
        [col - 1, row],
        [col + 1, row],
    ];
    for (const [c, r] of neighbors) {
        const n = metrics.get(cellKey(c, r));
        if (n && compare(n) > value * 1.03) {
            return false;
        }
    }
    return true;
}

function tooClose(
    picked: { cell: GridCellSample }[],
    lat: number,
    lon: number,
): boolean {
    for (const p of picked) {
        if (
            Math.abs(p.cell.point.lat - lat) < MIN_SYMBOL_SPACING_DEG &&
            Math.abs(p.cell.point.lon - lon) < MIN_SYMBOL_SPACING_DEG
        ) {
            return true;
        }
    }
    return false;
}

export function collectSymbolCells(
    cells: GridCellSample[],
    params: BumpinessParam[],
    altitudeFeet: number,
): { cell: GridCellSample; cause: HazardCause }[] {
    const metrics = new Map<string, CellMetrics>();

    for (const cell of cells) {
        const hazard = cell.hazardInputs ?? cell.inputs;
        const sub = factorSubscores(hazard);
        const bump = computeBumpiness(cell.inputs, params);
        const cause = classifyHazardCause(hazard, params, altitudeFeet);
        if (!cause || cause === 'gust' || cause === 'turbulence' || cause === 'mixed') {
            continue;
        }
        if (bump < MAP_DISPLAY_MIN_SCORE) {
            continue;
        }
        if (cause === 'thermic' && isStormyEnvironment(hazard)) {
            continue;
        }

        metrics.set(cellKey(cell.point.col, cell.point.row), {
            cell,
            cause,
            bump,
            thermicS: thermicActivityScore(hazard, sub),
        });
    }

    const thermicCandidates: CellMetrics[] = [];
    const otherCandidates: CellMetrics[] = [];

    for (const m of metrics.values()) {
        if (m.cause === 'thermic') {
            if (m.thermicS < THERMIC_MIN_ACTIVITY || m.bump < THERMIC_MIN_BUMPINESS) {
                continue;
            }
            if (
                !isLocalPeak(
                    metrics,
                    m.cell.point.col,
                    m.cell.point.row,
                    m.thermicS,
                    n => n.thermicS,
                )
            ) {
                continue;
            }
            thermicCandidates.push(m);
        } else {
            if (m.bump < HAZARD_MIN_BUMPINESS) {
                continue;
            }
            if (
                !isLocalPeak(metrics, m.cell.point.col, m.cell.point.row, m.bump, n => n.bump)
            ) {
                continue;
            }
            otherCandidates.push(m);
        }
    }

    thermicCandidates.sort((a, b) => b.thermicS * b.bump - a.thermicS * a.bump);
    otherCandidates.sort((a, b) => {
        const pri = (c: HazardCause) => (c === 'convective' ? 2 : 1);
        const d = pri(b.cause) - pri(a.cause);
        return d !== 0 ? d : b.bump - a.bump;
    });

    const picked: { cell: GridCellSample; cause: HazardCause }[] = [];

    for (const m of thermicCandidates) {
        if (picked.length >= MAX_THERMIC_SYMBOLS) {
            break;
        }
        if (tooClose(picked, m.cell.point.lat, m.cell.point.lon)) {
            continue;
        }
        picked.push({ cell: m.cell, cause: m.cause });
    }

    for (const m of otherCandidates) {
        if (picked.filter(p => p.cause !== 'thermic').length >= MAX_OTHER_SYMBOLS) {
            break;
        }
        if (tooClose(picked, m.cell.point.lat, m.cell.point.lon)) {
            continue;
        }
        picked.push({ cell: m.cell, cause: m.cause });
    }

    return picked;
}

export class HazardSymbolLayer {
    private group: L.LayerGroup | null = null;

    clear(): void {
        if (this.group) {
            map.removeLayer(this.group);
            this.group = null;
        }
    }

    render(cells: GridCellSample[], params: BumpinessParam[], altitudeFeet: number): void {
        this.clear();
        const pane = ensureBumpinessSymbolsPane(map);
        this.group = L.layerGroup();

        for (const { cell, cause } of collectSymbolCells(cells, params, altitudeFeet)) {
            const html = symbolHtml(cause);
            const icon = L.divIcon({
                className: 'vfr-hazard-marker',
                html,
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });
            L.marker([cell.point.lat, cell.point.lon], { icon, pane, interactive: false }).addTo(
                this.group,
            );
        }

        this.group.addTo(map);
    }
}
