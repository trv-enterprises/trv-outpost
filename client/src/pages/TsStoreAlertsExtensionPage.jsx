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
  Dropdown,
} from '@carbon/react';
import { TrashCan, Renew, View, Edit } from '@carbon/icons-react';
import apiClient from '../api/client';
import useExtensions from '../hooks/useExtensions';
import CreateMenu from '../components/CreateMenu';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
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
// What makes a rule fire, rendered for the list's Condition column.
// A condition rule shows its expression; a staleness rule has no
// condition at all (ts-store rejects one) and is defined by its
// max_age instead — rendering r.condition for it would leave a blank
// cell under a column header that claims otherwise.
function ruleTrigger(r) {
  if (r.rule_type === 'staleness') {
    return (
      <span className="rule-trigger rule-trigger--staleness">
        <Tag type="cool-gray" size="sm">staleness</Tag>
        <code className="condition">{r.max_age ? `no data for ${r.max_age}` : 'no data'}</code>
      </span>
    );
  }
  if (!r.condition) return <span className="empty-value">—</span>;
  return <code className="condition">{r.condition}</code>;
}

function TsStoreAlertsExtensionPage() {
  const navigate = useNavigate();
  const { isEnabled, loading: extLoading } = useExtensions();

  const [rules, setRules] = useState([]);
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [search, setSearch] = useState('');
  // Column filters, mirroring the connection/component list pages:
  // free-text search stays broad (any field), while these narrow to a
  // specific connection or rule. '' = no filter.
  const [connectionFilter, setConnectionFilter] = useState('');
  const [ruleNameFilter, setRuleNameFilter] = useState('');
  const [ruleTypeFilter, setRuleTypeFilter] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [rulePickerOpen, setRulePickerOpen] = useState(false); // "From Existing" clone-source picker
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

  // Distinct connections + rule names across the loaded rules, for the
  // filter dropdowns. Built from what's actually listed rather than the
  // full connection catalog, so the options can never select nothing.
  // A rule reachable through several connections contributes each one.
  const connectionOptions = useMemo(() => {
    const set = new Set();
    rules.forEach((r) => {
      const conns = r.connections?.length ? r.connections : (r.connection_name ? [{ connection_name: r.connection_name }] : []);
      conns.forEach((c) => { if (c.connection_name) set.add(c.connection_name); });
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rules]);

  const ruleNameOptions = useMemo(() => {
    const set = new Set();
    rules.forEach((r) => { if (r.rule_name) set.add(r.rule_name); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rules]);

  // Rule type — the #242 discriminator. Built from the loaded rules
  // rather than hardcoded, so a type ts-store adds later shows up
  // without a client change.
  const ruleTypeOptions = useMemo(() => {
    const set = new Set();
    rules.forEach((r) => { if (r.rule_type) set.add(r.rule_type); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rules]);

  // The two known rule types are always offered so the filter doesn't
  // appear and disappear as rules change, plus anything unexpected
  // ts-store starts returning.
  const ruleTypeItems = useMemo(
    () => ['', ...new Set(['condition', 'staleness', ...ruleTypeOptions])],
    [ruleTypeOptions],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter((r) => {
      const conns = r.connections?.length ? r.connections : (r.connection_name ? [{ connection_name: r.connection_name }] : []);
      // Column filters are exact-match and AND together with search.
      if (connectionFilter && !conns.some((c) => c.connection_name === connectionFilter)) return false;
      if (ruleNameFilter && r.rule_name !== ruleNameFilter) return false;
      if (ruleTypeFilter && r.rule_type !== ruleTypeFilter) return false;
      if (!q) return true;
      // Free-text search stays broad — any of the visible fields.
      if (r.rule_name?.toLowerCase().includes(q)) return true;
      if (r.condition?.toLowerCase().includes(q)) return true;
      // A staleness rule has no condition; max_age is its defining
      // attribute, so it must be searchable by it.
      if (r.max_age?.toLowerCase().includes(q)) return true;
      if (r.rule_type?.toLowerCase().includes(q)) return true;
      if (r.store_name?.toLowerCase().includes(q)) return true;
      return conns.some((c) => c.connection_name?.toLowerCase().includes(q));
    });
  }, [rules, search, connectionFilter, ruleNameFilter, ruleTypeFilter]);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await apiClient.deleteTSStoreAlert(confirmDelete.connection_id, confirmDelete.alert_id, confirmDelete.store_name);
      setConfirmDelete(null);
      await refresh();
    } catch (err) {
      setFetchError(`Delete failed: ${err.message || err}`);
    } finally {
      setDeleting(false);
    }
  };

  // Build a dashboard deep-link, appending the rule's variable pre-scoping as
  // ?var_<name>=<value> so the list link opens the dashboard scoped exactly like
  // the bell "Open dashboard" action (#125). Empty vars → bare URL.
  const dashboardUrlForRule = (r) => {
    let url = `/view/dashboards/${r.dashboard_id}`;
    const vars = r.dashboard_vars;
    if (vars && typeof vars === 'object') {
      const qs = new URLSearchParams();
      for (const [name, value] of Object.entries(vars)) {
        if (name && value != null && value !== '') qs.set(`var_${name}`, value);
      }
      const q = qs.toString();
      if (q) url += `?${q}`;
    }
    return url;
  };

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
    id: `${r.connection_id}|${r.store_name}|${r.alert_id}|${r.rule_name}`,
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
        {({ rows: rowsView, headers: hdrs, getHeaderProps, getRowProps, getTableProps, getToolbarProps }) => (
          <TableContainer>
            <TableToolbar {...getToolbarProps()}>
              <TableToolbarContent>
                {/* Search is OURS, not Carbon's. `rows` carry only
                    {id, raw} — the cells are rendered by hand below —
                    so Carbon's onInputChange has no cell values to
                    match and rejects every row, which made search
                    report "no rules match" for any term. Filtering
                    happens in `filtered` above; don't re-add
                    onInputChange here. */}
                <TableToolbarSearch
                  placeholder="Search"
                  onChange={(e) => setSearch(e.target.value)}
                  persistent
                  value={search}
                />
                {/* Column filters, matching the connection list page:
                    exact-match narrowing that ANDs with the free-text
                    search. Options come from the loaded rules, so a
                    filter can never select an empty set. */}
                <Dropdown
                  id="alerts-connection-filter"
                  titleText=""
                  label="All connections"
                  items={['', ...connectionOptions]}
                  itemToString={(c) => (c === '' ? 'All connections' : c)}
                  selectedItem={connectionFilter}
                  onChange={({ selectedItem }) => setConnectionFilter(selectedItem || '')}
                  size="md"
                />
                <Dropdown
                  id="alerts-rule-filter"
                  titleText=""
                  label="All rules"
                  items={['', ...ruleNameOptions]}
                  itemToString={(n) => (n === '' ? 'All rules' : n)}
                  selectedItem={ruleNameFilter}
                  onChange={({ selectedItem }) => setRuleNameFilter(selectedItem || '')}
                  size="md"
                />
                {/* Rule type — condition vs staleness (#242). Always
                    offered, even when the current rules are all one
                    type: hiding it would make the filter appear and
                    disappear as rules change, and it is how a user
                    discovers that staleness rules exist at all. */}
                {(
                  <Dropdown
                    id="alerts-ruletype-filter"
                    titleText=""
                    label="Fires when: any"
                    items={ruleTypeItems}
                    itemToString={(t) => {
                      if (t === '') return 'Fires when: any';
                      return t === 'staleness' ? 'No data arrives' : 'Record matches';
                    }}
                    selectedItem={ruleTypeFilter}
                    onChange={({ selectedItem }) => setRuleTypeFilter(selectedItem || '')}
                    size="md"
                  />
                )}
                <ResetFiltersButton
                  active={!!search || !!connectionFilter || !!ruleNameFilter || !!ruleTypeFilter}
                  onReset={() => {
                    setSearch('');
                    setConnectionFilter('');
                    setRuleNameFilter('');
                    setRuleTypeFilter('');
                  }}
                />
                <Button
                  kind="ghost"
                  renderIcon={Renew}
                  iconDescription="Refresh"
                  hasIconOnly
                  onClick={refresh}
                />
                {/* Create dropdown — Create Rule / From Existing (clone),
                    matching the connection/component pattern. No AI option. */}
                <CreateMenu
                  onCreate={() => navigate('/design/extensions/tsstore-alerts/new')}
                  onSelectExisting={() => setRulePickerOpen(true)}
                />
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
                          <TableCell>{ruleTrigger(r)}</TableCell>
                          <TableCell>{r.cooldown || <span className="muted">—</span>}</TableCell>
                          <TableCell>
                            {r.dashboard_id ? (
                              dash ? (
                                <Link onClick={(e) => { e.preventDefault(); navigate(dashboardUrlForRule(r)); }} href={dashboardUrlForRule(r)}>
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
                              onClick={() => navigate(
                                `/design/extensions/tsstore-alerts/${r.connection_id}/${r.alert_id}?store=${encodeURIComponent(r.store_name || '')}`,
                                // Carry manage-ability through: the detail
                                // read can't compute it, so the view page
                                // relies on this to decide whether to
                                // offer Edit.
                                { state: { canManage: r.can_manage !== false } },
                              )}
                            >
                              <View />
                            </IconButton>
                            {/* can_manage=false → the key can SEE this rule
                                (alert reads are read-classed since ts-store
                                v0.20.3) but not administer it — disable
                                rather than offer an edit/delete that would
                                403. Store rides in router state; the edit
                                form needs it to address the right alert. */}
                            <IconButton
                              kind="ghost"
                              label={r.can_manage === false
                                ? 'View only — the connection key lacks manage on this store'
                                : 'Edit rule'}
                              disabled={r.can_manage === false}
                              onClick={() => navigate(
                                `/design/extensions/tsstore-alerts/${r.connection_id}/${r.alert_id}/edit?store=${encodeURIComponent(r.store_name || '')}`,
                                { state: { store: r.store_name || '' } },
                              )}
                            >
                              <Edit />
                            </IconButton>
                            <IconButton
                              kind="ghost"
                              label={r.can_manage === false
                                ? 'View only — the connection key lacks manage on this store'
                                : 'Delete alert'}
                              disabled={r.can_manage === false}
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
          </div>
        )}
      </Modal>

      {/* "From Existing" — pick a rule to clone into a new one. Rules are
          already loaded, so this is a plain list; on select we navigate to the
          create editor with the source rule in router state (#152). */}
      <Modal
        open={rulePickerOpen}
        modalHeading="Create from existing rule"
        passiveModal
        onRequestClose={() => setRulePickerOpen(false)}
      >
        <p className="picker-help">
          Pick a rule to prefill the editor with its values. Nothing is created
          until you save the new rule.
        </p>
        {rules.length === 0 ? (
          <p className="muted">No existing rules to clone.</p>
        ) : (
          <div className="rule-clone-list">
            {rules.map((r) => (
              <button
                key={`${r.connection_id}|${r.store_name}|${r.alert_id}|${r.rule_name}`}
                type="button"
                className="rule-clone-item"
                onClick={() => {
                  setRulePickerOpen(false);
                  navigate('/design/extensions/tsstore-alerts/new', { state: { cloneFrom: r } });
                }}
              >
                <span className="rule-clone-name">{r.rule_name}</span>
                <Tag size="sm">{r.alert_type}</Tag>
                <code className="rule-clone-condition">
                  {r.rule_type === 'staleness' ? `no data for ${r.max_age || '?'}` : r.condition}
                </code>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default TsStoreAlertsExtensionPage;
