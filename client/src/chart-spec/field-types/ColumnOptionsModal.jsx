// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
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
 *   Called ONCE, on Apply, with everything that changed.
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
  // DRAFT state — edits are local until Apply, so Cancel genuinely reverts.
  // Matches the Dashboard Settings modal (DashboardViewerPage), which is the
  // established shape for a settings dialog in this app. The earlier
  // write-through version had only a Close button and no way back: every
  // keystroke hit the real config, so an experiment with a color or a
  // half-typed rule was already applied by the time you thought better of it.
  //
  // Seeded once per mount. The modal is only mounted while open (the caller
  // renders it conditionally), so there's no stale-draft case to reconcile.
  const [draft, setDraft] = useState(() => ({
    alias: alias || '',
    format: format || 'auto',
    width: width === '' || width == null ? '' : width,
    rules: Array.isArray(rules) ? rules : [],
  }));

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

  const apply = () => {
    onChange({
      alias: draft.alias,
      format: draft.format,
      width: draft.width,
      rules: draft.rules,
    });
    onClose();
  };

  return (
    <Modal
      open
      modalHeading={`Column: ${column}`}
      modalLabel="Column options"
      primaryButtonText="Apply"
      secondaryButtonText="Cancel"
      onRequestSubmit={apply}
      onSecondarySubmit={onClose}
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
            value={draft.alias}
            onChange={(e) => patch({ alias: e.target.value })}
          />
          <Select
            id={`colopt-${column}-format`}
            labelText="Value format"
            helperText="Compact turns 136365211648 into 127.0G."
            value={draft.format}
            onChange={(e) => patch({ format: e.target.value })}
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
            value={draft.width}
            allowEmpty
            min={1}
            max={2000}
            step={10}
            hideSteppers
            onChange={(_e, { value }) => patch({ width: value })}
          />
        </div>
      </div>

      <div className="column-options-modal__section">
        <h6 className="column-options-modal__section-title">
          Conditional formatting
          {draft.rules.length ? ` (${draft.rules.length})` : ''}
        </h6>
        <ColumnRuleList
          rules={draft.rules}
          onChange={(next) => patch({ rules: next })}
          idPrefix={`colopt-${column}-rule`}
        />
      </div>
    </Modal>
  );
}
