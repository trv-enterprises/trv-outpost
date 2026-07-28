// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Modal, TextInput, Select, SelectItem, NumberInput } from '@carbon/react';
import ColumnRuleList from './ColumnRuleList';

/**
 * ColumnOptionsModal — everything about ONE dataview column that isn't a
 * direct manipulation on the table itself (#214).
 *
 * The visual formatter handles what's naturally spatial — width by
 * dragging, order by dragging, visibility by toggling. Those are gestures
 * on the table. What's left is per-column *configuration*: display name,
 * value format, an exact pixel width, and the conditional-format rules.
 * Those don't belong on the table surface, so they live here, one column
 * at a time, opened from the column's header button.
 *
 * @param {object} props
 * @param {string} props.column      the column name being edited
 * @param {string} props.alias       current display name ('' = use the raw name)
 * @param {string} props.format      current value format id ('auto' = default)
 * @param {number|''} props.width    current author width in px ('' = auto)
 * @param {Array} props.rules        current conditional-format rules
 * @param {Array} props.formats      [{ value, label }] format vocabulary
 * @param {function} props.onChange  (patch) => void — { alias?, format?, width?, rules? }
 * @param {function} props.onClose
 */
export default function ColumnOptionsModal({
  column,
  alias,
  format,
  width,
  rules,
  formats,
  onChange,
  onClose,
}) {
  return (
    <Modal
      open
      passiveModal
      modalHeading={`Column: ${column}`}
      modalLabel="Column options"
      onRequestClose={onClose}
      // `sm`, not `lg`. This edits ONE column's four settings — at `lg`
      // (1152px measured) the fields floated in a mostly-empty expanse that
      // read as a broken dialog rather than a compact settings panel.
      size="sm"
      className="column-options-modal"
    >
      {/* Two stacked sections rather than tabs. There are only four
          settings here, so tabs hid half of them behind a click for no
          gain — and the rules section in particular should be visible
          without hunting, since it's the one setting with no other trace
          in the UI. (The tabbed version also silently rendered NOTHING:
          Carbon's TabList walks React.Children to build its tabs, and a
          JSX comment between two <Tab> elements was enough to make it
          emit only the scroll chrome. Not worth re-litigating for a
          layout that was wrong anyway.) */}
      <div className="column-options-modal__section">
        <div className="column-options-modal__grid">
          <TextInput
            id={`colopt-${column}-alias`}
            labelText="Display name"
            placeholder={column}
            helperText="Shown as the column header. Leave blank to use the column name."
            value={alias || ''}
            onChange={(e) => onChange({ alias: e.target.value })}
          />
          <Select
            id={`colopt-${column}-format`}
            labelText="Value format"
            helperText="Compact turns 136365211648 into 127.0G."
            value={format || 'auto'}
            onChange={(e) => onChange({ format: e.target.value })}
          >
            {formats.map((f) => (
              <SelectItem key={f.value} value={f.value} text={f.label} />
            ))}
          </Select>
          <NumberInput
            id={`colopt-${column}-width`}
            label="Width (px)"
            // Dragging the column edge is the primary way to set this;
            // the field is here for the case a drag can't serve — an
            // exact number, or matching a width across two tables.
            helperText="Blank = size to fit the content. Dragging the column edge in the table sets this too."
            placeholder="auto"
            value={width === '' || width == null ? '' : width}
            allowEmpty
            min={1}
            max={2000}
            step={10}
            hideSteppers
            onChange={(_e, { value }) => onChange({ width: value })}
          />
        </div>
      </div>

      <div className="column-options-modal__section">
        <h6 className="column-options-modal__section-title">
          Conditional formatting
          {rules?.length ? ` (${rules.length})` : ''}
        </h6>
        <ColumnRuleList
          rules={rules}
          onChange={(next) => onChange({ rules: next })}
          idPrefix={`colopt-${column}-rule`}
        />
      </div>
    </Modal>
  );
}
