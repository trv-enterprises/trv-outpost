// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import { TextInput, Dropdown, Button } from '@carbon/react';
import { Renew } from '@carbon/icons-react';
import VariableValuePickerModal from './VariableValuePickerModal';
import { useFilterVariableDiscovery } from '../hooks/useFilterVariableDiscovery';

/**
 * FilterVariablePicker — the filter-type dashboard-variable control.
 *
 * Extracted from DashboardViewerPage so the desktop viewer and the mobile
 * viewer render the SAME control. Three value sources:
 *   - 'freetext'   → TextInput
 *   - 'static'     → Dropdown over the author's option list
 *   - 'connection' → Dropdown over DISCOVERED values (server DISTINCT / one-shot
 *                    / newest, or a stored list for raw socket/mqtt), with a
 *                    session-only live "regenerate" for stream/socket types.
 *
 * The discovery machinery lives in useFilterVariableDiscovery (shared). This
 * component owns only the presentation + the regenerate modal wiring.
 *
 * Renders nothing when there's no filter variable — mount it unconditionally.
 *
 * @param {object}   variable   the filter DashboardVariable (or null)
 * @param {string}   value      selected/entered filter value (or null)
 * @param {Function} onChange   (value|null) => void
 * @param {Array}    panels     dashboard panels (for connection discovery)
 * @param {object}   chartsMap  component_id → component (for connection discovery)
 * @param {object}   dashboard  dashboard record (once-per-dash warn key)
 * @param {Function} [pushToast]       optional toast sink
 * @param {Function} [addNotification] optional notification sink
 */
function FilterVariablePicker({
  variable,
  value,
  onChange,
  panels,
  chartsMap,
  dashboard,
  pushToast,
  addNotification,
}) {
  const {
    effectiveDiscoveredOptions,
    discoveryLoading,
    discoveryIsStream,
    filterDropdownRef,
    discoveryTarget,
    regenerating,
    regenModalOpen,
    regenLiveValues,
    regenRecordCount,
    startSessionRegenerate,
    stopSessionRegenerate,
  } = useFilterVariableDiscovery({
    filterVariable: variable,
    panels,
    chartsMap,
    dashboard,
    pushToast,
    addNotification,
  });

  if (!variable) return null;
  const cfg = variable.filter_value || {};
  const label = variable.label || 'Filter';

  if (cfg.value_source === 'freetext') {
    return (
      <div className="dashboard-variable-picker">
        <TextInput
          id="dashboard-filter-variable"
          size="sm"
          labelText={label}
          placeholder="Enter a value…"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  // 'static' → the authored list; 'connection' → discovered values (server-side
  // for SQL/API, stored list for stream/socket; session override wins), falling
  // back to the static list (seed) on failure/empty.
  const staticOptions = Array.isArray(cfg.options) ? cfg.options : [];
  const options = cfg.value_source === 'connection'
    ? (effectiveDiscoveredOptions ?? staticOptions)
    : staticOptions;
  const selectedOpt = options.includes(value) ? value : null;
  const loading = cfg.value_source === 'connection' && discoveryLoading;
  const showRegenerate = cfg.value_source === 'connection' && discoveryIsStream;

  return (
    <>
      <div className="dashboard-variable-picker" ref={filterDropdownRef}>
        <Dropdown
          id="dashboard-filter-variable"
          size="sm"
          titleText={label}
          label={loading ? 'Loading…' : 'Select…'}
          items={options}
          disabled={loading || regenerating}
          itemToString={(item) => (item == null ? '' : String(item))}
          selectedItem={selectedOpt}
          onChange={({ selectedItem }) => onChange(selectedItem ?? null)}
        />
        {/* Regenerate (live re-capture) opens a modal that accumulates the
            distinct values in real time with a Stop button. Only for raw
            socket/mqtt variables (stored list); tsstore/API/SQL re-discover
            on load. */}
        {showRegenerate && (
          <Button
            kind="ghost"
            size="sm"
            hasIconOnly
            renderIcon={Renew}
            iconDescription="Refresh values (live capture, this session)"
            tooltipPosition="bottom"
            onClick={startSessionRegenerate}
            disabled={regenerating}
          />
        )}
      </div>

      {/* Live-capture modal (raw socket/mqtt regenerate). Stop commits the
          list (session-only) and closes; the dropdown then auto-opens. */}
      <VariableValuePickerModal
        open={regenModalOpen}
        onClose={stopSessionRegenerate}
        onSelect={() => {}}
        connectionId={discoveryTarget?.connId}
        providedValues={regenLiveValues}
        providedLoading={regenerating}
        providedPartial
        providedRecordCount={regenRecordCount}
        onStop={stopSessionRegenerate}
        captureOnly
      />
    </>
  );
}

FilterVariablePicker.propTypes = {
  variable: PropTypes.object,
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  panels: PropTypes.array,
  chartsMap: PropTypes.object,
  dashboard: PropTypes.object,
  pushToast: PropTypes.func,
  addNotification: PropTypes.func,
};

export default FilterVariablePicker;
