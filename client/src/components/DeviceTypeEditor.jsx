// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import {
  Modal,
  TextInput,
  TextArea,
  Select,
  SelectItem,
  Button,
  InlineNotification,
  Checkbox,
  Tag
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import apiClient from '../api/client';

const CATEGORIES = ['switch', 'light', 'sensor', 'thermostat', 'cover', 'other'];
const PROTOCOLS = ['mqtt', 'websocket-json'];
const CAPABILITY_TYPES = ['binary', 'numeric', 'enum', 'text'];
const CONTROL_UI_TYPES = ['toggle', 'scalar', 'button', 'text', 'plug', 'dimmer'];


function DeviceTypeEditor({ deviceType, onSave, onClose }) {
  const isEdit = !!deviceType;
  const readOnly = deviceType?.is_built_in || false;

  const [id, setId] = useState(deviceType?.id || '');
  const [name, setName] = useState(deviceType?.name || '');
  const [description, setDescription] = useState(deviceType?.description || '');
  const [category, setCategory] = useState(deviceType?.category || 'switch');
  const [subtype, setSubtype] = useState(deviceType?.subtype || '');
  const [protocol, setProtocol] = useState(deviceType?.protocol || 'mqtt');
  const [capabilities, setCapabilities] = useState(deviceType?.capabilities || []);
  const [supportedTypes, setSupportedTypes] = useState(deviceType?.supported_types || []);
  const [commands, setCommands] = useState(deviceType?.commands || {});
  const [stateQuery] = useState(deviceType?.state_query || null);
  const [response, setResponse] = useState(deviceType?.response || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Auto-generate ID from name
  useEffect(() => {
    if (!isEdit && name) {
      setId(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));
    }
  }, [name, isEdit]);

  const addCapability = () => {
    setCapabilities([...capabilities, {
      name: '',
      type: 'binary',
      description: '',
      state_path: ''
    }]);
  };

  const updateCapability = (index, field, value) => {
    const updated = [...capabilities];
    updated[index] = { ...updated[index], [field]: value };
    if (field === 'name' && value) {
      updated[index].state_path = '$.' + value;
    }
    setCapabilities(updated);
  };

  const removeCapability = (index) => {
    setCapabilities(capabilities.filter((_, i) => i !== index));
  };

  const toggleSupportedType = (type) => {
    if (readOnly) return;
    if (supportedTypes.includes(type)) {
      setSupportedTypes(supportedTypes.filter(t => t !== type));
      const newCommands = { ...commands };
      delete newCommands[type];
      setCommands(newCommands);
    } else {
      setSupportedTypes([...supportedTypes, type]);
      setCommands({
        ...commands,
        [type]: { template: {} }
      });
    }
  };

  const updateCommandTemplate = (controlType, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      setCommands({
        ...commands,
        [controlType]: { ...commands[controlType], template: parsed }
      });
    } catch {
      // Allow invalid JSON while editing
    }
  };

  const updateCommandValueMap = (controlType, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      setCommands({
        ...commands,
        [controlType]: { ...commands[controlType], value_map: parsed }
      });
    } catch {
      // Allow invalid JSON while editing
    }
  };

  const handleSave = async () => {
    if (readOnly) return;
    if (!id || !name || !category || !protocol) {
      setError('ID, Name, Category, and Protocol are required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload = {
        name,
        description,
        category,
        subtype,
        protocol,
        capabilities,
        supported_types: supportedTypes,
        commands,
        state_query: stateQuery,
        response
      };

      if (isEdit) {
        await apiClient.updateDeviceType(deviceType.id, payload);
      } else {
        await apiClient.createDeviceType({ id, ...payload });
      }
      onSave();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const modalHeading = readOnly
    ? `Device Type: ${deviceType.name}`
    : isEdit
      ? `Edit Device Type: ${deviceType.name}`
      : 'New Device Type';

  return (
    <Modal
      open
      modalHeading={modalHeading}
      primaryButtonText={readOnly ? 'Close' : saving ? 'Saving...' : 'Save'}
      secondaryButtonText={readOnly ? undefined : 'Cancel'}
      onRequestClose={onClose}
      onRequestSubmit={readOnly ? onClose : handleSave}
      primaryButtonDisabled={saving}
      size="lg"
    >
      {error && (
        <InlineNotification
          kind="error"
          title="Error"
          subtitle={error}
          onClose={() => setError(null)}
          style={{ marginBottom: '1rem' }}
        />
      )}

      <div style={{ display: 'grid', gap: '1rem' }}>
        {/* Basic info */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <TextInput
            id="dt-id"
            labelText="ID"
            value={id}
            onChange={e => setId(e.target.value)}
            disabled={isEdit}
            readOnly={readOnly}
          />
          <TextInput
            id="dt-name"
            labelText="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            readOnly={readOnly}
          />
        </div>

        <TextInput
          id="dt-description"
          labelText="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          readOnly={readOnly}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
          <Select
            id="dt-category"
            labelText="Category"
            value={category}
            onChange={e => setCategory(e.target.value)}
            disabled={readOnly}
          >
            {CATEGORIES.map(c => (
              <SelectItem key={c} value={c} text={c.charAt(0).toUpperCase() + c.slice(1)} />
            ))}
          </Select>
          <TextInput
            id="dt-subtype"
            labelText="Subtype"
            value={subtype}
            onChange={e => setSubtype(e.target.value)}
            placeholder="e.g., plug, dimmer"
            readOnly={readOnly}
          />
          <Select
            id="dt-protocol"
            labelText="Protocol"
            value={protocol}
            onChange={e => setProtocol(e.target.value)}
            disabled={readOnly}
          >
            {PROTOCOLS.map(p => (
              <SelectItem key={p} value={p} text={p} />
            ))}
          </Select>
        </div>

        {/* Capabilities */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--cds-text-primary)' }}>
              Capabilities ({capabilities.length})
            </span>
            {!readOnly && (
              <Button kind="ghost" size="sm" renderIcon={Add} onClick={addCapability}>
                Add Capability
              </Button>
            )}
          </div>

          {capabilities.map((cap, index) => (
            <div
              key={index}
              style={{
                display: 'grid',
                gridTemplateColumns: readOnly ? '2fr 1fr' : '2fr 1fr auto',
                gap: '0.5rem',
                marginBottom: '0.5rem',
                alignItems: 'end'
              }}
            >
              <TextInput
                id={`cap-name-${index}`}
                labelText={index === 0 ? 'Name' : ''}
                size="sm"
                value={cap.name}
                onChange={e => updateCapability(index, 'name', e.target.value)}
                placeholder="state, brightness..."
                readOnly={readOnly}
              />
              <Select
                id={`cap-type-${index}`}
                labelText={index === 0 ? 'Type' : ''}
                size="sm"
                value={cap.type}
                onChange={e => updateCapability(index, 'type', e.target.value)}
                disabled={readOnly}
              >
                {CAPABILITY_TYPES.map(t => (
                  <SelectItem key={t} value={t} text={t} />
                ))}
              </Select>
              {!readOnly && (
                <Button
                  kind="ghost"
                  size="sm"
                  hasIconOnly
                  renderIcon={TrashCan}
                  iconDescription="Remove"
                  onClick={() => removeCapability(index)}
                />
              )}
            </div>
          ))}
        </div>

        {/* Command Protocol Section — always visible */}
        <div>
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--cds-text-primary)', display: 'block', marginBottom: '0.5rem' }}>
            Command Protocol ({supportedTypes.length} control types)
          </span>

          {/* Supported control types */}
          <div style={{ marginBottom: '1rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)', display: 'block', marginBottom: '0.5rem' }}>
              Supported Control Types
            </span>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              {CONTROL_UI_TYPES.map(type => (
                <Checkbox
                  key={type}
                  id={`supported-type-${type}`}
                  labelText={type}
                  checked={supportedTypes.includes(type)}
                  onChange={() => toggleSupportedType(type)}
                  disabled={readOnly}
                />
              ))}
            </div>
          </div>

          {/* Command templates per supported type */}
          {supportedTypes.map(type => (
            <div key={type} style={{ borderLeft: '2px solid var(--cds-border-subtle-01)', paddingLeft: '1rem', marginBottom: '0.75rem' }}>
              <Tag type="blue" size="sm" style={{ marginBottom: '0.5rem' }}>{type}</Tag>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <TextArea
                  id={`cmd-template-${type}`}
                  labelText="Command Template (JSON)"
                  value={JSON.stringify(commands[type]?.template || {}, null, 2)}
                  onChange={e => updateCommandTemplate(type, e.target.value)}
                  rows={3}
                  placeholder='{"state": "{{value}}"}'
                  helperText="Use {{value}} and {{target}} placeholders"
                  readOnly={readOnly}
                />
                <TextArea
                  id={`cmd-valuemap-${type}`}
                  labelText="Value Map (JSON, optional)"
                  value={commands[type]?.value_map ? JSON.stringify(commands[type].value_map, null, 2) : ''}
                  onChange={e => updateCommandValueMap(type, e.target.value)}
                  rows={3}
                  placeholder='{"true": "ON", "false": "OFF"}'
                  helperText="Map control values to protocol values"
                  readOnly={readOnly}
                />
              </div>
            </div>
          ))}

          {supportedTypes.length === 0 && (
            <div style={{ color: 'var(--cds-text-secondary)', fontSize: '0.875rem', fontStyle: 'italic' }}>
              No control types configured. Check the boxes above to add command templates.
            </div>
          )}

          {/* Response parsing */}
          <div style={{ marginTop: '0.75rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)', display: 'block', marginBottom: '0.5rem' }}>
              Response Parsing (optional)
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <TextInput
                id="dt-response-state-path"
                labelText="State Path"
                size="sm"
                value={response?.state_path || ''}
                onChange={e => setResponse({ ...response, state_path: e.target.value })}
                placeholder="$.state"
                helperText="JSONPath to state value"
                readOnly={readOnly}
              />
              <TextInput
                id="dt-response-valuemap"
                labelText="Response Value Map (JSON)"
                size="sm"
                value={response?.value_map ? JSON.stringify(response.value_map) : ''}
                onChange={e => {
                  try {
                    const parsed = JSON.parse(e.target.value);
                    setResponse({ ...response, value_map: parsed });
                  } catch { /* allow invalid while editing */ }
                }}
                placeholder='{"ON": true, "OFF": false}'
                readOnly={readOnly}
              />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default DeviceTypeEditor;
