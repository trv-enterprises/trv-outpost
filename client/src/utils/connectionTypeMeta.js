// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import {
  Sql,
  Api,
  Document,
  NetworkEnterprise,
  Tree,
  ChartLineSmooth,
  Meter,
  Db2Database,
  Video,
  DataBase,
} from '@carbon/icons-react';

/**
 * Connection-type metadata shared across the connections list and the
 * component editor's connection picker. Keep the type ids in sync with
 * server-go/internal/models/datasource.go DatasourceType* constants.
 *
 * Each entry: { id, label, icon (Carbon component), color (Carbon Tag color) }.
 */
export const CONNECTION_TYPE_META = [
  { id: 'sql',        label: 'SQL Database', icon: Sql,             color: 'blue' },
  { id: 'api',        label: 'REST API',     icon: Api,             color: 'green' },
  { id: 'csv',        label: 'CSV File',     icon: Document,        color: 'purple' },
  { id: 'socket',     label: 'WebSocket',    icon: NetworkEnterprise, color: 'cyan' },
  { id: 'mqtt',       label: 'MQTT',         icon: Tree,            color: 'teal' },
  { id: 'tsstore',    label: 'ts-store',     icon: ChartLineSmooth, color: 'magenta' },
  { id: 'prometheus', label: 'Prometheus',   icon: Meter,           color: 'red' },
  { id: 'edgelake',   label: 'EdgeLake',     icon: Db2Database,     color: 'blue' },
  { id: 'frigate',    label: 'Frigate',      icon: Video,           color: 'warm-gray' },
];

const BY_ID = CONNECTION_TYPE_META.reduce((m, t) => { m[t.id] = t; return m; }, {});

/** Display label for a connection type id (falls back to the raw id). */
export function connectionTypeLabel(type) {
  const key = (type || '').toLowerCase();
  return BY_ID[key]?.label || type || '';
}

/** Carbon icon component for a connection type id (falls back to DataBase). */
export function connectionTypeIcon(type) {
  const key = (type || '').toLowerCase();
  return BY_ID[key]?.icon || DataBase;
}

/** Carbon Tag color for a connection type id (falls back to gray). */
export function connectionTypeColor(type) {
  const key = (type || '').toLowerCase();
  return BY_ID[key]?.color || 'gray';
}
