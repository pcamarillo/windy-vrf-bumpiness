import { map } from '@windy/map';

import { bumpinessColor, MAP_DISPLAY_MIN_SCORE } from './bumpiness';
import { ensureBumpinessPickerPane } from './bumpinessCanvas';

/** Map pin at the analyzed location (Windy-style picker). */
export class BumpinessPickerPin {
    private marker: L.Marker | null = null;

    update(lat: number, lon: number, score: number): void {
        const pane = ensureBumpinessPickerPane(map);
        const displayScore = Math.max(0, Math.min(10, score));
        const label = displayScore.toFixed(1);
        const bg = bumpinessColor(displayScore);

        const html = `<div class="vfr-bump-pin">
            <div class="vfr-bump-pin__badge" style="background:${bg}">${label}</div>
            <div class="vfr-bump-pin__tail"></div>
        </div>`;

        const icon = L.divIcon({
            className: 'vfr-bump-pin-wrap',
            html,
            iconSize: [52, 58],
            iconAnchor: [26, 54],
        });

        if (this.marker) {
            this.marker.setLatLng([lat, lon]);
            this.marker.setIcon(icon);
        } else {
            this.marker = L.marker([lat, lon], {
                icon,
                pane,
                interactive: false,
                zIndexOffset: 2000,
            });
            this.marker.addTo(map);
        }
    }

    clear(): void {
        if (this.marker) {
            map.removeLayer(this.marker);
            this.marker = null;
        }
    }
}
