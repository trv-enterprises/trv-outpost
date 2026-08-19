// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Renders the REAL series-row field with the unit-conversion picker (#265).
//
// The units registry has its own unit tests and the renderer has its own
// buildOption checks; neither of those mounts a component. This one does,
// because the failure mode those miss is the one that actually blanks the
// page: a temporal-dead-zone / bad-import crash that ESLint doesn't flag
// and a pure-function test can't reach.
//
// It also pins the two UI requirements from the issue that are easy to
// regress: the trigger shows the TARGET UNIT SYMBOL inline (not a generic
// icon), and setting a conversion does not add a row to the list.

import { render, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SpecRenderContext } from '../SpecContext';
import YAxisColumnsListField from './YAxisColumnsList';

const FIELD = {
  id: 'y_axis_columns',
  label: 'Series',
  required: true,
  showAccumulator: true,
  showConvert: true,
};

function renderList(entries, onFieldChange = vi.fn()) {
  const ctx = {
    availableColumns: ['ts', 'temp_c', 'humidity'],
    formState: { y_axis_columns: entries, multipleYAxis: false },
    onFieldChange,
    previewData: null,
  };
  const utils = render(
    <SpecRenderContext.Provider value={ctx}>
      <YAxisColumnsListField field={FIELD} />
    </SpecRenderContext.Provider>,
  );
  return { ...utils, onFieldChange };
}

const triggers = () => document.querySelectorAll('.series-transform-picker__trigger');
// Every row renders its own popover markup, so a bare screen.getByLabelText
// would match N controls with the same label. Scope to the row whose trigger
// is expanded — the one the test just opened.
const openPanel = () => {
  const t = [...triggers()].find((x) => x.getAttribute('aria-expanded') === 'true');
  return t.closest('.series-transform-picker');
};
const rows = () => document.querySelectorAll('.spec-yacl__row');

describe('series row — unit conversion picker', () => {
  it('renders one trigger per series and no conversion by default', () => {
    renderList([
      { column: 'temp_c', label: '', stack: false, axis: 'left' },
      { column: 'humidity', label: '', stack: false, axis: 'left' },
    ]);
    expect(rows()).toHaveLength(2);
    expect(triggers()).toHaveLength(2);
    // Unset reads as a low-emphasis dash, not a unit.
    [...triggers()].forEach((t) => {
      expect(t.textContent).toBe('—');
      expect(t.classList.contains('is-active')).toBe(false);
    });
  });

  it('shows the TARGET unit symbol inline on a converted series', () => {
    renderList([
      { column: 'temp_c', label: '', stack: false, axis: 'left', convert: { dimension: 'temperature', from: 'c', to: 'f' } },
      { column: 'humidity', label: '', stack: false, axis: 'left' },
    ]);
    const [a, b] = triggers();
    // The whole point of the design: the row carries the answer.
    expect(a.textContent).toBe('°F');
    expect(a.classList.contains('is-active')).toBe(true);
    expect(a.getAttribute('title')).toMatch(/Celsius → Fahrenheit/);
    // The unconverted sibling is untouched.
    expect(b.textContent).toBe('—');
  });

  it('does NOT add a row per series to expose the setting', () => {
    // The issue's hard constraint: the list must not double in height.
    const { container } = renderList([{ column: 'temp_c', label: '', stack: false, axis: 'left' }]);
    expect(container.querySelectorAll('.spec-yacl__row')).toHaveLength(1);
    expect(triggers()).toHaveLength(1);
  });

  it('commits a conversion through onFieldChange without touching other entries', () => {
    const onFieldChange = vi.fn();
    renderList([
      { column: 'temp_c', label: 'Kitchen', stack: false, axis: 'left', color: '#6929c4' },
      { column: 'humidity', label: '', stack: false, axis: 'left' },
    ], onFieldChange);

    fireEvent.click(triggers()[0]);
    // Pick the quantity; from/to seed to a valid non-identity pair.
    const panel = openPanel();
    fireEvent.change(within(panel).getByLabelText('Quantity'), { target: { value: 'temperature' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));

    expect(onFieldChange).toHaveBeenCalledTimes(1);
    const [fieldId, next] = onFieldChange.mock.calls[0];
    expect(fieldId).toBe('y_axis_columns');
    expect(next[0].convert).toEqual({ dimension: 'temperature', from: 'c', to: 'f' });
    // Sibling fields on the same row survive the patch...
    expect(next[0].label).toBe('Kitchen');
    expect(next[0].color).toBe('#6929c4');
    // ...and the other series is untouched.
    expect(next[1].convert).toBeNull();
  });

  it('clears a conversion back to null', () => {
    const onFieldChange = vi.fn();
    renderList(
      [{ column: 'temp_c', label: '', stack: false, axis: 'left', convert: { dimension: 'temperature', from: 'c', to: 'f' } }],
      onFieldChange,
    );
    fireEvent.click(triggers()[0]);
    fireEvent.click(within(openPanel()).getByRole('button', { name: 'Clear' }));
    expect(onFieldChange.mock.calls[0][1][0].convert).toBeNull();
  });

  it('will not Apply a no-op (identity) conversion', () => {
    const onFieldChange = vi.fn();
    renderList([{ column: 'temp_c', label: '', stack: false, axis: 'left' }], onFieldChange);
    fireEvent.click(triggers()[0]);
    const panel = openPanel();
    fireEvent.change(within(panel).getByLabelText('Quantity'), { target: { value: 'temperature' } });
    // Force from === to; Apply must go disabled rather than persist a no-op.
    fireEvent.change(within(panel).getByLabelText('Display as'), { target: { value: 'c' } });
    expect(within(panel).getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('offers the custom affine escape hatch', () => {
    const onFieldChange = vi.fn();
    renderList([{ column: 'temp_c', label: '', stack: false, axis: 'left' }], onFieldChange);
    fireEvent.click(triggers()[0]);
    const panel = openPanel();
    fireEvent.change(within(panel).getByLabelText('Quantity'), { target: { value: 'custom' } });
    // Scale/offset inputs replace the unit selects.
    fireEvent.change(within(panel).getByLabelText('Multiply by'), { target: { value: '100' } });
    fireEvent.change(within(panel).getByLabelText('Unit symbol (optional)'), { target: { value: '%' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(onFieldChange.mock.calls[0][1][0].convert).toEqual({
      dimension: 'custom', scale: 100, offset: 0, symbol: '%',
    });
  });

  it('keeps the picker visible for a pivot chart', () => {
    // Per-series COLOR is hidden for pivots (runtime series), but one
    // conversion legitimately applies to every runtime series, so the
    // picker must stay — matching how the renderer treats accumulate.
    const ctx = {
      availableColumns: ['ts', 'temp_c'],
      formState: { y_axis_columns: [{ column: 'temp_c', label: '', stack: false, axis: 'left' }], series_column: 'location' },
      onFieldChange: vi.fn(),
      previewData: null,
    };
    const { container } = render(
      <SpecRenderContext.Provider value={ctx}>
        <YAxisColumnsListField field={FIELD} />
      </SpecRenderContext.Provider>,
    );
    expect(container.querySelectorAll('.color-swatch-picker__trigger')).toHaveLength(0);
    expect(container.querySelectorAll('.series-transform-picker__trigger')).toHaveLength(1);
  });

  it('survives a legacy string entry and a stale conversion descriptor', () => {
    // Read-path robustness: bare strings (legacy y_axis) and a descriptor
    // naming a dimension that no longer exists must not crash the editor.
    const { container } = renderList([
      'temp_c',
      { column: 'humidity', convert: { dimension: 'gone', from: 'x', to: 'y' } },
    ]);
    expect(container.querySelectorAll('.spec-yacl__row')).toHaveLength(2);
    const [a, b] = triggers();
    expect(a.textContent).toBe('—');
    expect(b.textContent).toBe('—');
  });

  it('renders the accumulator checkbox alongside, not instead', () => {
    // The Δ checkbox is the popover's likely second tenant later; today
    // both must coexist on the row.
    const { container } = renderList([{ column: 'temp_c', label: '', stack: false, axis: 'left' }]);
    const row = container.querySelector('.spec-yacl__row');
    expect(within(row).getByLabelText('Δ Delta')).toBeInTheDocument();
    expect(row.querySelector('.series-transform-picker__trigger')).toBeTruthy();
  });
});
