/**
 * ts-store-native query options for a REST ts-store component (#202):
 * aggregation (agg_window / agg_default / agg_fields) and scan bounds
 * (window / scan_limit). Presentational — the editor owns the state object and
 * serializes it with tsstoreNativeToParams. Only the options ts-store applies
 * to the current query type are shown; blank = ts-store's default.
 */
import { useState } from 'react';
import { Accordion, AccordionItem, TextInput, Select, SelectItem } from '@carbon/react';
import {
  TSSTORE_AGG_FUNCTIONS,
  tsstoreNativeApplies,
  tsstoreNativeHasValues,
  validateTsstoreDuration,
  validateAggFields,
  validateScanLimit,
} from '../utils/tsstoreNativeParams';
import './TsstoreNativeParamsControls.scss';

// Scan-bound helper text depends on which query type ts-store applies it to.
const WINDOW_HELP = {
  newest: 'Lookback when filtering or aggregating (default 1h, 48h aggregating; 0 = whole store)',
  latest: 'Lookback when a filter is set (default 1h; 0 = whole store)',
};
const SCAN_LIMIT_HELP = {
  latest: 'Records scanned for the newest per series (default 5000; 0 = all, max 100000)',
  oldest: 'Records scanned when a filter is set (default 5000; 0 = all, max 100000)',
};

export default function TsstoreNativeParamsControls({ value, onChange, queryType }) {
  // Validate on blur, not per keystroke.
  const [touched, setTouched] = useState({});
  const touch = (key) => () => setTouched((t) => ({ ...t, [key]: true }));
  const set = (patch) => onChange({ ...value, ...patch });
  const error = (key, validate) => (touched[key] ? validate(value[key]) : null);
  // Open when a saved value arrives (the load can land after mount), but never
  // force it shut again: AccordionItem re-syncs to its open prop, so a plain
  // hasValues would collapse the panel as the author clears the last field.
  const hasValues = tsstoreNativeHasValues(value);
  const [expand, setExpand] = useState(hasValues);
  if (hasValues && !expand) setExpand(true);

  const showAgg = tsstoreNativeApplies('agg', queryType);
  const showWindow = tsstoreNativeApplies('window', queryType);
  const showScanLimit = tsstoreNativeApplies('scanLimit', queryType);
  // A saved agg_default the dropdown can't represent (e.g. "avg,max") is
  // shown as its own option so saving doesn't rewrite it.
  const customDefault = value.aggDefault && !TSSTORE_AGG_FUNCTIONS.includes(value.aggDefault);

  const aggWindowError = error('aggWindow', validateTsstoreDuration);
  const aggFieldsError = error('aggFields', validateAggFields);
  const windowError = error('window', (v) => validateTsstoreDuration(v, { allowZero: true }));
  const scanLimitError = error('scanLimit', validateScanLimit);

  return (
    <Accordion className="tsstore-native-params" size="sm">
      <AccordionItem title="ts-store options" open={expand}>
        {showAgg && (
          <>
            <div className="tsstore-query-row">
              <div className="tsstore-query-row__col">
                <TextInput
                  id="tsstore-agg-window"
                  labelText="Aggregation window"
                  placeholder="e.g. 5m"
                  value={value.aggWindow}
                  onChange={(e) => set({ aggWindow: e.target.value })}
                  onBlur={touch('aggWindow')}
                  invalid={!!aggWindowError}
                  invalidText={aggWindowError}
                  helperText="Bucket size; replaces a range picker's step"
                />
              </div>
              <div className="tsstore-query-row__col">
                <Select
                  id="tsstore-agg-default"
                  labelText="Aggregation function"
                  value={value.aggDefault}
                  onChange={(e) => set({ aggDefault: e.target.value })}
                  helperText="Numeric fields; blank = last (avg under a picker step)"
                >
                  <SelectItem value="" text="ts-store default" />
                  {customDefault && <SelectItem value={value.aggDefault} text={value.aggDefault} />}
                  {TSSTORE_AGG_FUNCTIONS.map((fn) => (
                    <SelectItem key={fn} value={fn} text={fn} />
                  ))}
                </Select>
              </div>
            </div>
            <div className="tsstore-query-row">
              <div className="tsstore-query-row__col">
                <TextInput
                  id="tsstore-agg-fields"
                  labelText="Per-field functions"
                  placeholder="e.g. temperature:avg, events:sum"
                  value={value.aggFields}
                  onChange={(e) => set({ aggFields: e.target.value })}
                  onBlur={touch('aggFields')}
                  invalid={!!aggFieldsError}
                  invalidText={aggFieldsError}
                  helperText="field:function; cpu:avg+max returns cpu_avg and cpu_max columns"
                />
              </div>
            </div>
          </>
        )}
        {(showWindow || showScanLimit) && (
          <div className="tsstore-query-row">
            {showWindow && (
              <div className="tsstore-query-row__col">
                <TextInput
                  id="tsstore-window"
                  labelText="Lookback window"
                  placeholder="e.g. 24h"
                  value={value.window}
                  onChange={(e) => set({ window: e.target.value })}
                  onBlur={touch('window')}
                  invalid={!!windowError}
                  invalidText={windowError}
                  helperText={WINDOW_HELP[queryType]}
                />
              </div>
            )}
            {showScanLimit && (
              <div className="tsstore-query-row__col">
                <TextInput
                  id="tsstore-scan-limit"
                  labelText="Scan limit"
                  placeholder="5000"
                  inputMode="numeric"
                  value={value.scanLimit}
                  onChange={(e) => set({ scanLimit: e.target.value })}
                  onBlur={touch('scanLimit')}
                  invalid={!!scanLimitError}
                  invalidText={scanLimitError}
                  helperText={SCAN_LIMIT_HELP[queryType]}
                />
              </div>
            )}
          </div>
        )}
      </AccordionItem>
    </Accordion>
  );
}
