// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { Modal, RadioButtonGroup, RadioButton } from '@carbon/react';
import { CATEGORICAL_PAIRINGS, PAIRING_COUNTS } from '../config/theme.js';
import { DEFAULT_PREFERRED_OPTIONS, normalizePreferredColorOptions } from '../utils/chartColorConfig.js';

/**
 * ChartColorOptionsEditorModal
 *
 * Picks which Carbon color-combination "option" multi-series charts use when
 * auto-coloring, per number of series (1–5). Carbon curates several
 * distinguishable combinations per series-count; each option is shown as a
 * row of color swatches so the admin can pick by sight. 6+ series falls back
 * to the full 14-color sequence (not configurable). Per-series manual color
 * overrides on a chart always win over this default.
 *
 * Value shape (matches the chart_preferred_color_options admin setting):
 *   { "1": 2, "2": 2, "3": 2, "4": 2, "5": 2 }   // 1-based option per count
 *
 * Reads CATEGORICAL_PAIRINGS for the ACTIVE theme — swatches reflect what
 * charts actually render under the current (g100) theme.
 */
function Swatches({ colors }) {
  return (
    <span style={{ display: 'inline-flex', gap: '4px', verticalAlign: 'middle' }}>
      {colors.map((hex, i) => (
        <span
          key={i}
          title={hex}
          style={{
            width: 18,
            height: 18,
            borderRadius: 3,
            backgroundColor: hex,
            border: '1px solid var(--cds-border-subtle-01)',
            display: 'inline-block',
          }}
        />
      ))}
    </span>
  );
}

function ChartColorOptionsEditorModal({ open, onClose, currentValue, onSave }) {
  // Per-count selection as 1-based option numbers, stored as strings for the
  // RadioButtonGroup. Seeded from currentValue, falling back to the defaults.
  const [selected, setSelected] = useState({});

  useEffect(() => {
    if (!open) return;
    // currentValue may arrive as the BSON [{Key,Value}] shape — normalize.
    const cv = normalizePreferredColorOptions(currentValue);
    const seed = {};
    for (const count of PAIRING_COUNTS) {
      const fromValue = cv[String(count)] ?? cv[count];
      const n = Number(fromValue);
      const optCount = (CATEGORICAL_PAIRINGS[count] || []).length;
      const def = DEFAULT_PREFERRED_OPTIONS[count] || 1;
      // Clamp to what exists for this count.
      const chosen = Number.isInteger(n) && n >= 1 && n <= optCount ? n : Math.min(def, optCount || 1);
      seed[count] = String(chosen);
    }
    setSelected(seed);
  }, [open, currentValue]);

  const handleSave = () => {
    // Emit the {count: number} map the setting expects.
    const out = {};
    for (const count of PAIRING_COUNTS) {
      out[String(count)] = Number(selected[count]) || (DEFAULT_PREFERRED_OPTIONS[count] || 1);
    }
    onSave(out);
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Chart Color Combinations"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={handleSave}
      size="md"
    >
      <div style={{ padding: '0 0 1rem' }}>
        <p style={{ color: 'var(--cds-text-secondary)', marginBottom: '1rem' }}>
          Choose which Carbon color combination multi-series charts use when they
          auto-color, by number of series. Charts with 6+ series use the full
          14-color sequence. A chart&apos;s own per-series color overrides always win.
        </p>

        {PAIRING_COUNTS.map((count) => {
          const options = CATEGORICAL_PAIRINGS[count] || [];
          return (
            <div key={count} style={{ marginBottom: '1.5rem' }}>
              <RadioButtonGroup
                legendText={`${count}-series charts`}
                name={`chart-color-option-${count}`}
                orientation="vertical"
                valueSelected={selected[count]}
                onChange={(value) => setSelected((prev) => ({ ...prev, [count]: value }))}
              >
                {options.map((combo, i) => (
                  <RadioButton
                    key={i}
                    id={`chart-color-${count}-${i + 1}`}
                    labelText={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ minWidth: 64, color: 'var(--cds-text-secondary)' }}>
                          Option {i + 1}
                        </span>
                        <Swatches colors={combo} />
                      </span>
                    }
                    value={String(i + 1)}
                  />
                ))}
              </RadioButtonGroup>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export default ChartColorOptionsEditorModal;
