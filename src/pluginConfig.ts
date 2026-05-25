import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-vfr-bumpiness',
    version: '0.0.2',
    title: 'VFR Bumpiness',
    icon: '🛩️',
    description:
        'Perceived turbulence (bumpiness) map for VFR light aircraft. Combines gusts, shear, CAPE, Windy CCL/thermals, rain, and model turbulence at your chosen altitude.',
    author: 'Pablo Camarillo (pablo.camarillo@gmail.com)',
    repository: 'https://github.com/pcamarillo/windy-vrf-bumpiness',
    desktopUI: 'rhpane',
    mobileUI: 'fullscreen',
    routerPath: '/vfr-bumpiness',
    private: false,
    listenToSingleclick: true,
};

export default config;

