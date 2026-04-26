// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { Modal, NumberInput } from '@carbon/react';

export const DEFAULT_DASHBOARD_CONFIG_REFRESH_INTERVAL = 300; // 5 minutes

/**
 * Admin setting — how often (seconds) viewers re-fetch the dashboard
 * record from the server to pick up edits made by another user.
 *
 * Polling is paused while a user is editing the dashboard they're
 * viewing, gated on browser-tab visibility, and only triggers a
 * re-render when the server reports an actual change.
 *
 * 0 disables the feature entirely.
 */
function DashboardConfigRefreshIntervalEditorModal({ open, onClose, currentValue, onSave }) {
  const [value, setValue] = useState(DEFAULT_DASHBOARD_CONFIG_REFRESH_INTERVAL);

  useEffect(() => {
    if (open) {
      const n = Number(currentValue);
      setValue(Number.isFinite(n) && n >= 0 ? n : DEFAULT_DASHBOARD_CONFIG_REFRESH_INTERVAL);
    }
  }, [open, currentValue]);

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Dashboard config refresh interval"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={() => onSave(value)}
      size="sm"
    >
      <div style={{ padding: '0 0 1rem' }}>
        <p style={{ color: 'var(--cds-text-secondary)', marginBottom: '1rem' }}>
          How often (in seconds) an unattended dashboard viewer should
          check the server for layout or chart edits made by another
          user. Lets a kiosk display pick up changes without a manual
          reload.
        </p>
        <NumberInput
          id="dashboard-config-refresh-interval"
          label="Interval (seconds)"
          value={value}
          onChange={(_e, { value: v }) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) setValue(n);
          }}
          min={0}
          max={86400}
          step={30}
          allowEmpty={false}
          helperText="Set to 0 to disable. Default 300 (5 minutes). Polling pauses while a user is editing the dashboard they're viewing and while the browser tab is hidden."
        />
      </div>
    </Modal>
  );
}

export default DashboardConfigRefreshIntervalEditorModal;
