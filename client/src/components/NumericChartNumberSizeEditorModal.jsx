// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { Modal, Select, SelectItem } from '@carbon/react';

// Shared across the number-chart editor and admin settings. Covers roughly
// "tile-ish" to "presentation wall" sizes. Large steps near the bottom
// because you pick these for specific panel dimensions, not for fine-tuning.
export const NUMBER_CHART_SIZES = [24, 32, 40, 48, 56, 64, 80, 96, 120, 160, 200, 240, 300, 400];

export const DEFAULT_NUMBER_CHART_SIZE = 120;

function NumericChartNumberSizeEditorModal({ open, onClose, currentValue, onSave }) {
  const [selected, setSelected] = useState(DEFAULT_NUMBER_CHART_SIZE);

  useEffect(() => {
    if (open) {
      const n = Number(currentValue);
      setSelected(Number.isFinite(n) && n > 0 ? n : DEFAULT_NUMBER_CHART_SIZE);
    }
  }, [open, currentValue]);

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Default Number Chart Value Size"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={() => onSave(selected)}
      size="sm"
    >
      <div style={{ padding: '0 0 1rem' }}>
        <p style={{ color: 'var(--cds-text-secondary)', marginBottom: '1rem' }}>
          Default font size (in pixels) for the numeric value on newly created Number charts.
          Individual charts can still override this in the chart editor.
        </p>
        <Select
          id="default-number-chart-size"
          labelText="Default Size (px)"
          value={String(selected)}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {NUMBER_CHART_SIZES.map((s) => (
            <SelectItem key={s} value={String(s)} text={`${s} px`} />
          ))}
        </Select>
        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--cds-layer-01)', borderRadius: 4, textAlign: 'center' }}>
          <span style={{ fontSize: `${selected}px`, fontWeight: 600, color: 'var(--cds-text-primary)', lineHeight: 1 }}>
            42.7
          </span>
        </div>
      </div>
    </Modal>
  );
}

export default NumericChartNumberSizeEditorModal;
