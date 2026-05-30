// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Band schemes for the banded_bar chart. A scheme defines the SEMANTICS
// of the bands — which data columns map to which band, what they're
// labelled, and the order from the center outward — independent of the
// visual style (time_series / column_* ) which is rendered the same way
// for every scheme.
//
// Shape:
//   id        — stored in data_mapping.band_columns.scheme
//   label     — selector option text
//   center    — { key, label } the center column (mean / median / target)
//   pairs     — ordered inner→outer; each pair is a band region between a
//               lower and an upper column. label/lowerLabel/upperLabel
//               drive the legend + tooltip. A pair renders as a filled
//               region between lower and upper, stacked outward from the
//               center. `key` is the stable band id used for series names.
//   fields    — the editor field rows (1/4-width column selects) in the
//               order/grouping requested. `bind` is the band_columns
//               subkey; `required` marks the center.
//
// The render (banded_bar.js) and the editor field type (BandScheme.jsx)
// both read from here so there is one source of truth. Adding a scheme
// (see GitHub issue #14 — percentile / quartile / IQR / ±3SD / box plot)
// is a new entry here plus, if needed, no render changes when it fits the
// center+pairs model.

export const DEFAULT_SCHEME = 'sd';

export const BAND_SCHEMES = {
  // ±1/±2 SD envelope — the original banded_bar structure, now explicit.
  sd: {
    id: 'sd',
    label: '±2, ±1, Mean, +1, +2 (Std Dev)',
    center: { key: 'mean', label: 'Mean' },
    pairs: [
      { key: 'sd1', label: '±1 SD', lowerKey: 'minus_1sd', upperKey: 'plus_1sd' },
      { key: 'sd2', label: '±2 SD', lowerKey: 'minus_2sd', upperKey: 'plus_2sd' },
    ],
    fields: [
      { bind: 'minus_2sd', label: '-2 SD column' },
      { bind: 'minus_1sd', label: '-1 SD column' },
      { bind: 'mean', label: 'Mean column', required: true },
      { bind: 'plus_1sd', label: '+1 SD column' },
      { bind: 'plus_2sd', label: '+2 SD column' },
    ],
  },

  // Min / Mean / Max — a single band region between min and max.
  minmaxmean: {
    id: 'minmaxmean',
    label: 'Min, Mean, Max (Range)',
    center: { key: 'mean', label: 'Mean' },
    pairs: [
      { key: 'range', label: 'Min / Max', lowerKey: 'min', upperKey: 'max' },
    ],
    fields: [
      { bind: 'min', label: 'Min column' },
      { bind: 'mean', label: 'Mean column', required: true },
      { bind: 'max', label: 'Max column' },
    ],
  },

  // SPC — Statistical Process Control. Target center, an inner control
  // band and an outer limit band, each with their own labels.
  spc: {
    id: 'spc',
    label: 'SPC Control Limits',
    center: { key: 'target', label: 'Target' },
    pairs: [
      { key: 'control', label: 'Control Limits', lowerKey: 'lower_control', upperKey: 'upper_control' },
      { key: 'limit', label: 'Spec Limits', lowerKey: 'lower_limit', upperKey: 'upper_limit' },
    ],
    fields: [
      { bind: 'lower_limit', label: 'Lower Limit column' },
      { bind: 'lower_control', label: 'Lower Control column' },
      { bind: 'target', label: 'Target column', required: true },
      { bind: 'upper_control', label: 'Upper Control column' },
      { bind: 'upper_limit', label: 'Upper Limit column' },
    ],
  },
};

/** Get a scheme by id, falling back to the default. */
export function getScheme(id) {
  return BAND_SCHEMES[id] || BAND_SCHEMES[DEFAULT_SCHEME];
}

/** Ordered list for the selector. */
export function schemeOptions() {
  return Object.values(BAND_SCHEMES).map((s) => ({ value: s.id, label: s.label }));
}
