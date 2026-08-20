// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useEffect } from 'react';
import PropTypes from 'prop-types';
import { Popover, PopoverContent, Select, SelectItem, NumberInput, TextInput, Button } from '@carbon/react';
import {
  UNIT_DIMENSIONS,
  CUSTOM_DIMENSION,
  conversionSymbol,
  conversionLabel,
  isValidConversion,
  normalizeConversion,
} from '../../chart-spec/units';
import './SeriesTransformPicker.scss';

/**
 * Per-series unit conversion affordance (#265).
 *
 * The Y-axis series row is already six controls wide, and dual-axis mode
 * reshuffles which of them appear — there is no room for a select. So the
 * trigger is one glyph-width and opens a popover, mirroring
 * ColorSwatchPicker (per-series affordance, state shown inline, popover
 * for the detail).
 *
 * The trigger renders the TARGET UNIT SYMBOL as its own content ("°F",
 * "psi") rather than a generic icon that badges when active. That's the
 * point: the requirement is that an author can tell a conversion is live
 * WITHOUT opening anything, and a symbol makes the row carry the answer
 * instead of merely signalling that an answer exists elsewhere. Unset
 * renders a low-emphasis "—".
 *
 * Named "Series transforms", not "Unit", deliberately: the Δ delta
 * checkbox (#8) is the natural second tenant of this popover — also a
 * per-series transform, also rarely used, also currently eating row
 * width. Naming it for the general case now avoids a rename later.
 *
 * @param {object|null} value     current convert descriptor, or null
 * @param {Function}    onChange  (convert|null) => void
 * @param {string}      label     accessible label (usually the column name)
 */
export default function SeriesTransformPicker({ value = null, onChange, label = 'Series' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Draft state so a half-finished conversion (dimension picked, target
  // not yet) doesn't churn the chart on every keystroke. Committed on
  // Apply; reset from `value` each time the popover opens so a cancelled
  // edit leaves nothing behind.
  const [draft, setDraft] = useState(() => toDraft(value));

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openPopover = () => {
    setDraft(toDraft(value));
    setOpen(true);
  };

  const apply = () => {
    onChange?.(normalizeConversion(fromDraft(draft)));
    setOpen(false);
  };

  const clear = () => {
    onChange?.(null);
    setOpen(false);
  };

  const symbol = conversionSymbol(value);
  const active = Boolean(symbol);
  const title = active
    ? `${conversionLabel(value)} — click to change`
    : 'No unit conversion — click to add';

  const isCustom = draft.dimension === CUSTOM_DIMENSION;
  const dim = UNIT_DIMENSIONS[draft.dimension];
  const unitEntries = dim ? Object.entries(dim.units) : [];
  // Apply stays disabled until the draft is a real conversion, so the
  // button never commits a no-op (from === to, or ×1 +0).
  const canApply = isValidConversion(fromDraft(draft));

  return (
    <span ref={ref} className="series-transform-picker">
      <Popover open={open} align="bottom-right" onRequestClose={() => setOpen(false)} dropShadow>
        <button
          type="button"
          className={`series-transform-picker__trigger ${active ? 'is-active' : ''}`}
          onClick={(e) => { e.stopPropagation(); open ? setOpen(false) : openPopover(); }}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={active ? `${label} unit: ${conversionLabel(value)}` : `${label}: no unit conversion`}
          title={title}
        >
          {active ? symbol : '—'}
        </button>
        <PopoverContent className="series-transform-picker__content">
          <div className="series-transform-picker__title">Series transforms</div>
          <div className="series-transform-picker__hint">
            Converts this series&apos; values before they are plotted, so the axis,
            thresholds, and tooltip all agree.
          </div>

          <Select
            id={`stp-dimension-${label}`}
            labelText="Quantity"
            size="sm"
            value={draft.dimension}
            onChange={(e) => setDraft(pickDimension(e.target.value))}
          >
            <SelectItem value="" text="None" />
            {Object.entries(UNIT_DIMENSIONS).map(([key, d]) => (
              <SelectItem key={key} value={key} text={d.label} />
            ))}
            <SelectItem value={CUSTOM_DIMENSION} text="Custom (scale + offset)" />
          </Select>

          {dim && (
            <div className="series-transform-picker__row">
              <Select
                id={`stp-from-${label}`}
                labelText="Stored as"
                size="sm"
                value={draft.from}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              >
                {unitEntries.map(([key, u]) => (
                  <SelectItem key={key} value={key} text={`${u.label} (${u.symbol})`} />
                ))}
              </Select>
              <Select
                id={`stp-to-${label}`}
                labelText="Display as"
                size="sm"
                value={draft.to}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              >
                {unitEntries.map(([key, u]) => (
                  <SelectItem key={key} value={key} text={`${u.label} (${u.symbol})`} />
                ))}
              </Select>
            </div>
          )}

          {isCustom && (
            <>
              <div className="series-transform-picker__row">
                <NumberInput
                  id={`stp-scale-${label}`}
                  label="Multiply by"
                  size="sm"
                  step={1}
                  value={draft.scale}
                  onChange={(_e, { value: v }) => setDraft((d) => ({ ...d, scale: v }))}
                />
                <NumberInput
                  id={`stp-offset-${label}`}
                  label="Then add"
                  size="sm"
                  step={1}
                  value={draft.offset}
                  onChange={(_e, { value: v }) => setDraft((d) => ({ ...d, offset: v }))}
                />
              </div>
              <TextInput
                id={`stp-symbol-${label}`}
                labelText="Unit symbol (optional)"
                size="sm"
                placeholder="e.g. %"
                value={draft.symbol}
                onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value }))}
              />
            </>
          )}

          <div className="series-transform-picker__actions">
            <Button kind="ghost" size="sm" onClick={clear} disabled={!active && !canApply}>
              Clear
            </Button>
            <Button kind="primary" size="sm" onClick={apply} disabled={!canApply}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

// ── draft <-> descriptor ─────────────────────────────────────────────
// The popover edits a flat draft (every field present) so switching
// dimensions doesn't have to juggle differently-shaped objects. The
// descriptor written back is the narrow canonical shape.

function toDraft(convert) {
  const base = { dimension: '', from: '', to: '', scale: 1, offset: 0, symbol: '' };
  if (!convert || typeof convert !== 'object') return base;
  if (convert.dimension === CUSTOM_DIMENSION) {
    return {
      ...base,
      dimension: CUSTOM_DIMENSION,
      scale: Number.isFinite(Number(convert.scale)) ? Number(convert.scale) : 1,
      offset: Number.isFinite(Number(convert.offset)) ? Number(convert.offset) : 0,
      symbol: typeof convert.symbol === 'string' ? convert.symbol : '',
    };
  }
  const dim = UNIT_DIMENSIONS[convert.dimension];
  if (!dim) return base;
  return { ...base, dimension: convert.dimension, from: convert.from || dim.base, to: convert.to || dim.base };
}

function fromDraft(draft) {
  if (!draft.dimension) return null;
  if (draft.dimension === CUSTOM_DIMENSION) {
    return {
      dimension: CUSTOM_DIMENSION,
      scale: Number(draft.scale),
      offset: Number(draft.offset),
      symbol: draft.symbol,
    };
  }
  return { dimension: draft.dimension, from: draft.from, to: draft.to };
}

// Seed sensible from/to when a dimension is chosen: `from` defaults to the
// dimension's base unit and `to` to the first unit that ISN'T the base, so
// the draft is immediately a valid (non-identity) conversion the author
// can Apply without extra clicks.
function pickDimension(dimension) {
  const base = { dimension, from: '', to: '', scale: 1, offset: 0, symbol: '' };
  if (!dimension || dimension === CUSTOM_DIMENSION) return base;
  const dim = UNIT_DIMENSIONS[dimension];
  if (!dim) return base;
  const keys = Object.keys(dim.units);
  return { ...base, from: dim.base, to: keys.find((k) => k !== dim.base) || dim.base };
}

SeriesTransformPicker.propTypes = {
  value: PropTypes.object,
  onChange: PropTypes.func,
  label: PropTypes.string,
};
