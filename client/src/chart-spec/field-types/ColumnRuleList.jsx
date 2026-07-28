// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem, TextInput, Checkbox, IconButton, Button } from '@carbon/react';
import { Add, Close } from '@carbon/icons-react';
import {
  COLUMN_RULE_OPERATORS,
  COLUMN_RULE_TARGETS,
  TEXT_THRESHOLD_COLOR_PALETTE,
  contrastPartnerFor,
} from '../option-helpers';
import ColorSwatchPicker from './ColorSwatchPicker';

/**
 * ColumnRuleList — the conditional-formatting rule editor for ONE dataview
 * column (#214). Each rule is
 * `{ op, value, color, target, wholeRow }`.
 *
 * Unlike the other field types in this directory this is NOT spec-context
 * driven: it edits one column's slice of the `column_rules` map and is
 * rendered inside the per-column options modal, which already knows which
 * column it is editing. So it takes `rules` + `onChange` as plain props.
 *
 * Rules are evaluated TOP-DOWN, FIRST MATCH WINS (resolveColumnRule), the
 * same contract as the value chart's text thresholds — which is why the
 * rows carry reorder controls instead of being sorted. Order is the
 * author's logic: a specific `equals` above a broad `contains`.
 *
 * @param {object} props
 * @param {Array} props.rules       current rules for this column
 * @param {function} props.onChange (nextRules) => void
 * @param {string} props.idPrefix   unique id stem — Carbon needs unique ids,
 *   and a duplicate id across mounted Selects silently breaks the Downshift
 *   components (see the v0.43.1 tag-filter bug).
 */
export default function ColumnRuleList({ rules, onChange, idPrefix }) {
  const entries = Array.isArray(rules) ? rules : [];

  const update = (i, patch) =>
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  const remove = (i) => onChange(entries.filter((_, idx) => idx !== i));

  const add = () =>
    onChange([
      ...entries,
      // Defaults chosen so a fresh rule is inert until the author fills in
      // the operand — resolveColumnRule skips a blank-operand rule rather
      // than matching every row.
      { op: 'eq', value: '', color: TEXT_THRESHOLD_COLOR_PALETTE[0].hex, target: 'text', wholeRow: false },
    ]);

  const move = (i, delta) => {
    const target = i + delta;
    if (target < 0 || target >= entries.length) return;
    const next = [...entries];
    [next[i], next[target]] = [next[target], next[i]];
    onChange(next);
  };

  return (
    <div className="column-rule-list">
      <p className="aliases-hint">
        Color this column&rsquo;s cells by what they contain. Rules are checked top to bottom
        and the first match wins, so put specific rules above broad ones. Text matching
        ignores case.
      </p>

      {entries.length === 0 && (
        <p className="column-rule-list__empty">No rules yet — the column uses the default cell styling.</p>
      )}

      {entries.map((rule, i) => {
        const opDef = COLUMN_RULE_OPERATORS.find((o) => o.value === (rule.op || 'eq'));
        const needsValue = opDef ? opDef.needsValue : true;
        const target = rule.target === 'both' ? 'both' : 'text';
        // Preview the rule exactly as the grid will paint it: text-only
        // rules color the text on the normal cell background, 'both' fills
        // and pairs the text from the fill.
        const previewStyle = target === 'both'
          ? { backgroundColor: rule.color, color: contrastPartnerFor(rule.color) || undefined }
          : { color: rule.color };
        return (
          <div key={i} className="column-rule-list__rule">
            <div className="column-rule-list__line">
              <Select
                id={`${idPrefix}-${i}-op`}
                labelText="When"
                size="sm"
                className="column-rule-list__op"
                value={rule.op || 'eq'}
                onChange={(e) => update(i, { op: e.target.value })}
              >
                {COLUMN_RULE_OPERATORS.map((o) => (
                  <SelectItem key={o.value} value={o.value} text={o.label} />
                ))}
              </Select>

              {/* "is empty" takes no operand — rendering a dead input would
                  invite the author to type something that can never apply. */}
              {needsValue && (
                <TextInput
                  id={`${idPrefix}-${i}-value`}
                  labelText="Value"
                  size="sm"
                  className="column-rule-list__value"
                  placeholder="e.g. running"
                  value={rule.value ?? ''}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              )}

              <Select
                id={`${idPrefix}-${i}-target`}
                labelText="Apply to"
                size="sm"
                className="column-rule-list__target"
                value={target}
                onChange={(e) => update(i, { target: e.target.value })}
              >
                {COLUMN_RULE_TARGETS.map((t) => (
                  <SelectItem key={t.value} value={t.value} text={t.label} />
                ))}
              </Select>

              <div className="column-rule-list__reorder">
                <IconButton kind="ghost" size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <span aria-hidden="true">↑</span>
                </IconButton>
                <IconButton
                  kind="ghost"
                  size="sm"
                  label="Move down"
                  disabled={i === entries.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <span aria-hidden="true">↓</span>
                </IconButton>
                <IconButton kind="ghost" size="sm" label="Remove rule" onClick={() => remove(i)}>
                  <Close />
                </IconButton>
              </div>
            </div>

            <div className="column-rule-list__line column-rule-list__line--second">
              <div className="column-rule-list__color">
                <span className="column-rule-list__color-label">Color</span>
                <ColorSwatchPicker
                  idPrefix={`${idPrefix}-${i}-color`}
                  value={rule.color}
                  onChange={(hex) => update(i, { color: hex })}
                  palette={TEXT_THRESHOLD_COLOR_PALETTE}
                  ariaLabel="Rule color"
                />
              </div>

              <Checkbox
                id={`${idPrefix}-${i}-wholerow`}
                labelText="Color the whole row"
                checked={rule.wholeRow === true}
                onChange={(_e, { checked }) => update(i, { wholeRow: checked })}
              />

              <span className="column-rule-list__preview" style={previewStyle}>
                Preview
              </span>
            </div>
          </div>
        );
      })}

      <div className="column-rule-list__add">
        <Button kind="ghost" size="sm" renderIcon={Add} onClick={add}>
          Add rule
        </Button>
      </div>

      {entries.some((r) => r.wholeRow) && (
        <p className="aliases-hint column-rule-list__row-note">
          When rules in more than one column claim the whole row, the leftmost column wins.
        </p>
      )}
    </div>
  );
}
