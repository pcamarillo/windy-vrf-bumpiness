import bcast from '@windy/broadcast';
import picker from '@windy/picker';

import type { LatLon } from '@windy/interfaces';

/** True on phones / narrow touch layouts (Windy mobile UI). */
export function isMobileDevice(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }
    return (
        window.matchMedia('(max-width: 768px)').matches ||
        window.matchMedia('(pointer: coarse)').matches
    );
}

type PickerApi = {
    open?: (loc: LatLon) => void;
    on?: (
        event: string,
        cb: (data: LatLon & { values?: unknown; overlay?: string }) => void,
    ) => number;
    off?: (id: number) => void;
};

const pickerApi = picker as PickerApi;

let windyPickerOpen = false;

export function isWindyPickerOpen(): boolean {
    return windyPickerOpen;
}

/** Open Windy's embedded weather picker at lat/lon (works on mobile when map is visible). */
export function openWindyPicker(lat: number, lon: number): void {
    windyPickerOpen = true;
    if (typeof pickerApi.open === 'function') {
        pickerApi.open({ lat, lon });
        return;
    }
    bcast.fire('rqstOpen', 'picker', { lat, lon });
}

export function onPickerMoved(
    callback: (loc: LatLon) => void,
): number | undefined {
    if (typeof pickerApi.on !== 'function') {
        return undefined;
    }
    return pickerApi.on('pickerMoved', ({ lat, lon }) => {
        callback({ lat, lon });
    });
}

export function onPickerOpenState(
    onOpen: () => void,
    onClose: () => void,
): number[] {
    if (typeof pickerApi.on !== 'function') {
        return [];
    }
    return [
        pickerApi.on('pickerOpened', () => {
            windyPickerOpen = true;
            onOpen();
        }),
        pickerApi.on('pickerClosed', () => {
            windyPickerOpen = false;
            onClose();
        }),
    ];
}

export function offPickerEvents(subIds: number[]): void {
    if (typeof pickerApi.off !== 'function') {
        return;
    }
    for (const id of subIds) {
        pickerApi.off(id);
    }
}

export function offPickerMoved(subId: number | undefined): void {
    if (subId !== undefined && typeof pickerApi.off === 'function') {
        pickerApi.off(subId);
    }
}
