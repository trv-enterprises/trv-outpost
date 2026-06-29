// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef } from 'react';
import {
  Modal,
  TreeView,
  TreeNode,
  ContentSwitcher,
  Switch,
  Toggle,
  Button,
  Tag,
  Search,
  InlineLoading,
  InlineNotification,
} from '@carbon/react';
import {
  DataBase,
  ChartLineSmooth,
  Dashboard,
  Folder,
  Edit,
  Renew,
} from '@carbon/icons-react';
import { useResourceNavigator } from '../../context/ResourceNavigatorContext';
import useResourceGraph from '../../hooks/useResourceGraph';
import { rootTree } from '../../utils/resourceGraph';
import NamespaceChip from '../shared/NamespaceChip';
import NamespaceFilter from '../shared/NamespaceFilter';
import TagFilter from '../shared/TagFilter';
import './ResourceNavigatorModal.scss';

// The entity-map key in `graph` for each root kind (root kind === rooting).
const ROOT_MAP_BY_KIND = {
  dashboard: 'dashboardsById',
  component: 'componentsById',
  connection: 'connectionsById',
};

// TagFilter's `entityType` (plural) for each root kind, so the tag dropdown
// only offers tags used by the CURRENT root type — not every entity.
const TAG_ENTITY_BY_KIND = {
  dashboard: 'dashboards',
  component: 'components',
  connection: 'connections',
};

const ROOT_OPTIONS = [
  { key: 'dashboard', text: 'Dashboard' },
  { key: 'component', text: 'Component' },
  { key: 'connection', text: 'Connection' },
];

const ICON_BY_KIND = {
  dashboard: Dashboard,
  component: ChartLineSmooth,
  connection: DataBase,
  group: Folder,
};

const EDITOR_ROUTE = {
  dashboard: (id) => `/design/dashboards/${id}`,
  component: (id) => `/design/components/${id}`,
  connection: (id) => `/design/connections/${id}`,
};

/**
 * ResourceNavigatorModal
 *
 * Two-pane modal: TreeView (left) over the connection↔component↔dashboard graph
 * + an info panel (right). Selecting a node shows its details on the right and
 * does NOT navigate; the "Open editor" button routes + closes the modal.
 *
 * Root-direction ContentSwitcher re-roots the same graph three ways. In the
 * dashboard-rooted view a Toggle controls whether each component nests its
 * connection(s) (default off; the dashboard always shows a flat connection
 * group regardless).
 */
function ResourceNavigatorModal({ navigate }) {
  const {
    open,
    closeModal,
    rootDirection,
    setRootDirection,
    showConnectionsUnderComponents,
    setShowConnectionsUnderComponents,
    expandedIds,
    toggleExpanded,
    selectedNode,
    setSelectedNode,
    scrollTopRef,
    setScrollTop,
    search,
    setSearch,
    filterNamespaces,
    setFilterNamespaces,
    filterTags,
    setFilterTags,
  } = useResourceNavigator();

  const { graph, loading, error, refresh, loadedOnce } = useResourceGraph({ enabled: open });
  const treeScrollRef = useRef(null);

  const fullTree = useMemo(() => {
    if (!graph) return [];
    return rootTree(graph, rootDirection, { showConnectionsUnderComponents });
  }, [graph, rootDirection, showConnectionsUnderComponents]);

  // Filter applies ONLY to top-level (root) nodes; matching roots keep their
  // full subtree. AND across search + namespace + tags; tags are any-of.
  const tree = useMemo(() => {
    if (!graph) return fullTree;
    const term = search.trim().toLowerCase();
    const nsSet = new Set(filterNamespaces);
    const tagSet = new Set(filterTags);
    if (!term && nsSet.size === 0 && tagSet.size === 0) return fullTree;

    const mapKey = ROOT_MAP_BY_KIND[rootDirection];
    const entityMap = graph[mapKey];

    return fullTree.filter((root) => {
      const entity = entityMap?.get(root.refId);
      if (term && !root.label.toLowerCase().includes(term)) return false;
      if (nsSet.size > 0 && !nsSet.has(entity?.namespace)) return false;
      if (tagSet.size > 0) {
        const tags = entity?.tags || [];
        if (!tags.some((t) => tagSet.has(t))) return false;
      }
      return true;
    });
  }, [graph, fullTree, search, filterNamespaces, filterTags, rootDirection]);

  // Restore scroll position when the modal opens / finishes loading.
  useEffect(() => {
    if (open && treeScrollRef.current) {
      treeScrollRef.current.scrollTop = scrollTopRef.current || 0;
    }
  }, [open, loading, rootDirection, scrollTopRef]);

  const rootIndex = Math.max(
    0,
    ROOT_OPTIONS.findIndex((o) => o.key === rootDirection)
  );

  const renderNode = (node) => {
    const Icon = ICON_BY_KIND[node.nodeKind] || Folder;
    const hasChildren = node.children && node.children.length > 0;
    const isSelected =
      selectedNode &&
      node.nodeKind === selectedNode.kind &&
      node.refId === selectedNode.refId &&
      node.refId != null;

    return (
      <TreeNode
        key={node.id}
        id={node.id}
        label={
          <span className="rn-node-label">
            <span className="rn-node-name" title={node.label}>{node.label}</span>
            {node.secondaryLabel ? (
              <span className="rn-node-secondary">{node.secondaryLabel}</span>
            ) : null}
          </span>
        }
        renderIcon={Icon}
        isExpanded={expandedIds.has(node.id)}
        active={isSelected || undefined}
        selected={isSelected ? [node.id] : []}
        onToggle={(_e, n) => toggleExpanded(node.id, n.isExpanded)}
        onSelect={() => {
          if (node.refId) setSelectedNode({ kind: node.nodeKind, refId: node.refId });
        }}
      >
        {hasChildren ? node.children.map(renderNode) : null}
      </TreeNode>
    );
  };

  const detail = useMemo(() => {
    if (!graph || !selectedNode) return null;
    const { kind, refId } = selectedNode;

    // `meta` = static facts about the entity (description, type, dimensions…),
    // `related` = its links to other entities (usage). The info panel renders
    // them as two sections split by a divider.
    if (kind === 'dashboard') {
      const d = graph.dashboardsById.get(refId);
      if (!d) return null;
      const s = d.settings || {};
      const meta = [];
      if (d.description) meta.push({ label: 'Description', value: d.description });
      meta.push({ label: 'Panels', value: String(d.panelCount) });
      if (s.layout_dimension) meta.push({ label: 'Dimension', value: s.layout_dimension });
      if (s.scale_percent) meta.push({ label: 'Scale', value: `${s.scale_percent}%` });
      if (s.title_scale) meta.push({ label: 'Title scale', value: `${s.title_scale}%` });
      if (s.theme) meta.push({ label: 'Theme', value: s.theme });
      if (s.refresh_interval) meta.push({ label: 'Refresh', value: `${s.refresh_interval} ms` });
      return {
        kind,
        refId,
        name: d.name,
        typeLabel: 'Dashboard',
        namespace: d.namespace,
        tags: d.tags,
        meta,
        related: [
          { heading: 'Components', items: d.componentUsage },
          { heading: 'Connections', items: d.connectionUsage },
        ],
      };
    }

    if (kind === 'component') {
      const c = graph.componentsById.get(refId);
      if (!c) return null;
      const conns = c.connectionIds
        .map((id) => graph.connectionsById.get(id))
        .filter(Boolean)
        .map((conn) => ({ id: conn.id, name: conn.name }));
      const meta = [];
      if (c.description) meta.push({ label: 'Description', value: c.description });
      meta.push({ label: 'Type', value: c.type });
      if (c.subtype) meta.push({ label: 'Subtype', value: c.subtype });
      if (c.title && c.rawName && c.title !== c.rawName) {
        meta.push({ label: 'Name', value: c.rawName });
      }
      return {
        kind,
        refId,
        name: c.name,
        typeLabel: `Component · ${c.type}${c.subtype ? ` (${c.subtype})` : ''}`,
        namespace: c.namespace,
        tags: c.tags,
        meta,
        related: [
          { heading: 'Used in dashboards', items: c.dashboardUsage },
          { heading: 'Connections', items: conns },
        ],
      };
    }

    // connection
    const conn = graph.connectionsById.get(refId);
    if (!conn) return null;
    const meta = [];
    if (conn.description) meta.push({ label: 'Description', value: conn.description });
    if (conn.type) meta.push({ label: 'Type', value: conn.type });
    if (conn.typeId) meta.push({ label: 'Type ID', value: conn.typeId });
    return {
      kind,
      refId,
      name: conn.name,
      typeLabel: `Connection${conn.type ? ` · ${conn.type}` : ''}`,
      namespace: conn.namespace,
      tags: conn.tags,
      meta,
      related: [{ heading: 'Used by components', items: conn.componentUsage }],
    };
  }, [graph, selectedNode]);

  const handleOpenEditor = () => {
    if (!detail) return;
    const route = EDITOR_ROUTE[detail.kind]?.(detail.refId);
    if (route) {
      closeModal();
      navigate(route);
    }
  };

  return (
    <Modal
      open={open}
      onRequestClose={closeModal}
      modalHeading="Resource Navigator"
      passiveModal
      size="lg"
      className="resource-navigator-modal"
    >
      <div className="rn-toolbar">
        <ContentSwitcher
          selectedIndex={rootIndex}
          onChange={({ index, name }) =>
            setRootDirection(ROOT_OPTIONS[index]?.key || name || 'dashboard')
          }
          size="sm"
        >
          {ROOT_OPTIONS.map((o) => (
            <Switch key={o.key} name={o.key} text={`By ${o.text}`} />
          ))}
        </ContentSwitcher>

        {rootDirection === 'dashboard' && (
          <Toggle
            id="rn-show-conns-toggle"
            size="sm"
            labelText=""
            labelA="Show connections under components"
            labelB="Show connections under components"
            toggled={showConnectionsUnderComponents}
            onToggle={(checked) => setShowConnectionsUnderComponents(checked)}
          />
        )}

        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          iconDescription="Refresh"
          renderIcon={Renew}
          onClick={refresh}
          className="rn-refresh"
        />
      </div>

      {/* Filters apply to the top-level rows of the current rooting. */}
      <div className="rn-filters">
        <Search
          size="sm"
          labelText="Search"
          placeholder={`Search ${ROOT_OPTIONS[rootIndex]?.text.toLowerCase() || ''}s`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          className="rn-search"
        />
        <NamespaceFilter
          id="rn-namespace-filter"
          selected={filterNamespaces}
          onChange={setFilterNamespaces}
        />
        <TagFilter
          entityType={TAG_ENTITY_BY_KIND[rootDirection]}
          selected={filterTags}
          onChange={setFilterTags}
        />
      </div>

      <div className="rn-body">
        <div
          className="rn-tree-pane"
          ref={treeScrollRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {error ? (
            <InlineNotification
              kind="error"
              lowContrast
              title="Failed to load resources"
              subtitle={error.message || 'Try refreshing.'}
              hideCloseButton
            />
          ) : loading && !loadedOnce ? (
            <InlineLoading description="Loading resource graph…" />
          ) : tree.length === 0 ? (
            <p className="rn-empty">
              {search || filterNamespaces.length || filterTags.length
                ? 'No matches for the current filters.'
                : 'No resources to show.'}
            </p>
          ) : (
            <TreeView label="Resource hierarchy" hideLabel>
              {tree.map(renderNode)}
            </TreeView>
          )}
        </div>

        <div className="rn-info-pane">
          {detail ? (
            <>
              <div className="rn-info-header">
                <h4 className="rn-info-name">{detail.name}</h4>
                {detail.kind !== 'group' && (
                  <Button
                    kind="tertiary"
                    size="sm"
                    renderIcon={Edit}
                    onClick={handleOpenEditor}
                  >
                    Open editor
                  </Button>
                )}
              </div>
              <p className="rn-info-type">{detail.typeLabel}</p>

              {/* Metadata: any descriptive data we have for this entity.
                  Namespace renders as its colored pill (same as list/tile
                  views) rather than text. */}
              <dl className="rn-info-meta">
                {detail.namespace ? (
                  <div className="rn-info-meta-row" key="namespace">
                    <dt>Namespace</dt>
                    <dd>
                      <NamespaceChip name={detail.namespace} size="sm" />
                    </dd>
                  </div>
                ) : null}
                {detail.meta.map((m) => (
                  <div className="rn-info-meta-row" key={m.label}>
                    <dt>{m.label}</dt>
                    <dd>{m.value}</dd>
                  </div>
                ))}
              </dl>

              {detail.tags && detail.tags.length ? (
                <div className="rn-info-tags">
                  {detail.tags.map((t) => (
                    <Tag key={t} type="blue" size="sm">
                      {t}
                    </Tag>
                  ))}
                </div>
              ) : null}

              {/* Divider between descriptive data and link/usage data. */}
              <hr className="rn-info-divider" />

              {detail.related.some((g) => g.items.length) ? (
                detail.related.map((group) =>
                  group.items.length ? (
                    <div className="rn-info-related" key={group.heading}>
                      <h5>{group.heading}</h5>
                      <ul>
                        {group.items.map((it) => (
                          <li key={`${group.heading}:${it.id}`}>{it.name}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null
                )
              ) : (
                <p className="rn-info-empty">No linked resources.</p>
              )}
            </>
          ) : (
            <p className="rn-info-empty">Select an item to see its details and links.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default ResourceNavigatorModal;
