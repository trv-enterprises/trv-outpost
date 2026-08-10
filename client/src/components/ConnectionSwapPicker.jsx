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
 * @param {string}   value      selected connection_id — or, in tag-value
 *                              mode, the selected key VALUE string
 * @param {Function} onChange   (connId|value|null) => void
 * @param {object}   swapMeta   tag-value payload ({ values: [{value,
 *                              families_matched, families_total}] }) — when
 *                              present the dropdown lists DISTINCT KEY VALUES
 *                              (each host once, deduped on the key tag)
 *                              instead of connections
 */
function ConnectionSwapPicker({ variable, candidates, value, onChange, swapMeta = null }) {
  if (!variable) return null;
  const vLabel = variable.label || 'Variable';

  // Tag-value mode: the picker selects a key VALUE and every connection
  // family follows it. Values partially covered (a family with no
  // connection for that host) are annotated rather than hidden — a partial
  // swap should be an informed one, not a surprise.
  if (swapMeta) {
    const items = swapMeta.values || [];
    const selected = items.find((v) => v.value === value) || null;
    return (
      <div className="dashboard-variable-picker">
        <Dropdown
          id="dashboard-variable-picker"
          size="sm"
          titleText={vLabel}
          label="Select…"
          items={items}
          itemToString={(item) => {
            if (!item) return '';
            return item.families_matched < item.families_total
              ? `${item.value} — ${item.families_matched} of ${item.families_total} families`
              : item.value;
          }}
          selectedItem={selected}
          onChange={({ selectedItem }) => onChange(selectedItem?.value || null)}
        />
      </div>
    );
  }

  const items = (candidates || []).filter((c) => c.compatible);
  const selected = items.find((c) => c.id === value) || null;
  // Optional: label each candidate from a prefixed tag (e.g. a
  // "host:trv-srv-001" tag → "trv-srv-001"), falling back to name.
  const labelPrefix = variable.connection_swap?.label_tag_prefix || '';
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
  swapMeta: PropTypes.shape({
    values: PropTypes.arrayOf(PropTypes.shape({
      value: PropTypes.string,
      families_matched: PropTypes.number,
      families_total: PropTypes.number,
    })),
  }),
};

export default ConnectionSwapPicker;
