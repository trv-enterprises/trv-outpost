// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  DataTable,
  TableContainer,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Button,
  IconButton,
  InlineNotification,
  Loading,
  Tag,
  Link,
  Modal,
} from '@carbon/react';
import { TrashCan, Renew, View } from '@carbon/icons-react';
import apiClient from '../api/client';
import useExtensions from '../hooks/useExtensions';
import './TsStoreAlertsExtensionPage.scss';

/**
 * ts-store Alerts extension — central page that aggregates every
 * ts-store alert rule across every tsstore connection. ts-store is
 * the source of truth for rules; this page is the editor over its
 * API.
 *
 * Capabilities: list, search, refresh, delete (whole alert), and
 * "+ New rule" launches the create-rule editor at
 * /design/extensions/tsstore-alerts/new.
 */
function TsStoreAlertsExtensionPage() {
  const navigate = useNavigate();
  const { isEnabled, loading: extLoading } = useExtensions();

  const [rules, setRules] = useState([]);
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [dashboardsById, setDashboardsById] = useState({});

  const refresh = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const data = await apiClient.listTSStoreAlertRules();
      setRules(data?.rules || []);
      setErrors(data?.errors || []);
    } catch (err) {
      setFetchError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  // Resolve dashboard names for the "target dashboard" column so we
  // can render the user-friendly name instead of a UUID. One bulk
  // fetch; missing IDs (deleted dashboards) just render as the raw
  // UUID with a subtle marker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiClient.getDashboards({ page: 1, page_size: 200 });
        if (cancelled) return;
        const byId = {};
        (data?.dashboards || []).forEach((d) => { byId[d.id] = d; });
        setDashboardsById(byId);
      } catch {
        // Non-fatal — the column falls back to raw IDs.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (isEnabled('tsstore_alerts')) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extLoading]);

  const filtered = useMemo(() => {
    if (!search) return rules;
    const q = search.toLowerCase();
    return rules.filter((r) => {
      if (r.rule_name?.toLowerCase().includes(q)) return true;
      if (r.condition?.toLowerCase().includes(q)) return true;
      if (r.store_name?.toLowerCase().includes(q)) return true;
      const conns = r.connections?.length ? r.connections : (r.connection_name ? [{ connection_name: r.connection_name }] : []);
      return conns.some((c) => c.connection_name?.toLowerCase().includes(q));
    });
  }, [rules, search]);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await apiClient.deleteTSStoreAlert(confirmDelete.connection_id, confirmDelete.alert_id);
      setConfirmDelete(null);
      await refresh();
    } catch (err) {
      setFetchError(`Delete failed: ${err.message || err}`);
    } finally {
      setDeleting(false);
    }
  };

  // Group rules by alert_id so the confirmation modal can warn when
  // deleting an alert nukes more than one rule (ts-store delete is
  // alert-level, not rule-level).
  const siblingRuleCount = (alertId) =>
    rules.filter((r) => r.alert_id === alertId).length;

  if (extLoading) {
    return <div className="tsstore-alerts-extension-page tsstore-alerts-extension-page--loading">Loading…</div>;
  }

  if (!isEnabled('tsstore_alerts')) {
    return <Navigate to="/design" replace />;
  }

  const headers = [
    { key: 'connection', header: 'Connection' },
    { key: 'rule_name', header: 'Rule' },
    { key: 'condition', header: 'Condition' },
    { key: 'cooldown', header: 'Cooldown' },
    { key: 'target_dashboard', header: 'Target dashboard' },
    { key: 'state', header: 'State' },
    { key: 'actions', header: '' },
  ];

  const rows = filtered.map((r) => ({
    id: `${r.connection_id}|${r.alert_id}|${r.rule_name}`,
    raw: r,
  }));

  return (
    <div className="tsstore-alerts-extension-page">
      <div className="page-header">
        <h1>ts-store Alerts</h1>
        <p>
          Manage ts-store alert rules across every tsstore connection. Rules
          created here, via the ts-store CLI, or via scripts all appear in
          one place.
        </p>
      </div>

      {fetchError && (
        <InlineNotification
          kind="error"
          title="Failed to load alert rules"
          subtitle={fetchError}
          onCloseButtonClick={() => setFetchError(null)}
          lowContrast
        />
      )}

      {errors.length > 0 && (
        <InlineNotification
          kind="warning"
          title="Some connections did not respond"
          subtitle={errors.map((e) => `${e.connection_name}: ${e.error}`).join('; ')}
          hideCloseButton
          lowContrast
        />
      )}

      <DataTable rows={rows} headers={headers} isSortable>
        {({ rows: rowsView, headers: hdrs, getHeaderProps, getRowProps, getTableProps, getToolbarProps, onInputChange }) => (
          <TableContainer>
            <TableToolbar {...getToolbarProps()}>
              <TableToolbarContent>
                <TableToolbarSearch
                  placeholder="Search rules, conditions, connections…"
                  onChange={(e) => { setSearch(e.target.value); onInputChange(e); }}
                  persistent
                />
                <Button
                  kind="ghost"
                  renderIcon={Renew}
                  iconDescription="Refresh"
                  hasIconOnly
                  onClick={refresh}
                />
                <Button
                  kind="primary"
                  onClick={() => navigate('/design/extensions/tsstore-alerts/new')}
                >
                  + New rule
                </Button>
              </TableToolbarContent>
            </TableToolbar>
            {loading ? (
              <Loading description="Loading rules" withOverlay={false} small />
            ) : (
              <Table {...getTableProps()}>
                <TableHead>
                  <TableRow>
                    {hdrs.map((h) => {
                      const { key: hKey, ...headerProps } = getHeaderProps({ header: h });
                      return (
                        <TableHeader key={hKey ?? h.key} {...headerProps}>
                          {h.header}
                        </TableHeader>
                      );
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rowsView.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={headers.length} className="empty-cell">
                        {rules.length === 0
                          ? 'No alert rules found. Create one on a tsstore connection to see it here.'
                          : 'No rules match your search.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    rowsView.map((row) => {
                      const r = rows.find((x) => x.id === row.id)?.raw;
                      if (!r) return null;
                      const dash = r.dashboard_id ? dashboardsById[r.dashboard_id] : null;
                      const { key: rowKey, ...rowProps } = getRowProps({ row });
                      return (
                        <TableRow key={rowKey ?? row.id} {...rowProps}>
                          <TableCell>
                            <div className="cell-primary">{r.connection_name}</div>
                            <div className="cell-secondary">{r.store_name}</div>
                            {r.connections && r.connections.length > 1 && (
                              <div
                                className="cell-secondary cell-shared"
                                title={r.connections.map((c) => c.connection_name).join('\n')}
                              >
                                Also via: {r.connections.filter((c) => c.connection_id !== r.connection_id).map((c) => c.connection_name).join(', ')}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="cell-primary">{r.rule_name}</div>
                            <div className="cell-secondary">
                              <Tag size="sm">{r.alert_type}</Tag>
                            </div>
                          </TableCell>
                          <TableCell><code className="condition">{r.condition}</code></TableCell>
                          <TableCell>{r.cooldown || <span className="muted">—</span>}</TableCell>
                          <TableCell>
                            {r.dashboard_id ? (
                              dash ? (
                                <Link onClick={(e) => { e.preventDefault(); navigate(`/view/dashboards/${r.dashboard_id}`); }} href={`/view/dashboards/${r.dashboard_id}`}>
                                  {dash.name}
                                </Link>
                              ) : (
                                <span className="muted" title={r.dashboard_id}>Unknown ({r.dashboard_id.slice(0, 8)})</span>
                              )
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Tag type={r.state === 'running' ? 'green' : r.state === 'error' ? 'red' : 'gray'} size="sm">
                              {r.state || 'unknown'}
                            </Tag>
                            {r.alerts_fired > 0 && (
                              <div className="cell-secondary">{r.alerts_fired} fired</div>
                            )}
                          </TableCell>
                          <TableCell className="actions-cell">
                            <IconButton
                              kind="ghost"
                              label="View rule details"
                              onClick={() => navigate(`/design/extensions/tsstore-alerts/${r.connection_id}/${r.alert_id}`)}
                            >
                              <View />
                            </IconButton>
                            <IconButton
                              kind="ghost"
                              label="Delete alert"
                              onClick={() => setConfirmDelete(r)}
                            >
                              <TrashCan />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            )}
          </TableContainer>
        )}
      </DataTable>

      <Modal
        open={!!confirmDelete}
        modalHeading="Delete alert?"
        primaryButtonText={deleting ? 'Deleting…' : 'Delete alert'}
        secondaryButtonText="Cancel"
        danger
        onRequestClose={() => setConfirmDelete(null)}
        onRequestSubmit={handleDelete}
        primaryButtonDisabled={deleting}
      >
        {confirmDelete && (
          <div className="delete-confirm">
            <p>
              Delete alert <strong>{confirmDelete.alert_id.slice(0, 8)}…</strong> on{' '}
              <strong>{confirmDelete.connection_name}</strong>?
            </p>
            {confirmDelete.connections && confirmDelete.connections.length > 1 && (
              <InlineNotification
                kind="info"
                title="Shared across multiple connections"
                subtitle={`This alert lives on a ts-store backend reachable through ${confirmDelete.connections.length} dashboard connections: ${confirmDelete.connections.map((c) => c.connection_name).join(', ')}. Deleting it removes the alert for all of them.`}
                hideCloseButton
                lowContrast
              />
            )}
            {siblingRuleCount(confirmDelete.alert_id) > 1 && (
              <InlineNotification
                kind="warning"
                title="This alert has multiple rules"
                subtitle={`Deleting will remove all ${siblingRuleCount(confirmDelete.alert_id)} rules on this alert. ts-store does not support per-rule delete.`}
                hideCloseButton
                lowContrast
              />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default TsStoreAlertsExtensionPage;
