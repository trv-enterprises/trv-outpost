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
}) {
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

  // Auto-fetch when the modal opens with a known column.
  useEffect(() => {
    if (open && column) fetchValues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, column]);

  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return values;
    return values.filter((v) => String(v).toLowerCase().includes(q));
  }, [values, search]);

  const handleSelect = (value) => {
    onSelect?.(value, { column, table });
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Pick a value from the connection"
      passiveModal
      size="sm"
    >
      <div className="variable-value-picker">
        {/* Column selector — preselected to the derived column, editable so the
            user can correct a bad derivation or pick one when none was found. */}
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

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem' }}>
            <Loading small withOverlay={false} description="Loading values" />
            <button type="button" className="cds--link" onClick={stop} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
              Stop
            </button>
          </div>
        )}

        {error && (
          <InlineNotification
            kind="error"
            title="Couldn't load values"
            subtitle={error}
            lowContrast
            hideCloseButton
            style={{ marginTop: '1rem' }}
          />
        )}

        {!loading && !error && values.length > 0 && (
          <>
            {partial && (
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
                  onClick={() => handleSelect(v)}
                  style={{ cursor: 'pointer', marginBottom: '0.25rem' }}
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

        {!loading && !error && column && values.length === 0 && (
          <p style={{ color: 'var(--cds-text-helper)', fontSize: '0.875rem', marginTop: '1rem' }}>
            No values found for this column.
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
  schemaColumns: PropTypes.arrayOf(PropTypes.string),
};

export default VariableValuePickerModal;
