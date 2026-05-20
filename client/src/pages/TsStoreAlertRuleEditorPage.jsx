// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Button,
  Form,
  FormGroup,
  TextInput,
  TextArea,
  Select,
  SelectItem,
  FilterableMultiSelect,
  InlineNotification,
  Loading,
  Tag,
} from '@carbon/react';
import { ArrowLeft, Save } from '@carbon/icons-react';
import apiClient from '../api/client';
import useExtensions from '../hooks/useExtensions';
import DashboardPickerModal from '../components/DashboardPickerModal';
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
  const { isEnabled, loading: extLoading } = useExtensions();

  // Form state.
  const [connections, setConnections] = useState([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  // Namespace filter — empty array means "show all" (the default).
  // Populating it narrows the connection list to those namespaces.
  const [namespaceFilter, setNamespaceFilter] = useState([]);
  const [connectionId, setConnectionId] = useState('');
  const [ruleName, setRuleName] = useState('');
  const [condition, setCondition] = useState('');
  const [cooldown, setCooldown] = useState('5m');
  const [dashboardId, setDashboardId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Target-dashboard picker state — we keep the chosen record so we
  // can render its name next to the trigger. Lookup-from-id-only
  // would force another fetch.
  const [dashboardRecord, setDashboardRecord] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // Load tsstore connections once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setConnectionsLoading(true);
      try {
        const data = await apiClient.getConnections({ type: 'tsstore', page_size: 200 });
        if (cancelled) return;
        setConnections(data?.connections || []);
      } catch (err) {
        if (cancelled) return;
        setError(`Failed to load connections: ${err.message || err}`);
      } finally {
        if (!cancelled) setConnectionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Probe the chosen connection's auth posture against ts-store so
  // we can fail fast if the connection's API key won't be accepted.
  // Same endpoint the rule-create POST will exercise, just GET-list
  // instead of POST-create.
  useEffect(() => {
    if (!connectionId) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    setProbe('pending');
    apiClient.probeTSStoreConnection(connectionId)
      .then((r) => { if (!cancelled) setProbe(r); })
      .catch((err) => { if (!cancelled) setProbe({ ok: false, error: err.message || String(err) }); });
    return () => { cancelled = true; };
  }, [connectionId]);

  // Discover field names for the chosen connection. The schema endpoint
  // samples recent records on the ts-store backend; for json stores
  // there's no formal schema, so we get whatever keys appear in the
  // 10 newest records.
  useEffect(() => {
    if (!connectionId) {
      setFields(null);
      return;
    }
    let cancelled = false;
    setFields('pending');
    apiClient.getConnectionSchema(connectionId)
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
  }, [connectionId]);

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

  const canSubmit =
    connectionId &&
    ruleName.trim() &&
    condition.trim() &&
    !submitting &&
    probe && probe !== 'pending' && probe.ok === true;

  const handleCreate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.createTSStoreAlertRule({
        connection_id: connectionId,
        rule_name: ruleName.trim(),
        condition: condition.trim(),
        cooldown: cooldown.trim() || undefined,
        dashboard_id: dashboardId || undefined,
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
      <div className="editor-header">
        <Button
          kind="ghost"
          renderIcon={ArrowLeft}
          onClick={() => navigate('/design/extensions/tsstore-alerts')}
        >
          Back to rules
        </Button>
        <h1>New ts-store alert rule</h1>
        <p>
          Define a condition that fires alerts back into this dashboard&apos;s bell panel.
          The dashboard mints a per-connection webhook secret automatically, so no API key
          ceremony is required.
        </p>
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

      <div className="editor-body">
        <Form onSubmit={(e) => { e.preventDefault(); if (canSubmit) handleCreate(); }}>
          <FormGroup legendText="Connection">
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
                </div>

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

          <FormGroup legendText="Rule">
            <TextInput
              id="rule-name"
              labelText="Name"
              placeholder="e.g. warehouse-temp-high"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              helperText="Unique within this alert; shown on the bell row when the rule fires."
            />

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
                    {fields.map((name) => (
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
              labelText="Condition"
              placeholder="temperature > 80"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              onDragOver={handleConditionDragOver}
              onDrop={handleConditionDrop}
              helperText="ts-store expression evaluated against each new record. Drag a pill above into the box or click it to insert at the cursor. Supports field comparisons, AND/OR, and parentheses."
              rows={3}
            />
            <TextInput
              id="rule-cooldown"
              labelText="Cooldown"
              placeholder="5m"
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
              helperText="Minimum time between consecutive fires of this rule. Empty = no cooldown. Examples: 30s, 5m, 1h."
            />
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
                    onClick={() => { setDashboardRecord(null); setDashboardId(''); }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </FormGroup>
        </Form>
      </div>

      <div className="editor-footer">
        <Button kind="secondary" onClick={() => navigate('/design/extensions/tsstore-alerts')} disabled={submitting}>
          Cancel
        </Button>
        <Button
          kind="primary"
          renderIcon={Save}
          onClick={handleCreate}
          disabled={!canSubmit}
        >
          {submitting ? 'Creating…' : 'Create rule'}
        </Button>
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
        }}
      />
    </div>
  );
}

export default TsStoreAlertRuleEditorPage;
