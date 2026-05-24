// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Notification, Terminal } from '@carbon/icons-react';

/**
 * Registry of Design-mode extensions.
 *
 * Each entry maps a settings key (admin toggle) to its sidebar
 * presence + route. The Extensions section in the sidebar iterates
 * this list, filters to enabled entries, and hides the whole section
 * when none are enabled.
 *
 * Adding a new extension:
 *   1. Add a settings key (`extensions.<id>.enabled`, default value)
 *      to `server-go/config/user-configurable.yaml`.
 *   2. Append an entry below.
 *   3. Wire its route in `App.jsx`.
 */
export const EXTENSIONS = [
  {
    id: 'tsstore_alerts',
    settingsKey: 'extensions.tsstore_alerts.enabled',
    label: 'ts-store Alerts',
    description: 'Manage ts-store alert rules across every tsstore connection',
    icon: Notification,
    path: '/design/extensions/tsstore-alerts',
  },
  {
    id: 'edgelake_terminal',
    settingsKey: 'extensions.edgelake_terminal.enabled',
    label: 'EdgeLake Terminal',
    description: 'Interactive AnyLog/EdgeLake command shell against any EdgeLake connection',
    icon: Terminal,
    path: '/design/extensions/edgelake-terminal',
  },
];
