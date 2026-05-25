import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-vfr-bumpiness',
    version: '0.0.1',
    title: 'VFR-Comfort',
    icon: '🛩️',
    description: 'Evaluates flight comfort, IMC visibility, and thermals for light aircraft at low altitudes.',
    author: 'Pablo Camarillo (pablo.camarillo@gmail.com)',
    repository: 'https://github.com/pcamarillo/windy-vrf-bumpiness',
    desktopUI: 'rhpane',
    mobileUI: 'fullscreen',
    routerPath: '/vfr-bumpiness',
    private: true,
    listenToSingleclick: true,
};

export default config;
