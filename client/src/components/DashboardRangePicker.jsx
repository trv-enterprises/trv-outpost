// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { Dropdown, DatePicker, DatePickerInput, TimePicker, Tooltip } from '@carbon/react';
import {
  DEFAULT_RANGE_PRESETS,
  DEFAULT_STEP,
  presetLabel,
  resolveIntentToAbsolute,
  clampStep,
  maxPointsForType,
  stepsForWindow,
} from '../utils/rangePresets';

/**
 * DashboardRangePicker — the header control for a `range` dashboard variable.
 *
 * Emits the range INTENT (never a pre-resolved window): a relative preset →
 * { type:'relative', token } and the "Custom…" absolute editor →
 * { type:'absolute', from, to }. Resolution to concrete instants happens
 * server-side per connection type (and client-side only for preview parity).
 *
 * For a step-aware range dashboard (Prometheus, ts-store) the picker also shows
 * a `step` (resolution) dropdown; the chosen step is folded into the emitted
 * intent. The step is clamped against that type's point budget so a fine step
 * over a wide window can't request an unreasonable number of points — the
 * clamped value is surfaced as an *effective* step with an explanatory tooltip
 * rather than silently overriding the selection.
 *
 * @param {object}   props.variable   the range DashboardVariable (label, range config)
 * @param {object}   props.value      active range intent, or null
 * @param {Function} props.onChange   (intent|null) => void
 * @param {boolean}  props.showStep   show the step dropdown
 * @param {string}   props.stepType   connection type driving the step budget
 *                                    ('prometheus' | 'tsstore')
 */
const CUSTOM = '__custom__';

// Split an ISO instant into the { date: 'YYYY-MM-DD', time: 'HH:MM' } parts the
// Carbon DatePicker + TimePicker inputs expect (local time).
function isoToParts(iso) {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

// Combine a 'YYYY-MM-DD' date and 'HH:MM' time (local) into an ISO instant.
// Returns null when either part is missing/unparseable.
function partsToIso(date, time) {
  if (!date) return null;
  const t = time && /^\d{1,2}:\d{2}$/.test(time) ? time : '00:00';
  const d = new Date(`${date}T${t}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default function DashboardRangePicker({ variable, value, onChange, showStep = false, stepType = null }) {
  const label = variable?.label || 'Range';
  const cfg = variable?.range || {};
  const presets = Array.isArray(cfg.presets) && cfg.presets.length ? cfg.presets : DEFAULT_RANGE_PRESETS;
  const allowAbsolute = cfg.allow_absolute !== false; // default true

  const items = useMemo(() => {
    const list = presets.map((p) => ({ id: p, label: presetLabel(p) }));
    if (allowAbsolute) list.push({ id: CUSTOM, label: 'Custom…' });
    return list;
  }, [presets, allowAbsolute]);

  // The user explicitly chose "Custom…". Kept as LOCAL state so the absolute
  // editor stays open while the user fills in from/to — even before both are
  // set (an incomplete absolute intent isn't a valid stored value, so we can't
  // derive "is custom open" from `value` alone).
  const [customChosen, setCustomChosen] = useState(false);

  // The dropdown's sticky selection: an active relative intent shows its preset
  // token; an absolute intent (or an in-progress Custom choice) shows Custom.
  const selectedId = value?.type === 'relative'
    ? value.token
    : (value?.type === 'absolute' || customChosen)
      ? CUSTOM
      : null;
  const customOpen = selectedId === CUSTOM;
  const selectedItem = selectedId ? items.find((i) => i.id === selectedId) || null : null;

  const step = value?.step || (showStep ? DEFAULT_STEP : undefined);

  // When this is a step-aware range dashboard and the active value carries no
  // step yet, fold in the default so it's persisted + applied downstream.
  useEffect(() => {
    if (showStep && value && value.type && !value.step) {
      onChange({ ...value, step: DEFAULT_STEP });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStep, value?.type, value?.token, value?.from, value?.to, value?.step]);

  // Effective step shown to the user: each step-aware type caps how many points
  // a range query may return, so a fine step over a wide window is auto-raised
  // (server + client). When that happens, surface the coarser effective step so
  // the dropdown selection isn't silently overridden without explanation.
  const maxPoints = maxPointsForType(stepType);
  const windowMs = useMemo(() => {
    const abs = resolveIntentToAbsolute(value);
    if (!abs) return 0;
    return new Date(abs.to).getTime() - new Date(abs.from).getTime();
  }, [value]);
  const effectiveStep = useMemo(() => {
    if (!showStep || !step) return step;
    if (!windowMs) return step;
    return clampStep(step, windowMs, maxPoints);
  }, [showStep, step, windowMs, maxPoints]);
  const stepClamped = showStep && effectiveStep !== step;

  // Only offer steps that draw a readable number of points for this window —
  // hides sub-minute steps on wide ranges (see stepsForWindow). Falls back to
  // the full list when the window isn't resolvable yet.
  const stepItems = useMemo(
    () => stepsForWindow(windowMs, maxPoints),
    [windowMs, maxPoints]
  );

  // Widening the range can make the ACTIVE step (e.g. 15s) no longer offerable
  // (15s on 24h isn't readable). Snap the stored step up to the finest still-
  // offered one so the value that flows to the query matches the dropdown — the
  // display-only snap on the Dropdown isn't enough; value.step must change too.
  useEffect(() => {
    if (!showStep || !value?.type || !value?.step) return;
    if (stepItems.length && !stepItems.includes(value.step)) {
      onChange({ ...value, step: stepItems[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStep, stepItems, value?.step, value?.type, value?.token, value?.from, value?.to]);

  // Preserve the active step when switching window kind so a Prometheus
  // dashboard's resolution survives a preset/custom change.
  const withStep = (intent) => (showStep && step ? { ...intent, step } : intent);

  const handleSelect = (item) => {
    if (!item) return;
    if (item.id === CUSTOM) {
      // Reveal the absolute editor. Seed a default last-24h window so the
      // inputs aren't blank and the chart has a runnable range immediately;
      // the user then adjusts from/to.
      setCustomChosen(true);
      if (value?.type !== 'absolute') {
        const now = new Date();
        const from = new Date(now.getTime() - 24 * 3600 * 1000);
        onChange(withStep({ type: 'absolute', from: from.toISOString(), to: now.toISOString() }));
      }
      return;
    }
    setCustomChosen(false);
    onChange(withStep({ type: 'relative', token: item.id }));
  };

  const fromParts = isoToParts(value?.type === 'absolute' ? value.from : '');
  const toParts = isoToParts(value?.type === 'absolute' ? value.to : '');

  // The TimePicker is a CONTROLLED input gated on a complete HH:MM, but the user
  // types one character at a time ("0" → "00" → "00:" → "00:0" → "00:00"). If we
  // drove its value straight from the committed ISO, every incomplete keystroke
  // would fail partsToIso, leave `value` unchanged, and snap the input back to
  // the old time — so it reads as "can't type a time". Keep a LOCAL draft so
  // partial input persists; commit the ISO only when a full HH:MM is entered,
  // and re-sync the draft when `value` changes externally (preset/date switch).
  const [fromTimeDraft, setFromTimeDraft] = useState(fromParts.time);
  const [toTimeDraft, setToTimeDraft] = useState(toParts.time);
  useEffect(() => { setFromTimeDraft(fromParts.time); }, [fromParts.time]);
  useEffect(() => { setToTimeDraft(toParts.time); }, [toParts.time]);

  const commitCustom = (next) => {
    const fromIso = partsToIso(next.fromDate, next.fromTime);
    const toIso = partsToIso(next.toDate, next.toTime);
    if (fromIso && toIso) onChange(withStep({ type: 'absolute', from: fromIso, to: toIso }));
  };

  const handleStep = (newStep) => {
    if (!value) return;
    onChange({ ...value, step: newStep });
  };

  return (
    <div className="dashboard-variable-picker dashboard-range-picker">
      <Dropdown
        id="dashboard-range-variable"
        size="sm"
        titleText={label}
        label="Select…"
        items={items}
        itemToString={(item) => (item ? item.label : '')}
        selectedItem={selectedItem}
        onChange={({ selectedItem: it }) => handleSelect(it)}
      />
      {customOpen && allowAbsolute && (
        <div className="dashboard-range-custom">
          {/* From and To each group their date+time so they wrap as a unit
              when the toolbar is tight (the row folds From-over-To rather
              than clipping). The field row also scrolls horizontally as a
              backstop so nothing is ever truncated. */}
          <div className="dashboard-range-field">
            <DatePicker
              datePickerType="single"
              dateFormat="Y-m-d"
              value={fromParts.date || undefined}
              onChange={(dates) => {
                const d = dates?.[0];
                if (!d) return;
                const pad = (n) => String(n).padStart(2, '0');
                const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                commitCustom({ fromDate: date, fromTime: fromParts.time, toDate: toParts.date, toTime: toParts.time });
              }}
            >
              <DatePickerInput id="range-from-date" size="sm" labelText="From" placeholder="YYYY-MM-DD" />
            </DatePicker>
            <TimePicker
              id="range-from-time"
              size="sm"
              labelText=""
              value={fromTimeDraft}
              onChange={(e) => {
                const t = e.target.value;
                setFromTimeDraft(t); // keep partial input visible while typing
                commitCustom({ fromDate: fromParts.date, fromTime: t, toDate: toParts.date, toTime: toTimeDraft });
              }}
            />
          </div>
          <div className="dashboard-range-field">
            <DatePicker
              datePickerType="single"
              dateFormat="Y-m-d"
              value={toParts.date || undefined}
              onChange={(dates) => {
                const d = dates?.[0];
                if (!d) return;
                const pad = (n) => String(n).padStart(2, '0');
                const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                commitCustom({ fromDate: fromParts.date, fromTime: fromParts.time, toDate: date, toTime: toParts.time });
              }}
            >
              <DatePickerInput id="range-to-date" size="sm" labelText="To" placeholder="YYYY-MM-DD" />
            </DatePicker>
            <TimePicker
              id="range-to-time"
              size="sm"
              labelText=""
              value={toTimeDraft}
              onChange={(e) => {
                const t = e.target.value;
                setToTimeDraft(t); // keep partial input visible while typing
                commitCustom({ fromDate: fromParts.date, fromTime: fromTimeDraft, toDate: toParts.date, toTime: t });
              }}
            />
          </div>
        </div>
      )}
      {showStep && (
        <div className="dashboard-range-step">
          <Dropdown
            id="dashboard-range-step"
            size="sm"
            titleText="Step"
            label="Step"
            items={stepItems}
            itemToString={(item) => (item == null ? '' : String(item))}
            selectedItem={stepItems.includes(step) ? step : (stepItems[0] || null)}
            onChange={({ selectedItem: it }) => handleStep(it)}
          />
          {stepClamped && (
            <Tooltip
              align="bottom"
              label={`Effective step. A range query is capped at ${maxPoints?.toLocaleString()} points, so the requested ${step} step was raised to ${effectiveStep} to cover this time range.`}
            >
              <span className="dashboard-range-step-note" tabIndex={0}>
                → {effectiveStep}
              </span>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

DashboardRangePicker.propTypes = {
  variable: PropTypes.object,
  value: PropTypes.object,
  onChange: PropTypes.func.isRequired,
  showStep: PropTypes.bool,
  stepType: PropTypes.oneOf(['prometheus', 'tsstore']),
};
