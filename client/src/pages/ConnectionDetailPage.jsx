// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button,
  Loading,
  Modal,
  TextInput,
  Select,
  SelectItem,
  Checkbox,
  NumberInput,
  TextArea,
  Tabs,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  InlineNotification,
  Tag,
  Toggle
} from '@carbon/react';
import { Save, Close, TrashCan, Play, ConnectionSignal, Checkmark, ErrorFilled, ArrowLeft } from '@carbon/icons-react';
import apiClient, { API_BASE } from '../api/client';
import TagInput from '../components/shared/TagInput';
import { invalidateTagsCache } from '../components/shared/tagsApi';
import { useEnabledTypes } from '../context/EnabledTypesContext';
import { useNamespaces } from '../context/NamespaceContext';
import NamespaceSelect from '../components/shared/NamespaceSelect';
import SecretTextInput, { SECRET_MASKED_VALUE } from '../components/shared/SecretTextInput';
import './ConnectionDetailPage.scss';

/**
 * ConnectionDetailPage Component
 *
 * Create/Edit connection with type-specific configuration forms.
 * Supports connection types: SQL, CSV, Socket, API, TSStore, Prometheus, EdgeLake
 */

function ConnectionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isCreateMode = id === 'new';
  const { isConnectionTypeEnabled, enabledConnectionTypes } = useEnabledTypes();

  // The connection editor's Select uses bare legacy names (`sql`, `api`,
  // `csv`, `socket`, `mqtt`, `frigate`, etc.) because those are the values
  // persisted on Datasource.Type. The registry uses dotted IDs (`db.postgres`,
  // `stream.mqtt`, `api.rest`, ...). Each bare name maps to a *family* of
  // dotted IDs — a bare option should appear in the dropdown when at least
  // one member of its family is enabled (or when it has no family mapping
  // and matches a registry ID directly, e.g. `frigate`).
  const familyEnabledFn = (() => {
    const enabledIds = new Set((enabledConnectionTypes || []).map((t) => t.type_id));
    const families = {
      sql: ['db.'],
      api: ['api.rest'],
      csv: ['file.csv'],
      socket: ['stream.tcp', 'stream.websocket', 'stream.websocket-bidir'],
      mqtt: ['stream.mqtt'],
      tsstore: ['store.tsstore'],
      prometheus: ['api.prometheus'],
      edgelake: ['api.edgelake'],
      frigate: ['frigate']
    };
    return (bareName) => {
      const matchers = families[bareName];
      if (!matchers) return isConnectionTypeEnabled(bareName);
      return matchers.some((m) => {
        if (m.endsWith('.')) {
          for (const id of enabledIds) if (id.startsWith(m)) return true;
          return false;
        }
        return enabledIds.has(m);
      });
    };
  })();

  // Wraps Carbon SelectItem so a disabled connection type only renders for
  // the user when (a) we're editing an existing connection of that type
  // (so the form opens to the correct subform), or (b) at least one member
  // of its registry family is enabled.
  const renderConnTypeOption = (value, text, currentType) => {
    if (familyEnabledFn(value) || value === currentType) {
      return <SelectItem key={value} value={value} text={text} />;
    }
    return null;
  };

  const [connection, setConnection] = useState(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const { activeNamespace } = useNamespaces();
  // Create mode seeds from the header's active namespace; edit mode
  // reads from the record once it loads. An empty string here means
  // "not yet resolved" — we only render the Select once we have a real
  // slug so it doesn't briefly show the Carbon empty-state.
  const [namespace, setNamespace] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('sql');
  const [config, setConfig] = useState({});
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(!isCreateMode);
  const [error, setError] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testInput, setTestInput] = useState('{\n  "type": "reading",\n  "data": {\n    "temperature": 23.5,\n    "humidity": 65,\n    "pressure": 1013.25\n  },\n  "timestamp": "2024-01-15T10:30:00Z"\n}');
  // Tracks the user's explicit preset selection. Without this, picking
  // "Custom" while all parser fields are empty would re-derive preset back
  // to "none" on the next render and disable the inputs before the user
  // could type. Reset to null to fall back to value-based detection.
  const [parserPresetOverride, setParserPresetOverride] = useState(null);

  // Test connection state
  const [testing, setTesting] = useState(false);
  const [showTestModal, setShowTestModal] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testSchema, setTestSchema] = useState(null);

  useEffect(() => {
    if (!isCreateMode) {
      fetchConnection();
    } else {
      // Initialize empty config for create mode
      setConfig(getDefaultConfig('sql'));
    }
  }, [id]);

  // In create mode, inherit the header's active namespace whenever it
  // resolves (which may be after the component mounts — context loads
  // async). Only sets if we haven't already picked one.
  useEffect(() => {
    if (isCreateMode && !namespace && activeNamespace) {
      setNamespace(activeNamespace);
    }
  }, [isCreateMode, activeNamespace, namespace]);

  const fetchConnection = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getConnection(id);
      console.log('Connection response:', data);

      setConnection(data);
      setName(data.name);
      setDescription(data.description || '');
      setType(data.type);
      setConfig(data.config || {});
      setTags(data.tags || []);
      setNamespace(data.namespace || 'default');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Check for duplicate connection name on blur
  const checkDuplicateConnectionName = async (nameToCheck) => {
    if (!nameToCheck || !nameToCheck.trim()) {
      setNameError('');
      return;
    }
    try {
      const response = await apiClient.getConnections();
      const connections = response.datasources || response.connections || [];
      const duplicate = connections.find(conn =>
        conn.name.toLowerCase() === nameToCheck.trim().toLowerCase() &&
        conn.id !== id
      );
      if (duplicate) {
        setNameError('A connection with this name already exists');
      } else {
        setNameError('');
      }
    } catch (err) {
      console.error('Error checking connection name:', err);
      setNameError('');
    }
  };

  const getDefaultConfig = (connectionType) => {
    switch (connectionType) {
      case 'sql':
        return {
          sql: {
            driver: 'postgres',
            host: '',
            port: 5432,
            database: '',
            username: '',
            password: '',
            ssl: false,
            max_connections: 10,
            timeout: 30,
            options: ''
          }
        };
      case 'csv':
        return {
          csv: {
            path: '',
            delimiter: ',',
            has_header: true,
            watch_changes: false,
            encoding: 'utf-8'
          }
        };
      case 'socket':
        return {
          socket: {
            url: '',
            protocol: 'websocket',
            reconnect_on_error: true,
            reconnect_delay: 5000,
            ping_interval: 30,
            message_format: 'json',
            buffer_size: 100,
            parser: {
              data_path: '',
              timestamp_field: ''
            }
          }
        };
      case 'api':
        return {
          api: {
            url: '',
            method: 'GET',
            headers: {},
            query_params: {},
            body: '',
            auth_type: 'none',
            auth_credentials: {},
            timeout: 30,
            retry_count: 3,
            retry_delay: 1000,
            data_path: ''
          }
        };
      case 'tsstore':
        return {
          tsstore: {
            transport: 'rest',
            protocol: 'http',
            host: '',
            port: 21080,
            store_name: '',
            api_key: '',
            timeout: 30
          }
        };
      case 'prometheus':
        return {
          prometheus: {
            url: '',
            username: '',
            password: '',
            timeout: 30
          }
        };
      case 'edgelake':
        return {
          edgelake: {
            host: '',
            port: 32049,
            timeout: 20,
            use_distributed_query: false
          }
        };
      case 'mqtt':
        return {
          mqtt: {
            broker_url: 'mqtt://192.168.1.216:1883',
            client_id: '',
            username: '',
            password: '',
            tls: false,
            keep_alive: 60,
            qos: 0,
            clean_start: true,
            buffer_size: 100
          }
        };
      case 'frigate':
        return {
          frigate: {
            host: '',
            port: 5000,
            username: '',
            password: '',
            go2rtc_port: 1984
          }
        };
      default:
        return {};
    }
  };

  const handleTypeChange = (e) => {
    const newType = e.target.value;
    setType(newType);
    setConfig(getDefaultConfig(newType));
    setHasChanges(true);
  };

  const updateConfig = (path, value) => {
    setConfig((prev) => {
      // Deep clone to avoid mutation issues with nested objects
      const newConfig = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let current = newConfig;

      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }

      current[keys[keys.length - 1]] = value;
      return newConfig;
    });
    setHasChanges(true);
  };

  // Prepare config for save, preserving masked secrets
  const prepareConfigForSave = (configToSave) => {
    const prepared = JSON.parse(JSON.stringify(configToSave)); // Deep clone

    // For SQL: if password is empty and was masked, keep the masked value
    if (prepared.sql) {
      if (prepared.sql.password === '' && connection?.config?.sql?.password === SECRET_MASKED_VALUE) {
        prepared.sql.password = SECRET_MASKED_VALUE;
      }
    }

    // For TSStore: if api_key is empty and was masked, keep the masked value
    if (prepared.tsstore) {
      if (prepared.tsstore.api_key === '' && connection?.config?.tsstore?.api_key === SECRET_MASKED_VALUE) {
        prepared.tsstore.api_key = SECRET_MASKED_VALUE;
      }
    }

    // For MQTT: if password is empty and was masked, keep the masked value
    if (prepared.mqtt) {
      if (prepared.mqtt.password === '' && connection?.config?.mqtt?.password === SECRET_MASKED_VALUE) {
        prepared.mqtt.password = SECRET_MASKED_VALUE;
      }
    }

    // For Frigate: if password is empty and was masked, keep the masked value
    if (prepared.frigate) {
      if (prepared.frigate.password === '' && connection?.config?.frigate?.password === SECRET_MASKED_VALUE) {
        prepared.frigate.password = SECRET_MASKED_VALUE;
      }
    }

    // For API: preserve masked auth_credentials
    if (prepared.api && prepared.api.auth_credentials) {
      const originalCreds = connection?.config?.api?.auth_credentials || {};
      for (const key in prepared.api.auth_credentials) {
        if (prepared.api.auth_credentials[key] === '' && originalCreds[key] === SECRET_MASKED_VALUE) {
          prepared.api.auth_credentials[key] = SECRET_MASKED_VALUE;
        }
      }
    }

    return prepared;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const preparedConfig = isCreateMode ? config : prepareConfigForSave(config);

      const payload = {
        name,
        description,
        type,
        config: preparedConfig,
        tags,
        namespace,
      };

      if (isCreateMode) {
        await apiClient.createConnection(payload);
      } else {
        await apiClient.updateConnection(id, payload);
      }

      invalidateTagsCache();
      setHasChanges(false);
      setShowSaveModal(false);
      navigate('/design/connections');
    } catch (err) {
      alert(`Failed to save: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (hasChanges) {
      setShowCancelModal(true);
    } else {
      navigate('/design/connections');
    }
  };

  const confirmCancel = () => {
    setShowCancelModal(false);
    navigate('/design/connections');
  };

  // Test connection handler
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setTestSchema(null);

    try {
      let result;
      // Always test with current form values so unsaved changes are tested
      const testConfig = prepareConfigForSave(config);
      result = await apiClient.testConnection(type, testConfig, isCreateMode ? null : id);
      setTestResult(result);

      // For SQL connections, schema is included in the test response data
      if (result.success && type === 'sql' && result.data) {
        setTestSchema(result.data);
      }

      setShowTestModal(true);
    } catch (err) {
      setTestResult({
        success: false,
        status: 'error',
        message: err.message || 'Connection test failed'
      });
      setShowTestModal(true);
    } finally {
      setTesting(false);
    }
  };

  // Helper function to extract data by path (mirrors backend logic)
  const extractByPath = (data, path) => {
    if (!path || path.trim() === '') return data;
    const parts = path.split('.');
    let current = data;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return null;
      }
    }
    return current;
  };

  // Compute parsed output based on test input, data_path, timestamp_field,
  // and timestamp_scale. Mirrors the chart-side parser preview so admins
  // can verify the data_path / scale selection before saving the connection.
  const parsedOutput = useMemo(() => {
    const socketConfig = config.socket || {};
    const parserConfig = socketConfig.parser || {};
    const dataPath = parserConfig.data_path || '';
    const timestampField = parserConfig.timestamp_field || '';
    const timestampScale = parserConfig.timestamp_scale || '';

    try {
      const parsed = JSON.parse(testInput);

      // Step 1: Lift timestamp from the envelope (BEFORE we re-root) so we
      // don't lose it when data_path narrows the record.
      let extractedTimestamp = null;
      if (timestampField) {
        extractedTimestamp = extractByPath(parsed, timestampField);
      }

      // Apply scale hint to numeric timestamps. Mirrors the backend
      // normalizeTimestampWithScale logic so the preview agrees with what
      // the server will store.
      if (typeof extractedTimestamp === 'number') {
        if (timestampScale === 'ns') extractedTimestamp = extractedTimestamp / 1e9;
        else if (timestampScale === 'ms') extractedTimestamp = extractedTimestamp / 1e3;
        else if (!timestampScale) {
          if (extractedTimestamp > 1e15) extractedTimestamp = extractedTimestamp / 1e9;
          else if (extractedTimestamp > 1e12) extractedTimestamp = extractedTimestamp / 1e3;
        }
      }

      // Step 2: Re-root at data_path if set.
      let extracted = dataPath ? extractByPath(parsed, dataPath) : parsed;

      // Step 3: If extracted is an object, merge the lifted timestamp.
      if (extracted && typeof extracted === 'object' && !Array.isArray(extracted)) {
        extracted = { ...extracted };
        if (extractedTimestamp !== null) {
          extracted.timestamp = extractedTimestamp;
        }
      }

      return {
        success: true,
        original: parsed,
        extracted: extracted,
        fields: extracted && typeof extracted === 'object' && !Array.isArray(extracted)
          ? Object.keys(extracted)
          : []
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        original: null,
        extracted: null,
        fields: []
      };
    }
  }, [
    testInput,
    config.socket?.parser?.data_path,
    config.socket?.parser?.timestamp_field,
    config.socket?.parser?.timestamp_scale
  ]);

  const renderSQLConfig = () => {
    const sqlConfig = config.sql || {};
    const isSQLite = sqlConfig.driver === 'sqlite';
    return (
      <div className="config-form">
        <Select
          id="sql-driver"
          labelText="Database Driver"
          value={sqlConfig.driver || 'postgres'}
          onChange={(e) => updateConfig('sql.driver', e.target.value)}
        >
          <SelectItem value="postgres" text="PostgreSQL" />
          <SelectItem value="mysql" text="MySQL" />
          <SelectItem value="sqlite" text="SQLite" />
          <SelectItem value="mssql" text="MS SQL Server" />
          <SelectItem value="oracle" text="Oracle" />
        </Select>

        {!isSQLite && (
          <div className="form-row">
            <TextInput
              id="sql-host"
              labelText="Host"
              value={sqlConfig.host || ''}
              onChange={(e) => updateConfig('sql.host', e.target.value)}
              placeholder="localhost"
            />
            <NumberInput
              id="sql-port"
              label="Port"
              value={sqlConfig.port || 5432}
              onChange={(e, { value }) => updateConfig('sql.port', value)}
              min={1}
              max={65535}
            />
          </div>
        )}

        <TextInput
          id="sql-database"
          labelText={isSQLite ? "Database Path" : "Database"}
          value={sqlConfig.database || ''}
          onChange={(e) => updateConfig('sql.database', e.target.value)}
          placeholder={isSQLite ? "/path/to/database.db or :memory:" : "database_name"}
        />

        {!isSQLite && (
          <>
            <div className="form-row">
              <TextInput
                id="sql-username"
                labelText="Username"
                value={sqlConfig.username || ''}
                onChange={(e) => updateConfig('sql.username', e.target.value)}
              />
              <SecretTextInput
                id="sql-password"
                labelText="Password"
                value={sqlConfig.password || ''}
                onChange={(e) => updateConfig('sql.password', e.target.value)}
                placeholder="Enter password"
              />
            </div>

            <Checkbox
              id="sql-ssl"
              labelText="Use SSL"
              checked={sqlConfig.ssl || false}
              onChange={(e) => updateConfig('sql.ssl', e.target.checked)}
            />
          </>
        )}

        <div className="form-row">
          <NumberInput
            id="sql-max-connections"
            label="Max Connections"
            value={sqlConfig.max_connections || 10}
            onChange={(e, { value }) => updateConfig('sql.max_connections', value)}
            min={1}
            max={100}
          />
          <NumberInput
            id="sql-timeout"
            label="Timeout (seconds)"
            value={sqlConfig.timeout || 30}
            onChange={(e, { value }) => updateConfig('sql.timeout', value)}
            min={1}
            max={300}
          />
        </div>

        <TextInput
          id="sql-options"
          labelText="Optional Parameters"
          value={sqlConfig.options || ''}
          onChange={(e) => updateConfig('sql.options', e.target.value)}
          placeholder="e.g., sslmode=verify-full or application_name=dashboard"
          helperText="Additional driver-specific connection parameters"
        />
      </div>
    );
  };

  const renderCSVConfig = () => {
    const csvConfig = config.csv || {};
    return (
      <div className="config-form">
        <TextInput
          id="csv-path"
          labelText="File Path"
          value={csvConfig.path || ''}
          onChange={(e) => updateConfig('csv.path', e.target.value)}
          placeholder="/path/to/file.csv"
        />

        <TextInput
          id="csv-delimiter"
          labelText="Delimiter"
          value={csvConfig.delimiter || ','}
          onChange={(e) => updateConfig('csv.delimiter', e.target.value)}
          maxLength={1}
        />

        <TextInput
          id="csv-encoding"
          labelText="Encoding"
          value={csvConfig.encoding || 'utf-8'}
          onChange={(e) => updateConfig('csv.encoding', e.target.value)}
        />

        <Checkbox
          id="csv-has-header"
          labelText="File has header row"
          checked={csvConfig.has_header !== false}
          onChange={(e) => updateConfig('csv.has_header', e.target.checked)}
        />

        <Checkbox
          id="csv-watch-changes"
          labelText="Watch for file changes"
          checked={csvConfig.watch_changes || false}
          onChange={(e) => updateConfig('csv.watch_changes', e.target.checked)}
        />
      </div>
    );
  };

  const renderSocketConfig = () => {
    const socketConfig = config.socket || {};
    const parserConfig = socketConfig.parser || {};
    const messageFormatIsJson = (socketConfig.message_format || 'json') === 'json';
    // Derive the preset. ts-store covers both MQTT and WebSocket transports
    // because both use the same envelope: {"timestamp": <ns int64>, "data":
    // {...}}. The override state stickies the user's explicit selection so
    // picking "Custom" with empty fields doesn't immediately re-derive back
    // to "none" and disable the inputs.
    const parserPreset = parserPresetOverride || (
      (parserConfig.data_path === 'data' && parserConfig.timestamp_field === 'timestamp' && parserConfig.timestamp_scale === 'ns')
        ? 'tsstore'
        : (parserConfig.data_path || parserConfig.timestamp_field || parserConfig.timestamp_scale ? 'custom' : 'none')
    );
    return (
      <div className="config-form">
        <TextInput
          id="socket-url"
          labelText="URL"
          value={socketConfig.url || ''}
          onChange={(e) => updateConfig('socket.url', e.target.value)}
          placeholder="ws://localhost:8080/stream"
        />

        <div className="form-row">
          <Select
            id="socket-protocol"
            labelText="Protocol"
            value={socketConfig.protocol || 'websocket'}
            onChange={(e) => updateConfig('socket.protocol', e.target.value)}
          >
            <SelectItem value="websocket" text="WebSocket" />
            <SelectItem value="tcp" text="TCP" />
          </Select>

          <Select
            id="socket-message-format"
            labelText="Message Format"
            value={socketConfig.message_format || 'json'}
            onChange={(e) => updateConfig('socket.message_format', e.target.value)}
          >
            <SelectItem value="json" text="JSON" />
            <SelectItem value="text" text="Text" />
          </Select>
        </div>

        {socketConfig.protocol === 'websocket' && (
          <Checkbox
            id="socket-bidirectional"
            labelText="Bidirectional (allow sending commands)"
            helperText="Required for WebSocket connections used by control components. Read-only WebSockets can only receive."
            checked={socketConfig.bidirectional === true}
            onChange={(e) => updateConfig('socket.bidirectional', e.target.checked)}
          />
        )}

        <Checkbox
          id="socket-reconnect"
          labelText="Reconnect on error"
          checked={socketConfig.reconnect_on_error !== false}
          onChange={(e) => updateConfig('socket.reconnect_on_error', e.target.checked)}
        />

        <div className="form-row">
          <NumberInput
            id="socket-reconnect-delay"
            label="Reconnect Delay (ms)"
            value={socketConfig.reconnect_delay || 5000}
            onChange={(e, { value }) => updateConfig('socket.reconnect_delay', value)}
            min={100}
            max={60000}
          />
          <NumberInput
            id="socket-ping-interval"
            label="Ping Interval (seconds)"
            value={socketConfig.ping_interval || 30}
            onChange={(e, { value }) => updateConfig('socket.ping_interval', value)}
            min={1}
            max={300}
          />
        </div>

        <NumberInput
          id="socket-buffer-size"
          label="Buffer Size (messages)"
          value={socketConfig.buffer_size || 100}
          onChange={(e, { value }) => updateConfig('socket.buffer_size', value)}
          min={1}
          max={10000}
        />

        {/* Parser Configuration Section — JSON mode only. Text mode passes
            payloads through verbatim, so the parser fields wouldn't apply.
            Rendered without an IIFE wrapper so React keeps each TextInput's
            instance identity across keystrokes (otherwise focus is lost on
            every character). */}
        {messageFormatIsJson && (
          <div className="parser-config-section">
            <h4>Data Parser Configuration</h4>
            <p className="helper-text">
              Connection-level parser. Applies to every component reading from this connection so the unwrap happens once on the server. (For broker-style connections like MQTT, parsers stay on the chart instead.)
            </p>

            <div className="parser-fields-row">
              <Select
                id="socket-parser-preset"
                labelText="Preset"
                value={parserPreset}
                onChange={(e) => {
                  const next = e.target.value;
                  setParserPresetOverride(next);
                  if (next === 'tsstore') {
                    updateConfig('socket.parser.data_path', 'data');
                    updateConfig('socket.parser.timestamp_field', 'timestamp');
                    updateConfig('socket.parser.timestamp_scale', 'ns');
                  } else if (next === 'none') {
                    updateConfig('socket.parser.data_path', '');
                    updateConfig('socket.parser.timestamp_field', '');
                    updateConfig('socket.parser.timestamp_scale', '');
                  }
                  // 'custom' = leave fields as-is; override stickies "custom"
                }}
              >
                <SelectItem value="none" text="None (flat JSON)" />
                <SelectItem value="tsstore" text="ts-store" />
                <SelectItem value="custom" text="Custom" />
              </Select>
              <TextInput
                id="socket-data-path"
                labelText="Data Path"
                value={parserConfig.data_path || ''}
                onChange={(e) => updateConfig('socket.parser.data_path', e.target.value)}
                placeholder="data, payload.readings"
                helperText="Dot-path to the data object inside the envelope"
                disabled={parserPreset === 'none'}
              />
              <TextInput
                id="socket-timestamp-field"
                labelText="Timestamp Field"
                value={parserConfig.timestamp_field || ''}
                onChange={(e) => updateConfig('socket.parser.timestamp_field', e.target.value)}
                placeholder="timestamp, ts, time"
                helperText="Lifted before data_path is applied"
                disabled={parserPreset === 'none'}
              />
              <Select
                id="socket-timestamp-scale"
                labelText="Timestamp Scale"
                value={parserConfig.timestamp_scale || ''}
                onChange={(e) => updateConfig('socket.parser.timestamp_scale', e.target.value)}
                helperText="ns/ms hint for numeric timestamps; empty = auto-detect"
                disabled={parserPreset === 'none'}
              >
                <SelectItem value="" text="Auto-detect" />
                <SelectItem value="ns" text="Nanoseconds" />
                <SelectItem value="ms" text="Milliseconds" />
              </Select>
            </div>

            {/* Test Parse Preview */}
            <div className="parse-preview-section">
              <h5>Test Parser</h5>
              <p className="helper-text">
                Paste a sample message to verify the data path / scale extraction.
              </p>

              <div className="preview-columns">
                <div className="preview-column">
                  <label className="preview-label">Sample Input (JSON)</label>
                  <TextArea
                    id="test-input"
                    value={testInput}
                    onChange={(e) => setTestInput(e.target.value)}
                    rows={8}
                    className="preview-textarea"
                  />
                </div>
                <div className="preview-column">
                  <label className="preview-label">
                    Extracted Output {parserConfig.data_path && <span className="path-badge">path: {parserConfig.data_path}</span>}
                  </label>
                  {parsedOutput.success ? (
                    <pre className="preview-output">
                      {JSON.stringify(parsedOutput.extracted, null, 2)}
                    </pre>
                  ) : (
                    <InlineNotification
                      kind="error"
                      title="Parse Error"
                      subtitle={parsedOutput.error}
                      lowContrast
                      hideCloseButton
                    />
                  )}
                  {parsedOutput.success && parsedOutput.fields.length > 0 && (
                    <div className="extracted-fields">
                      <span className="fields-label">Fields: </span>
                      {parsedOutput.fields.map((field) => (
                        <span key={field} className="field-tag">{field}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderAPIConfig = () => {
    const apiConfig = config.api || {};
    return (
      <div className="config-form">
        <TextInput
          id="api-url"
          labelText="URL"
          value={apiConfig.url || ''}
          onChange={(e) => updateConfig('api.url', e.target.value)}
          placeholder="https://api.example.com/data"
        />

        <Select
          id="api-method"
          labelText="HTTP Method"
          value={apiConfig.method || 'GET'}
          onChange={(e) => updateConfig('api.method', e.target.value)}
        >
          <SelectItem value="GET" text="GET" />
          <SelectItem value="POST" text="POST" />
          <SelectItem value="PUT" text="PUT" />
          <SelectItem value="DELETE" text="DELETE" />
          <SelectItem value="PATCH" text="PATCH" />
        </Select>

        <Select
          id="api-auth-type"
          labelText="Authentication"
          value={apiConfig.auth_type || 'none'}
          onChange={(e) => {
            updateConfig('api.auth_type', e.target.value);
            // Clear auth credentials when changing type
            updateConfig('api.auth_credentials', {});
          }}
        >
          <SelectItem value="none" text="None" />
          <SelectItem value="bearer" text="Bearer Token" />
          <SelectItem value="basic" text="Basic Auth" />
          <SelectItem value="api-key" text="API Key" />
        </Select>

        {/* Bearer Token auth */}
        {apiConfig.auth_type === 'bearer' && (
          <SecretTextInput
            id="api-auth-bearer-token"
            labelText="Bearer Token"
            value={apiConfig.auth_credentials?.token || ''}
            onChange={(e) => updateConfig('api.auth_credentials', { ...apiConfig.auth_credentials, token: e.target.value })}
            placeholder="Enter bearer token"
          />
        )}

        {/* Basic Auth */}
        {apiConfig.auth_type === 'basic' && (
          <div className="form-row">
            <TextInput
              id="api-auth-basic-username"
              labelText="Username"
              value={apiConfig.auth_credentials?.username || ''}
              onChange={(e) => updateConfig('api.auth_credentials', { ...apiConfig.auth_credentials, username: e.target.value })}
              placeholder="Enter username"
            />
            <SecretTextInput
              id="api-auth-basic-password"
              labelText="Password"
              value={apiConfig.auth_credentials?.password || ''}
              onChange={(e) => updateConfig('api.auth_credentials', { ...apiConfig.auth_credentials, password: e.target.value })}
              placeholder="Enter password"
            />
          </div>
        )}

        {/* API Key auth */}
        {apiConfig.auth_type === 'api-key' && (
          <div className="form-row">
            <TextInput
              id="api-auth-apikey-header"
              labelText="Header Name"
              value={apiConfig.auth_credentials?.header || 'X-API-Key'}
              onChange={(e) => updateConfig('api.auth_credentials', { ...apiConfig.auth_credentials, header: e.target.value })}
              placeholder="X-API-Key"
              helperText="HTTP header name for the API key"
            />
            <SecretTextInput
              id="api-auth-apikey-value"
              labelText="API Key"
              value={apiConfig.auth_credentials?.key || ''}
              onChange={(e) => updateConfig('api.auth_credentials', { ...apiConfig.auth_credentials, key: e.target.value })}
              placeholder="Enter API key"
            />
          </div>
        )}

        <TextArea
          id="api-body"
          labelText="Request Body (JSON)"
          value={apiConfig.body || ''}
          onChange={(e) => updateConfig('api.body', e.target.value)}
          placeholder='{"key": "value"}'
          rows={4}
        />

        <div className="form-row">
          <NumberInput
            id="api-timeout"
            label="Timeout (seconds)"
            value={apiConfig.timeout || 30}
            onChange={(e, { value }) => updateConfig('api.timeout', value)}
            min={1}
            max={300}
          />
          <NumberInput
            id="api-retry-count"
            label="Retry Count"
            value={apiConfig.retry_count || 3}
            onChange={(e, { value }) => updateConfig('api.retry_count', value)}
            min={0}
            max={10}
          />
        </div>

        <NumberInput
          id="api-retry-delay"
          label="Retry Delay (ms)"
          value={apiConfig.retry_delay || 1000}
          onChange={(e, { value }) => updateConfig('api.retry_delay', value)}
          min={100}
          max={10000}
        />

        <TextInput
          id="api-data-path"
          labelText="Data Path"
          value={apiConfig.data_path || ''}
          onChange={(e) => updateConfig('api.data_path', e.target.value)}
          placeholder="data"
          helperText="For wrapped JSON responses, the key containing the data array (e.g., 'data' for {data: [...], total, limit}). Leave blank if the response is already a bare array."
        />
      </div>
    );
  };

  const renderTSStoreConfig = () => {
    const tsstoreConfig = config.tsstore || {};
    const isStreamingTransport = tsstoreConfig.transport === 'streaming';
    return (
      <div className="config-form">
        <div className="form-row">
          <Select
            id="tsstore-transport"
            labelText="Transport"
            value={tsstoreConfig.transport || 'rest'}
            onChange={(e) => {
              updateConfig('tsstore.transport', e.target.value);
              // Clear push config when switching to REST
              if (e.target.value === 'rest') {
                updateConfig('tsstore.push', undefined);
              }
            }}
            helperText="REST for periodic queries, Streaming for real-time WebSocket push"
          >
            <SelectItem value="rest" text="REST (HTTP)" />
            <SelectItem value="streaming" text="Streaming (WebSocket Push)" />
          </Select>
          <Select
            id="tsstore-protocol"
            labelText="Protocol"
            value={tsstoreConfig.protocol || 'http'}
            onChange={(e) => updateConfig('tsstore.protocol', e.target.value)}
            helperText={isStreamingTransport ? 'WS for unencrypted, WSS for encrypted' : 'HTTP for unencrypted, HTTPS for encrypted'}
          >
            <SelectItem value="http" text={isStreamingTransport ? 'WS (unencrypted)' : 'HTTP (unencrypted)'} />
            <SelectItem value="https" text={isStreamingTransport ? 'WSS (encrypted)' : 'HTTPS (encrypted)'} />
          </Select>
        </div>

        <div className="form-row">
          <TextInput
            id="tsstore-host"
            labelText="Host"
            value={tsstoreConfig.host || ''}
            onChange={(e) => updateConfig('tsstore.host', e.target.value)}
            placeholder="localhost or 100.127.19.27"
            helperText="Hostname or IP address of the TSStore server"
          />
          <NumberInput
            id="tsstore-port"
            label="Port"
            value={tsstoreConfig.port || 21080}
            onChange={(e, { value }) => updateConfig('tsstore.port', value)}
            min={1}
            max={65535}
            helperText="TSStore server port"
          />
        </div>

        <TextInput
          id="tsstore-store-name"
          labelText="Store Name"
          value={tsstoreConfig.store_name || ''}
          onChange={(e) => updateConfig('tsstore.store_name', e.target.value)}
          placeholder="my-timeseries-store"
          helperText="Name of the timeseries store to connect to"
        />

        <SecretTextInput
          id="tsstore-api-key"
          labelText="API Key (optional)"
          value={tsstoreConfig.api_key || ''}
          onChange={(e) => updateConfig('tsstore.api_key', e.target.value)}
          placeholder="Enter API key"
          helperText="API key for authentication (if required)"
        />

        <NumberInput
          id="tsstore-timeout"
          label="Timeout (seconds)"
          value={tsstoreConfig.timeout || 30}
          onChange={(e, { value }) => updateConfig('tsstore.timeout', value)}
          min={1}
          max={300}
          helperText="Request timeout in seconds"
        />

        {/* Streaming/Push Configuration — only shown for streaming transport */}
        {isStreamingTransport && (<>
        <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--cds-text-secondary)' }}>
          Streaming Configuration
        </h4>
        <p style={{ fontSize: '0.875rem', color: 'var(--cds-text-helper)', marginBottom: '1rem' }}>
          Configure how data is pushed from ts-store to the dashboard. These settings affect all charts using this connection.
        </p>

        <TextInput
          id="tsstore-filter"
          labelText="Filter"
          value={tsstoreConfig.push?.filter || ''}
          onChange={(e) => updateConfig('tsstore.push.filter', e.target.value)}
          placeholder="temperature"
          helperText="Substring filter - only records containing this text are sent"
        />

        <Toggle
          id="tsstore-filter-ignore-case"
          labelText="Case-insensitive filter"
          labelA="Off"
          labelB="On"
          toggled={tsstoreConfig.push?.filter_ignore_case || false}
          onToggle={(checked) => updateConfig('tsstore.push.filter_ignore_case', checked)}
        />

        {/* Aggregation Section */}
        <div style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: 'var(--cds-layer-01)', borderRadius: '4px' }}>
          <Toggle
            id="tsstore-enable-aggregation"
            labelText="Enable time-window aggregation"
            labelA="Off"
            labelB="On"
            toggled={!!tsstoreConfig.push?.agg_window}
            onToggle={(checked) => {
              if (!checked) {
                // Clear all aggregation settings
                updateConfig('tsstore.push.agg_window', '');
                updateConfig('tsstore.push.agg_default', '');
                updateConfig('tsstore.push.agg_fields', '');
              } else {
                // Set a default window
                updateConfig('tsstore.push.agg_window', '1m');
              }
            }}
          />

          {tsstoreConfig.push?.agg_window && (
            <div style={{ marginTop: '1rem' }}>
              {/* Time Window */}
              <div className="form-row" style={{ marginBottom: '1rem' }}>
                <NumberInput
                  id="tsstore-agg-window-value"
                  label="Time Window"
                  value={parseInt(tsstoreConfig.push?.agg_window) || 1}
                  onChange={(e, { value }) => {
                    const unit = tsstoreConfig.push?.agg_window?.replace(/[0-9]/g, '') || 'm';
                    updateConfig('tsstore.push.agg_window', `${value}${unit}`);
                  }}
                  min={1}
                  max={60}
                  helperText="Records are accumulated over this time period"
                />
                <Select
                  id="tsstore-agg-window-unit"
                  labelText="Unit"
                  value={tsstoreConfig.push?.agg_window?.replace(/[0-9]/g, '') || 'm'}
                  onChange={(e) => {
                    const value = parseInt(tsstoreConfig.push?.agg_window) || 1;
                    updateConfig('tsstore.push.agg_window', `${value}${e.target.value}`);
                  }}
                >
                  <SelectItem value="s" text="Seconds" />
                  <SelectItem value="m" text="Minutes" />
                  <SelectItem value="h" text="Hours" />
                </Select>
              </div>

              {/* Default Aggregations for Numeric Fields */}
              <fieldset style={{ border: '1px solid var(--cds-border-subtle-01)', padding: '1rem', borderRadius: '4px', marginBottom: '1rem' }}>
                <legend style={{ padding: '0 0.5rem', color: 'var(--cds-text-secondary)', fontSize: '0.875rem' }}>
                  Default Aggregations for Numeric Fields
                </legend>
                <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-helper)', marginBottom: '0.75rem' }}>
                  Select which calculations to apply to all numeric fields (can select multiple):
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                  {['avg', 'sum', 'min', 'max', 'count', 'last'].map((func) => {
                    const currentDefaults = (tsstoreConfig.push?.agg_default || '').split(',').filter(Boolean);
                    const isChecked = currentDefaults.includes(func);
                    return (
                      <Checkbox
                        key={func}
                        id={`tsstore-agg-default-${func}`}
                        labelText={func === 'avg' ? 'Average' : func === 'sum' ? 'Sum' : func === 'min' ? 'Minimum' : func === 'max' ? 'Maximum' : func === 'count' ? 'Count' : 'Last'}
                        checked={isChecked}
                        onChange={(_, { checked }) => {
                          let newDefaults = currentDefaults.filter(f => f !== func);
                          if (checked) {
                            newDefaults.push(func);
                          }
                          updateConfig('tsstore.push.agg_default', newDefaults.join(','));
                        }}
                      />
                    );
                  })}
                </div>
              </fieldset>

              {/* Field-Specific Overrides */}
              <fieldset style={{ border: '1px solid var(--cds-border-subtle-01)', padding: '1rem', borderRadius: '4px' }}>
                <legend style={{ padding: '0 0.5rem', color: 'var(--cds-text-secondary)', fontSize: '0.875rem' }}>
                  Field Overrides (Optional)
                </legend>
                <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-helper)', marginBottom: '0.75rem' }}>
                  Override default aggregations for specific fields. Use Test Connection to discover available fields.
                </p>

                {/* Parse and display existing field overrides */}
                {(() => {
                  const aggFieldsStr = tsstoreConfig.push?.agg_fields || '';
                  const fieldOverrides = aggFieldsStr ? aggFieldsStr.split(',').map(part => {
                    const [field, funcs] = part.split(':');
                    return { field: field?.trim(), functions: (funcs || '').split('+').map(f => f.trim()).filter(Boolean) };
                  }).filter(f => f.field) : [];

                  return (
                    <>
                      {fieldOverrides.map((override, index) => (
                        <div key={index} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.75rem', padding: '0.75rem', backgroundColor: 'var(--cds-layer-02)', borderRadius: '4px' }}>
                          <TextInput
                            id={`tsstore-field-override-name-${index}`}
                            labelText="Field"
                            size="sm"
                            value={override.field}
                            onChange={(e) => {
                              const newOverrides = [...fieldOverrides];
                              newOverrides[index].field = e.target.value;
                              const newStr = newOverrides.map(o => `${o.field}:${o.functions.join('+')}`).join(',');
                              updateConfig('tsstore.push.agg_fields', newStr);
                            }}
                            style={{ width: '150px' }}
                          />
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>Aggregations</label>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                              {['avg', 'sum', 'min', 'max', 'count', 'last'].map((func) => (
                                <Checkbox
                                  key={func}
                                  id={`tsstore-field-${index}-${func}`}
                                  labelText={func}
                                  checked={override.functions.includes(func)}
                                  onChange={(_, { checked }) => {
                                    const newOverrides = [...fieldOverrides];
                                    if (checked) {
                                      newOverrides[index].functions.push(func);
                                    } else {
                                      newOverrides[index].functions = newOverrides[index].functions.filter(f => f !== func);
                                    }
                                    const newStr = newOverrides.map(o => `${o.field}:${o.functions.join('+')}`).join(',');
                                    updateConfig('tsstore.push.agg_fields', newStr);
                                  }}
                                />
                              ))}
                            </div>
                          </div>
                          <Button
                            kind="ghost"
                            size="sm"
                            hasIconOnly
                            renderIcon={TrashCan}
                            iconDescription="Remove override"
                            onClick={() => {
                              const newOverrides = fieldOverrides.filter((_, i) => i !== index);
                              const newStr = newOverrides.map(o => `${o.field}:${o.functions.join('+')}`).join(',');
                              updateConfig('tsstore.push.agg_fields', newStr);
                            }}
                            style={{ marginTop: '1rem' }}
                          />
                        </div>
                      ))}
                      <Button
                        kind="tertiary"
                        size="sm"
                        onClick={() => {
                          const newOverrides = [...fieldOverrides, { field: '', functions: ['avg'] }];
                          const newStr = newOverrides.map(o => `${o.field}:${o.functions.join('+')}`).join(',');
                          updateConfig('tsstore.push.agg_fields', newStr);
                        }}
                      >
                        + Add field override
                      </Button>
                    </>
                  );
                })()}
              </fieldset>

              <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-helper)', marginTop: '1rem', fontStyle: 'italic' }}>
                Non-numeric fields always use "last value" only.
              </p>
            </div>
          )}
        </div>
        </>)}
      </div>
    );
  };

  const renderPrometheusConfig = () => {
    const prometheusConfig = config.prometheus || {};
    return (
      <div className="config-form">
        <TextInput
          id="prometheus-url"
          labelText="Prometheus URL"
          value={prometheusConfig.url || ''}
          onChange={(e) => updateConfig('prometheus.url', e.target.value)}
          placeholder="http://localhost:9090"
          helperText="Base URL of the Prometheus server"
        />

        <TextInput
          id="prometheus-username"
          labelText="Username (optional)"
          value={prometheusConfig.username || ''}
          onChange={(e) => updateConfig('prometheus.username', e.target.value)}
          placeholder="Enter username for basic auth"
          helperText="Username for basic authentication (if required)"
        />

        <SecretTextInput
          id="prometheus-password"
          labelText="Password (optional)"
          value={prometheusConfig.password || ''}
          onChange={(e) => updateConfig('prometheus.password', e.target.value)}
          placeholder="Enter password"
          helperText="Password for basic authentication (if required)"
        />

        <NumberInput
          id="prometheus-timeout"
          label="Timeout (seconds)"
          value={prometheusConfig.timeout || 30}
          onChange={(e, { value }) => updateConfig('prometheus.timeout', value)}
          min={1}
          max={300}
          helperText="Query timeout in seconds"
        />
      </div>
    );
  };

  const renderEdgeLakeConfig = () => {
    const elConfig = config.edgelake || {};
    return (
      <div className="config-form">
        <div className="form-row">
          <TextInput
            id="edgelake-host"
            labelText="Host"
            value={elConfig.host || ''}
            onChange={(e) => updateConfig('edgelake.host', e.target.value)}
            placeholder="192.168.1.100 or edgelake.example.com"
            helperText="IP address or hostname of the EdgeLake node"
          />
          <NumberInput
            id="edgelake-port"
            label="Port"
            value={elConfig.port || 32049}
            onChange={(e, { value }) => updateConfig('edgelake.port', value)}
            min={1}
            max={65535}
            helperText="REST API port (default: 32049)"
          />
        </div>

        <NumberInput
          id="edgelake-timeout"
          label="Timeout (seconds)"
          value={elConfig.timeout || 20}
          onChange={(e, { value }) => updateConfig('edgelake.timeout', value)}
          min={1}
          max={300}
          helperText="Request timeout in seconds"
        />

        <Checkbox
          id="edgelake-distributed"
          labelText="Enable distributed queries (send to all network nodes)"
          checked={elConfig.use_distributed_query || false}
          onChange={(e) => updateConfig('edgelake.use_distributed_query', e.target.checked)}
        />
      </div>
    );
  };

  const renderMQTTConfig = () => {
    const mqttConfig = config.mqtt || {};
    return (
      <div className="config-form">
        <TextInput
          id="mqtt-broker-url"
          labelText="Broker URL"
          value={mqttConfig.broker_url || ''}
          onChange={(e) => updateConfig('mqtt.broker_url', e.target.value)}
          placeholder="mqtt://192.168.1.216:1883"
          helperText="MQTT broker URL (mqtt:// or mqtts:// for TLS)"
        />

        <TextInput
          id="mqtt-client-id"
          labelText="Client ID"
          value={mqttConfig.client_id || ''}
          onChange={(e) => updateConfig('mqtt.client_id', e.target.value)}
          placeholder="dashboard-client-01"
          helperText="Unique client identifier (auto-generated if empty)"
        />

        <div className="form-row">
          <TextInput
            id="mqtt-username"
            labelText="Username"
            value={mqttConfig.username || ''}
            onChange={(e) => updateConfig('mqtt.username', e.target.value)}
            placeholder="(optional)"
          />
          <SecretTextInput
            id="mqtt-password"
            labelText="Password"
            value={mqttConfig.password || ''}
            onChange={(e) => updateConfig('mqtt.password', e.target.value)}
            placeholder="(optional)"
          />
        </div>

        <div className="form-row">
          <NumberInput
            id="mqtt-keep-alive"
            label="Keep Alive (seconds)"
            value={mqttConfig.keep_alive || 60}
            onChange={(e, { value }) => updateConfig('mqtt.keep_alive', value)}
            min={5}
            max={3600}
            helperText="Ping interval to keep connection alive"
          />
          <Select
            id="mqtt-qos"
            labelText="Default QoS"
            value={String(mqttConfig.qos ?? 0)}
            onChange={(e) => updateConfig('mqtt.qos', parseInt(e.target.value))}
          >
            <SelectItem value="0" text="0 - At most once" />
            <SelectItem value="1" text="1 - At least once" />
            <SelectItem value="2" text="2 - Exactly once" />
          </Select>
        </div>

        <NumberInput
          id="mqtt-buffer-size"
          label="Buffer Size (messages)"
          value={mqttConfig.buffer_size || 100}
          onChange={(e, { value }) => updateConfig('mqtt.buffer_size', value)}
          min={1}
          max={10000}
        />

        <div className="form-row">
          <Checkbox
            id="mqtt-tls"
            labelText="Use TLS encryption"
            checked={mqttConfig.tls || false}
            onChange={(e) => updateConfig('mqtt.tls', e.target.checked)}
          />
          <Checkbox
            id="mqtt-clean-start"
            labelText="Clean session on connect"
            checked={mqttConfig.clean_start !== false}
            onChange={(e) => updateConfig('mqtt.clean_start', e.target.checked)}
          />
        </div>
      </div>
    );
  };

  const renderFrigateConfig = () => {
    const frigateConfig = config.frigate || {};
    return (
      <div className="config-form">
        <div className="form-row">
          <TextInput
            id="frigate-host"
            labelText="Host"
            value={frigateConfig.host || ''}
            onChange={(e) => updateConfig('frigate.host', e.target.value)}
            placeholder="192.168.1.100"
            helperText="Frigate NVR hostname or IP address"
          />
          <NumberInput
            id="frigate-port"
            label="Port"
            value={frigateConfig.port || 5000}
            onChange={(e, { value }) => updateConfig('frigate.port', value)}
            min={1}
            max={65535}
            helperText="Frigate API port (default: 5000)"
          />
        </div>

        <div className="form-row">
          <TextInput
            id="frigate-username"
            labelText="Username"
            value={frigateConfig.username || ''}
            onChange={(e) => updateConfig('frigate.username', e.target.value)}
            placeholder="(optional)"
          />
          <SecretTextInput
            id="frigate-password"
            labelText="Password"
            value={frigateConfig.password || ''}
            onChange={(e) => updateConfig('frigate.password', e.target.value)}
            placeholder="(optional)"
          />
        </div>

        <NumberInput
          id="frigate-go2rtc-port"
          label="go2rtc Port"
          value={frigateConfig.go2rtc_port || 1984}
          onChange={(e, { value }) => updateConfig('frigate.go2rtc_port', value)}
          min={1}
          max={65535}
          helperText="go2rtc streaming port (default: 1984)"
        />
      </div>
    );
  };

  if (loading) {
    return (
      <div className="connection-detail-page">
        <Loading description="Loading connection..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="connection-detail-page">
        <div className="error-message">Error: {error}</div>
        <Button onClick={() => navigate('/design/connections')}>Back to Connections</Button>
      </div>
    );
  }

  return (
    <div className="connection-detail-page">
      {/* Page header bar with title and actions */}
      <div className="page-header-bar">
        <div className="header-left">
          <Button
            kind="ghost"
            renderIcon={ArrowLeft}
            onClick={() => navigate('/design/connections')}
            size="md"
          >
            Back
          </Button>
          <h1>{isCreateMode ? 'Create Connection' : 'Edit Connection'}</h1>
        </div>
        <div className="page-actions">
          <Button
            kind="secondary"
            renderIcon={Close}
            onClick={handleCancel}
            size="md"
          >
            Cancel
          </Button>
          <Button
            kind="primary"
            renderIcon={Save}
            onClick={() => setShowSaveModal(true)}
            disabled={!name || !type}
            size="md"
          >
            Save Connection
          </Button>
        </div>
      </div>

      {/* Form content */}
      <div className="form-content">
        {/* Connection Name - full width */}
        <div className="form-row">
          <TextInput
            id="connection-name"
            labelText="Connection Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setHasChanges(true);
              if (nameError) setNameError('');
            }}
            onBlur={(e) => checkDuplicateConnectionName(e.target.value)}
            placeholder="Enter connection name"
            invalid={!!nameError}
            invalidText={nameError}
          />
        </div>

        {/* Description - full width */}
        <div className="form-row">
          <TextInput
            id="connection-description"
            labelText="Description (optional)"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setHasChanges(true);
            }}
            placeholder="Enter connection description"
          />
        </div>

        {/* Namespace */}
        <div className="form-row">
          <NamespaceSelect
            id="connection-namespace"
            value={namespace}
            onChange={(v) => { setNamespace(v); setHasChanges(true); }}
          />
        </div>

        {/* Tags */}
        <div className="form-row">
          <TagInput
            id="connection-tags"
            label="Tags"
            value={tags}
            onChange={(next) => {
              setTags(next);
              setHasChanges(true);
            }}
          />
        </div>

        {/* Type selector */}
        <div className="form-row">
          <Select
            id="connection-type"
            labelText="Connection Type"
            value={type}
            onChange={handleTypeChange}
            disabled={!isCreateMode}
          >
            {renderConnTypeOption('sql', 'SQL Database', type)}
            {renderConnTypeOption('csv', 'CSV File', type)}
            {renderConnTypeOption('socket', 'Socket/WebSocket', type)}
            {renderConnTypeOption('api', 'REST API', type)}
            {renderConnTypeOption('tsstore', 'TSStore (Timeseries)', type)}
            {renderConnTypeOption('prometheus', 'Prometheus', type)}
            {renderConnTypeOption('edgelake', 'EdgeLake', type)}
            {renderConnTypeOption('mqtt', 'MQTT Broker', type)}
            {renderConnTypeOption('frigate', 'Frigate NVR', type)}
          </Select>
        </div>

        {/* Type-specific configuration */}
        <div className="config-section">
          <div className="config-section-header">
            <h3>Configuration</h3>
            <Button
              kind="tertiary"
              renderIcon={ConnectionSignal}
              onClick={handleTestConnection}
              disabled={testing}
              size="sm"
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </Button>
          </div>
          {type === 'sql' && renderSQLConfig()}
          {type === 'csv' && renderCSVConfig()}
          {type === 'socket' && renderSocketConfig()}
          {type === 'api' && renderAPIConfig()}
          {type === 'tsstore' && renderTSStoreConfig()}
          {type === 'prometheus' && renderPrometheusConfig()}
          {type === 'edgelake' && renderEdgeLakeConfig()}
          {type === 'mqtt' && renderMQTTConfig()}
          {type === 'frigate' && renderFrigateConfig()}
        </div>
      </div>

      {/* Cancel confirmation modal */}
      {showCancelModal && (
        <Modal
          open={true}
          onRequestClose={() => setShowCancelModal(false)}
          onRequestSubmit={confirmCancel}
          modalHeading="Discard Changes?"
          primaryButtonText="Discard"
          secondaryButtonText="Keep Editing"
          danger
        >
          <p>You have unsaved changes. Are you sure you want to discard them?</p>
        </Modal>
      )}

      {/* Save confirmation modal */}
      {showSaveModal && (
        <Modal
          open={true}
          onRequestClose={() => setShowSaveModal(false)}
          onRequestSubmit={handleSave}
          modalHeading={isCreateMode ? "Create Connection" : "Save Changes"}
          primaryButtonText={saving ? "Saving..." : "Save"}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={saving}
        >
          <p>
            {isCreateMode
              ? `Create connection "${name}" of type ${type}?`
              : `Save changes to connection "${name}"?`}
          </p>
        </Modal>
      )}

      {/* Test Connection Results Modal */}
      {showTestModal && testResult && (
        <Modal
          open={true}
          onRequestClose={() => {
            setShowTestModal(false);
            setTestResult(null);
            setTestSchema(null);
          }}
          modalHeading="Connection Test Results"
          passiveModal
          size="md"
          className="test-connection-modal"
        >
          <div className="test-result-content">
            {/* Status indicator */}
            <div className={`test-status ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? (
                <Checkmark size={24} />
              ) : (
                <ErrorFilled size={24} />
              )}
              <span className="status-text">
                {testResult.success ? 'Connection Successful' : 'Connection Failed'}
              </span>
            </div>

            {/* Message */}
            {testResult.message && (
              <p className="test-message">{testResult.message}</p>
            )}

            {/* Response time */}
            {testResult.response_time && (
              <p className="response-time">
                Response time: {testResult.response_time}ms
              </p>
            )}

            {/* Schema information for SQL connections */}
            {testResult.success && testSchema && testSchema.tables && (
              <div className="schema-info">
                <h4>Database Schema</h4>
                <p className="schema-count">{testSchema.tables.length} tables found</p>
                <div className="schema-tables">
                  {testSchema.tables.map((table) => (
                    <div key={table.name} className="schema-table">
                      <div className="table-name">{table.name}</div>
                      <div className="table-columns">
                        {table.columns && table.columns.map((col) => (
                          <Tag key={col.name} size="sm" type="cool-gray">
                            {col.name}
                          </Tag>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default ConnectionDetailPage;
