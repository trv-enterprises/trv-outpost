// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'TRVE Dashboards',
  tagline: 'User Guide',
  favicon: 'img/favicon.ico',

  url: 'http://localhost:3001',
  baseUrl: '/docs/',

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: '/', // Serve docs at /docs/ root (no /docs/docs/)
          sidebarPath: './sidebars.js',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'dark',
        disableSwitch: true, // Always dark to match Carbon g100
        respectPrefersColorScheme: false,
      },
      navbar: {
        title: 'TRVE Dashboards',
        // No "Back to Dashboard" link — the docs open in a new tab,
        // so the link only spawned a duplicate tab. Closing the docs
        // tab is the natural way back to the app.
        items: [],
      },
      footer: {
        style: 'dark',
        copyright: `Copyright © ${new Date().getFullYear()} TRV Enterprises LLC`,
      },
    }),
};

module.exports = config;
