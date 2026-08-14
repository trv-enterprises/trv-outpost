// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Regression test for the #248 store picker's visibility matrix.
//
// The picker's visibility is RENDER-BRANCH structure, not just a predicate:
// the editor's query area branches on transport (socket/streaming → mqtt →
// tsstore), and the picker originally lived inside the tsstore REST query
// section — so streaming-transport connections, which take the first
// branch, never rendered it (the v0.53.0 bug this file exists to pin).
// The picker must render for an endpoint-scoped tsstore connection on
// EITHER transport, and never for a pinned connection.

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
const tsstoreConnection = ({ transport, storeName }) => ({
  id: 'conn-1',
  name: 'test-tsstore',
  type: 'tsstore',
  namespace: 'default',
  tags: [],
  config: {
    tsstore: {
      transport,
      protocol: 'http',
      host: 'ts.example',
      port: 21080,
      ...(storeName ? { store_name: storeName } : {}),
    },
  },
});

// A minimal saved chart bound to that connection, so the editor mounts with
// the connection selected and the query section visible.
const chartOn = (queryType) => ({
  id: 'chart-1',
  name: 'test-chart',
  component_type: 'chart',
  chart_type: 'line',
  namespace: 'default',
  connection_id: 'conn-1',
  query_config: { raw: 'newest', type: queryType, params: {} },
  data_mapping: {},
});

const renderEditor = async ({ transport, storeName }) => {
  apiClient.__setConnections([tsstoreConnection({ transport, storeName })]);
  const utils = render(
    <ComponentEditor
      chart={chartOn(transport === 'streaming' ? 'stream_filter' : 'api')}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );
  // Wait until the connection list resolved and the editor bound it.
  await waitFor(() => expect(apiClient.getConnections).toHaveBeenCalled());
  await screen.findByText(/test-tsstore/);
  return utils;
};

const storePicker = () => document.getElementById('tsstore-store-picker');

describe('ComponentEditor store picker visibility (#248)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders for an endpoint-scoped STREAMING connection (the v0.53.0 regression)', async () => {
    await renderEditor({ transport: 'streaming', storeName: '' });
    await waitFor(() => expect(storePicker()).toBeInTheDocument());
  });

  it('renders for an endpoint-scoped REST connection', async () => {
    await renderEditor({ transport: 'rest', storeName: '' });
    await waitFor(() => expect(storePicker()).toBeInTheDocument());
  });

  it('does NOT render for a pinned STREAMING connection (the pin wins)', async () => {
    await renderEditor({ transport: 'streaming', storeName: 'home-env' });
    // Give the async loads a beat to settle, then assert absence.
    await waitFor(() => expect(apiClient.getConnections).toHaveBeenCalled());
    expect(storePicker()).not.toBeInTheDocument();
  });

  it('does NOT render for a pinned REST connection', async () => {
    await renderEditor({ transport: 'rest', storeName: 'home-env' });
    await waitFor(() => expect(apiClient.getConnections).toHaveBeenCalled());
    expect(storePicker()).not.toBeInTheDocument();
  });
});
