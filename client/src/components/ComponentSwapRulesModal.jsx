// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import {
  Modal,
  Select,
  SelectItem,
  TextInput,
  Button,
  IconButton,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import ComponentPickerModal from './ComponentPickerModal';
import './ComponentSwapRulesModal.scss';

/**
 * ComponentSwapRulesModal — author per-panel component-swap rules.
 *
 * A panel renders its DEFAULT component unless one of its rules matches the
 * active dashboard-variable value, in which case that rule's component renders
 * instead (and, for a connection_swap variable, reads from the selected
 * connection). Rules are evaluated top-to-bottom, first match wins.
 *
 * Each rule is a predicate over the active variable:
 *   subject "variable" — tests the variable's effective VALUE string (for
 *     connection_swap that's the selected connection's display value — its
 *     label-tag-prefix value, else its NAME; for a filter variable it's the
 *     filter value).
 *   subject "tag" — tests the VALUE part of the selected connection's prefixed
 *     tags (connection_swap variables only; hidden for filter variables).
 *   op "eq" (exact) | "contains" (substring); value = the operand string.
 *
 * This replaces the former per-panel "Pin connection" toggle.
 *
 * @param {boolean}  open
 * @param {Function} onClose
 * @param {Function} onSave            ({ component_id, component_overrides }) => void
 * @param {object}   panel             the panel being edited
 * @param {object}   chartsMap         id → component (for labeling chosen components)
 * @param {string}   variableMode      'connection_swap' | 'filter' (the active variable)
 * @param {string}   variableLabel     display label of the active variable (for help text)
 */
function ComponentSwapRulesModal({
  open,
  onClose,
  onSave,
  panel,
  chartsMap = {},
  variableMode = 'connection_swap',
  variableLabel = 'variable',
}) {
  // Local draft. defaultComponentId = the panel's base component; rules = the
  // override list. Seeded from the panel each time the modal opens.
  const [defaultComponentId, setDefaultComponentId] = useState('');
  const [rules, setRules] = useState([]);
  // Which slot is currently picking a component: 'default' | rule index | null.
  const [pickingFor, setPickingFor] = useState(null);
  // A live cache of components chosen in this session that aren't yet in
  // chartsMap, so we can label them immediately.
  const [pickedComponents, setPickedComponents] = useState({});

  useEffect(() => {
    if (!open) return;
    setDefaultComponentId(panel?.component_id || '');
    setRules(
      Array.isArray(panel?.component_overrides)
        ? panel.component_overrides.map((o) => ({
            subject: o?.subject === 'tag' ? 'tag' : 'variable',
            op: o?.op === 'contains' ? 'contains' : 'eq',
            value: o?.value || '',
            component_id: o?.component_id || '',
          }))
        : [],
    );
    setPickedComponents({});
    setPickingFor(null);
  }, [open, panel]);

  const tagSubjectAllowed = variableMode === 'connection_swap';

  const componentName = (cid) => {
    if (!cid) return '';
    const c = chartsMap[cid] || pickedComponents[cid];
    // Show the component's NAME (its unique identifier), not its display title —
    // the author is wiring a specific component, so the name disambiguates.
    return c ? (c.name || cid) : cid;
  };

  const addRule = () => {
    setRules((r) => [...r, { subject: 'variable', op: 'eq', value: '', component_id: '' }]);
  };
  const removeRule = (idx) => {
    setRules((r) => r.filter((_, i) => i !== idx));
  };
  const updateRule = (idx, patch) => {
    setRules((r) => r.map((rule, i) => (i === idx ? { ...rule, ...patch } : rule)));
  };

  const handlePicked = (component) => {
    if (!component) { setPickingFor(null); return; }
    setPickedComponents((m) => ({ ...m, [component.id]: component }));
    if (pickingFor === 'default') {
      setDefaultComponentId(component.id);
    } else if (typeof pickingFor === 'number') {
      updateRule(pickingFor, { component_id: component.id });
    }
    setPickingFor(null);
  };

  const handleSave = () => {
    // Keep only complete rules (an operand AND a chosen component); blank-op
    // contains is still valid (matches everything) — but empty value is dropped
    // to avoid an accidental catch-all.
    const cleaned = rules
      .filter((r) => r.component_id && r.value.trim() !== '')
      .map((r) => ({
        subject: r.subject === 'tag' && tagSubjectAllowed ? 'tag' : 'variable',
        op: r.op === 'contains' ? 'contains' : 'eq',
        value: r.value.trim(),
        component_id: r.component_id,
      }));
    onSave?.({
      component_id: defaultComponentId || null,
      component_overrides: cleaned,
    });
    onClose?.();
  };

  return (
    <>
      <Modal
        open={open && pickingFor === null}
        onRequestClose={onClose}
        modalHeading="Connection-based components"
        primaryButtonText="Save"
        secondaryButtonText="Cancel"
        onRequestSubmit={handleSave}
        size="md"
      >
        <div className="component-swap-rules">
          <p className="csr-help">
            This panel shows the <strong>default</strong> component unless a rule
            below matches the active {variableMode === 'filter' ? 'filter value' : 'connection'} for
            the <strong>{variableLabel}</strong> variable. Rules are checked top-to-bottom;
            the first match wins.
          </p>

          {/* DEFAULT row */}
          <div className="csr-row csr-row--default">
            <span className="csr-rule-label">DEFAULT</span>
            <span className="csr-spacer" />
            <Button
              kind="tertiary"
              size="sm"
              onClick={() => setPickingFor('default')}
            >
              {defaultComponentId ? componentName(defaultComponentId) : 'Select component…'}
            </Button>
          </div>

          {/* Rule rows */}
          {rules.map((rule, idx) => (
            <div className="csr-row" key={idx}>
              <Select
                id={`csr-subject-${idx}`}
                labelText=""
                size="sm"
                value={rule.subject}
                onChange={(e) => updateRule(idx, { subject: e.target.value })}
                className="csr-subject"
                hideLabel
              >
                <SelectItem value="variable" text="VARIABLE" />
                {tagSubjectAllowed && <SelectItem value="tag" text="TAG" />}
              </Select>
              <Select
                id={`csr-op-${idx}`}
                labelText=""
                size="sm"
                value={rule.op}
                onChange={(e) => updateRule(idx, { op: e.target.value })}
                className="csr-op"
                hideLabel
              >
                <SelectItem value="eq" text="=" />
                <SelectItem value="contains" text="CONTAINS" />
              </Select>
              <TextInput
                id={`csr-value-${idx}`}
                labelText=""
                size="sm"
                placeholder="value (e.g. PI)"
                value={rule.value}
                onChange={(e) => updateRule(idx, { value: e.target.value })}
                className="csr-value"
                hideLabel
              />
              <Button
                kind="tertiary"
                size="sm"
                onClick={() => setPickingFor(idx)}
                className="csr-component-btn"
              >
                {rule.component_id ? componentName(rule.component_id) : 'Select component…'}
              </Button>
              <IconButton
                kind="ghost"
                size="sm"
                label="Remove rule"
                onClick={() => removeRule(idx)}
              >
                <TrashCan size={16} />
              </IconButton>
            </div>
          ))}

          <Button kind="ghost" size="sm" renderIcon={Add} onClick={addRule} className="csr-add">
            Add rule
          </Button>
        </div>
      </Modal>

      {/* Component picker, reused for the default + each rule. Rendered when a
          slot is picking; closes back to the rules modal on select/cancel. */}
      <ComponentPickerModal
        open={open && pickingFor !== null}
        onClose={() => setPickingFor(null)}
        onSelect={handlePicked}
        category="all"
      />
    </>
  );
}

ComponentSwapRulesModal.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  onSave: PropTypes.func,
  panel: PropTypes.object,
  chartsMap: PropTypes.object,
  variableMode: PropTypes.string,
  variableLabel: PropTypes.string,
};

export default ComponentSwapRulesModal;
