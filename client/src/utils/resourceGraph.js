// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * resourceGraph — pure, synchronous helpers that join the three list
 * endpoints (components / connections / dashboards, loaded with the #21
 * `include_usage` denormalization) into a single in-memory graph, then
 * derive three "rootings" (read directions) from it.
 *
 * No React, no fetching — keep it testable. The async loading + namespace /
 * enabled-type wiring lives in hooks/useResourceGraph.js.
 *
 * Why a client-side join: DashboardSummary carries only FLAT component_usage
 * and connection_usage — there is no per-component→connection mapping in it.
 * To render "component A → connection A" under a dashboard we look each of the
 * dashboard's components up in componentsById and read that component's own
 * connectionIds. The single graph below makes all three reads cheap.
 */

const labelOf = (entity) => entity?.title || entity?.name || entity?.id || '';

/**
 * Build the normalized graph from the three raw list responses.
 *
 * @param {object} lists
 * @param {Array}  lists.components   resp.components (flat ComponentWithUsage)
 * @param {Array}  lists.connections  resp.connections (WRAPPED rows: {connection, component_usage, component_count})
 * @param {Array}  lists.dashboards   resp.dashboards (DashboardSummary)
 * @returns {{componentsById: Map, connectionsById: Map, dashboardsById: Map}}
 */
export function buildResourceGraph({ components = [], connections = [], dashboards = [] } = {}) {
  const componentsById = new Map();
  const connectionsById = new Map();
  const dashboardsById = new Map();

  components.forEach((c) => {
    if (!c?.id) return;
    const dc = c.display_config || {};
    // De-dupe connection refs: primary connection_id plus the two display-config
    // connection ids (frigate/mqtt), dropping falsy.
    const connectionIds = [
      ...new Set(
        [c.connection_id, dc.frigate_connection_id, dc.mqtt_connection_id].filter(Boolean)
      ),
    ];
    componentsById.set(c.id, {
      id: c.id,
      // Key the navigator off the component's NAME, not its title. The
      // dashboard/connection usage refs from the API carry only {id, name}, so
      // the tree and the info-box "Components" list must both use name to line
      // up (a title-first label made them look like different entities). The
      // title is carried separately and shown in braces in the info box.
      name: c.name || c.id || '',
      title: c.title || '',
      rawName: c.name || '',
      type: c.component_type || 'component',
      subtype: c.chart_type || dc.display_type || c.control_config?.control_type || '',
      namespace: c.namespace || '',
      description: c.description || '',
      tags: c.tags || [],
      connectionIds,
      dashboardUsage: c.dashboard_usage || [],
      dashboardCount: c.dashboard_count ?? (c.dashboard_usage?.length || 0),
    });
  });

  connections.forEach((row) => {
    // Connections come WRAPPED: { connection, component_usage, component_count }.
    const conn = row?.connection || row;
    if (!conn?.id) return;
    connectionsById.set(conn.id, {
      id: conn.id,
      name: labelOf(conn),
      type: conn.type || conn.connection_type || '',
      typeId: conn.type_id || '',
      namespace: conn.namespace || '',
      description: conn.description || '',
      tags: conn.tags || [],
      componentUsage: row?.component_usage || [],
      componentCount: row?.component_count ?? (row?.component_usage?.length || 0),
    });
  });

  dashboards.forEach((d) => {
    if (!d?.id) return;
    dashboardsById.set(d.id, {
      id: d.id,
      name: labelOf(d),
      namespace: d.namespace || '',
      description: d.description || '',
      tags: d.tags || [],
      panelCount: d.panel_count ?? 0,
      settings: d.settings || {},
      componentUsage: d.component_usage || [],
      connectionUsage: d.connection_usage || [],
    });
  });

  return { componentsById, connectionsById, dashboardsById };
}

// --- tree node helpers -----------------------------------------------------

const node = (id, nodeKind, refId, label, secondaryLabel, children = []) => ({
  id, // PATH-UNIQUE — the same entity can appear under multiple parents and
      // Carbon TreeNode ids must be unique. Always prefix with the parent path.
  nodeKind, // 'dashboard' | 'component' | 'connection' | 'group'
  refId, // the underlying entity id (used to look up details + route to editor)
  label,
  secondaryLabel,
  children,
});

const missingComponent = (refId) => ({
  id: refId,
  name: '(missing component)',
  type: 'component',
  namespace: '',
  connectionIds: [],
  dashboardUsage: [],
  dashboardCount: 0,
});

const missingConnection = (refId) => ({
  id: refId,
  name: '(missing connection)',
  type: '',
  namespace: '',
  componentUsage: [],
  componentCount: 0,
});

const missingDashboard = (refId) => ({
  id: refId,
  name: '(missing dashboard)',
  namespace: '',
  panelCount: 0,
});

// #4: the server redacts usage refs the caller may not see into opaque
// {unauthorized:true, kind} placeholders — no id, no name, no
// namespace. These render as a labeled placeholder node rather than a
// navigable one. `unauthorizedIndex` keeps tree ids unique (Carbon
// TreeNode requires it) since the refs carry no id of their own.
let unauthorizedIndex = 0;
const isUnauthorizedRef = (ref) => !!ref?.unauthorized;
const unauthorizedEntity = (kind) => {
  unauthorizedIndex += 1;
  const label = kind === 'connection'
    ? 'Unauthorized Connection'
    : kind === 'dashboard'
      ? 'Unauthorized Dashboard'
      : 'Unauthorized Component';
  return {
    id: `unauthorized-${kind || 'component'}-${unauthorizedIndex}`,
    name: label,
    type: '',
    namespace: '',
    unauthorized: true,
    connectionIds: [],
    componentUsage: [],
    componentCount: 0,
    dashboardUsage: [],
    dashboardCount: 0,
    panelCount: 0,
  };
};

const countLabel = (n, singular) => `${n} ${singular}${n === 1 ? '' : 's'}`;

// --- rooting transforms ----------------------------------------------------

/**
 * Dashboard-rooted (default): dashboard → components, PLUS a flat group of the
 * dashboard's connections at the just-under-dashboard level.
 * When showConnectionsUnderComponents is ON, each component also nests its
 * connection(s); when OFF, components are leaves but the flat connection group
 * still renders.
 */
export function toDashboardRooted(graph, { showConnectionsUnderComponents = false } = {}) {
  const { componentsById, connectionsById, dashboardsById } = graph;
  return [...dashboardsById.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((dash) => {
      const base = `dash:${dash.id}`;
      const componentNodes = dash.componentUsage.map((ref) => {
        const comp = isUnauthorizedRef(ref)
          ? unauthorizedEntity('component')
          : (componentsById.get(ref.id) || missingComponent(ref.id));
        const compPath = `${base}/comp:${comp.id}`;
        const connChildren = showConnectionsUnderComponents
          ? comp.connectionIds.map((cid) => {
              const conn = connectionsById.get(cid) || missingConnection(cid);
              return node(`${compPath}/conn:${conn.id}`, 'connection', conn.id, conn.name, conn.type);
            })
          : [];
        return node(compPath, 'component', comp.unauthorized ? null : comp.id, comp.name, comp.type, connChildren);
      });

      // Flat connection group at the just-under-dashboard level.
      const connGroupChildren = dash.connectionUsage.map((ref) => {
        const conn = isUnauthorizedRef(ref)
          ? unauthorizedEntity('connection')
          : (connectionsById.get(ref.id) || missingConnection(ref.id));
        return node(`${base}/conngroup/conn:${conn.id}`, 'connection', conn.unauthorized ? null : conn.id, conn.name, conn.type);
      });
      const children = [...componentNodes];
      if (connGroupChildren.length) {
        children.push(
          node(
            `${base}/conngroup`,
            'group',
            null,
            'Connections',
            countLabel(connGroupChildren.length, 'connection'),
            connGroupChildren
          )
        );
      }
      return node(base, 'dashboard', dash.id, dash.name, countLabel(dash.panelCount, 'panel'), children);
    });
}

/**
 * Connection-rooted: connection → components → dashboards.
 * "What does this connection feed?" — impact analysis before edit/delete.
 */
export function toConnectionRooted(graph) {
  const { componentsById, dashboardsById, connectionsById } = graph;
  return [...connectionsById.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((conn) => {
      const base = `conn:${conn.id}`;
      const compNodes = conn.componentUsage.map((ref) => {
        const comp = isUnauthorizedRef(ref)
          ? unauthorizedEntity('component')
          : (componentsById.get(ref.id) || missingComponent(ref.id));
        const compPath = `${base}/comp:${comp.id}`;
        const dashNodes = comp.dashboardUsage.map((dref) => {
          const dash = isUnauthorizedRef(dref)
            ? unauthorizedEntity('dashboard')
            : (dashboardsById.get(dref.id) || missingDashboard(dref.id));
          return node(`${compPath}/dash:${dash.id}`, 'dashboard', dash.unauthorized ? null : dash.id, dash.name, null);
        });
        return node(compPath, 'component', comp.unauthorized ? null : comp.id, comp.name, comp.type, dashNodes);
      });
      return node(base, 'connection', conn.id, conn.name, countLabel(conn.componentCount, 'component'), compNodes);
    });
}

/**
 * Component-rooted: component → dashboards (where used) + its connection(s).
 * "Where is this component used?"
 */
export function toComponentRooted(graph) {
  const { componentsById, dashboardsById, connectionsById } = graph;
  return [...componentsById.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((comp) => {
      const base = `comp:${comp.id}`;
      const dashNodes = comp.dashboardUsage.map((dref) => {
        const dash = isUnauthorizedRef(dref)
          ? unauthorizedEntity('dashboard')
          : (dashboardsById.get(dref.id) || missingDashboard(dref.id));
        return node(`${base}/dash:${dash.id}`, 'dashboard', dash.unauthorized ? null : dash.id, dash.name, null);
      });
      const connNodes = comp.connectionIds.map((cid) => {
        const conn = connectionsById.get(cid) || missingConnection(cid);
        return node(`${base}/conn:${conn.id}`, 'connection', conn.id, conn.name, conn.type);
      });
      return node(base, 'component', comp.id, comp.name, comp.type, [...connNodes, ...dashNodes]);
    });
}

/**
 * Convenience: pick the transform for a root direction.
 */
export function rootTree(graph, rootDirection, opts) {
  switch (rootDirection) {
    case 'connection':
      return toConnectionRooted(graph);
    case 'component':
      return toComponentRooted(graph);
    case 'dashboard':
    default:
      return toDashboardRooted(graph, opts);
  }
}
