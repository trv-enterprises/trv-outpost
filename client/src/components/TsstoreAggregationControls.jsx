/**
 * Server-side aggregation controls for a ts-store REST component (#202):
 * agg_window / agg_default / agg_fields. Presentational — the editor owns the
 * state object ({ enabled, window, func, fields }) and serializes it with
 * tsstoreAggToParams.
 */
import { useState } from 'react';
import { Toggle, TextInput, Select, SelectItem } from '@carbon/react';
import {
  TSSTORE_AGG_FUNCTIONS,
  validateAggWindow,
  validateAggFields,
} from '../utils/tsstoreAggregation';
import './TsstoreAggregationControls.scss';

export default function TsstoreAggregationControls({ value, onChange }) {
  // Validate on blur, not per keystroke.
  const [touched, setTouched] = useState({ window: false, fields: false });
  const set = (patch) => onChange({ ...value, ...patch });
  const windowError = touched.window ? validateAggWindow(value.window) : null;
  const fieldsError = touched.fields ? validateAggFields(value.fields) : null;
  // An API/agent-authored agg_default the dropdown can't represent (e.g.
  // "avg,max") is shown as its own option so saving doesn't rewrite it.
  const customFunc = value.func && !TSSTORE_AGG_FUNCTIONS.includes(value.func);

  return (
    <div className="tsstore-agg">
      <Toggle
        id="tsstore-agg-enabled"
        labelText="Server-side aggregation"
        labelA="Off"
        labelB="On"
        size="sm"
        toggled={value.enabled}
        onToggle={(enabled) => set({ enabled })}
      />
      {value.enabled && (
        <>
          <div className="tsstore-query-row">
            <div className="tsstore-query-row__col">
              <TextInput
                id="tsstore-agg-window"
                labelText="Window (optional)"
                placeholder="e.g. 5m"
                value={value.window}
                onChange={(e) => set({ window: e.target.value })}
                onBlur={() => setTouched((t) => ({ ...t, window: true }))}
                invalid={!!windowError}
                invalidText={windowError}
                helperText="Minimum bucket size"
              />
            </div>
            <div className="tsstore-query-row__col">
              <Select
                id="tsstore-agg-function"
                labelText="Function"
                value={value.func}
                onChange={(e) => set({ func: e.target.value })}
                helperText="Applied to numeric fields"
              >
                {customFunc && <SelectItem value={value.func} text={`${value.func} (custom)`} />}
                {TSSTORE_AGG_FUNCTIONS.map((fn) => (
                  <SelectItem key={fn} value={fn} text={fn} />
                ))}
              </Select>
            </div>
          </div>
          <TextInput
            id="tsstore-agg-fields"
            labelText="Per-field functions (optional)"
            placeholder="e.g. temperature:avg, events:sum"
            value={value.fields}
            onChange={(e) => set({ fields: e.target.value })}
            onBlur={() => setTouched((t) => ({ ...t, fields: true }))}
            invalid={!!fieldsError}
            invalidText={fieldsError}
            helperText="Overrides the function for the named fields"
          />
          <p className="editor-info-hint">
            ts-store buckets records into windows and returns one row per
            bucket, keeping the original field names. On a dashboard with a
            time-range picker, the picker&apos;s resolution is used instead
            whenever it&apos;s coarser than this window. With no window set,
            the function applies at the picker&apos;s resolution only.
          </p>
        </>
      )}
    </div>
  );
}
