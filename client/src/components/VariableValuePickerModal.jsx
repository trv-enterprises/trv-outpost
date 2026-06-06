// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import {
  Modal,
  Search,
  Select,
  SelectItem,
  Loading,
  InlineNotification,
  Tile,
  Button,
} from '@carbon/react';
import apiClient from '../api/client';

/**
 * VariableValuePickerModal — pick a dashboard-variable value from the distinct
 * values of a connection column.
 *
 * The variable's token sits opposite a column (`WHERE control_id =
 * {{dashboard-variable}}`). When the column was derived from the query it's
 * passed in `column`/`table`; when derivation failed, `column` is empty and the
 * user picks one from `schemaColumns`. The modal fetches distinct values via
 * `apiClient.getVariableValues` and lets the user select one. On select it calls
 * `onSelect(value, { column, table })` so the caller can both set the preview
 * value AND remember the column/table for runtime discovery.
 *
 * @param {boolean}  open
 * @param {Function} onClose
 * @param {Function} onSelect        (value, {column, table}) => void
 * @param {string}   connectionId
 * @param {string}   column          derived column (may be empty → user picks)
 * @param {string}   table           derived/declared source table (may be empty)
 * @param {string}   database        EdgeLake database (from the component query)
 * @param {string[]} schemaColumns   columns to choose from when none derived
 *
 * CLIENT MODE — for connection types with no engine-side DISTINCT (streams /
 * sockets / API), the caller captures records itself and uniques the column in
 * the browser, then supplies the list directly:
 * @param {string[]|null} providedValues  when non-null, the modal renders THIS
 *   list and skips the server fetch entirely (column selector hidden — the
 *   caller already knows the column from the filter).
 * @param {boolean}  providedPartial   list may be incomplete (cap / stop)
 * @param {boolean}  providedLoading   a client capture is in progress
 * @param {number}   providedRecordCount  total stream records processed so far
 *   during a client capture (every message seen, not just distinct values).
 *   Shown alongside the distinct-value count so the user can tell the stream is
 *   live even when no NEW value has arrived for a while.
 * @param {Function} onStop            () => void — stop an in-progress capture
 */
function VariableValuePickerModal({
  open,
  onClose,
  onSelect,
  connectionId,
  column: derivedColumn = '',
  table = '',
  database = '',
  schemaColumns = [],
  providedValues = null,
  providedPartial = false,
  providedLoading = false,
  providedRecordCount = 0,
  onStop = null,
  // captureOnly: render the accumulating list read-only (no clickable tiles).
  // Used by the dashboard, where the modal only CAPTURES — selection happens in
  // the header dropdown afterward, not inside the modal.
  captureOnly = false,
}) {
  // Client mode: the caller supplies the values (client-side capture). No server
  // fetch, no column picker.
  const clientMode = providedValues !== null;
  const [column, setColumn] = useState(derivedColumn);
  const [values, setValues] = useState([]);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const abortRef = useRef(null);

  // Reset transient state each time the modal opens or the derived column
  // changes, so a reopened modal doesn't show a stale list.
  useEffect(() => {
    if (!open) return;
    setColumn(derivedColumn);
    setValues([]);
    setPartial(false);
    setError(null);
    setSearch('');
  }, [open, derivedColumn]);

  const fetchValues = useCallback(async () => {
    if (!connectionId || !column) return;
    // Cancel any in-flight fetch (also wired to the Stop control).
    if (abortRef.current) abortRef.current.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getVariableValues(connectionId, {
        column,
        table,
        database,
        signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      if (res?.success) {
        setValues(res.values || []);
        setPartial(!!res.partial);
      } else {
        setError(res?.error || 'Failed to load values');
        setValues([]);
      }
    } catch (err) {
      if (ctl.signal.aborted) return; // user stopped — keep what we have
      setError(err.message || 'Failed to load values');
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
      setLoading(false);
    }
  }, [connectionId, column, table, database]);

  // Auto-fetch when the modal opens with a known column — server mode only.
  // In client mode the caller supplies the values, so there's nothing to fetch.
  useEffect(() => {
    if (clientMode) return;
    if (open && column) fetchValues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, column, clientMode]);

  const serverStop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  // Effective view state: in client mode everything comes from props (and Stop
  // delegates to the caller's onStop); in server mode it's the local fetch.
  const effValues = useMemo(
    () => (clientMode ? (providedValues || []) : values),
    [clientMode, providedValues, values],
  );
  const effPartial = clientMode ? providedPartial : partial;
  const effLoading = clientMode ? providedLoading : loading;
  const effError = clientMode ? null : error;
  const stop = clientMode ? (onStop || (() => {})) : serverStop;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return effValues;
    return effValues.filter((v) => String(v).toLowerCase().includes(q));
  }, [effValues, search]);

  const handleSelect = (value) => {
    onSelect?.(value, { column, table });
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading={captureOnly ? 'Capturing values from the stream' : 'Pick a value from the connection'}
      passiveModal
      size="sm"
    >
      <div className="variable-value-picker">
        {/* Column selector — server mode only. In client mode the caller already
            knows the column (from the filter) and supplies the values, so the
            picker is hidden. Preselected to the derived column, editable so the
            user can correct a bad derivation or pick one when none was found. */}
        {!clientMode && (
        <Select
          id="vvp-column"
          labelText="Column"
          value={column}
          onChange={(e) => setColumn(e.target.value)}
          helperText={derivedColumn ? 'Detected from the query — change if wrong.' : 'Could not auto-detect — choose the column the variable filters on.'}
        >
          <SelectItem value="" text="Select a column…" />
          {/* Always include the derived column even if not in schemaColumns. */}
          {derivedColumn && !schemaColumns.includes(derivedColumn) && (
            <SelectItem value={derivedColumn} text={derivedColumn} />
          )}
          {schemaColumns.map((c) => (
            <SelectItem key={c} value={c} text={c} />
          ))}
        </Select>
        )}

        {effLoading && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Loading small withOverlay={false} description={clientMode ? 'Capturing values' : 'Loading values'} />
              <span style={{ fontSize: '0.875rem', color: 'var(--cds-text-helper)' }}>
                {clientMode
                  ? `Capturing… ${providedRecordCount.toLocaleString()} record${providedRecordCount === 1 ? '' : 's'} processed, ${effValues.length} distinct value${effValues.length === 1 ? '' : 's'}`
                  : 'Loading values'}
              </span>
            </div>
            <Button
              kind="primary"
              size="md"
              onClick={stop}
              style={{ marginTop: '0.75rem' }}
            >
              Stop
            </Button>
          </div>
        )}

        {effError && (
          <InlineNotification
            kind="error"
            title="Couldn't load values"
            subtitle={effError}
            lowContrast
            hideCloseButton
            style={{ marginTop: '1rem' }}
          />
        )}

        {/* Value list. In client (capture) mode it renders WHILE capturing so the
            list visibly accumulates in real time — the editor and the dashboard
            both show found uniques live, not just after Stop. captureOnly only
            controls clickability (dashboard picks via the header dropdown, so its
            tiles are read-only; the editor picks in-modal, so its tiles are
            clickable even mid-capture). Server mode still shows after loading. */}
        {!effError && effValues.length > 0 && (clientMode || !effLoading) && (
          <>
            {effPartial && !effLoading && (
              <InlineNotification
                kind="info"
                title="Partial list"
                subtitle="Discovery was cut short; some values may be missing."
                lowContrast
                hideCloseButton
                style={{ marginTop: '0.5rem' }}
              />
            )}
            <Search
              id="vvp-search"
              labelText="Filter values"
              placeholder="Filter values…"
              size="sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ marginTop: '1rem' }}
            />
            <div className="variable-value-list" style={{ marginTop: '0.5rem', maxHeight: '40vh', overflowY: 'auto' }}>
              {filtered.map((v) => (
                <Tile
                  key={String(v)}
                  className="variable-value-option"
                  onClick={captureOnly ? undefined : () => handleSelect(v)}
                  style={{ cursor: captureOnly ? 'default' : 'pointer', marginBottom: '0.25rem' }}
                >
                  {String(v)}
                </Tile>
              ))}
              {filtered.length === 0 && (
                <p style={{ color: 'var(--cds-text-helper)', fontSize: '0.875rem' }}>No values match the filter.</p>
              )}
            </div>
          </>
        )}

        {!effLoading && !effError && (clientMode || column) && effValues.length === 0 && (
          <p style={{ color: 'var(--cds-text-helper)', fontSize: '0.875rem', marginTop: '1rem' }}>
            No values found{clientMode ? ' in the captured records.' : ' for this column.'}
          </p>
        )}
      </div>
    </Modal>
  );
}

VariableValuePickerModal.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  onSelect: PropTypes.func,
  connectionId: PropTypes.string,
  column: PropTypes.string,
  table: PropTypes.string,
  database: PropTypes.string,
  providedValues: PropTypes.arrayOf(PropTypes.oneOfType([PropTypes.string, PropTypes.number])),
  providedPartial: PropTypes.bool,
  providedLoading: PropTypes.bool,
  providedRecordCount: PropTypes.number,
  onStop: PropTypes.func,
  captureOnly: PropTypes.bool,
  schemaColumns: PropTypes.arrayOf(PropTypes.string),
};

export default VariableValuePickerModal;
