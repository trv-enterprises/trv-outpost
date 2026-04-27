// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Use current hostname for API calls (allows Tailscale/network access)
// Falls back to localhost for SSR or when window is not available
const getApiBaseUrl = () => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  if (typeof window !== 'undefined') {
    return `http://${window.location.hostname}:3001`;
  }
  return 'http://localhost:3001';
};

const API_BASE_URL = getApiBaseUrl();

// Export for use in other files
export const API_BASE = API_BASE_URL;

/**
 * Build a URLSearchParams string from a filters object, handling array
 * values (like `tags`) by repeating the parameter. Empty strings, null,
 * and undefined values are dropped.
 *
 *   buildListParams({ type: 'sql', tags: ['home', 'sensors'] })
 *   // → "type=sql&tags=home&tags=sensors"
 */
function buildListParams(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== null && item !== undefined && item !== '') {
          params.append(key, item);
        }
      });
    } else if (value !== null && value !== undefined && value !== '') {
      params.append(key, value);
    }
  });
  return params.toString();
}

/**
 * API Client for Dashboard Server
 */
class APIClient {
  constructor(baseURL = API_BASE_URL) {
    this.baseURL = baseURL;
    this.currentUserGuid = null;
  }

  // Set the current user GUID for authentication
  setCurrentUser(guid) {
    this.currentUserGuid = guid;
    if (guid) {
      localStorage.setItem('currentUserGuid', guid);
    } else {
      localStorage.removeItem('currentUserGuid');
    }
  }

  // Get the current user GUID (from memory or localStorage)
  getCurrentUserGuid() {
    if (!this.currentUserGuid) {
      this.currentUserGuid = localStorage.getItem('currentUserGuid');
    }
    return this.currentUserGuid;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Add user authentication header if we have a current user
    const userGuid = this.getCurrentUserGuid();
    if (userGuid) {
      headers['X-User-ID'] = userGuid;
    }

    const config = {
      headers,
      ...options,
    };

    try {
      const response = await fetch(url, config);

      // Handle 204 No Content (successful DELETE)
      if (response.status === 204) {
        return { success: true };
      }

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Server returned invalid JSON (HTTP ${response.status})`);
      }

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  }

  // Data source endpoints
  async getSystems() {
    return this.request('/api/datasources');
  }

  async getSources(system) {
    return this.request(`/api/datasources/${system}`);
  }

  async getSourceMetadata(system, source) {
    return this.request(`/api/datasources/${system}/${source}/metadata`);
  }

  async updateSourceMetadata(system, source, metadata) {
    return this.request(`/api/datasources/${system}/${source}/metadata`, {
      method: 'PUT',
      body: JSON.stringify(metadata),
    });
  }

  // Health check
  async health() {
    return this.request('/health');
  }

  // Chart endpoints
  async getCharts(filters = {}) {
    const params = buildListParams({ page_size: 1000, ...filters });
    return this.request(`/api/charts?${params}`);
  }

  async getChart(id) {
    return this.request(`/api/charts/${id}`);
  }

  async getChartSummaries(limit = 50) {
    return this.request(`/api/charts/summaries?limit=${limit}`);
  }

  async createChart(chart) {
    return this.request('/api/charts', {
      method: 'POST',
      body: JSON.stringify(chart),
    });
  }

  async updateChart(id, updates) {
    return this.request(`/api/charts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteChart(id) {
    return this.request(`/api/charts/${id}`, {
      method: 'DELETE',
    });
  }

  // Chart versioning endpoints
  async getChartVersionInfo(id) {
    return this.request(`/api/charts/${id}/version-info`);
  }

  async getChartVersions(id) {
    return this.request(`/api/charts/${id}/versions`);
  }

  async getChartVersion(id, version) {
    return this.request(`/api/charts/${id}/versions/${version}`);
  }

  async deleteChartVersion(id, version) {
    return this.request(`/api/charts/${id}/versions/${version}`, {
      method: 'DELETE',
    });
  }

  async getChartDraft(id) {
    return this.request(`/api/charts/${id}/draft`);
  }

  async deleteChartDraft(id) {
    return this.request(`/api/charts/${id}/draft`, {
      method: 'DELETE',
    });
  }

  // Dashboard endpoints
  async getDashboards(filters = {}) {
    const params = buildListParams(filters);
    return this.request(`/api/dashboards?${params}`);
  }

  async getDashboard(id) {
    return this.request(`/api/dashboards/${id}`);
  }

  async createDashboard(dashboard) {
    return this.request('/api/dashboards', {
      method: 'POST',
      body: JSON.stringify(dashboard),
    });
  }

  async updateDashboard(id, updates) {
    return this.request(`/api/dashboards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteDashboard(id) {
    return this.request(`/api/dashboards/${id}`, {
      method: 'DELETE',
    });
  }

  // Connection endpoints (new terminology - preferred)
  async getConnections(filters = {}) {
    const params = buildListParams(filters);
    return this.request(`/api/connections?${params}`);
  }

  async getConnection(id) {
    return this.request(`/api/connections/${id}`);
  }

  async queryConnection(id, query) {
    return this.request(`/api/connections/${id}/query`, {
      method: 'POST',
      body: JSON.stringify(query),
    });
  }

  async getConnectionSchema(id) {
    return this.request(`/api/connections/${id}/schema`);
  }

  async createConnection(connection) {
    return this.request('/api/connections', {
      method: 'POST',
      body: JSON.stringify(connection),
    });
  }

  async updateConnection(id, updates) {
    return this.request(`/api/connections/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteConnection(id) {
    return this.request(`/api/connections/${id}`, {
      method: 'DELETE',
    });
  }

  async testConnection(type, config, id = null) {
    const payload = { type, config };
    if (id) {
      payload.id = id;
    }
    return this.request('/api/connections/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // Check health of an existing connection (uses stored credentials)
  async checkConnectionHealth(id) {
    return this.request(`/api/connections/${id}/health`, {
      method: 'POST',
    });
  }

  async getPrometheusLabelValues(connectionId, labelName) {
    return this.request(`/api/connections/${connectionId}/prometheus/labels/${encodeURIComponent(labelName)}/values`);
  }

  async getEdgeLakeDatabases(connectionId) {
    return this.request(`/api/connections/${connectionId}/edgelake/databases`);
  }

  async getEdgeLakeTables(connectionId, database) {
    return this.request(`/api/connections/${connectionId}/edgelake/tables?database=${encodeURIComponent(database)}`);
  }

  async getEdgeLakeSchema(connectionId, database, table) {
    return this.request(`/api/connections/${connectionId}/edgelake/schema?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`);
  }

  async getMQTTTopics(connectionId) {
    return this.request(`/api/connections/${connectionId}/mqtt/topics`);
  }

  async sampleMQTTTopic(connectionId, topic) {
    return this.request(`/api/connections/${connectionId}/mqtt/sample?topic=${encodeURIComponent(topic)}`);
  }

  // Get connections that support write operations (for controls)
  async getWritableConnections() {
    const response = await this.getConnections();
    return {
      connections: (response.datasources || response.connections || []).filter(c => c.capabilities?.can_write)
    };
  }

  // Execute a control command
  async executeControlCommand(controlId, value) {
    return this.request(`/api/controls/${controlId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    });
  }

  // Device Type endpoints
  async getDeviceTypes(filters = {}) {
    const params = new URLSearchParams();
    if (filters.category) params.append('category', filters.category);
    if (filters.protocol) params.append('protocol', filters.protocol);
    if (filters.built_in_only) params.append('built_in_only', 'true');
    if (filters.page) params.append('page', filters.page);
    if (filters.page_size) params.append('page_size', filters.page_size);
    const queryString = params.toString();
    return this.request(`/api/device-types${queryString ? '?' + queryString : ''}`);
  }

  async getDeviceType(id) {
    return this.request(`/api/device-types/${encodeURIComponent(id)}`);
  }

  async createDeviceType(deviceType) {
    return this.request('/api/device-types', {
      method: 'POST',
      body: JSON.stringify(deviceType),
    });
  }

  async updateDeviceType(id, updates) {
    return this.request(`/api/device-types/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteDeviceType(id) {
    return this.request(`/api/device-types/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async getDeviceCategories() {
    return this.request('/api/device-types/categories');
  }

  async getDeviceTypeControlTypes() {
    return this.request('/api/device-types/control-types');
  }

  // Device endpoints
  async getDevices(filters = {}) {
    const params = new URLSearchParams();
    if (filters.device_type_id) params.append('device_type_id', filters.device_type_id);
    if (filters.connection_id) params.append('connection_id', filters.connection_id);
    if (filters.room) params.append('room', filters.room);
    if (filters.page) params.append('page', filters.page);
    if (filters.page_size) params.append('page_size', filters.page_size);
    const queryString = params.toString();
    return this.request(`/api/devices${queryString ? '?' + queryString : ''}`);
  }

  async getDevice(id) {
    return this.request(`/api/devices/${encodeURIComponent(id)}`);
  }

  async createDevice(device) {
    return this.request('/api/devices', {
      method: 'POST',
      body: JSON.stringify(device),
    });
  }

  async updateDevice(id, updates) {
    return this.request(`/api/devices/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteDevice(id) {
    return this.request(`/api/devices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async importDevices(connectionId, devices) {
    return this.request('/api/devices/import', {
      method: 'POST',
      body: JSON.stringify({ connection_id: connectionId, devices }),
    });
  }

  async discoverDevices(connectionId) {
    return this.request(`/api/connections/${connectionId}/discover-devices`, {
      method: 'POST',
    });
  }

  // Frigate NVR proxy endpoints
  async getFrigateCameras(connectionId) {
    return this.request(`/api/frigate/${connectionId}/cameras`);
  }

  getFrigateSnapshotUrl(connectionId, camera) {
    return `${this.baseURL}/api/frigate/${connectionId}/snapshot/${encodeURIComponent(camera)}`;
  }

  async getFrigateEvents(connectionId, camera, limit = 10) {
    return this.request(`/api/frigate/${connectionId}/events/${encodeURIComponent(camera)}?limit=${limit}`);
  }

  /**
   * Fetch Frigate review segments (the "reviewed/unreviewed" queue).
   * Defaults to unreviewed alerts. Pass `reviewed: 1` to include reviewed.
   *
   * @param {string} connectionId Frigate connection
   * @param {object} opts
   * @param {number} [opts.limit=20] Max segments to return
   * @param {string} [opts.camera] Camera name filter
   * @param {string} [opts.severity] 'alert' | 'detection'
   * @param {number} [opts.reviewed=0] 0 for unreviewed only, 1 to include reviewed
   */
  async getFrigateReviews(connectionId, opts = {}) {
    const params = new URLSearchParams();
    params.append('limit', String(opts.limit ?? 20));
    params.append('reviewed', String(opts.reviewed ?? 0));
    if (opts.camera) params.append('camera', opts.camera);
    if (opts.severity) params.append('severity', opts.severity);
    return this.request(`/api/frigate/${connectionId}/reviews?${params}`);
  }

  /**
   * Mark one or more Frigate review segments as reviewed (viewed).
   * Removes them from the unreviewed queue.
   *
   * @param {string} connectionId Frigate connection
   * @param {string[]} ids Review segment IDs to mark
   */
  async markFrigateReviewsViewed(connectionId, ids) {
    return this.request(`/api/frigate/${connectionId}/reviews/viewed`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  /**
   * Frigate review thumbnail URL.
   * Review thumbnails are WebP files under /clips/review/thumb-{camera}-{id}.webp
   * on the Frigate host. The backend proxy constructs the final path from
   * the camera + review id, so both must be passed in.
   */
  getFrigateReviewThumbnailUrl(connectionId, reviewId, camera) {
    const params = new URLSearchParams({ camera });
    return `${this.baseURL}/api/frigate/${connectionId}/review/${encodeURIComponent(reviewId)}/thumbnail?${params}`;
  }

  /**
   * Frigate review clip URL. A review segment is a group of detection
   * events; the review JSON's `data.detections` array holds those event
   * IDs. There's no dedicated review clip endpoint, so we fetch the clip
   * for the first detection event (reusing the existing event clip
   * endpoint that's already proxied and Range-aware).
   */
  getFrigateReviewClipUrl(connectionId, review) {
    const eventId = review?.data?.detections?.[0];
    if (!eventId) return null;
    return this.getFrigateEventClipUrl(connectionId, eventId);
  }

  getFrigateEventClipUrl(connectionId, eventId) {
    return `${this.baseURL}/api/frigate/${connectionId}/event/${encodeURIComponent(eventId)}/clip`;
  }

  getFrigateEventSnapshotUrl(connectionId, eventId) {
    return `${this.baseURL}/api/frigate/${connectionId}/event/${encodeURIComponent(eventId)}/snapshot`;
  }

  async getFrigateInfo(connectionId) {
    return this.request(`/api/frigate/${connectionId}/info`);
  }

  // Deprecated aliases - keep for backwards compatibility
  async getDatasources(filters = {}) {
    return this.getConnections(filters);
  }

  async getDatasource(id) {
    return this.getConnection(id);
  }

  async queryDatasource(id, query) {
    return this.queryConnection(id, query);
  }

  async getDatasourceSchema(id) {
    return this.getConnectionSchema(id);
  }

  async createDatasource(datasource) {
    return this.createConnection(datasource);
  }

  async updateDatasource(id, updates) {
    return this.updateConnection(id, updates);
  }

  async deleteDatasource(id) {
    return this.deleteConnection(id);
  }

  async testDatasource(type, config) {
    return this.testConnection(type, config);
  }

  async checkDatasourceHealth(id) {
    return this.checkConnectionHealth(id);
  }

  // AI Session endpoints
  async createAISession(chartId = null, context = {}) {
    const payload = chartId ? { chart_id: chartId } : {};
    // Apply pre-flight context to session creation
    if (context.componentType) payload.component_type = context.componentType;
    if (context.chartType) payload.chart_type = context.chartType;
    if (context.controlType) payload.control_type = context.controlType;
    if (context.connectionId) payload.connection_id = context.connectionId;
    if (context.dashboardId) payload.dashboard_id = context.dashboardId;
    if (context.panelId) payload.panel_id = context.panelId;
    return this.request('/api/ai/sessions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getAISession(sessionId) {
    return this.request(`/api/ai/sessions/${sessionId}`);
  }

  async sendAIMessage(sessionId, content) {
    return this.request(`/api/ai/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  async saveAISession(sessionId, chartName) {
    return this.request(`/api/ai/sessions/${sessionId}/save`, {
      method: 'POST',
      body: JSON.stringify({ name: chartName }),
    });
  }

  async cancelAISession(sessionId) {
    return this.request(`/api/ai/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  }

  // Returns WebSocket URL for AI session events
  getAISessionWebSocketURL(sessionId) {
    // Convert http(s) to ws(s)
    const wsProtocol = this.baseURL.startsWith('https') ? 'wss' : 'ws';
    const host = this.baseURL.replace(/^https?:\/\//, '');
    return `${wsProtocol}://${host}/api/ai/sessions/${sessionId}/ws`;
  }

  // Returns WebSocket URL for Frigate JSMPEG live stream proxy
  getFrigateLiveStreamUrl(connectionId, camera) {
    const wsProtocol = this.baseURL.startsWith('https') ? 'wss' : 'ws';
    const host = this.baseURL.replace(/^https?:\/\//, '');
    return `${wsProtocol}://${host}/api/frigate/${connectionId}/live/${encodeURIComponent(camera)}`;
  }

  // Config endpoints
  async getSystemConfig() {
    return this.request('/api/config/system');
  }

  async updateSystemConfig(settings) {
    return this.request('/api/config/system', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
  }

  async getUserConfig(userId) {
    return this.request(`/api/config/user/${userId}`);
  }

  async updateUserConfig(userId, settings) {
    return this.request(`/api/config/user/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
  }

  // Server configuration (for Electron/remote connections)
  setServerUrl(url) {
    this.baseURL = url;
    localStorage.setItem('serverUrl', url);
  }

  getServerUrl() {
    return this.baseURL;
  }

  // Restore server URL from storage (call on app init)
  restoreServerUrl() {
    const savedUrl = localStorage.getItem('serverUrl');
    if (savedUrl) {
      this.baseURL = savedUrl;
    }
  }

  // Clear all stored credentials (for logout/disconnect)
  clearCredentials() {
    this.currentUserGuid = null;
    localStorage.removeItem('currentUserGuid');
    localStorage.removeItem('serverUrl');
    // Reset to default
    this.baseURL = API_BASE_URL;
  }

  // Check if credentials are stored
  hasStoredCredentials() {
    return !!(localStorage.getItem('currentUserGuid') && localStorage.getItem('serverUrl'));
  }

  // User/Auth endpoints

  // Login with a key (GUID) - validates key and returns user info
  // This endpoint does not require authentication
  async login(key) {
    const response = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
    // On successful login, store the key
    if (response.guid) {
      this.setCurrentUser(response.guid);
    }
    return response;
  }

  async getUsers() {
    return this.request('/api/users');
  }

  async getCurrentUser() {
    return this.request('/api/auth/me');
  }

  async getUser(id) {
    return this.request(`/api/users/${id}`);
  }

  async createUser(user) {
    return this.request('/api/users', {
      method: 'POST',
      body: JSON.stringify(user),
    });
  }

  async updateUser(id, updates) {
    return this.request(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteUser(id) {
    return this.request(`/api/users/${id}`, {
      method: 'DELETE',
    });
  }

  // Tags endpoint (shared pool across connections/components/dashboards)
  async getAllTags() {
    return this.request('/api/tags');
  }

  // Settings endpoints
  async getSettings() {
    return this.request('/api/settings');
  }

  async getSetting(key) {
    return this.request(`/api/settings/${key}`);
  }

  async updateSetting(key, value) {
    return this.request(`/api/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  }

  // Registry / type catalog endpoints. The catalog is filtered by the
  // admin's enabled_types selection by default; pass { includeDisabled: true }
  // when the settings editor needs to render every possible type so admins
  // can re-enable previously disabled ones.
  async getRegistryCatalog({ includeDisabled = false } = {}) {
    const qs = includeDisabled ? '?include_disabled=true' : '';
    return this.request(`/api/registry/catalog${qs}`);
  }

  async getRegistryConnectionTypes({ includeDisabled = false } = {}) {
    const qs = includeDisabled ? '?include_disabled=true' : '';
    return this.request(`/api/registry/connections${qs}`);
  }

  async getRegistryComponentTypes({ category = '', includeDisabled = false } = {}) {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (includeDisabled) params.set('include_disabled', 'true');
    const qs = params.toString();
    return this.request(`/api/registry/components${qs ? `?${qs}` : ''}`);
  }

  async getRegistryIntegrations({ includeDisabled = false } = {}) {
    const qs = includeDisabled ? '?include_disabled=true' : '';
    return this.request(`/api/registry/integrations${qs}`);
  }

  // ── Namespaces ────────────────────────────────────────────────────
  // Namespaces partition connection/component/dashboard records into
  // separate conflict domains — uniqueness is (namespace, name) not name.
  async getNamespaces() {
    return this.request('/api/namespaces');
  }

  async getNamespace(id) {
    return this.request(`/api/namespaces/${id}`);
  }

  async createNamespace(body) {
    return this.request('/api/namespaces', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updateNamespace(id, body) {
    return this.request(`/api/namespaces/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async deleteNamespace(id) {
    return this.request(`/api/namespaces/${id}`, {
      method: 'DELETE',
    });
  }

  async getNamespaceUsage(id) {
    return this.request(`/api/namespaces/${id}/usage`);
  }

  // ── API Keys ──────────────────────────────────────────────────────
  // Per-user authentication tokens for non-browser callers (the
  // dashboard-agent CLI, MCP clients, scripts). The plaintext token
  // is returned exactly once on creation — the UI must surface it
  // immediately and warn that it can't be recovered.
  async getAPIKeys() {
    return this.request('/api/api-keys');
  }

  async getAllAPIKeys() {
    return this.request('/api/api-keys/all');
  }

  async createAPIKey({ name, expires_at = null } = {}) {
    return this.request('/api/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, expires_at }),
    });
  }

  async revokeAPIKey(id) {
    return this.request(`/api/api-keys/${id}`, {
      method: 'DELETE',
    });
  }

  // ── Dashboard export / import ─────────────────────────────────────
  async previewExportDashboards(dashboardIds) {
    return this.request('/api/dashboards/export/preview', {
      method: 'POST',
      body: JSON.stringify({ dashboard_ids: dashboardIds }),
    });
  }

  async exportDashboards(dashboardIds) {
    return this.request('/api/dashboards/export', {
      method: 'POST',
      body: JSON.stringify({ dashboard_ids: dashboardIds }),
    });
  }

  async preflightImport(bundle, targetNamespace = '') {
    return this.request('/api/dashboards/import/preflight', {
      method: 'POST',
      body: JSON.stringify({ bundle, target_namespace: targetNamespace }),
    });
  }

  async applyImport(bundle, targetNamespace = '', overwriteDecisions = {}) {
    return this.request('/api/dashboards/import/apply', {
      method: 'POST',
      body: JSON.stringify({
        bundle,
        target_namespace: targetNamespace,
        overwrite_decisions: overwriteDecisions,
      }),
    });
  }
}

export default new APIClient();
