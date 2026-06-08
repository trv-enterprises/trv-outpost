/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    {
      type: 'doc',
      id: 'README',
      label: 'User Guide',
    },
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: ['getting-started', 'modes'],
    },
    {
      type: 'category',
      label: 'View Mode',
      items: ['viewing-dashboards', 'viewer-controls', 'dashboard-variables'],
    },
    {
      type: 'category',
      label: 'Editing Dashboards',
      items: ['dashboard-editor', 'panel-management', 'dashboard-settings', 'dashboard-variables'],
    },
    {
      type: 'category',
      label: 'Components',
      items: [
        'components-overview',
        'creating-components',
        'chart-types',
        'control-types',
        'display-types',
        'ai-builder',
      ],
    },
    {
      type: 'category',
      label: 'Connections',
      items: ['connections-overview', 'connection-types'],
    },
    {
      type: 'category',
      label: 'Sharing & Organization',
      items: ['namespaces', 'export-import'],
    },
    {
      type: 'category',
      label: 'Extensions',
      items: ['extensions-overview', 'tsstore-alerts', 'edgelake-terminal'],
    },
    {
      type: 'category',
      label: 'Administration',
      items: ['user-management', 'system-users', 'system-settings', 'device-types', 'ai-usage'],
    },
    {
      type: 'category',
      label: 'Automation & Integration',
      items: ['api-overview', 'mcp'],
    },
    {
      type: 'category',
      label: 'Reference',
      items: ['keyboard-shortcuts', 'grid-layout'],
    },
  ],
};

module.exports = sidebars;
