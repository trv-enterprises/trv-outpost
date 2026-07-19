// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import { Dropdown } from '@carbon/react';
import { candidateLabel } from '../utils/tagValueByPrefix';

/**
 * ConnectionSwapPicker — the connection-swap dashboard-variable dropdown.
 *
 * Extracted from DashboardViewerPage's inline toolbar block so the desktop
 * viewer and the mobile viewer render the SAME control. Selecting a candidate
 * repoints every variable-driven component at that connection (the parent's
 * resolveConnectionId, driven by the value this sets).
 *
 * Renders nothing when there's no connection-swap variable — callers can mount
 * it unconditionally.
 *
 * @param {object}   variable   the connection_swap DashboardVariable (or null)
 * @param {Array}    candidates candidate connections ([{id,name,compatible,...}])
 * @param {string}   value      selected connection_id (or null)
 * @param {Function} onChange   (connId|null) => void
 */
function ConnectionSwapPicker({ variable, candidates, value, onChange }) {
  if (!variable) return null;
  const items = (candidates || []).filter((c) => c.compatible);
  const selected = items.find((c) => c.id === value) || null;
  // Optional: label each candidate from a prefixed tag (e.g. a
  // "host:trv-srv-001" tag → "trv-srv-001"), falling back to name.
  const labelPrefix = variable.connection_swap?.label_tag_prefix || '';
  const vLabel = variable.label || 'Variable';
  return (
    <div className="dashboard-variable-picker">
      <Dropdown
        id="dashboard-variable-picker"
        size="sm"
        titleText={vLabel}
        label="Select…"
        items={items}
        itemToString={(item) => candidateLabel(item, labelPrefix)}
        selectedItem={selected}
        onChange={({ selectedItem }) => onChange(selectedItem?.id || null)}
      />
    </div>
  );
}

ConnectionSwapPicker.propTypes = {
  variable: PropTypes.object,
  candidates: PropTypes.array,
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
};

export default ConnectionSwapPicker;
