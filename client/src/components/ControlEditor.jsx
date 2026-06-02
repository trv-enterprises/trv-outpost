// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Select,
  SelectItem,
  TextInput,
  NumberInput,
  TextArea,
  Grid,
  Column,
  Tag,
  InlineNotification,
  ComboBox,
  IconButton,
  Loading,
  Modal,
  Button,
  Tooltip,
  Toggletip,
  ToggletipButton,
  ToggletipContent
} from '@carbon/react';
import { Renew, Information } from '@carbon/icons-react';
import Icon from '@mdi/react';
import {
  mdiPowerPlug,
  mdiLightbulbOn,
  mdiLightbulbOutline,
  mdiCeilingFanLight,
  mdiTelevision,
  mdiWaterPump,
  mdiFan,
  mdiPowerSocket,
  mdiGarage,
  mdiGateOpen,
  mdiDoorOpen,
  mdiThermometer
} from '@mdi/js';
import { CONTROL_TYPES, CONTROL_TYPE_INFO, CONTROL_CATEGORIES } from './controls';
import { DISPLAY_CONTENT_FORMATS } from './controls/ControlTextLabel';
import apiClient from '../api/client';
import { useEnabledTypes } from '../context/EnabledTypesContext';
import './ControlEditor.scss';

// Available icons for tile/switch controls
const TILE_ICONS = [
  { id: 'power-plug', path: mdiPowerPlug, label: 'Plug' },
  { id: 'lightbulb-on', path: mdiLightbulbOn, label: 'Light (on)' },
  { id: 'lightbulb-outline', path: mdiLightbulbOutline, label: 'Light (outline)' },
  { id: 'ceiling-fan-light', path: mdiCeilingFanLight, label: 'Fan Light' },
  { id: 'fan', path: mdiFan, label: 'Fan' },
  { id: 'television', path: mdiTelevision, label: 'TV' },
  { id: 'water-pump', path: mdiWaterPump, label: 'Pump' },
  { id: 'power-socket', path: mdiPowerSocket, label: 'Outlet' },
  { id: 'garage', path: mdiGarage, label: 'Garage' },
  { id: 'gate-open', path: mdiGateOpen, label: 'Gate' },
  { id: 'door-open', path: mdiDoorOpen, label: 'Door' },
  { id: 'thermometer', path: mdiThermometer, label: 'Thermostat' },
];

// Export for use by tile components
export { TILE_ICONS };

/**
 * ControlEditor Component
 *
 * Editor for configuring control components (buttons, toggles, sliders, text inputs).
 * Used within ComponentEditor when component_type="control".
 */

function PayloadEditor({ payload, onChange }) {
  const [raw, setRaw] = useState(JSON.stringify(payload || {}, null, 2));
  const [error, setError] = useState(null);

  useEffect(() => {
    setRaw(JSON.stringify(payload || {}, null, 2));
  }, [payload]);

  const handleBlur = () => {
    try {
      const parsed = JSON.parse(raw);
      setError(null);
      onChange(parsed);
    } catch {
      setError('Invalid JSON');
    }
  };

  return (
    <TextArea
      id="ui-payload"
      labelText="JSON Payload"
      value={raw}
      onChange={(e) => { setRaw(e.target.value); setError(null); }}
      onBlur={handleBlur}
      placeholder='{"type": "alert", "camera": "front_door"}'
      helperText={error || 'Static JSON payload to publish when the button is pressed'}
      invalid={!!error}
      invalidText={error}
      rows={6}
    />
  );
}

function ControlEditor({
  controlConfig,
  connectionId,
  displayTitle,
  onControlConfigChange,
  onConnectionIdChange
}) {
  const { isControlTypeEnabled } = useEnabledTypes();
  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [connections, setConnections] = useState([]);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [mqttTopics, setMqttTopics] = useState([]);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [mqttDeviceTypes, setMqttDeviceTypes] = useState([]);

  // Extract config values with defaults
  const controlType = controlConfig?.control_type || CONTROL_TYPES.BUTTON;
  const commandConfig = controlConfig?.command_config || {};
  const uiConfig = controlConfig?.ui_config || {};

  // Detect MQTT connection
  const isMQTT = selectedConnection?.type === 'mqtt';

  // Check if this control type needs a connection (decorative types don't).
  // Default to TRUE when typeInfo is missing so legacy/unknown control types
  // still get the connection dropdown — better than stranding the user with
  // an un-editable component.
  const typeInfo = CONTROL_TYPE_INFO[controlType];
  const needsConnection = typeInfo ? (typeInfo.canWrite || typeInfo.canRead) : true;

  // If we already have a connectionId, fetch that connection immediately for fast display
  useEffect(() => {
    if (connectionId && !selectedConnection) {
      apiClient.getConnection(connectionId)
        .then(conn => setSelectedConnection(conn))
        .catch(() => {});
    }
  }, [connectionId]);

  // Fetch all writable connections for the dropdown
  useEffect(() => {
    if (!needsConnection) return;
    const fetchConnections = async () => {
      try {
        setLoadingConnections(true);
        // For read-only controls, fetch all readable connections; for writable, fetch writable
        const response = typeInfo?.canWrite
          ? await apiClient.getWritableConnections()
          : await apiClient.getConnections();
        const connList = response.connections || [];
        const filtered = typeInfo?.canWrite
          ? connList
          : connList.filter(c => c.capabilities?.can_read || c.capabilities?.can_stream);
        setConnections(filtered);
      } catch (err) {
        console.error('Failed to fetch connections:', err);
      } finally {
        setLoadingConnections(false);
      }
    };
    fetchConnections();

    // Fetch available MQTT device types (for command templates)
    apiClient.getDeviceTypes({ protocol: 'mqtt' })
      .then(result => setMqttDeviceTypes(result?.device_types || []))
      .catch(() => setMqttDeviceTypes([]));
  }, [needsConnection]);

  // Update selected connection when connections list loads (if not already set)
  useEffect(() => {
    if (connectionId && connections.length > 0 && !selectedConnection) {
      const conn = connections.find(c => c.id === connectionId);
      if (conn) setSelectedConnection(conn);
    }
  }, [connectionId, connections]);

  const fetchMQTTTopics = async () => {
    if (!connectionId) return;
    try {
      setLoadingTopics(true);
      const response = await apiClient.getMQTTTopics(connectionId);
      const allTopics = response.topics || [];
      // Filter out Zigbee2MQTT internals and command topics
      const filtered = allTopics.filter(t => {
        const topic = typeof t === 'string' ? t : t.topic;
        if (topic.includes('/bridge/')) return false;
        if (topic.endsWith('/set')) return false;
        if (topic.endsWith('/get')) return false;
        if (topic.endsWith('/availability')) return false;
        return true;
      });
      setMqttTopics(filtered.map(t => typeof t === 'string' ? t : t.topic));
    } catch (err) {
      console.error('Failed to fetch MQTT topics:', err);
      setMqttTopics([]);
    } finally {
      setLoadingTopics(false);
    }
  };

  // Fetch MQTT topics when an MQTT connection is selected
  useEffect(() => {
    if (!isMQTT || !connectionId) {
      setMqttTopics([]);
      return;
    }
    fetchMQTTTopics();
  }, [connectionId, isMQTT]);

  // Whether this control type uses the raw topic (no /set suffix)
  const usesRawTopic = controlType === CONTROL_TYPES.MQTT_PUBLISH || !typeInfo?.canWrite;

  // Track the ComboBox selection independently from the target field.
  // This prevents circular updates when manually editing the Command Target.
  const [comboBoxTopic, setComboBoxTopic] = useState(null);

  // Sync comboBoxTopic when topics finish loading and we have an existing target
  useEffect(() => {
    if (mqttTopics.length === 0) return;
    const target = controlConfig?.target || '';
    if (!target) return;
    const base = usesRawTopic ? target : (target.endsWith('/set') ? target.slice(0, -4) : target);
    if (mqttTopics.includes(base)) {
      setComboBoxTopic(base);
    }
  }, [mqttTopics, controlConfig?.target, usesRawTopic]);

  // Handle MQTT topic selection from ComboBox — sets target
  const handleTopicSelect = (topic) => {
    setComboBoxTopic(topic || null);
    if (!topic) {
      const newConfig = { ...controlConfig };
      delete newConfig.target;
      delete newConfig.device_type_id;
      delete newConfig.command_config;
      onControlConfigChange(newConfig);
      return;
    }
    // For mqtt_publish and read-only controls, use the topic directly.
    // For standard writable controls, append /set (Zigbee2MQTT convention).
    const target = usesRawTopic ? topic : `${topic}/set`;
    const newConfig = {
      ...controlConfig,
      target,
      command_config: null
    };
    onControlConfigChange(newConfig);
  };

  // Handle MQTT device type selection
  const handleDeviceTypeSelect = (deviceTypeId) => {
    const newConfig = { ...controlConfig };
    if (deviceTypeId) {
      newConfig.device_type_id = deviceTypeId;
      newConfig.command_config = null; // Device type handles commands
    } else {
      delete newConfig.device_type_id;
    }
    onControlConfigChange(newConfig);
  };

  // Get payload preview from the selected device type
  const getPayloadPreview = () => {
    if (!controlConfig?.device_type_id) return null;
    const dt = mqttDeviceTypes.find(d => d.id === controlConfig.device_type_id);
    if (!dt?.commands) return null;

    // Find the command definition for the current control type, or the first available
    const cmdDef = dt.commands[controlType] || Object.values(dt.commands)[0];
    if (!cmdDef?.template) return null;

    const template = cmdDef.template;
    const valueMap = cmdDef.value_map || {};

    // Build ON/OFF or value previews
    const previews = [];
    if (valueMap['true'] !== undefined && valueMap['false'] !== undefined) {
      const onPayload = { ...template };
      const offPayload = { ...template };
      for (const key of Object.keys(template)) {
        if (template[key] === '{{value}}') {
          onPayload[key] = valueMap['true'];
          offPayload[key] = valueMap['false'];
        }
      }
      previews.push({ label: `${valueMap['true']} payload`, payload: onPayload });
      previews.push({ label: `${valueMap['false']} payload`, payload: offPayload });
    } else {
      previews.push({ label: 'Payload template', payload: template });
    }
    return previews;
  };

  // Helper to update control config
  const updateConfig = (field, value) => {
    const newConfig = {
      ...controlConfig,
      [field]: value
    };
    onControlConfigChange(newConfig);
  };

  // Helper to update command config
  const updateCommandConfig = (field, value) => {
    const newCommandConfig = {
      ...commandConfig,
      [field]: value
    };
    updateConfig('command_config', newCommandConfig);
  };

  // Helper to update UI config
  const updateUIConfig = (field, value) => {
    const newUIConfig = {
      ...uiConfig,
      [field]: value
    };
    updateConfig('ui_config', newUIConfig);
  };

  // Handle control type change - reset UI config to defaults
  const handleControlTypeChange = (newType) => {
    const typeInfo = CONTROL_TYPE_INFO[newType];
    const newConfig = {
      ...controlConfig,
      control_type: newType,
      ui_config: typeInfo?.defaultUIConfig || {}
    };
    onControlConfigChange(newConfig);
  };

  // Parse payload template from JSON string
  const _parsePayloadTemplate = (jsonStr) => {
    try {
      return JSON.parse(jsonStr);
    } catch {
      return {};
    }
  };

  // Stringify payload template for editing
  const stringifyPayloadTemplate = (template) => {
    return JSON.stringify(template || {}, null, 2);
  };

  return (
    <div className="control-editor">
      {/* Control Type Selection — compact display + modal */}
      <div className="control-type-section">
        <h4>Control Type</h4>
        <div className="control-type-current" onClick={() => setTypeModalOpen(true)}>
          <Button kind="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setTypeModalOpen(true); }}>
            Change
          </Button>
          {typeInfo?.icon && <Icon path={typeInfo.icon} size={1} className="current-type-icon" />}
          <div className="current-type-info">
            <span className="current-type-label">{typeInfo?.label || controlType}</span>
            <span className="current-type-description">{typeInfo?.description || ''}</span>
          </div>
        </div>
      </div>

      {/* Control Type Selection Modal — portaled to body to escape parent modal */}
      {typeModalOpen && createPortal(
        <Modal
          open
          onRequestClose={() => setTypeModalOpen(false)}
          onRequestSubmit={() => setTypeModalOpen(false)}
          modalHeading="Select Control Type"
          primaryButtonText="Close"
          size="md"
          className="control-type-modal"
        >
          <div className="control-type-modal-body">
            {Object.entries(CONTROL_CATEGORIES).map(([catId, catInfo]) => {
              // Filter out admin-disabled control types (the active type is
              // always shown so editing existing controls still works).
              const typesInCategory = Object.entries(CONTROL_TYPE_INFO)
                .filter(([type, info]) =>
                  info.category === catId &&
                  !info.hidden &&
                  (isControlTypeEnabled(type) || type === controlType)
                );
              if (typesInCategory.length === 0) return null;
              return (
                <div key={catId} className="control-type-category">
                  <h5 className="category-label">{catInfo.label}</h5>
                  <div className="category-grid">
                    {typesInCategory.map(([type, info]) => (
                      <div
                        key={type}
                        className={`control-type-option ${controlType === type ? 'selected' : ''}`}
                        onClick={() => { handleControlTypeChange(type); setTypeModalOpen(false); }}
                      >
                        {info.icon && <Icon path={info.icon} size={0.9} className="type-icon" />}
                        <div className="type-label">{info.label}</div>
                        <div className="type-description">{info.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Modal>,
        document.body
      )}

      {/* Connection & Command — hidden for decorative controls.
          Connection block mirrors the chart-page Connection picker:
          h4 header + (i) hover Tooltip exposing the description,
          then the Select with its label hidden (the h4 IS the
          label), then a tag-chip row beneath (type chip + user
          tags). Same .connection-tags-row / .connection-picker-*
          styles from ComponentEditor.scss. */}
      {needsConnection && <><div className="connection-section">
        <div className="connection-picker-header">
          <h4>Connection</h4>
          {selectedConnection?.description && (
            <Tooltip
              align="bottom"
              label={selectedConnection.description}
              className="connection-picker-info-tooltip"
            >
              <button
                type="button"
                className="connection-picker-info-trigger"
                aria-label="Connection description"
              >
                <Information size={16} />
              </button>
            </Tooltip>
          )}
        </div>
        <Select
          id="control-connection"
          labelText=""
          hideLabel
          value={connectionId || ''}
          onChange={(e) => onConnectionIdChange(e.target.value)}
          disabled={loadingConnections}
          helperText="Select a connection that supports write operations"
        >
          <SelectItem value="" text={loadingConnections ? 'Loading...' : 'Select a connection...'} />
          {connections.map(conn => (
            <SelectItem
              key={conn.id}
              value={conn.id}
              text={`${conn.name} (${conn.type})`}
            />
          ))}
        </Select>
        {selectedConnection && (() => {
          const userTags = Array.isArray(selectedConnection.tags) ? selectedConnection.tags : [];
          const chips = [
            { label: selectedConnection.type, kind: 'type' },
            ...userTags.map(t => ({ label: t, kind: 'user' })),
          ];
          const VISIBLE_TAG_CAP = 4;
          const visible = chips.slice(0, VISIBLE_TAG_CAP);
          const overflow = chips.slice(VISIBLE_TAG_CAP);
          return (
            <div className="connection-tags-row">
              {visible.map((chip, i) => (
                <Tag
                  key={`${chip.kind}-${chip.label}-${i}`}
                  type={chip.kind === 'type' ? 'blue' : 'gray'}
                  size="sm"
                >
                  {chip.label}
                </Tag>
              ))}
              {overflow.length > 0 && (
                <Toggletip align="bottom">
                  <ToggletipButton label={`Show ${overflow.length} more tag${overflow.length === 1 ? '' : 's'}`}>
                    <span className="connection-tags-overflow">+{overflow.length}…</span>
                  </ToggletipButton>
                  <ToggletipContent>
                    <p>{chips.map(c => c.label).join(', ')}</p>
                  </ToggletipContent>
                </Toggletip>
              )}
            </div>
          );
        })()}

        {connections.length === 0 && !loadingConnections && (
          <InlineNotification
            kind="warning"
            title="No writable connections"
            subtitle="Create a bidirectional connection (like WebSocket) to use controls"
            lowContrast
            hideCloseButton
          />
        )}
      </div>

      {/* Command Configuration. Stacked rows inside the tile —
          the prior Carbon Grid `Column lg={8|1|3}` layout truncated
          the Device Topic combobox at narrow tile widths. Three
          natural rows now: Device Topic (with refresh) → Device
          Type → Command Target. Each row fills the tile width. */}
      <div className="command-section">
        <h4>Command Configuration</h4>
        {!connectionId ? (
          // No connection selected yet — the right fields to show
          // here depend on the connection's type (MQTT gets device
          // topic / device type / command target; other types get
          // the generic action / target / payload form). Defer the
          // form until the user picks a connection.
          <p className="editor-info-hint">Select a connection first.</p>
        ) : isMQTT ? (
          <div className="control-form-stack">
            <div className="control-form-row">
              <div className="control-form-row__main">
                <ComboBox
                  id="mqtt-topic-select"
                  titleText="Device Topic"
                  items={mqttTopics}
                  itemToString={(item) => item || ''}
                  selectedItem={comboBoxTopic}
                  onChange={({ selectedItem }) => handleTopicSelect(selectedItem)}
                  placeholder={loadingTopics ? 'Loading topics...' : 'Select a device topic...'}
                  disabled={loadingTopics}
                  helperText={usesRawTopic
                    ? 'Select a topic to pre-fill the publish topic below'
                    : 'Select a device state topic to auto-fill the command target'}
                />
              </div>
              <div className="control-form-row__action">
                <IconButton
                  label="Refresh topics"
                  kind="ghost"
                  onClick={fetchMQTTTopics}
                  disabled={loadingTopics}
                >
                  {loadingTopics ? <Loading small withOverlay={false} /> : <Renew />}
                </IconButton>
              </div>
            </div>
            {!usesRawTopic && (
              <Select
                id="mqtt-device-type-select"
                labelText="Device Type"
                value={controlConfig?.device_type_id || ''}
                onChange={(e) => handleDeviceTypeSelect(e.target.value || null)}
                helperText="Optional — defines payload format"
              >
                <SelectItem value="" text="None (manual payload)" />
                {mqttDeviceTypes.map(dt => (
                  <SelectItem key={dt.id} value={dt.id} text={dt.name} />
                ))}
              </Select>
            )}
            <TextInput
              id="mqtt-command-target"
              labelText={usesRawTopic ? 'Publish Topic' : 'Command Target (topic)'}
              value={controlConfig?.target || ''}
              onChange={(e) => updateConfig('target', e.target.value)}
              placeholder={usesRawTopic ? 'e.g., zigbee2mqtt/Small Garage Door' : 'e.g., zigbee2mqtt/device/set or caseta/device'}
              helperText={usesRawTopic ? 'MQTT topic to publish to — edit freely after selecting from above' : 'MQTT topic to publish commands to'}
            />
            {controlType !== CONTROL_TYPES.MQTT_PUBLISH && controlConfig?.device_type_id && (() => {
              const previews = getPayloadPreview();
              if (!previews) return null;
              return (
                <div className="mqtt-schema-info">
                  <Tag type="teal">Device Type: {controlConfig.device_type_id}</Tag>
                  <div className="payload-preview">
                    {previews.map((p, i) => (
                      <span key={i}>
                        <span className="payload-label">{p.label}:</span>
                        <code>{JSON.stringify(p.payload)}</code>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="control-form-stack">
            <div className="control-form-row">
              <div className="control-form-row__half">
                <TextInput
                  id="command-action"
                  labelText="Action"
                  value={commandConfig.action || ''}
                  onChange={(e) => updateCommandConfig('action', e.target.value)}
                  placeholder="set, toggle, send, execute..."
                  helperText="The command action to perform"
                />
              </div>
              <div className="control-form-row__half">
                <TextInput
                  id="command-target"
                  labelText="Target (optional)"
                  value={commandConfig.target || ''}
                  onChange={(e) => updateCommandConfig('target', e.target.value)}
                  placeholder="device_id, channel, topic..."
                  helperText="Optional target identifier"
                />
              </div>
            </div>
            <TextArea
              id="command-payload-template"
              labelText="Payload Template (JSON)"
              value={stringifyPayloadTemplate(commandConfig.payload_template)}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  updateCommandConfig('payload_template', parsed);
                } catch {
                  // Allow invalid JSON while editing
                }
              }}
              placeholder='{"value": "{{value}}", "timestamp": "{{value}}"}'
              helperText='Use {{value}} as placeholder for the control value'
              rows={4}
            />
          </div>
        )}
      </div></>}

      {/* UI Configuration - varies by control type */}
      <div className="ui-config-section">
        <h4>UI Configuration</h4>
        <Grid narrow>
          {/* MQTT Publish UI Config */}
          {controlType === CONTROL_TYPES.MQTT_PUBLISH && (
            <>
              <Column lg={6} md={4} sm={4}>
                <TextInput
                  id="ui-label"
                  labelText="Button Label"
                  value={uiConfig.label || ''}
                  onChange={(e) => updateUIConfig('label', e.target.value)}
                  placeholder="Publish"
                />
              </Column>
              <Column lg={6} md={4} sm={4}>
                <Select
                  id="ui-kind"
                  labelText="Button Style"
                  value={uiConfig.kind || 'primary'}
                  onChange={(e) => updateUIConfig('kind', e.target.value)}
                >
                  <SelectItem value="primary" text="Primary (Blue)" />
                  <SelectItem value="secondary" text="Secondary (Gray)" />
                  <SelectItem value="danger" text="Danger (Red)" />
                  <SelectItem value="ghost" text="Ghost (Transparent)" />
                </Select>
              </Column>
              <Column lg={12} md={8} sm={4}>
                <PayloadEditor
                  payload={uiConfig.payload}
                  onChange={(parsed) => updateUIConfig('payload', parsed)}
                />
              </Column>
            </>
          )}

          {/* Button UI Config */}
          {controlType === CONTROL_TYPES.BUTTON && (
            <>
              <Column lg={6} md={4} sm={4}>
                <TextInput
                  id="ui-label"
                  labelText="Button Label"
                  value={uiConfig.label || ''}
                  onChange={(e) => updateUIConfig('label', e.target.value)}
                  placeholder="Execute"
                />
              </Column>
              <Column lg={6} md={4} sm={4}>
                <Select
                  id="ui-kind"
                  labelText="Button Style"
                  value={uiConfig.kind || 'primary'}
                  onChange={(e) => updateUIConfig('kind', e.target.value)}
                >
                  <SelectItem value="primary" text="Primary (Blue)" />
                  <SelectItem value="secondary" text="Secondary (Gray)" />
                  <SelectItem value="danger" text="Danger (Red)" />
                  <SelectItem value="ghost" text="Ghost (Transparent)" />
                </Select>
              </Column>
            </>
          )}

          {/* Toggle UI Config */}
          {controlType === CONTROL_TYPES.TOGGLE && (
            <>
              <Column lg={6} md={4} sm={4}>
                <TextInput
                  id="ui-label"
                  labelText="On Label"
                  value={uiConfig.label || ''}
                  onChange={(e) => updateUIConfig('label', e.target.value)}
                  placeholder="Enable"
                />
              </Column>
              <Column lg={6} md={4} sm={4}>
                <TextInput
                  id="ui-off-label"
                  labelText="Off Label"
                  value={uiConfig.offLabel || ''}
                  onChange={(e) => updateUIConfig('offLabel', e.target.value)}
                  placeholder="Disable"
                />
              </Column>
            </>
          )}

          {/* Slider UI Config */}
          {controlType === CONTROL_TYPES.SLIDER && (
            <>
              <Column lg={4} md={4} sm={4}>
                <TextInput
                  id="ui-label"
                  labelText="Label"
                  value={uiConfig.label || ''}
                  onChange={(e) => updateUIConfig('label', e.target.value)}
                  placeholder="Value"
                />
              </Column>
              <Column lg={4} md={4} sm={4}>
                <NumberInput
                  id="ui-min"
                  label="Minimum"
                  value={uiConfig.min ?? 0}
                  onChange={(e, { value }) => updateUIConfig('min', value)}
                  min={-1000000}
                  max={1000000}
                />
              </Column>
              <Column lg={4} md={4} sm={4}>
                <NumberInput
                  id="ui-max"
                  label="Maximum"
                  value={uiConfig.max ?? 100}
                  onChange={(e, { value }) => updateUIConfig('max', value)}
                  min={-1000000}
                  max={1000000}
                />
              </Column>
              <Column lg={4} md={4} sm={4}>
                <NumberInput
                  id="ui-step"
                  label="Step"
                  value={uiConfig.step ?? 1}
                  onChange={(e, { value }) => updateUIConfig('step', value)}
                  min={0.001}
                  max={1000}
                  step={0.001}
                />
              </Column>
            </>
          )}

          {/* Switch UI Config */}
          {controlType === CONTROL_TYPES.SWITCH && (
            <>
              <Column lg={4} md={4} sm={4}>
                <TextInput
                  id="ui-on-label"
                  labelText="On Label"
                  value={uiConfig.onLabel || ''}
                  onChange={(e) => updateUIConfig('onLabel', e.target.value)}
                  placeholder="On"
                />
              </Column>
              <Column lg={4} md={4} sm={4}>
                <TextInput
                  id="ui-off-label"
                  labelText="Off Label"
                  value={uiConfig.offLabel || ''}
                  onChange={(e) => updateUIConfig('offLabel', e.target.value)}
                  placeholder="Off"
                />
              </Column>
            </>
          )}

          {/* Dimmer UI Config */}
          {controlType === CONTROL_TYPES.DIMMER && (
            <>
              <Column lg={3} md={2} sm={4}>
                <NumberInput
                  id="ui-min"
                  label="Min"
                  value={uiConfig.min ?? 0}
                  onChange={(e, { value }) => updateUIConfig('min', value)}
                  min={0}
                  max={999}
                  step={1}
                />
              </Column>
              <Column lg={3} md={2} sm={4}>
                <NumberInput
                  id="ui-max"
                  label="Max"
                  value={uiConfig.max ?? 100}
                  onChange={(e, { value }) => updateUIConfig('max', value)}
                  min={1}
                  max={1000}
                  step={1}
                />
              </Column>
              <Column lg={2} md={2} sm={4}>
                <NumberInput
                  id="ui-step"
                  label="Step"
                  value={uiConfig.step ?? 1}
                  onChange={(e, { value }) => updateUIConfig('step', value)}
                  min={1}
                  max={100}
                  step={1}
                />
              </Column>
            </>
          )}

          {/* Tile Switch UI Config */}
          {controlType === CONTROL_TYPES.TILE_SWITCH && (
            <>
              <Column lg={12} md={8} sm={4}>
                <div className="icon-selector">
                  <span className="icon-selector-label">Icon</span>
                  <div className="icon-selector-grid">
                    {TILE_ICONS.map(icon => (
                      <div
                        key={icon.id}
                        className={`icon-option ${(uiConfig.icon || 'power-plug') === icon.id ? 'selected' : ''}`}
                        onClick={() => updateUIConfig('icon', icon.id)}
                        title={icon.label}
                      >
                        <Icon path={icon.path} size={0.9} />
                      </div>
                    ))}
                  </div>
                </div>
              </Column>
            </>
          )}

          {/* Tile Dimmer UI Config */}
          {controlType === CONTROL_TYPES.TILE_DIMMER && (
            <>
              <Column lg={12} md={8} sm={4}>
                <div className="icon-selector">
                  <span className="icon-selector-label">Icon</span>
                  <div className="icon-selector-grid">
                    {TILE_ICONS.map(icon => (
                      <div
                        key={icon.id}
                        className={`icon-option ${(uiConfig.icon || 'lightbulb-on') === icon.id ? 'selected' : ''}`}
                        onClick={() => updateUIConfig('icon', icon.id)}
                        title={icon.label}
                      >
                        <Icon path={icon.path} size={0.9} />
                      </div>
                    ))}
                  </div>
                </div>
              </Column>
              <Column lg={3} md={2} sm={4}>
                <NumberInput
                  id="ui-min"
                  label="Min"
                  value={uiConfig.min ?? 0}
                  onChange={(e, { value }) => updateUIConfig('min', value)}
                  min={0}
                  max={999}
                  step={1}
                />
              </Column>
              <Column lg={3} md={2} sm={4}>
                <NumberInput
                  id="ui-max"
                  label="Max"
                  value={uiConfig.max ?? 100}
                  onChange={(e, { value }) => updateUIConfig('max', value)}
                  min={1}
                  max={1000}
                  step={1}
                />
              </Column>
              <Column lg={2} md={2} sm={4}>
                <NumberInput
                  id="ui-step"
                  label="Step"
                  value={uiConfig.step ?? 1}
                  onChange={(e, { value }) => updateUIConfig('step', value)}
                  min={1}
                  max={100}
                  step={1}
                />
              </Column>
            </>
          )}

          {/* Text Label UI Config */}
          {controlType === CONTROL_TYPES.TEXT_LABEL && (() => {
            const now = new Date();
            const titlePreview = displayTitle || '(empty)';
            const contentItems = Object.entries(DISPLAY_CONTENT_FORMATS)
              // dashboard_variable is a dashboard-panel-only content type; a
              // control has no dashboard variable, so don't offer it here.
              .filter(([, def]) => !def.dashboardVariable)
              .map(([id, def]) => ({
                id,
                text: def.isDateTime ? def.format(now) : titlePreview
              }));
            return (
              <>
                <Column lg={4} md={4} sm={4}>
                  <Select
                    id="ui-display-content"
                    labelText="Display Content"
                    value={uiConfig.display_content || 'title'}
                    onChange={(e) => updateUIConfig('display_content', e.target.value)}
                  >
                    {contentItems.map(item => (
                      <SelectItem key={item.id} value={item.id} text={item.text} />
                    ))}
                  </Select>
                </Column>
                <Column lg={4} md={2} sm={4}>
                  <Select
                    id="ui-size"
                    labelText="Text Size"
                    value={uiConfig.size || 'md'}
                    onChange={(e) => updateUIConfig('size', e.target.value)}
                  >
                    <SelectItem value="sm" text="Small" />
                    <SelectItem value="md" text="Medium" />
                    <SelectItem value="lg" text="Large" />
                    <SelectItem value="xl" text="Extra Large" />
                  </Select>
                </Column>
                <Column lg={4} md={2} sm={4}>
                  <Select
                    id="ui-align"
                    labelText="Alignment"
                    value={uiConfig.align || 'center'}
                    onChange={(e) => updateUIConfig('align', e.target.value)}
                  >
                    <SelectItem value="left" text="Left" />
                    <SelectItem value="center" text="Center" />
                    <SelectItem value="right" text="Right" />
                  </Select>
                </Column>
              </>
            );
          })()}

          {/* Text Input UI Config */}
          {controlType === CONTROL_TYPES.TEXT_INPUT && (
            <>
              <Column lg={4} md={4} sm={4}>
                <TextInput
                  id="ui-label"
                  labelText="Label"
                  value={uiConfig.label || ''}
                  onChange={(e) => updateUIConfig('label', e.target.value)}
                  placeholder="Command"
                />
              </Column>
              <Column lg={4} md={4} sm={4}>
                <TextInput
                  id="ui-placeholder"
                  labelText="Placeholder"
                  value={uiConfig.placeholder || ''}
                  onChange={(e) => updateUIConfig('placeholder', e.target.value)}
                  placeholder="Enter value..."
                />
              </Column>
              <Column lg={4} md={4} sm={4}>
                <TextInput
                  id="ui-submit-label"
                  labelText="Submit Button Label"
                  value={uiConfig.submitLabel || ''}
                  onChange={(e) => updateUIConfig('submitLabel', e.target.value)}
                  placeholder="Send"
                />
              </Column>
            </>
          )}
        </Grid>
      </div>
    </div>
  );
}

export default ControlEditor;
