// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';
import { Modal, NumberInput, TextInput, Toggle } from '@carbon/react';

/**
 * Generic editor used by SettingsPage's `handleEdit` fallback when
 * no bespoke modal is registered for the setting key.
 *
 * Auto-detects the right input from `typeof currentValue`:
 *   boolean → Toggle
 *   number  → NumberInput
 *   string  → TextInput
 *
 * Settings that need richer UX (dropdowns of MQTT connections,
 * hierarchical pickers, complex schema validation, etc.) should
 * still ship their own modal — this fallback exists so that adding
 * a primitive setting to `user-configurable.yaml` Just Works without
 * a UI follow-up.
 */
function PrimitiveSettingEditorModal({ open, onClose, setting, onSave }) {
  // Detect kind once on open so the editor doesn't flip if the user
  // is mid-edit and the value happens to round-trip through a
  // different type (e.g. typing "0" into a number field briefly).
  const [kind, setKind] = useState('string');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!open || !setting) return;
    const detected = detectKind(setting.value);
    setKind(detected);
    setValue(setting.value);
  }, [open, setting]);

  if (!setting) return null;

  const handleSubmit = () => {
    let out = value;
    if (kind === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      out = n;
    } else if (kind === 'boolean') {
      out = !!value;
    }
    onSave(out);
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading={setting.key}
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={handleSubmit}
      size="sm"
    >
      <div style={{ padding: '0 0 1rem' }}>
        {setting.description && (
          <p style={{ color: 'var(--cds-text-secondary)', marginBottom: '1rem', fontSize: '0.875rem' }}>
            {setting.description}
          </p>
        )}

        {kind === 'boolean' && (
          <Toggle
            id={`primitive-${setting.key}`}
            labelText="Value"
            labelA="Off"
            labelB="On"
            toggled={!!value}
            onToggle={(checked) => setValue(checked)}
          />
        )}

        {kind === 'number' && (
          <NumberInput
            id={`primitive-${setting.key}`}
            label="Value"
            value={Number(value) || 0}
            onChange={(_e, { value: v }) => {
              const n = Number(v);
              if (Number.isFinite(n)) setValue(n);
            }}
            allowEmpty={false}
            hideSteppers={false}
          />
        )}

        {kind === 'string' && (
          <TextInput
            id={`primitive-${setting.key}`}
            labelText="Value"
            value={value ?? ''}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </div>
    </Modal>
  );
}

/**
 * Pick an editor based on the runtime type of the current value.
 * Falls back to `string` for anything we can't represent with the
 * three primitive inputs (arrays, objects, null) — the caller
 * should usually ship a bespoke editor in those cases, but landing
 * on a TextInput is at least better than the "no editor available"
 * notification.
 */
function detectKind(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  return 'string';
}

export default PrimitiveSettingEditorModal;
