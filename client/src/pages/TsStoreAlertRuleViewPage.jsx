// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Form,
  FormGroup,
  TextInput,
  TextArea,
  RadioButtonGroup,
  RadioButton,
  InlineNotification,
  Loading,
  Link,
} from '@carbon/react';
import { ArrowLeft, Close } from '@carbon/icons-react';
import apiClient from '../api/client';
import useExtensions from '../hooks/useExtensions';
import './TsStoreAlertRuleEditorPage.scss';

/**
 * Read-only view of a single ts-store alert rule.
 *
 * Mirrors the create-editor's layout (Name → Type → Store → Send-to
 * → Condition → Policy → Target dashboard) but every input is
 * disabled / readOnly so the page is purely informational. There
 * is no save action — the only way to mutate a rule is delete-and-
 * recreate, which lives on the list page. To keep the surface
 * tight, this page exposes only "Back to rules" as an action.
 *
 * Data comes from a fresh GET against the dashboard's
 * /api/tsstore-alerts/rules/:alert_id?connection_id=... endpoint,
 * which proxies the full alert detail (status + transport block
 * with rule fields, restart policy, max_replay, etc.) from the
 * owning tsstore. ts-store redacts secret-bearing fields before
 * returning, so what lands in the form has been scrubbed by the
 * source.
 */
function TsStoreAlertRuleViewPage() {
  const navigate = useNavigate();
  const { connectionId, alertId } = useParams();
  const { isEnabled, loading: extLoading } = useExtensions();

  const [detail, setDetail] = useState(null);
  // Connection + dashboard resolution — alert.target_dashboard only
  // gives us an id; we want the display name. Fetched lazily.
  const [connection, setConnection] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!connectionId || !alertId) return;
    let cancelled = false;
    setLoading(true);
    apiClient
      .getTSStoreAlertDetail(connectionId, alertId)
      .then(async (d) => {
        if (cancelled) return;
        setDetail(d);
        // Best-effort connection name lookup — non-fatal.
        try {
          const conn = await apiClient.getConnection(connectionId);
          if (!cancelled) setConnection(conn);
        } catch {
          // leave name as the raw id; the page still loads.
        }
        // Decode target dashboard id from external_ref if present.
        const ref = sinkBlock(d)?.external_ref;
        const dashboardId = decodeDashboardId(ref);
        if (dashboardId) {
          try {
            const dash = await apiClient.getDashboard(dashboardId);
            if (!cancelled) setDashboard(dash);
          } catch {
            // unknown dashboard — render the raw id below.
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [connectionId, alertId]);

  if (extLoading) {
    return <div className="tsstore-alert-rule-editor tsstore-alert-rule-editor--loading">Loading…</div>;
  }
  if (!isEnabled('tsstore_alerts')) {
    return <Navigate to="/design" replace />;
  }

  const handleBack = () => navigate('/design/extensions/tsstore-alerts');

  const sink = detail ? sinkBlock(detail) : null;
  const type = detail?.type || '';
  const ruleName = detail?.rule_name || sink?.name || '';
  const condition = sink?.condition || '';
  const cooldown = sink?.cooldown || '';
  const restartPolicy = sink?.restart_policy || 'now';
  const maxReplay = sink?.max_replay || '';
  const dashboardId = decodeDashboardId(sink?.external_ref);

  return (
    <div className="tsstore-alert-rule-editor">
      {/* Sticky page-header bar — same layout as the editor and as
          ConnectionDetailPage / ComponentDetailPage. Cancel sits in
          the same slot the editor uses so the affordance is
          consistent across create + view; this page has no Save
          since it's read-only. */}
      <div className="page-header-bar">
        <div className="header-left">
          <Button
            kind="ghost"
            renderIcon={ArrowLeft}
            size="md"
            onClick={handleBack}
          >
            Back
          </Button>
          <h1>Rule details</h1>
        </div>
        <div className="page-actions">
          <Button
            kind="secondary"
            renderIcon={Close}
            size="md"
            onClick={handleBack}
          >
            Cancel
          </Button>
        </div>
      </div>

      {error && (
        <InlineNotification
          kind="error"
          title="Could not load rule"
          subtitle={error}
          onCloseButtonClick={() => setError(null)}
          lowContrast
        />
      )}

      {loading && !detail ? (
        <div className="form-content">
          <Loading description="Loading rule" withOverlay={false} small />
        </div>
      ) : detail ? (
        <div className="form-content">
          <Form onSubmit={(e) => e.preventDefault()}>
            <TextInput
              id="view-rule-name"
              labelText="Name"
              value={ruleName}
              readOnly
              helperText="Unique label shown on the bell row when the rule fires."
            />

            <FormGroup legendText="Type">
              <RadioButtonGroup
                name="view-rule-alert-type"
                legendText=""
                orientation="horizontal"
                valueSelected={type}
                onChange={() => {}}
                disabled
              >
                <RadioButton id="view-type-webhook" value="webhook" labelText="Webhook (dashboard bell)" />
                <RadioButton id="view-type-mqtt" value="mqtt" labelText="MQTT (publish to broker)" />
              </RadioButtonGroup>
            </FormGroup>

            <FormGroup legendText="Store">
              <TextInput
                id="view-rule-connection"
                labelText="ts-store connection"
                value={connection ? `${connection.name} (${connection.namespace || 'default'})` : connectionId}
                readOnly
                helperText={connection?.config?.tsstore?.store_name ? `store: ${connection.config.tsstore.store_name}` : undefined}
              />
            </FormGroup>

            {type === 'webhook' && (
              <FormGroup legendText="Send alerts to">
                <TextInput
                  id="view-rule-webhook-url"
                  labelText="Webhook URL"
                  value={sink?.url || ''}
                  readOnly
                  helperText="Where ts-store POSTs the alert payload. The dashboard mints this URL automatically for rules created here."
                />
                {sink?.timeout && (
                  <TextInput
                    id="view-rule-webhook-timeout"
                    labelText="Timeout"
                    value={sink.timeout}
                    readOnly
                  />
                )}
              </FormGroup>
            )}

            {type === 'mqtt' && (
              <FormGroup legendText="Send alerts to">
                <TextInput
                  id="view-rule-mqtt-broker"
                  labelText="Broker URL"
                  value={sink?.broker_url || ''}
                  readOnly
                />
                <TextInput
                  id="view-rule-mqtt-topic"
                  labelText="Topic"
                  value={sink?.topic || ''}
                  readOnly
                />
                <TextInput
                  id="view-rule-mqtt-qos"
                  labelText="QoS"
                  value={sink?.qos != null ? String(sink.qos) : '1'}
                  readOnly
                />
              </FormGroup>
            )}

            <FormGroup legendText="Condition">
              <TextArea
                id="view-rule-condition"
                labelText=""
                value={condition}
                readOnly
                rows={3}
                helperText="ts-store expression evaluated against each new record."
              />
            </FormGroup>

            <FormGroup legendText="Policy">
              <TextInput
                id="view-rule-cooldown"
                labelText="Cooldown"
                value={cooldown || ''}
                readOnly
                helperText={cooldown ? 'Minimum time between consecutive fires.' : 'No cooldown — every match fires.'}
              />
              <div className="restart-policy-row">
                <RadioButtonGroup
                  name="view-rule-restart-policy"
                  legendText="Restart behavior"
                  orientation="horizontal"
                  valueSelected={restartPolicy}
                  onChange={() => {}}
                  disabled
                >
                  <RadioButton id="view-restart-now" value="now" labelText="Start from now (no replay)" />
                  <RadioButton id="view-restart-resume" value="resume" labelText="Resume from last seen" />
                </RadioButtonGroup>
                {restartPolicy === 'resume' && (
                  <TextInput
                    id="view-rule-max-replay"
                    labelText="Max replay window"
                    value={maxReplay || ''}
                    readOnly
                    helperText={maxReplay ? undefined : 'unbounded'}
                  />
                )}
              </div>
            </FormGroup>

            <FormGroup legendText="Target dashboard">
              <div className="dashboard-trigger-row">
                <div className="dashboard-trigger-current">
                  {dashboardId ? (
                    dashboard ? (
                      <>
                        <span className="trigger-label">Selected:</span>{' '}
                        <Link
                          href={`/view/dashboards/${dashboardId}`}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(`/view/dashboards/${dashboardId}`);
                          }}
                        >
                          {dashboard.name}
                        </Link>
                      </>
                    ) : (
                      <span className="trigger-placeholder">Unknown ({dashboardId.slice(0, 8)}…)</span>
                    )
                  ) : (
                    <span className="trigger-placeholder">No dashboard selected</span>
                  )}
                </div>
              </div>
            </FormGroup>
          </Form>
        </div>
      ) : null}
    </div>
  );
}

// ts-store's GET /alerts/:id returns one of webhook/mqtt at top
// level depending on the alert's type. Helper returns whichever
// block is present.
function sinkBlock(detail) {
  if (!detail) return null;
  return detail.webhook || detail.mqtt || detail.ws || null;
}

// external_ref carries JSON.stringify({dashboard_id}) for rules the
// dashboard owns. Soft-fail: anything malformed returns '' so non-
// dashboard producers don't crash the page.
function decodeDashboardId(externalRef) {
  if (!externalRef) return '';
  try {
    const parsed = JSON.parse(externalRef);
    return parsed?.dashboard_id || '';
  } catch {
    return '';
  }
}

export default TsStoreAlertRuleViewPage;
