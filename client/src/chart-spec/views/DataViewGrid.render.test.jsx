// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Renders the REAL DataViewGrid (AG Grid in jsdom) and asserts the initial
// timestamp sort actually lands on the grid: 'newest' (the default,
// including for records with no stored value) → timestamp descending;
// 'none' → no sort. The resolver unit test can't see this half — a colDef
// property that AG Grid ignores would pass it silently.

import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import DataViewGrid from './DataViewGrid';

// Same registration the app does in main.jsx.
ModuleRegistry.registerModules([AllCommunityModule]);

// The per-user layout hook reads apiClient-backed prefs; stub it flat.
vi.mock('../../hooks/useDataviewLayout', () => ({
  useDataviewLayout: () => ({ layout: null, saveLayout: () => {}, clearLayout: () => {} }),
}));

const dataCtx = {
  data: {
    columns: ['timestamp', 'value'],
    rows: [
      [1786600000, 1],
      [1786600060, 2],
    ],
  },
  loading: false,
  error: null,
  isStreaming: false,
};

const renderGrid = (props = {}) =>
  render(
    <DataViewGrid
      config={{ id: 'test-dataview', title: 'Test' }}
      dataCtx={dataCtx}
      {...props}
    />
  );

describe('DataViewGrid initial sort (defaultSort)', () => {
  it("applies timestamp DESC by default ('newest' — latest row at the top)", async () => {
    const { container } = renderGrid();
    await waitFor(() => {
      const sorted = container.querySelector('[aria-sort="descending"]');
      expect(sorted).not.toBeNull();
      expect(sorted.getAttribute('col-id')).toBe('timestamp');
    });
  });

  it("'oldest' applies ascending", async () => {
    const { container } = renderGrid({ defaultSort: 'oldest' });
    await waitFor(() => {
      const sorted = container.querySelector('[aria-sort="ascending"]');
      expect(sorted).not.toBeNull();
      expect(sorted.getAttribute('col-id')).toBe('timestamp');
    });
  });

  it("'none' leaves delivery order (no sorted header)", async () => {
    const { container } = renderGrid({ defaultSort: 'none' });
    await waitFor(() => {
      expect(container.querySelector('.ag-header-cell')).not.toBeNull();
    });
    expect(container.querySelector('[aria-sort="descending"], [aria-sort="ascending"]')).toBeNull();
  });

  it('editor mode never applies the sort (the column manager is a layout tool)', async () => {
    const { container } = renderGrid({ editable: true });
    await waitFor(() => {
      expect(container.querySelector('.ag-header-cell')).not.toBeNull();
    });
    expect(container.querySelector('[aria-sort="descending"], [aria-sort="ascending"]')).toBeNull();
  });
});
