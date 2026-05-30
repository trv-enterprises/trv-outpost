// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';
import { DEFAULT_SCHEME, getScheme, schemeOptions } from '../specs/band-schemes';

/**
 * BandScheme — banded_bar's bespoke band-mapping widget. A scheme
 * selector plus the per-scheme column-select rows. Switching the scheme
 * swaps which band columns are shown and how the chart labels them; the
 * scheme id + the column mappings are stored together as the single
 * bound object `data_mapping.band_columns` ({ scheme, ...colMappings }).
 *
 * Reads the whole band_columns object from formState[field.id] and writes
 * it back as one value (the multi-id-feeds-one-widget pattern, like
 * ColumnManager). The scheme definitions + which fields each shows live
 * in specs/band-schemes.js so the render and this editor agree.
 *
 * Fields render at 1/4 width in the scheme's declared order (the scheme's
 * `fields` array), grouped onto rows of up to four via flex wrap.
 */
export default function BandScheme({ field }) {
  const { availableColumns, formState, onFieldChange } = useSpecRenderContext();
  const bandColumns = formState[field.id] || {};
  const schemeId = bandColumns.scheme || DEFAULT_SCHEME;
  const scheme = getScheme(schemeId);

  const update = (next) => onFieldChange(field.id, next);

  const changeScheme = (nextId) => {
    // Switching schemes keeps any column mappings whose band keys carry
    // over (e.g. 'mean' exists in both sd + minmaxmean), drops the rest.
    const nextScheme = getScheme(nextId);
    const keep = new Set(nextScheme.fields.map((f) => f.bind));
    const carried = {};
    for (const [k, v] of Object.entries(bandColumns)) {
      if (k === 'scheme') continue;
      if (keep.has(k)) carried[k] = v;
    }
    update({ scheme: nextId, ...carried });
  };

  const setColumn = (bind, value) => {
    const next = { ...bandColumns, scheme: schemeId };
    if (value) next[bind] = value;
    else delete next[bind];
    update(next);
  };

  return (
    <div className="band-scheme">
      <Select
        id={`spec-${field.id}-scheme`}
        labelText={field.label || 'Band scheme'}
        value={schemeId}
        onChange={(e) => changeScheme(e.target.value)}
      >
        {schemeOptions().map((opt) => (
          <SelectItem key={opt.value} value={opt.value} text={opt.label} />
        ))}
      </Select>

      <div className="band-scheme__fields">
        {scheme.fields.map((f) => {
          const value = bandColumns[f.bind] || '';
          // Inject the saved value as an option when availableColumns
          // hasn't been repopulated (saved chart, pre-fetch) — same guard
          // as ColumnSelect so a configured band doesn't look empty.
          const options = value && !availableColumns.includes(value)
            ? [value, ...availableColumns]
            : availableColumns;
          return (
            <div key={f.bind} className="band-scheme__field">
              <Select
                id={`spec-${field.id}-${f.bind}`}
                labelText={f.label}
                value={value}
                onChange={(e) => setColumn(f.bind, e.target.value)}
                invalid={f.required && !value}
                invalidText={f.required ? 'Required' : undefined}
              >
                <SelectItem value="" text="Select a column" />
                {options.map((col) => (
                  <SelectItem key={col} value={col} text={col} />
                ))}
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
