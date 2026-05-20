// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useState } from 'react';
import { Modal, Search, Dropdown, Loading } from '@carbon/react';
import apiClient from '../api/client';
import NamespaceFilter from './shared/NamespaceFilter';
import TagFilter from './shared/TagFilter';
import ResetFiltersButton from './shared/ResetFiltersButton';
import DashboardTile from './DashboardTile';
import './DashboardPickerModal.scss';

/**
 * Modal dashboard picker. Mirrors the View-mode landing-page tile
 * experience (search + namespace + tag + connection filters, tile
 * grid) so the user picks a target the same way regardless of where
 * the picker is invoked from. Used by the ts-store rule wizard's
 * "target dashboard" affordance and any future form that needs to
 * pick one dashboard.
 *
 * Props:
 *   open               — modal visibility
 *   onClose            — () => void
 *   onSelect           — (dashboard) => void
 *   currentId          — optional, dashboard to pre-select
 *   defaultConnectionId — optional, pre-fills the connection filter
 *                        with this connection id (single-select). Use
 *                        from forms that already know the relevant
 *                        connection. User can switch to "All".
 *   defaultNamespaces  — optional string[], pre-fills the namespace
 *                        filter. Empty / unset = no namespace filter.
 *   heading            — optional modal title
 */
function DashboardPickerModal({
  open,
  onClose,
  onSelect,
  currentId = null,
  defaultConnectionId = '',
  defaultNamespaces = [],
  heading = 'Select a dashboard',
}) {
  // Confirmed selection — what we'll hand back to the parent on
  // primary-button submit. Defaults to currentId so a re-open shows
  // the previously-saved pick.
  const [pending, setPending] = useState(null);

  // Data fetched in parallel — same set the View-mode page loads.
  const [dashboards, setDashboards] = useState([]);
  const [components, setComponents] = useState({});       // id -> component
  const [connectionMap, setConnectionMap] = useState({}); // id -> name
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters.
  const [search, setSearch] = useState('');
  const [namespaceFilter, setNamespaceFilter] = useState(defaultNamespaces);
  const [tagFilter, setTagFilter] = useState([]);
  const [connectionFilter, setConnectionFilter] = useState(defaultConnectionId || 'all');

  // Refresh defaults each time the modal is opened — the parent
  // form's active connection / namespace selection may have changed.
  useEffect(() => {
    if (open) {
      setNamespaceFilter(defaultNamespaces || []);
      setConnectionFilter(defaultConnectionId || 'all');
      setSearch('');
      setTagFilter([]);
      setPending(null);
    }
  }, [open, defaultConnectionId, defaultNamespaces]);

  // Load dashboards + components + connections in parallel. We need
  // all three to render connection tags on tiles and to support the
  // connection filter.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [dRes, cRes, connRes] = await Promise.all([
          apiClient.getDashboards({ page: 1, page_size: 200 }),
          apiClient.getComponents(),
          apiClient.getConnections(),
        ]);
        if (cancelled) return;
        setDashboards(dRes?.dashboards || []);
        const compMap = {};
        (cRes?.components || []).forEach((c) => { compMap[c.id] = c; });
        setComponents(compMap);
        const connNames = {};
        (connRes?.connections || []).forEach((c) => { connNames[c.id] = c.name; });
        setConnectionMap(connNames);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Single source of truth for "does this dashboard reference
  // connection X" — mirrors DashboardTileViewPage so behavior is
  // consistent.
  const dashboardUsesConnection = (dashboard, connectionId) => {
    if (!dashboard.panels) return false;
    return dashboard.panels.some((p) => {
      if (!p.component_id) return false;
      const c = components[p.component_id];
      if (!c) return false;
      if (c.connection_id === connectionId) return true;
      const dc = c.display_config;
      if (dc?.frigate_connection_id === connectionId) return true;
      if (dc?.mqtt_connection_id === connectionId) return true;
      return false;
    });
  };

  const filtered = useMemo(() => {
    let out = dashboards;
    if (namespaceFilter && namespaceFilter.length > 0) {
      const set = new Set(namespaceFilter);
      out = out.filter((d) => set.has(d.namespace || 'default'));
    }
    if (tagFilter && tagFilter.length > 0) {
      const wanted = new Set(tagFilter);
      out = out.filter((d) => (d.tags || []).some((t) => wanted.has(t)));
    }
    if (connectionFilter && connectionFilter !== 'all') {
      out = out.filter((d) => dashboardUsesConnection(d, connectionFilter));
    }
    if (search) {
      const q = search.toLowerCase();
      out = out.filter((d) =>
        d.name?.toLowerCase().includes(q) ||
        (d.description && d.description.toLowerCase().includes(q))
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboards, components, namespaceFilter, tagFilter, connectionFilter, search]);

  const handleConfirm = () => {
    if (pending) onSelect?.(pending);
    onClose?.();
  };

  const handleCancel = () => {
    setPending(null);
    onClose?.();
  };

  const filtersActive =
    !!search ||
    namespaceFilter.length > 0 ||
    tagFilter.length > 0 ||
    connectionFilter !== 'all';

  const connectionOptions = useMemo(() => [
    { id: 'all', text: 'All Connections' },
    ...Object.entries(connectionMap).map(([id, name]) => ({ id, text: name })),
  ], [connectionMap]);

  const selectedConnectionItem = useMemo(() => {
    if (connectionFilter === 'all') return { id: 'all', text: 'All Connections' };
    return {
      id: connectionFilter,
      text: connectionMap[connectionFilter] || 'Unknown',
    };
  }, [connectionFilter, connectionMap]);

  const selectedId = pending?.id || currentId;

  return (
    <Modal
      open={open}
      onRequestClose={handleCancel}
      modalHeading={heading}
      primaryButtonText="Select"
      secondaryButtonText="Cancel"
      onRequestSubmit={handleConfirm}
      primaryButtonDisabled={!pending}
      size="lg"
    >
      <div className="dashboard-picker-modal">
        <div className="picker-toolbar">
          <Search
            size="md"
            placeholder="Search dashboards…"
            labelText="Search"
            closeButtonLabelText="Clear search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <NamespaceFilter
            id="dashboard-picker-modal-namespace"
            selected={namespaceFilter}
            onChange={setNamespaceFilter}
          />
          <TagFilter
            entityType="dashboards"
            selected={tagFilter}
            onChange={setTagFilter}
          />
          <Dropdown
            id="dashboard-picker-modal-connection"
            className="connection-filter-dropdown"
            label="Filter by connection"
            titleText=""
            items={connectionOptions}
            itemToString={(item) => item?.text || ''}
            selectedItem={selectedConnectionItem}
            onChange={({ selectedItem }) => setConnectionFilter(selectedItem?.id || 'all')}
            size="md"
          />
          <ResetFiltersButton
            active={filtersActive}
            onReset={() => {
              setSearch('');
              setNamespaceFilter([]);
              setTagFilter([]);
              setConnectionFilter('all');
            }}
          />
        </div>

        {error && <div className="picker-error">{error}</div>}

        {loading ? (
          <Loading description="Loading dashboards" withOverlay={false} small />
        ) : filtered.length === 0 ? (
          <div className="picker-empty">
            {dashboards.length === 0
              ? 'No dashboards exist yet.'
              : 'No dashboards match the current filters.'}
          </div>
        ) : (
          <div className="picker-tiles">
            {filtered.map((d) => (
              <DashboardTile
                key={d.id}
                dashboard={d}
                componentMap={components}
                connectionMap={connectionMap}
                selected={selectedId === d.id}
                onClick={() => setPending(d)}
                onDoubleClick={() => { setPending(d); onSelect?.(d); onClose?.(); }}
                descriptionMode="inline"
                showRefreshInterval
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default DashboardPickerModal;
