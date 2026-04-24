// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import {
  Modal,
  RadioButtonGroup,
  RadioButton
} from '@carbon/react';

const FIT_MODE_OPTIONS = [
  {
    key: 'stretch',
    label: 'Stretch to fill (default)',
    description: 'Fill both axes; may distort round elements like gauges and pies.'
  },
  {
    key: 'window',
    label: 'Fit to window',
    description: 'Uniform scale, centered. Preserves aspect ratio; nothing clipped.'
  },
  {
    key: 'width',
    label: 'Fit to width',
    description: 'Fill width; scroll vertically if content is taller than the viewport.'
  },
  {
    key: 'actual',
    label: 'Actual size',
    description: 'Native pixel size, top-left, scroll in both directions when needed.'
  }
];

/**
 * DefaultDashboardFitModeEditorModal
 *
 * Admin setting — chooses the fit mode used for any dashboard a user
 * has not explicitly set. Per-user per-dashboard preferences always
 * override this default.
 */
function DefaultDashboardFitModeEditorModal({ open, onClose, currentValue, onSave }) {
  const [selectedValue, setSelectedValue] = useState('stretch');

  useEffect(() => {
    if (open) {
      setSelectedValue(currentValue || 'stretch');
    }
  }, [open, currentValue]);

  const handleSave = () => {
    onSave(selectedValue);
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Default dashboard fit mode"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={handleSave}
      size="sm"
    >
      <div style={{ padding: '0 0 1rem' }}>
        <p style={{ color: 'var(--cds-text-secondary)', marginBottom: '1rem' }}>
          Applied to any dashboard a user has not explicitly set a fit mode on.
          Per-user per-dashboard choices always override this default.
        </p>

        <RadioButtonGroup
          legendText="Fit mode"
          name="default-dashboard-fit-mode"
          orientation="vertical"
          valueSelected={selectedValue}
          onChange={(value) => setSelectedValue(value)}
        >
          {FIT_MODE_OPTIONS.map((opt) => (
            <RadioButton
              key={opt.key}
              id={`default-fit-${opt.key}`}
              labelText={
                <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <strong>{opt.label}</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)' }}>
                    {opt.description}
                  </span>
                </span>
              }
              value={opt.key}
            />
          ))}
        </RadioButtonGroup>
      </div>
    </Modal>
  );
}

export default DefaultDashboardFitModeEditorModal;
