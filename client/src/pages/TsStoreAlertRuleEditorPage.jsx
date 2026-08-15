// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  Button,
  Form,
  FormGroup,
  TextInput,
  TextArea,
  Select,
  SelectItem,
  RadioButtonGroup,
  RadioButton,
  FilterableMultiSelect,
  ComboBox,
  InlineNotification,
  Loading,
  Tag,
} from '@carbon/react';
import { ArrowLeft, Close, Save } from '@carbon/icons-react';
import apiClient from '../api/client';
import useExtensions from '../hooks/useExtensions';
import { useNamespaces } from '../context/NamespaceContext';
import DashboardPickerModal from '../components/DashboardPickerModal';
import { Dropdown } from '@carbon/react';
import { candidateLabel } from '../utils/tagValueByPrefix';
import './TsStoreAlertRuleEditorPage.scss';

/**
 * Create a webhook alert rule on a tsstore connection.
 *
 * v1 scope: webhook transport only (the path the dashboard's own
 * receiver consumes). WS / MQTT transports + multi-rule + edit-
 * existing all deferred — the wizard always creates one fresh
 * alert with exactly one rule.
 *
 * Auth model: the page POSTs to /api/tsstore-alerts/rules, which is
 * gated on Design capability. Backend mints a per-connection URL
 * secret and builds a webhook URL pointing at this dashboard's
 * public secret-gated receiver, so the user doesn't have to pick a
 * system-user API key for inbound auth.
 */
function TsStoreAlertRuleEditorPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isEnabled, loading: extLoading } = useExtensions();
  const { activeNamespace } = useNamespaces();

  // Form state.
  const [connections, setConnections] = useState([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  // Namespace filter — empty array means "show all" (the default).
  // Populating it narrows the connection list to those namespaces.
  const [namespaceFilter, setNamespaceFilter] = useState([]);
  const [connectionId, setConnectionId] = useState('');
  // #248: target store for an ENDPOINT-SCOPED connection (no pinned
  // store_name) — required there; a pinned connection's rule always
  // registers on its pin and shows no picker. storeOptions is the
  // MANAGE-granted store list (alert CRUD is manage-classed under
  // ts-store scoped keys); null = list unavailable → free-text fallback.
  const [storeName, setStoreName] = useState('');
  const [storeOptions, setStoreOptions] = useState(null);
  const [ruleName, setRuleName] = useState('');
  // Alert delivery type. WebSocket sink is intentionally omitted —
  // WS has no topic mechanism, so ts-store WS alerts would mix with
  // any telemetry on the same socket. Webhook and MQTT cover every
  // dashboard use case cleanly.
  const [alertType, setAlertType] = useState('webhook');
  // MQTT-sink fields. SinkConnectionID is an MQTT-type connection
  // (broker creds harvested server-side). Topic lives on the rule,
  // not on the connection, because ts-store models topic that way
  // and an MQTT connection record is just the broker.
  const [mqttConnections, setMqttConnections] = useState([]);
  const [sinkConnectionId, setSinkConnectionId] = useState('');
  const [mqttTopic, setMqttTopic] = useState('');
  // Track whether the user has manually edited the topic so we stop
  // re-prefilling from the rule name once they take ownership of it.
  const [mqttTopicDirty, setMqttTopicDirty] = useState(false);
  const [mqttQos, setMqttQos] = useState('1');
  const [condition, setCondition] = useState('');
  const [cooldown, setCooldown] = useState('5m');
  // Restart policy: "now" (default — start at wall-clock now, no
  // cursor I/O, never replays history) or "resume" (read cursor + replay
  // since last seen, optionally floored by max_replay). Empty value
  // would be treated as "now" by ts-store, so we just default to "now"
  // explicitly to keep the UI in sync with what gets sent.
  const [restartPolicy, setRestartPolicy] = useState('now');
  // Only meaningful when restartPolicy === 'resume'. ts-store rejects
  // a non-empty max_replay paired with restart_policy=now (400). We
  // suggest "1h" as a starting point on resume per the new API doc's
  // example — empty would mean unbounded replay, which is the doc's
  // foot-gun case.
  const [maxReplay, setMaxReplay] = useState('1h');
  const [dashboardId, setDashboardId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Target-dashboard picker state — we keep the chosen record so we
  // can render its name next to the trigger. Lookup-from-id-only
  // would force another fetch.
  const [dashboardRecord, setDashboardRecord] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Dashboard-variable pre-scoping (#125): the picked dashboard's variables
  // (connection_swap + filter, range deferred) and the value chosen for each.
  // dashVarValues maps variable NAME → value; sent as dashboard_vars so the
  // bell link opens the dashboard pre-scoped.
  const [dashVariables, setDashVariables] = useState([]); // subset of settings.variables we support
  const [dashVarValues, setDashVarValues] = useState({}); // { variableName → value }
  const [dashConnCandidates, setDashConnCandidates] = useState({}); // { variableName → [candidate connections] }

  // Probe state. `probe` is one of:
  //   null      — no connection selected yet
  //   'pending' — probe in flight
  //   { ok: true }
  //   { ok: false, http_status?, error? }
  const [probe, setProbe] = useState(null);

  // Field discovery for the chosen connection. Renders as pills above
  // the Condition textarea; clicking or dragging one inserts the field
  // name at the cursor. `fields` is one of:
  //   null      — no connection selected yet
  //   'pending' — schema fetch in flight
  //   string[]  — array of field names (may be empty)
  //   { error }
  const [fields, setFields] = useState(null);
  const conditionRef = useRef(null);

  // #248: is the chosen connection endpoint-scoped (no pinned store)?
  const selectedConn = connections.find((c) => c.id === connectionId);
  const isEndpointScoped = !!selectedConn && !selectedConn?.config?.tsstore?.store_name;
  // The store the alert operations target: only meaningful (and only
  // sent) for endpoint-scoped connections.
  const effectiveStore = isEndpointScoped ? storeName : '';


  // Load tsstore + mqtt connections once on mount. tsstore connections
  // are required (rule owner picker); mqtt connections are only needed
  // when alertType === 'mqtt' but we fetch eagerly so the picker is
  // populated the moment the user flips the radio.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setConnectionsLoading(true);
      try {
        const [ts, mq] = await Promise.all([
          apiClient.getConnections({ type: 'tsstore', page_size: 200 }),
          apiClient.getConnections({ type: 'mqtt', page_size: 200 }),
        ]);
        if (cancelled) return;
        setConnections(ts?.connections || []);
        setMqttConnections(mq?.connections || []);
        // Default the namespace filter to the user's ACTIVE namespace (the
        // header picker) — but only when it actually contains a tsstore
        // connection (an empty pre-filtered dropdown reads as broken), and
        // never when cloning (the source rule's connection may live in
        // another namespace and must stay selectable).
        if (!location.state?.cloneFrom && activeNamespace) {
          const namespaces = new Set((ts?.connections || []).map((c) => c.namespace || 'default'));
          if (namespaces.has(activeNamespace)) {
            setNamespaceFilter([activeNamespace]);
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(`Failed to load connections: ${err.message || err}`);
      } finally {
        if (!cancelled) setConnectionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Mount-once by design: activeNamespace/cloneFrom only seed the INITIAL
    // filter — re-running on namespace switch mid-form would clobber the
    // user's own filter choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "From Existing" prefill (#152): seed the form from a source rule passed via
  // router state. ts-store has no per-rule edit — this is create-with-prefill,
  // so it also gives the copy a fresh default name (source + " copy") to avoid
  // a same-name collision. Runs once on mount.
  const clonedRef = useRef(false);
  useEffect(() => {
    const src = location.state?.cloneFrom;
    if (!src || clonedRef.current) return;
    clonedRef.current = true;
    setAlertType(src.alert_type || 'webhook');
    setConnectionId(src.connection_id || '');
    // Store rides along for endpoint-scoped connections. The store-list
    // effect resets storeName on connection change, so defer one tick.
    if (src.store_name) {
      setTimeout(() => setStoreName(src.store_name), 0);
    }
    setRuleName(src.rule_name ? `${src.rule_name} copy` : '');
    setCondition(src.condition || '');
    if (src.cooldown) setCooldown(src.cooldown);
    if (src.sink_connection_id) setSinkConnectionId(src.sink_connection_id);
    if (src.mqtt_topic) { setMqttTopic(src.mqtt_topic); setMqttTopicDirty(true); }
    if (src.mqtt_qos != null) setMqttQos(String(src.mqtt_qos));
    // Dashboard link + variable pre-scoping.
    if (src.dashboard_id) {
      setDashboardId(src.dashboard_id);
      if (src.dashboard_vars && typeof src.dashboard_vars === 'object') {
        setDashVarValues({ ...src.dashboard_vars });
      }
      apiClient.getDashboard(src.dashboard_id)
        .then((d) => {
          if (d) { setDashboardRecord(d); handleDashboardChosen(d, src.dashboard_vars); }
        })
        .catch(() => { /* link stays set; the variable section just won't render */ });
    }
     
  }, [location.state]);

  // Prefill the MQTT topic from the rule name (slugified) until the
  // user manually edits the topic field. Keeps the topic in sync as
  // they type the name; once they touch the topic, we leave it alone.
  // Slug rule: lowercase, replace runs of non-alphanumeric chars with
  // a single hyphen, trim leading/trailing hyphens.
  useEffect(() => {
    if (mqttTopicDirty) return;
    const slug = ruleName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    setMqttTopic(slug ? `trve/alerts/${slug}` : '');
  }, [ruleName, mqttTopicDirty]);

  // #248: load the manage-granted store list for an endpoint-scoped
  // connection so the store picker offers real names. Alert CRUD is a
  // per-store MANAGE grant, so only manage stores are offered; an empty
  // list means the key can't administer alerts anywhere.
  useEffect(() => {
    setStoreName('');
    if (!connectionId || !isEndpointScoped) {
      setStoreOptions(null);
      return undefined;
    }
    let cancelled = false;
    apiClient.getConnectionStores(connectionId)
      .then((resp) => {
        if (cancelled) return;
        const stores = Array.isArray(resp?.stores) ? resp.stores : [];
        setStoreOptions(stores.filter((st) => Array.isArray(st.access) && st.access.includes('manage')));
      })
      .catch(() => { if (!cancelled) setStoreOptions(null); });
    return () => { cancelled = true; };
     
  }, [connectionId, isEndpointScoped]);

  // Probe the chosen connection's auth posture against ts-store so
  // we can fail fast if the connection's API key won't be accepted.
  // Same endpoint the rule-create POST will exercise, just GET-list
  // instead of POST-create.
  useEffect(() => {
    if (!connectionId || (isEndpointScoped && !effectiveStore)) {
      setProbe(null);
      return undefined;
    }
    let cancelled = false;
    setProbe('pending');
    apiClient.probeTSStoreConnection(connectionId, effectiveStore || undefined)
      .then((r) => { if (!cancelled) setProbe(r); })
      .catch((err) => { if (!cancelled) setProbe({ ok: false, error: err.message || String(err) }); });
    return () => { cancelled = true; };
  }, [connectionId, isEndpointScoped, effectiveStore]);

  // Discover field names for the chosen connection. The schema endpoint
  // samples recent records on the ts-store backend; for json stores
  // there's no formal schema, so we get whatever keys appear in the
  // 10 newest records.
  useEffect(() => {
    if (!connectionId || (isEndpointScoped && !effectiveStore)) {
      setFields(null);
      return undefined;
    }
    let cancelled = false;
    setFields('pending');
    apiClient.getConnectionSchema(connectionId, effectiveStore || undefined)
      .then((resp) => {
        if (cancelled) return;
        if (!resp?.success) {
          setFields({ error: resp?.error || 'Schema discovery failed' });
          return;
        }
        const cols = resp.schema?.tables?.[0]?.columns || [];
        setFields(cols.map((c) => c.name));
      })
      .catch((err) => {
        if (cancelled) return;
        setFields({ error: err.message || String(err) });
      });
    return () => { cancelled = true; };
  }, [connectionId, isEndpointScoped, effectiveStore]);

  // Insert a field name into the Condition textarea at the current
  // selection. If the textarea isn't focused (drop from elsewhere), we
  // use the stored selection range that the drop handler captured.
  const insertField = (name, dropRange) => {
    const el = conditionRef.current;
    if (!el) {
      setCondition((c) => (c ? c + ' ' + name : name));
      return;
    }
    const start = dropRange?.start ?? el.selectionStart ?? condition.length;
    const end = dropRange?.end ?? el.selectionEnd ?? condition.length;
    const before = condition.slice(0, start);
    const after = condition.slice(end);
    // Add a space before/after if the neighbour isn't whitespace and
    // isn't a comparison operator — small ergonomic so `temp.cpu_max>48`
    // doesn't fuse into `temp.cpu_max48` after dropping the second
    // operand.
    const needsLeadSpace = before.length > 0 && !/[\s(]$/.test(before);
    const needsTrailSpace = after.length > 0 && !/^[\s)]/.test(after);
    const insert = (needsLeadSpace ? ' ' : '') + name + (needsTrailSpace ? ' ' : '');
    const next = before + insert + after;
    setCondition(next);
    // Restore caret to the position right after the inserted name.
    const caret = start + insert.length;
    requestAnimationFrame(() => {
      if (conditionRef.current) {
        conditionRef.current.focus();
        conditionRef.current.setSelectionRange(caret, caret);
      }
    });
  };

  // Drag-over the textarea: must call preventDefault so the drop event
  // fires. The browser keeps the textarea's caret responsive to mouse
  // movement on its own — we don't need to track positions manually.
  const handleConditionDragOver = (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  // Drop: insert the dragged pill at the textarea's current caret. The
  // browser positions the caret under the mouse cursor during the drag,
  // so selectionStart at drop time IS where the user dropped.
  const handleConditionDrop = (e) => {
    e.preventDefault();
    const name = e.dataTransfer?.getData('text/plain');
    if (!name) return;
    const el = conditionRef.current;
    insertField(name, el ? { start: el.selectionStart, end: el.selectionEnd } : undefined);
  };

  const visibleConnections = useMemo(() => {
    if (!namespaceFilter || namespaceFilter.length === 0) return connections;
    const set = new Set(namespaceFilter);
    return connections.filter((c) => set.has(c.namespace || 'default'));
  }, [connections, namespaceFilter]);

  // Distinct namespace values across loaded tsstore connections.
  // Treat empty / missing as the "default" namespace so the option
  // list is honest about where the unscoped connections live.
  const namespaceOptions = useMemo(() => {
    const set = new Set();
    for (const c of connections) {
      set.add(c.namespace || 'default');
    }
    return Array.from(set).sort();
  }, [connections]);

  // MQTT-sink fields are required when alertType === 'mqtt'; for
  // webhook the sink URL is autogenerated server-side from the
  // tsstore connection's host:port so no extra inputs are needed.
  const mqttReady = alertType !== 'mqtt' || (sinkConnectionId && mqttTopic.trim());

  const canSubmit =
    connectionId &&
    (!isEndpointScoped || storeName) &&
    ruleName.trim() &&
    condition.trim() &&
    mqttReady &&
    !submitting &&
    probe && probe !== 'pending' && probe.ok === true;

  // When a target dashboard is chosen, load its supported variables
  // (connection_swap + filter; range deferred) so the user can pre-scope the
  // deep link. Connection-swap candidates come from the variable-candidates
  // endpoint (same list the viewer's Host picker uses). Resets any prior
  // values since they belonged to a different dashboard.
  const handleDashboardChosen = async (d, presetValues) => {
    // Preserve caller-provided values (clone prefill); otherwise reset — a newly
    // picked dashboard's variables differ from the previous one's.
    setDashVarValues(presetValues && typeof presetValues === 'object' ? { ...presetValues } : {});
    setDashConnCandidates({});
    setDashVariables([]);
    if (!d?.id) return;
    let full = d;
    if (!Array.isArray(d?.settings?.variables)) {
      try {
        full = await apiClient.getDashboard(d.id);
      } catch {
        return; // no variables surfaced; the section just won't render
      }
    }
    const vars = (full?.settings?.variables || []).filter(
      (v) => v && (v.mode === 'connection_swap' || v.mode === 'filter'),
    );
    setDashVariables(vars);
    // Fetch connection candidates for each connection_swap variable.
    for (const v of vars) {
      if (v.mode !== 'connection_swap') continue;
      try {
        const res = await apiClient.getDashboardVariableCandidates(d.id, v.name);
        setDashConnCandidates((prev) => ({ ...prev, [v.name]: res?.candidates || [] }));
      } catch {
        setDashConnCandidates((prev) => ({ ...prev, [v.name]: [] }));
      }
    }
  };

  // Build the dashboard_vars map to send: variable name → value, dropping
  // empty selections.
  const buildDashboardVars = () => {
    const out = {};
    for (const v of dashVariables) {
      const val = dashVarValues[v.name];
      if (val != null && String(val).trim() !== '') out[v.name] = String(val);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const handleCreate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.createTSStoreAlertRule({
        type: alertType,
        connection_id: connectionId,
        store_name: isEndpointScoped ? storeName : undefined,
        rule_name: ruleName.trim(),
        condition: condition.trim(),
        cooldown: cooldown.trim() || undefined,
        dashboard_id: dashboardId || undefined,
        // Pre-scope the deep link: variable name → value. Only non-empty
        // values for variables the picked dashboard actually has; dropped
        // entirely when no dashboard is selected (#125).
        dashboard_vars: dashboardId ? buildDashboardVars() : undefined,
        // Only send restart_policy when it diverges from ts-store's
        // implicit default ("now"). max_replay is only valid on
        // resume; sending it with restart_policy=now would 400.
        restart_policy: restartPolicy === 'resume' ? 'resume' : undefined,
        max_replay: restartPolicy === 'resume' && maxReplay.trim() ? maxReplay.trim() : undefined,
        // MQTT sink fields. Only included when alertType=mqtt; the
        // server ignores them otherwise.
        sink_connection_id: alertType === 'mqtt' ? sinkConnectionId : undefined,
        mqtt_topic: alertType === 'mqtt' ? mqttTopic.trim() : undefined,
        mqtt_qos: alertType === 'mqtt' ? Number(mqttQos) : undefined,
      });
      navigate('/design/extensions/tsstore-alerts');
    } catch (err) {
      setError(`Create failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (extLoading) {
    return <div className="tsstore-alert-rule-editor tsstore-alert-rule-editor--loading">Loading…</div>;
  }
  if (!isEnabled('tsstore_alerts')) {
    return <Navigate to="/design" replace />;
  }

  return (
    <div className="tsstore-alert-rule-editor">
      {/* Sticky page-header bar — mirrors ConnectionDetailPage /
          ComponentDetailPage layout: Back on the left, Cancel +
          Save (icon-buttons) on the right. The body scrolls under
          this bar on the page's right edge. */}
      <div className="page-header-bar">
        <div className="header-left">
          <Button
            kind="ghost"
            renderIcon={ArrowLeft}
            size="md"
            onClick={() => navigate('/design/extensions/tsstore-alerts')}
          >
            Back
          </Button>
          <h1>New ts-store alert rule</h1>
        </div>
        <div className="page-actions">
          <Button
            kind="secondary"
            renderIcon={Close}
            size="md"
            onClick={() => navigate('/design/extensions/tsstore-alerts')}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            kind="primary"
            renderIcon={Save}
            size="md"
            onClick={handleCreate}
            disabled={!canSubmit}
          >
            {submitting ? 'Creating…' : 'Save'}
          </Button>
        </div>
      </div>

      {error && (
        <InlineNotification
          kind="error"
          title="Could not create rule"
          subtitle={error}
          onCloseButtonClick={() => setError(null)}
          lowContrast
        />
      )}

      <div className="form-content">
        <Form onSubmit={(e) => { e.preventDefault(); if (canSubmit) handleCreate(); }}>
          {/* 1. Name — identity comes first so the user grounds the
              rule with a label before making any structural choices. */}
          <TextInput
            id="rule-name"
            labelText="Name"
            placeholder="e.g. warehouse-temp-high"
            value={ruleName}
            onChange={(e) => setRuleName(e.target.value)}
            helperText="Unique label; shown on the bell row when the rule fires. Used to derive the default MQTT topic when MQTT delivery is selected."
          />

          {/* 2. Type — drives what the sink picker below renders.
              WebSocket sink is intentionally not exposed; see comment
              on alertType state above. */}
          <FormGroup legendText="Type">
            <RadioButtonGroup
              name="rule-alert-type"
              legendText=""
              orientation="horizontal"
              valueSelected={alertType}
              onChange={(value) => setAlertType(value)}
            >
              <RadioButton id="type-webhook" value="webhook" labelText="Webhook (dashboard bell)" />
              <RadioButton id="type-mqtt" value="mqtt" labelText="MQTT (publish to broker)" />
            </RadioButtonGroup>
          </FormGroup>

          {/* 3. Store — always a TSStore connection. Defines where
              the rule is registered (api endpoint + store name). */}
          <FormGroup legendText="Store">
            {connectionsLoading ? (
              <Loading description="Loading connections" withOverlay={false} small />
            ) : (
              <>
                <div className="connection-row">
                  <div className="namespace-filter-cell">
                    <FilterableMultiSelect
                      id="rule-namespace-filter"
                      titleText="Namespace"
                      items={namespaceOptions}
                      itemToString={(s) => s || ''}
                      selectedItems={namespaceFilter}
                      onChange={({ selectedItems }) => setNamespaceFilter(selectedItems || [])}
                      placeholder="All"
                      size="md"
                    />
                  </div>
                  <div className="connection-cell">
                    <Select
                      id="rule-connection"
                      labelText="ts-store connection"
                      value={connectionId}
                      onChange={(e) => setConnectionId(e.target.value)}
                    >
                      <SelectItem value="" text="Select a connection…" />
                      {visibleConnections.map((c) => (
                        <SelectItem
                          key={c.id}
                          value={c.id}
                          text={`${c.name} (${c.namespace || 'default'})`}
                        />
                      ))}
                    </Select>
                  </div>
                  {/* #248: endpoint-scoped connection → the rule's store is
                      chosen here, from the key's MANAGE-granted stores
                      (alert CRUD is a per-store manage grant). Pinned
                      connections register on their pin and show nothing. */}
                  {isEndpointScoped && (
                    <div className="connection-cell">
                      {Array.isArray(storeOptions) ? (
                        storeOptions.length === 0 ? (
                          <TextInput
                            id="rule-store"
                            labelText="Store"
                            value=""
                            readOnly
                            invalid
                            invalidText="This connection's key has no manage grants — alerts need a key with manage on the target store."
                          />
                        ) : (
                          <ComboBox
                            id="rule-store"
                            titleText="Store"
                            placeholder="Choose a store"
                            items={storeOptions.map((st) => st.name)}
                            selectedItem={storeName || null}
                            onChange={({ selectedItem }) => setStoreName(selectedItem || '')}
                            helperText={storeName ? undefined : 'Required — this connection is endpoint-scoped'}
                          />
                        )
                      ) : (
                        <TextInput
                          id="rule-store"
                          labelText="Store"
                          placeholder="store name"
                          value={storeName}
                          onChange={(e) => setStoreName(e.target.value)}
                          helperText="Required — store list unavailable, enter the name"
                        />
                      )}
                    </div>
                  )}
                </div>
                {isEndpointScoped && !storeName && (
                  <div className="probe-line probe-line--pending">Choose a store to check auth and discover fields.</div>
                )}

                {/* Probe status — feedback on whether the chosen
                    connection's API key will actually be accepted by
                    ts-store. Without this the form would happily
                    submit and then 401 from the create POST. */}
                {connectionId && probe === 'pending' && (
                  <div className="probe-line probe-line--pending">Checking connection auth…</div>
                )}
                {connectionId && probe && probe !== 'pending' && probe.ok && (
                  <div className="probe-line probe-line--ok">
                    Connection authenticates successfully against ts-store.
                  </div>
                )}
                {connectionId && probe && probe !== 'pending' && !probe.ok && (
                  <div className="probe-line probe-line--bad">
                    Cannot use this connection:{' '}
                    {probe.http_status === 401 || probe.http_status === 403 ? (
                      <>
                        ts-store rejected the API key (HTTP {probe.http_status}).{' '}
                        <a
                          href={`/design/connections/${connectionId}`}
                          onClick={(e) => { e.preventDefault(); navigate(`/design/connections/${connectionId}`); }}
                        >
                          Open this connection
                        </a>{' '}
                        and use Test Connection to verify the api_key.
                      </>
                    ) : probe.http_status > 0 ? (
                      <>ts-store returned HTTP {probe.http_status}.</>
                    ) : (
                      <>{probe.error || 'ts-store was unreachable.'}</>
                    )}
                  </div>
                )}
              </>
            )}
          </FormGroup>

          {/* 4. Sink — type-specific. Webhook needs no inputs (the
              dashboard autogenerates the URL); MQTT needs a broker
              connection + topic + QoS. */}
          {alertType === 'webhook' && (
            <FormGroup legendText="Send alerts to">
              <p className="sink-help sink-help--webhook">
                Fires to the dashboard&apos;s bell panel. A per-connection webhook secret is minted automatically; no API-key ceremony required.
              </p>
            </FormGroup>
          )}
          {alertType === 'mqtt' && (
            <FormGroup legendText="Send alerts to">
              {connectionsLoading ? (
                <Loading description="Loading connections" withOverlay={false} small />
              ) : mqttConnections.length === 0 ? (
                <p className="sink-help sink-help--empty">
                  No MQTT connections defined. <a
                    href="/design/connections/new"
                    onClick={(e) => { e.preventDefault(); navigate('/design/connections/new'); }}
                  >Create one</a> first, then return here.
                </p>
              ) : (
                <>
                  <Select
                    id="rule-mqtt-connection"
                    labelText="MQTT broker connection"
                    value={sinkConnectionId}
                    onChange={(e) => setSinkConnectionId(e.target.value)}
                    helperText="Broker URL and credentials are harvested from this connection. The topic below is part of the rule itself."
                  >
                    <SelectItem value="" text="Select an MQTT connection…" />
                    {mqttConnections.map((c) => (
                      <SelectItem
                        key={c.id}
                        value={c.id}
                        text={`${c.name} (${c.namespace || 'default'})`}
                      />
                    ))}
                  </Select>
                  <TextInput
                    id="rule-mqtt-topic"
                    labelText="Topic"
                    placeholder="trve/alerts/<rule-name>"
                    value={mqttTopic}
                    onChange={(e) => {
                      setMqttTopicDirty(true);
                      setMqttTopic(e.target.value);
                    }}
                    helperText="Auto-filled from the rule name under trve/alerts/. The dashboard's bell ingestor (planned) listens to this prefix; topics outside trve/alerts/ won't appear in the bell."
                  />
                  <Select
                    id="rule-mqtt-qos"
                    labelText="QoS"
                    value={mqttQos}
                    onChange={(e) => setMqttQos(e.target.value)}
                    helperText="MQTT delivery guarantee. 0 = at-most-once, 1 = at-least-once (default), 2 = exactly-once."
                  >
                    <SelectItem value="0" text="0 — at most once" />
                    <SelectItem value="1" text="1 — at least once (default)" />
                    <SelectItem value="2" text="2 — exactly once" />
                  </Select>
                </>
              )}
            </FormGroup>
          )}

          {/* 5. Condition — uses fields from the chosen Store. */}
          <FormGroup legendText="Condition">
            {/* Field pills above the condition textarea. Drag a pill
                onto the textarea to insert at the drop point, or click
                to insert at the current cursor. Only shown once a
                connection is selected. */}
            {connectionId && (
              <div className="field-pills">
                <div className="field-pills-label">Available fields</div>
                {fields === 'pending' && (
                  <div className="field-pills-empty">Loading fields…</div>
                )}
                {fields && typeof fields === 'object' && !Array.isArray(fields) && fields.error && (
                  <div className="field-pills-empty">Couldn't load fields: {fields.error}</div>
                )}
                {Array.isArray(fields) && fields.length === 0 && (
                  <div className="field-pills-empty">No fields discovered. Type the field name manually.</div>
                )}
                {Array.isArray(fields) && fields.length > 0 && (
                  <div className="field-pills-row">
                    {/* Sort the pills alphabetically (locale-aware,
                        case-insensitive) so a field is easy to find — the
                        schema returns them in discovery order otherwise. */}
                    {[...fields]
                      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
                      .map((name) => (
                      <Tag
                        key={name}
                        type="blue"
                        size="sm"
                        className="field-pill"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'copy';
                          e.dataTransfer.setData('text/plain', name);
                        }}
                        onClick={() => insertField(name)}
                        title={`Drag onto the condition, or click to insert "${name}" at the cursor`}
                      >
                        {name}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
            )}

            <TextArea
              id="rule-condition"
              ref={conditionRef}
              labelText=""
              placeholder="temperature > 80"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              onDragOver={handleConditionDragOver}
              onDrop={handleConditionDrop}
              helperText="ts-store expression evaluated against each new record. Drag a pill above into the box or click it to insert at the cursor. Supports field comparisons, AND/OR, and parentheses."
              rows={3}
            />
          </FormGroup>

          {/* 6. Policy — cooldown + restart behavior + (conditional)
              max replay window. Cooldown gates spam; restart_policy /
              max_replay control behavior on ts-store server restarts. */}
          <FormGroup legendText="Policy">
            <TextInput
              id="rule-cooldown"
              labelText="Cooldown"
              placeholder="5m"
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
              helperText="Minimum time between consecutive fires of this rule. Empty = no cooldown. Examples: 30s, 5m, 1h."
            />
            <div className="restart-policy-row">
              <RadioButtonGroup
                name="rule-restart-policy"
                legendText="Restart behavior"
                orientation="horizontal"
                valueSelected={restartPolicy}
                onChange={(value) => setRestartPolicy(value)}
              >
                <RadioButton id="restart-now" value="now" labelText="Start from now (no replay)" />
                <RadioButton id="restart-resume" value="resume" labelText="Resume from last seen" />
              </RadioButtonGroup>
              {restartPolicy === 'resume' && (
                <TextInput
                  id="rule-max-replay"
                  labelText="Max replay window"
                  placeholder="1h"
                  value={maxReplay}
                  onChange={(e) => setMaxReplay(e.target.value)}
                  helperText="Empty = unbounded. Examples: 5m, 1h, 24h."
                />
              )}
            </div>
            <p className="restart-policy-help">
              {restartPolicy === 'resume'
                ? 'On server restart, replay records since the last seen timestamp. Use this for event streams (e.g. journal logs) where a missed match matters.'
                : 'On server restart, begin evaluating from now. No replay of past records. Use this for metrics where a brief gap is fine.'}
            </p>
          </FormGroup>

          <FormGroup legendText="Target dashboard (optional)">
            <p className="picker-help">
              Pick a dashboard for the bell row to deep-link to when this rule fires.
              Leave none selected to show the rule without an &quot;Open dashboard&quot; action.
            </p>
            <div className="dashboard-trigger-row">
              <div className="dashboard-trigger-current">
                {dashboardRecord ? (
                  <>
                    <span className="trigger-label">Selected:</span>{' '}
                    <span className="trigger-name">{dashboardRecord.name}</span>
                  </>
                ) : (
                  <span className="trigger-placeholder">No dashboard selected</span>
                )}
              </div>
              <div className="dashboard-trigger-actions">
                <Button kind="tertiary" size="sm" onClick={() => setPickerOpen(true)}>
                  {dashboardRecord ? 'Change…' : 'Select dashboard…'}
                </Button>
                {dashboardRecord && (
                  <Button
                    kind="ghost"
                    size="sm"
                    onClick={() => {
                      setDashboardRecord(null);
                      setDashboardId('');
                      setDashVariables([]);
                      setDashVarValues({});
                      setDashConnCandidates({});
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>

            {/* Pre-scope the deep link with the alert's context (#125). Only
                shows when the picked dashboard has a supported variable. */}
            {dashboardRecord && dashVariables.length > 0 && (
              <div className="dashboard-var-prescope">
                <p className="picker-help">
                  Optionally pass values into the dashboard&apos;s variables so the link
                  opens already scoped to this alert (e.g. the connection that fired).
                </p>
                {dashVariables.map((v) => {
                  const label = v.label || v.name;
                  if (v.mode === 'connection_swap') {
                    // Present EXACTLY like the dashboard viewer's header picker:
                    // a Dropdown of schema-compatible candidates, labelled via
                    // the same candidateLabel (label_tag_prefix aware). A blank
                    // option means "let the viewer pick on open".
                    const labelPrefix = v.connection_swap?.label_tag_prefix || '';
                    const cands = (dashConnCandidates[v.name] || []).filter((c) => c.compatible);
                    const items = [{ id: '', __none: true }, ...cands];
                    const selected = items.find((c) => c.id === (dashVarValues[v.name] || '')) || items[0];
                    return (
                      <div key={v.name} className="dashboard-var-row">
                        <span className="dashboard-var-label">{label} (connection)</span>
                        <div className="dashboard-var-control">
                          <Dropdown
                            id={`dashvar-${v.name}`}
                            size="sm"
                            titleText=""
                            label="Select…"
                            items={items}
                            itemToString={(item) => (item?.__none ? 'None (viewer picks on open)' : candidateLabel(item, labelPrefix))}
                            selectedItem={selected}
                            onChange={({ selectedItem }) => setDashVarValues((p) => {
                              const n = { ...p };
                              if (!selectedItem || selectedItem.__none) delete n[v.name];
                              else n[v.name] = selectedItem.id;
                              return n;
                            })}
                          />
                        </div>
                      </div>
                    );
                  }
                  // filter (text) variable. Mirror the viewer's presentation by
                  // value_source: 'static' → Dropdown of the authored options;
                  // 'freetext' → TextInput. 'connection' (live value discovery)
                  // isn't wired here yet — fall back to freetext with a note
                  // (see the shared-picker follow-up). A blank value = "let the
                  // viewer pick on open".
                  const cfg = v.filter_value || {};
                  const staticOpts = Array.isArray(cfg.options) ? cfg.options : [];
                  const useStatic = cfg.value_source === 'static' && staticOpts.length > 0;
                  return (
                    <div key={v.name} className="dashboard-var-row">
                      <span className="dashboard-var-label">{label} (text)</span>
                      <div className="dashboard-var-control">
                        {useStatic ? (
                          <Select
                            id={`dashvar-${v.name}`}
                            labelText=""
                            value={dashVarValues[v.name] || ''}
                            onChange={(e) => setDashVarValues((p) => ({ ...p, [v.name]: e.target.value }))}
                            size="sm"
                          >
                            <SelectItem value="" text="None (viewer picks on open)" />
                            {staticOpts.map((o) => (
                              <SelectItem key={String(o)} value={String(o)} text={String(o)} />
                            ))}
                          </Select>
                        ) : (
                          <TextInput
                            id={`dashvar-${v.name}`}
                            labelText=""
                            placeholder="Value to pass (leave blank for none)"
                            value={dashVarValues[v.name] || ''}
                            onChange={(e) => setDashVarValues((p) => ({ ...p, [v.name]: e.target.value }))}
                            size="sm"
                          />
                        )}
                      </div>
                      {cfg.value_source === 'connection' && (
                        <span className="dashboard-var-note">
                          This variable discovers its values live in the viewer; type an exact value to pre-scope the link.
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </FormGroup>
        </Form>
      </div>

      <DashboardPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentId={dashboardId || null}
        defaultConnectionId={connectionId || ''}
        defaultNamespaces={namespaceFilter}
        onSelect={(d) => {
          setDashboardRecord(d);
          setDashboardId(d.id);
          handleDashboardChosen(d);
        }}
      />
    </div>
  );
}

export default TsStoreAlertRuleEditorPage;
