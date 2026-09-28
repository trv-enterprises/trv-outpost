// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Server-side aggregation controls (#202) inside the ts-store REST query
// section: restore from saved params and visibility per transport / query
// type. Mounting the full editor also guards
// the builder against a TDZ crash (it must not reference isTSStoreStreaming,
// which is declared further down the component).

import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---- Heavy leaves mocked: not under test, expensive or jsdom-hostile ----
vi.mock('./DynamicComponentLoader', () => ({ default: () => null }));
vi.mock('./SQLQueryBuilder', () => ({
  default: () => null,
  parseSimpleQuery: () => null,
}));
vi.mock('./PrometheusQueryBuilder', () => ({ default: () => null }));
vi.mock('./EdgeLakeQueryBuilder', () => ({ default: () => null }));
vi.mock('./MQTTTopicSelector', () => ({ default: () => null }));
vi.mock('./ControlEditor', () => ({ default: () => null }));
vi.mock('./DisplayEditor', () => ({ default: () => null }));
vi.mock('./VariableValuePickerModal', () => ({ default: () => null }));
vi.mock('./ConnectionPickerModal', () => ({ default: () => null }));
vi.mock('./shared/TagInput', () => ({ default: () => null }));
vi.mock('./shared/NamespaceSelect', () => ({ default: () => null }));
vi.mock('./shared/ConnectionGuidanceHint', () => ({ default: () => null }));
vi.mock('../chart-spec/SpecDrivenSections', () => ({ default: () => null }));

vi.mock('../context/EnabledTypesContext', () => ({
  useEnabledTypes: () => ({
    isChartTypeEnabled: () => true,
    enabledDisplayTypes: null,
    enabledControlTypes: null,
  }),
}));
vi.mock('../context/NamespaceContext', () => ({
  useNamespaces: () => ({
    activeNamespace: 'default',
    namespaces: [{ name: 'default' }],
  }),
}));

vi.mock('../api/client', () => {
  const connections = { current: [] };
  const api = {
    __setConnections: (list) => { connections.current = list; },
    getConnections: vi.fn(() => Promise.resolve({ connections: connections.current })),
    getConnection: vi.fn((id) => Promise.resolve(connections.current.find((c) => c.id === id))),
    getRegistryConnectionTypes: vi.fn(() => Promise.resolve({
      types: [{ type_id: 'store.tsstore', query_surface: { kind: 'store_list', label: 'Store' } }],
    })),
    getConnectionStores: vi.fn(() => Promise.resolve({
      stores: [
        { name: 'home-env', data_type: 'json', role: 'store', access: ['read', 'write', 'manage'] },
        { name: 'garage-env', data_type: 'schema', role: 'store', access: ['read'] },
      ],
    })),
    getSetting: vi.fn(() => Promise.resolve({ value: null })),
    getComponents: vi.fn(() => Promise.resolve({ components: [] })),
    queryConnection: vi.fn(() => Promise.resolve({ success: true, result_set: { columns: [], rows: [] } })),
    getMQTTTopics: vi.fn(() => Promise.resolve({ topics: [] })),
    sampleMQTTTopic: vi.fn(() => Promise.resolve({})),
    getEdgeLakeDatabases: vi.fn(() => Promise.resolve({ databases: [] })),
    saveDiscoveredValues: vi.fn(() => Promise.resolve({})),
    httpOriginForApi: vi.fn(() => 'http://localhost:3001'),
    streamAuthQuery: vi.fn(() => ''),
    streamAuthHeaders: vi.fn(() => ({})),
    getCurrentUserGuid: vi.fn(() => 'test-user'),
    onTokenChange: vi.fn(() => () => {}),
  };
  return { default: api };
});

import apiClient from '../api/client';
import ComponentEditor from './ComponentEditor';

// One tsstore connection record in the shape the editor's connection list
// resolves selectedDatasource from.
const tsstoreConnection = (transport) => ({
  id: 'conn-1',
  name: 'test-tsstore',
  type: 'tsstore',
  namespace: 'default',
  tags: [],
  config: {
    tsstore: { transport, protocol: 'http', host: 'ts.example', port: 21080, store_name: 'home-env' },
  },
});

const chartWith = (raw, params) => ({
  id: 'chart-1',
  name: 'test-chart',
  component_type: 'chart',
  chart_type: 'line',
  namespace: 'default',
  connection_id: 'conn-1',
  query_config: { raw, type: 'tsstore', params },
  data_mapping: {},
});

const renderEditor = async ({ transport = 'rest', raw = 'since:6h', params = {} } = {}) => {
  apiClient.__setConnections([tsstoreConnection(transport)]);
  const utils = render(
    <ComponentEditor
      chart={chartWith(raw, params)}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );
  await waitFor(() => expect(apiClient.getConnections).toHaveBeenCalled());
  await screen.findByText(/test-tsstore/);
  return utils;
};

const aggToggle = () => document.getElementById('tsstore-agg-enabled');
const aggWindow = () => document.getElementById('tsstore-agg-window');

describe('ComponentEditor ts-store server-side aggregation (#202)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores saved aggregation params', async () => {
    await renderEditor({ params: { agg_window: '5m', agg_default: 'max', agg_fields: 'events:sum' } });
    await waitFor(() => expect(aggWindow()).toBeInTheDocument());
    expect(aggToggle()).toHaveAttribute('aria-checked', 'true');
    expect(aggWindow()).toHaveValue('5m');
    expect(document.getElementById('tsstore-agg-function')).toHaveValue('max');
    expect(document.getElementById('tsstore-agg-fields')).toHaveValue('events:sum');
  });

  it('is offered but off for a REST component without aggregation', async () => {
    await renderEditor();
    await waitFor(() => expect(aggToggle()).toBeInTheDocument());
    expect(aggToggle()).toHaveAttribute('aria-checked', 'false');
    expect(aggWindow()).not.toBeInTheDocument();
  });

  it('is not offered for the Current State (latest_by) query type', async () => {
    await renderEditor({ raw: 'newest', params: { latest_by: 'container' } });
    await screen.findByDisplayValue('container');
    expect(aggToggle()).not.toBeInTheDocument();
  });

  it('is not offered for Oldest Records', async () => {
    await renderEditor({ raw: 'oldest' });
    await waitFor(() => expect(document.getElementById('tsstore-query-type')).toHaveValue('oldest'));
    expect(aggToggle()).not.toBeInTheDocument();
  });

  it('is not offered on a streaming connection', async () => {
    await renderEditor({ transport: 'streaming', raw: '' });
    await waitFor(() => expect(apiClient.getConnections).toHaveBeenCalled());
    expect(aggToggle()).not.toBeInTheDocument();
  });
});
