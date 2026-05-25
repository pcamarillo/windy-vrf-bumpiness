import { map } from '@windy/map';

import {
    classifyHazardCause,
    type BumpinessInputs,
    type BumpinessParam,
    type HazardCause,
} from './bumpiness';
import { ensureBumpinessPane } from './bumpinessCanvas';
import type { GridPoint } from './bumpinessSampler';

const MAX_SYMBOLS = 80;

function symbolHtml(cause: HazardCause): string {
    if (cause === 'thermic') {
        return '<span class="vfr-hazard-sym vfr-hazard-sym--thermic" title="Térmicas secas">SS</span>';
    }
    if (cause === 'convective') {
        return '<span class="vfr-hazard-sym vfr-hazard-sym--convective" title="Convección con lluvia">⛈</span>';
    }
    if (cause === 'orographic') {
        return '<span class="vfr-hazard-sym vfr-hazard-sym--orographic" title="Orográfico">⛰</span>';
    }
    return '';
}

export type GridCellSample = {
    point: GridPoint;
    inputs: BumpinessInputs;
};

export function collectSymbolCells(
    cells: GridCellSample[],
    params: BumpinessParam[],
    altitudeFeet: number,
): { cell: GridCellSample; cause: HazardCause }[] {
    const candidates: { cell: GridCellSample; cause: HazardCause }[] = [];

    for (const cell of cells) {
        const cause = classifyHazardCause(cell.inputs, params, altitudeFeet);
        if (cause === 'thermic' || cause === 'convective' || cause === 'orographic') {
            candidates.push({ cell, cause });
        }
    }

    const priority = (c: HazardCause) =>
        c === 'convective' ? 3 : c === 'thermic' ? 2 : 1;

    candidates.sort((a, b) => priority(b.cause) - priority(a.cause));

    const step = Math.max(1, Math.ceil(candidates.length / MAX_SYMBOLS));
    const picked: { cell: GridCellSample; cause: HazardCause }[] = [];
    for (let i = 0; i < candidates.length && picked.length < MAX_SYMBOLS; i += step) {
        picked.push(candidates[i]);
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
        const pane = ensureBumpinessPane(map);
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
