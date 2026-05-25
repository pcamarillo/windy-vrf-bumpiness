import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-vfr-bumpiness',
    version: '0.0.3',
    title: 'VFR Bumpiness',
    icon: '🛩️',
    description:
        'VFR bumpiness map with a configurable on-screen cell count (aspect-adjusted grid). Cell size adapts to zoom — zoom in for finer km resolution. Gusts, shear, CAPE, CCL/thermals, rain, and turbulence at your altitude.',
    author: 'Pablo Camarillo (pablo.camarillo@gmail.com)',
    repository: 'https://github.com/pcamarillo/windy-vrf-bumpiness',
    desktopUI: 'rhpane',
    mobileUI: 'fullscreen',
    routerPath: '/vfr-bumpiness',
    private: false,
    listenToSingleclick: true,
};

export default config;

