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

// Substrings on the server-side error string that mean "the
// connection itself is unreachable" — emitted by adapters wrapping
// network/HTTP failures. Other 500s (validation errors, query
// syntax) don't match these and stay as plain inline panel errors.
const CONNECTION_FAILURE_HINTS = [
  'connection failed',
  'connection refused',
  'failed to fetch',
  'context deadline exceeded',
  'no such host',
  'i/o timeout',
];

// How long after firing one connection-failure notification we stay
// silent on the same key. 30s feels right: long enough to swallow a
// dashboard's worth of parallel panel queries, short enough that the
// next refresh cycle re-alerts if the outage continues.
const FAILURE_DEBOUNCE_MS = 30_000;

// Default per-request timeout. Without this, a fully unreachable
// network (Wi-Fi down, route black-holed) leaves fetch() hanging
// indefinitely — the user sees only a spinner with no signal that
// anything is wrong. 15s is long enough to absorb a slow query but
// short enough to feel responsive when something is actually broken.
// Overridable per-call via options.timeout (set to 0 to disable).
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * API Client for Dashboard Server
 */
class APIClient {
  constructor(baseURL = API_BASE_URL) {
    this.baseURL = baseURL;
    this.currentUserGuid = null;
    // Optional async function that returns a Clerk session JWT.
    // Set by ClerkSessionBridge when ClerkProvider mounts. When set
    // and it returns a non-empty string, every outbound request
    // attaches `Authorization: Bearer <jwt>`. When it returns null
    // (Clerk session signed out) or throws, we fall through to the
    // API-key / X-User-ID legacy paths. Unset entirely on
    // Clerk-disabled deployments — no async overhead in that case.
    this.tokenProvider = null;
    // API key (`trve_…`) for non-browser clients (Electron, kiosk,
    // dashboard-agent, mcp-proxy). Persisted to localStorage so it
    // survives page reload. The auth header path prefers Clerk JWT
    // when one is available, then this API key, then the legacy
    // X-User-ID header.
    this.apiKey = null;
    try {
      this.apiKey = localStorage.getItem('apiKey') || null;
    } catch {
      // localStorage may be inaccessible in some embed contexts;
      // request() falls through to other auth channels.
    }
    // Notification surface plumbed in by NotificationProvider on
    // mount. When unset, connection-failure detection is silent.
    // Two callbacks: pushToast(transient corner toast) and
    // addNotification(persistent bell-panel entry).
    this.notificationHandlers = null;
    // id → human name, populated opportunistically when getConnections
    // / getConnection responses come back. Used to render
    // "Connection unreachable — <name>" instead of a UUID.
    this.connectionNameCache = new Map();
    // key → epoch ms of last fired notification. Key is connection_id
    // for connection failures, '__server__' for connectionless server
    // failures (network down / 5xx from a non-connection endpoint).
    this.connectionFailureDebounce = new Map();

    // v0.17.0 session token. Once bootstrap (POST /api/auth/session)
    // returns a pair, every request rides on this access token. The
    // refresh token is in an httpOnly cookie the server set; the
    // browser sends it automatically on /api/auth/refresh calls.
    // No localStorage for the access token by design — it has a
    // short TTL (15 min default) and gets refreshed on demand or on
    // 401. Keeps the token off disk where XSS scripts hunt.
    this.accessToken = null;
    this.accessExpiresAt = null;     // ms epoch, used by schedulers
    // Coalesce concurrent refresh attempts. If 12 panels 401 at once,
    // we want ONE /auth/refresh call, not 12.
    this._refreshPromise = null;
    // Optional callback when refresh fails permanently — App.jsx
    // wires this to a re-bootstrap. Set via setSessionExpiredHandler.
    this.onSessionExpired = null;
  }

  // setAccessToken stamps the JWT and remembers its exp. Called by
  // App.jsx after a successful /auth/session or /auth/refresh.
  // Pass null to clear (sign-out path).
  //
  // Side-effect: dispatches `apiclient-authenticated` on the window
  // when transitioning from "no token" to "has token." Providers
  // mounted above the route tree (EnabledTypesProvider, etc.) that
  // need to fire data calls after bootstrap completes listen for
  // this. Browser-only — no-op in non-window contexts.
  setAccessToken(token, expiresAt) {
    const hadToken = !!this.accessToken;
    this.accessToken = token || null;
    this.accessExpiresAt = expiresAt ? new Date(expiresAt).getTime() : null;
    const hasToken = !!this.accessToken;
    if (!hadToken && hasToken && typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new Event('apiclient-authenticated'));
      } catch {
        // window.Event missing in unusual environments — non-fatal.
      }
    }
  }

  getAccessToken() {
    return this.accessToken;
  }

  // setSessionExpiredHandler lets App.jsx subscribe to "refresh
  // failed permanently, you need to bootstrap again." Fired only
  // when refresh-and-retry exhausts; transient refresh successes
  // don't notify.
  setSessionExpiredHandler(handler) {
    this.onSessionExpired = typeof handler === 'function' ? handler : null;
  }

  // createSession is the explicit bootstrap call. App.jsx calls this
  // once on mount with whatever inbound credential it has (Clerk JWT
  // via tokenProvider, API key via setApiKey + URL param, or GUID
  // via setCurrentUser). The server walks its IdP registry to find
  // which credential validates, mints a JWT pair, sets the refresh
  // cookie, returns the access token in the body.
  //
  // After this resolves, every subsequent request rides the access
  // token automatically.
  async createSession() {
    const headers = { 'Content-Type': 'application/json' };
    // Forward the inbound credentials the server's IdP registry
    // knows how to look at. Clerk's tokenProvider goes in
    // Authorization; the API key (if set) does too — server
    // dispatches by shape. X-User-ID and ?user_id= still ride
    // their respective channels.
    if (this.tokenProvider) {
      try {
        const token = await this.tokenProvider();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch (err) {
        console.warn('apiClient: bootstrap tokenProvider error', err);
      }
    }
    if (!headers['Authorization'] && this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    const guid = this.getCurrentUserGuid();
    if (!headers['Authorization'] && guid) {
      headers['X-User-ID'] = guid;
    }

    const response = await fetch(`${this.baseURL}/api/auth/session`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`bootstrap failed (HTTP ${response.status})`);
      err.status = response.status;
      err.body = text;
      throw err;
    }
    const data = await response.json();
    this.setAccessToken(data.access_token, data.expires_at);
    return data;
  }

  // _refreshSession exchanges the refresh cookie for a new access
  // token. Coalesced — concurrent callers share one in-flight
  // promise. Returns true on success, false when refresh
  // permanently failed (cookie missing, refresh revoked, etc.) and
  // notifies the session-expired handler in that case.
  async _refreshSession() {
    if (this._refreshPromise) {
      return this._refreshPromise;
    }
    this._refreshPromise = (async () => {
      try {
        const response = await fetch(`${this.baseURL}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!response.ok) {
          this.accessToken = null;
          this.accessExpiresAt = null;
          if (this.onSessionExpired) {
            try { this.onSessionExpired(); } catch (e) { console.warn(e); }
          }
          return false;
        }
        const data = await response.json();
        this.setAccessToken(data.access_token, data.expires_at);
        return true;
      } catch (err) {
        console.warn('apiClient: refresh failed', err);
        this.accessToken = null;
        this.accessExpiresAt = null;
        if (this.onSessionExpired) {
          try { this.onSessionExpired(); } catch (e) { console.warn(e); }
        }
        return false;
      } finally {
        this._refreshPromise = null;
      }
    })();
    return this._refreshPromise;
  }

  // logout calls POST /api/auth/logout to revoke the refresh family
  // and clear the cookie, then clears local state. Best-effort —
  // network failures still clear local state.
  async logout() {
    try {
      await fetch(`${this.baseURL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch (err) {
      console.warn('apiClient: logout call failed', err);
    }
    this.accessToken = null;
    this.accessExpiresAt = null;
  }

  // setTokenProvider lets the Clerk integration plug in a
  // `() => Promise<string|null>` that returns a fresh session JWT.
  // Pass null to disable Clerk-token attachment (sign-out, mode
  // switch, tests).
  setTokenProvider(provider) {
    this.tokenProvider = typeof provider === 'function' ? provider : null;
  }

  // setApiKey stamps a `trve_…` API key onto the apiClient and
  // persists it. Every subsequent request attaches it as
  // Authorization: Bearer trve_…. Pass null/empty to clear.
  //
  // Side-effect: dispatches `apiclient-authenticated` when transitioning
  // from "no credential" to "has API key" — same signal that
  // setAccessToken fires. Providers above the route tree listen for
  // it so their initial data fetch happens after a credential is
  // available, not before.
  setApiKey(key) {
    const hadCred = !!this.apiKey || !!this.accessToken;
    if (typeof key === 'string' && key.startsWith('trve_')) {
      this.apiKey = key;
      try { localStorage.setItem('apiKey', key); } catch { /* ignore */ }
    } else {
      this.apiKey = null;
      try { localStorage.removeItem('apiKey'); } catch { /* ignore */ }
    }
    const hasCred = !!this.apiKey || !!this.accessToken;
    if (!hadCred && hasCred && typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new Event('apiclient-authenticated'));
      } catch {
        // window.Event missing in unusual environments — non-fatal.
      }
    }
  }

  clearApiKey() {
    this.setApiKey(null);
  }

  // setNotificationHandlers wires in the toast + bell push points.
  // NotificationProvider calls this once on mount; pass null to
  // disable (tests, sign-out cleanup).
  setNotificationHandlers(handlers) {
    if (handlers && typeof handlers.pushToast === 'function' && typeof handlers.addNotification === 'function') {
      this.notificationHandlers = handlers;
    } else {
      this.notificationHandlers = null;
    }
  }

  // Internal — called from request() and the stream manager when a
  // call looks like a connection-unreachable failure. Debounces
  // per-key so a 12-panel dashboard fires one toast, not twelve. The
  // original error still propagates to whoever called request(); this
  // is purely additive notification.
  _reportConnectionFailure(connectionId) {
    if (!this.notificationHandlers) return;
    const key = connectionId || '__server__';
    const now = Date.now();
    const last = this.connectionFailureDebounce.get(key) || 0;
    if (now - last < FAILURE_DEBOUNCE_MS) return;
    this.connectionFailureDebounce.set(key, now);

    let title;
    let subtitle;
    if (connectionId) {
      const name = this.connectionNameCache.get(connectionId);
      title = 'Connection unreachable';
      if (name) {
        subtitle = `${name} did not respond. Check the connection or its endpoint.`;
      } else {
        // Cache miss — the user still needs to know *which* connection
        // broke. A bare "A connection did not respond" gives them no
        // way to act. The UUID prefix is enough to disambiguate even
        // on deployments with many connections, and is recoverable
        // (they can match it against the connections list).
        // Eager name fetch below populates the cache so subsequent
        // failures render the friendly name.
        const idHint = connectionId.slice(0, 8);
        subtitle = `Connection ${idHint} did not respond. Check the connection or its endpoint.`;
        // Fire-and-forget — fills the cache for next time. We don't
        // await; the current notification ships with the UUID-hint
        // copy, and the next failure (or page refresh) picks up the
        // real name. Errors are swallowed — the user is already
        // looking at a connection-down notification; they don't need
        // a second "couldn't fetch connection metadata" toast layered
        // on top.
        this.getConnection(connectionId).catch(() => {});
      }
    } else {
      title = 'Server unreachable';
      subtitle = 'The dashboard server is not responding. Check that it is running.';
    }

    // Background failure detection — bell-only. Connection/server reachability
    // checks fire from polling and stream loops with no user action behind them,
    // so a corner toast is too loud (and stacks per-connection on busy
    // dashboards). The bell badge is the right surface; users open it when
    // they care.
    const payload = { kind: 'error', title, subtitle };
    try {
      this.notificationHandlers.addNotification(payload);
    } catch (err) {
      console.warn('apiClient: notification handler error', err);
    }
  }

  // Cache a connection's name so the next failure notification can
  // render a friendly label. Called from getConnections/getConnection.
  _cacheConnectionName(connection) {
    if (connection && connection.id && connection.name) {
      this.connectionNameCache.set(connection.id, connection.name);
    }
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

    // Credential attachment, in priority order:
    //
    //   1. API key (`trve_…`) when one is set. Long-lived, revoke-by-
    //      delete; lifecycle matches always-on displays (kiosks,
    //      status boards). The server's middleware accepts `trve_…`
    //      as a first-class credential — no JWT involved on the wire.
    //      A kiosk bootstrapped with ?key=trve_… stays alive
    //      indefinitely until the key is revoked.
    //   2. Access JWT otherwise. Browser users without a personal
    //      API key (Clerk SSO, X-User-ID dev, ?user_id= URL) get
    //      this path — short-lived token, refresh via httpOnly
    //      cookie when needed.
    //
    // Note: the bootstrap endpoint (/api/auth/session) takes any
    // inbound credential the IdP registry recognizes — different
    // attachment logic lives in createSession() below.
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    } else if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    // Pull internal options out before spreading into fetch — fetch
    // ignores unknown keys but better not to leak them into the
    // network layer.
    const connectionId = options.connectionId || null;
    const explicitTimeout = options.timeout;
    const skipRefreshRetry = options.skipRefreshRetry === true;
    const config = { headers, ...options };
    delete config.connectionId;
    delete config.timeout;
    delete config.skipRefreshRetry;
    // Send the refresh cookie on every same-origin call so the
    // /auth/refresh round-trip works without the caller threading
    // credentials explicitly. Harmless on non-/auth routes — the
    // cookie's Path is scoped to /api/auth so it's not actually
    // sent on regular API calls.
    if (!config.credentials) {
      config.credentials = 'same-origin';
    }

    // Apply a default timeout via AbortController unless the caller
    // supplied their own signal (their abort policy wins) or asked
    // for no timeout (timeout: 0). Streaming endpoints that want to
    // stay open should opt out. The abort below classifies as a
    // connection failure so the user sees a toast — same path as a
    // network error, but driven by the timeout instead of by the
    // browser detecting a network problem.
    let timeoutHandle = null;
    let timedOut = false;
    if (!config.signal) {
      const timeoutMs =
        typeof explicitTimeout === 'number' ? explicitTimeout : DEFAULT_REQUEST_TIMEOUT_MS;
      if (timeoutMs > 0) {
        const ctl = new AbortController();
        config.signal = ctl.signal;
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          ctl.abort();
        }, timeoutMs);
      }
    }

    try {
      const response = await fetch(url, config);
      if (timeoutHandle) clearTimeout(timeoutHandle);

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
        // 401 with hint:"refresh" → access token expired but the
        // refresh token (cookie) might still be good. Try ONE
        // refresh and re-issue this request. Coalesced via
        // _refreshPromise so concurrent 401s don't stampede the
        // refresh endpoint.
        //
        // Skip refresh when:
        //   - skipRefreshRetry is set (recursion guard for the
        //     post-refresh retry attempt).
        //   - We sent the API key as the credential. API-key 401s
        //     mean the key is revoked/deleted — refresh wouldn't
        //     help, and would mask the real failure with a misleading
        //     "session expired" round-trip.
        //   - No access token is set (the credential we used wasn't
        //     a refreshable JWT in the first place).
        const usedApiKey = !!this.apiKey;
        if (response.status === 401 && data?.hint === 'refresh' && !skipRefreshRetry && !usedApiKey && this.accessToken) {
          const refreshed = await this._refreshSession();
          if (refreshed) {
            // Re-issue with the new access token. Mark skip so a
            // second 401 doesn't recurse.
            return this.request(endpoint, { ...options, skipRefreshRetry: true });
          }
          // Refresh failed permanently — fall through to the 401
          // error below. The session-expired handler has already
          // been notified inside _refreshSession.
        }

        // Two failure shapes count as connection-unreachable:
        //   (1) Gateway-style 5xx — 502 / 503 / 504 — typically a
        //       reverse proxy reporting the backend is down.
        //   (2) 500 with an error body whose text matches one of
        //       the adapter-level connection failure hints.
        // Other non-2xx responses (400, 401, 404, 422, plain 500
        // for query syntax errors etc.) are NOT connection
        // failures and shouldn't toast.
        const status = response.status;
        const errStr = (data && data.error ? String(data.error) : '').toLowerCase();
        const isConnectionFailure =
          status === 502 || status === 503 || status === 504 ||
          (status === 500 && CONNECTION_FAILURE_HINTS.some((h) => errStr.includes(h)));
        if (isConnectionFailure) {
          this._reportConnectionFailure(connectionId);
        }
        // Attach the HTTP status and the parsed body to the thrown
        // Error so callers can branch on 409 (in-use guard) and read
        // the usage payload without re-fetching. Existing callers that
        // only inspect err.message keep working.
        const apiErr = new Error(data.error || `HTTP ${response.status}`);
        apiErr.status = status;
        apiErr.body = data;
        throw apiErr;
      }

      return data;
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Three failure shapes land here:
      //   - TypeError: fetch() couldn't reach the server (network
      //     down, DNS, TLS, server crashed before responding).
      //   - AbortError: our timeout fired (timedOut = true) OR the
      //     caller's own AbortController fired (timedOut = false —
      //     don't toast then; the caller intentionally cancelled).
      //   - The HTTP-error rethrow from above (already reported).
      const isAbortError = error && error.name === 'AbortError';
      const isNetworkError = error instanceof TypeError;
      if (isNetworkError || (isAbortError && timedOut)) {
        this._reportConnectionFailure(connectionId);
        // Re-shape the timeout error so callers see a clearer
        // message in inline UI (the panel error chip etc.).
        if (isAbortError && timedOut) {
          throw new Error('Request timed out');
        }
      }
      console.error('API Error:', error);
      throw error;
    }
  }


  // Health check
  async health() {
    return this.request('/health');
  }

  // Component endpoints (umbrella for chart, control, and display sub-types)
  async getComponents(filters = {}) {
    const params = buildListParams({ page_size: 1000, ...filters });
    return this.request(`/api/components?${params}`);
  }

  async getComponent(id) {
    return this.request(`/api/components/${id}`);
  }

  async getComponentSummaries(limit = 50) {
    return this.request(`/api/components/summaries?limit=${limit}`);
  }

  async createComponent(component) {
    return this.request('/api/components', {
      method: 'POST',
      body: JSON.stringify(component),
    });
  }

  async updateComponent(id, updates) {
    return this.request(`/api/components/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteComponent(id) {
    return this.request(`/api/components/${id}`, {
      method: 'DELETE',
    });
  }

  // Component versioning endpoints
  async getComponentVersionInfo(id) {
    return this.request(`/api/components/${id}/version-info`);
  }

  async getComponentVersions(id) {
    return this.request(`/api/components/${id}/versions`);
  }

  async getComponentVersion(id, version) {
    return this.request(`/api/components/${id}/versions/${version}`);
  }

  async deleteComponentVersion(id, version) {
    return this.request(`/api/components/${id}/versions/${version}`, {
      method: 'DELETE',
    });
  }

  async getComponentDraft(id) {
    return this.request(`/api/components/${id}/draft`);
  }

  async deleteComponentDraft(id) {
    return this.request(`/api/components/${id}/draft`, {
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
    const result = await this.request(`/api/connections?${params}`);
    // Opportunistically warm the name cache so failure toasts can
    // render real names instead of UUIDs. Shape: { connections: [...] }
    // for the paged response, plain array for some legacy callers.
    const list = Array.isArray(result) ? result : result?.connections || [];
    list.forEach((c) => this._cacheConnectionName(c));
    return result;
  }

  async getConnection(id) {
    const result = await this.request(`/api/connections/${id}`, { connectionId: id });
    this._cacheConnectionName(result);
    return result;
  }

  async queryConnection(id, query) {
    return this.request(`/api/connections/${id}/query`, {
      method: 'POST',
      body: JSON.stringify(query),
      connectionId: id,
    });
  }

  async getConnectionSchema(id) {
    return this.request(`/api/connections/${id}/schema`, { connectionId: id });
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
      connectionId: id,
    });
  }

  async getPrometheusLabelValues(connectionId, labelName) {
    return this.request(`/api/connections/${connectionId}/prometheus/labels/${encodeURIComponent(labelName)}/values`, { connectionId });
  }

  async getEdgeLakeDatabases(connectionId) {
    return this.request(`/api/connections/${connectionId}/edgelake/databases`, { connectionId });
  }

  async getEdgeLakeTables(connectionId, database) {
    return this.request(`/api/connections/${connectionId}/edgelake/tables?database=${encodeURIComponent(database)}`, { connectionId });
  }

  async getEdgeLakeSchema(connectionId, database, table) {
    return this.request(`/api/connections/${connectionId}/edgelake/schema?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`, { connectionId });
  }

  async getMQTTTopics(connectionId) {
    return this.request(`/api/connections/${connectionId}/mqtt/topics`, { connectionId });
  }

  async sampleMQTTTopic(connectionId, topic) {
    return this.request(`/api/connections/${connectionId}/mqtt/sample?topic=${encodeURIComponent(topic)}`, { connectionId });
  }

  // Get connections that support write operations (for controls)
  async getWritableConnections() {
    const response = await this.getConnections();
    return {
      connections: (response.connections || []).filter(c => c.capabilities?.can_write)
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

  // AI Session endpoints
  async createAISession(componentId = null, context = {}) {
    const payload = componentId ? { component_id: componentId } : {};
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

  // streamAuthQuery returns the auth fragment for SSE/WS URLs.
  // EventSource and WebSocket can't set Authorization headers, so
  // the credential rides ?st= instead. Same precedence as request():
  // API key wins (kiosk-friendly, no expiry), JWT falls through.
  // Returns "" when neither is set — the request will then 401 from
  // the auth middleware, which is the correct failure signal.
  streamAuthQuery() {
    if (this.apiKey) {
      return `st=${encodeURIComponent(this.apiKey)}`;
    }
    if (this.accessToken) {
      return `st=${encodeURIComponent(this.accessToken)}`;
    }
    return '';
  }

  // Returns WebSocket URL for AI session events
  getAISessionWebSocketURL(sessionId) {
    // Convert http(s) to ws(s)
    const wsProtocol = this.baseURL.startsWith('https') ? 'wss' : 'ws';
    const host = this.baseURL.replace(/^https?:\/\//, '');
    const auth = this.streamAuthQuery();
    const qs = auth ? `?${auth}` : '';
    return `${wsProtocol}://${host}/api/ai/sessions/${sessionId}/ws${qs}`;
  }

  // Returns WebSocket URL for Frigate JSMPEG live stream proxy
  getFrigateLiveStreamUrl(connectionId, camera) {
    const wsProtocol = this.baseURL.startsWith('https') ? 'wss' : 'ws';
    const host = this.baseURL.replace(/^https?:\/\//, '');
    const auth = this.streamAuthQuery();
    const qs = auth ? `?${auth}` : '';
    return `${wsProtocol}://${host}/api/frigate/${connectionId}/live/${encodeURIComponent(camera)}${qs}`;
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
  //
  // For client validation, call setApiKey(key) followed by
  // getCurrentUser() — the API key is sent as Authorization: Bearer
  // trve_…, /api/auth/me returns the resolved user, and a 401 means
  // the key is invalid. The legacy /api/auth/login endpoint was
  // removed in v0.11.1.


  async getUsers() {
    return this.request('/api/users');
  }

  async getCurrentUser() {
    return this.request('/api/auth/me');
  }

  async getUser(id) {
    return this.request(`/api/users/${id}`);
  }

  // Resolve a user by GUID (the value used in the X-User-ID header
  // and persisted in localStorage). Manage-only — admins use this in
  // the user-edit flows. SPA bootstrap and the header user pill
  // resolve self-identity via /api/auth/me, which carries id/guid/
  // name/capabilities without exposing any other user record.
  async getUserByGuid(guid) {
    return this.request(`/api/users/by-guid/${encodeURIComponent(guid)}`);
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

  // ── System Users (admin-only service principals) ──────────────────
  // Non-interactive user records whose only purpose is to own API
  // keys for inbound integrations (ts-store webhook receiver, etc.).
  // No interactive sign-in path; IdP/Clerk rejects.
  async listSystemUsers() {
    return this.request('/api/system-users');
  }

  async createSystemUser({ name, capabilities } = {}) {
    const body = { name };
    if (Array.isArray(capabilities)) body.capabilities = capabilities;
    return this.request('/api/system-users', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async deleteSystemUser(id) {
    return this.request(`/api/system-users/${id}`, { method: 'DELETE' });
  }

  async listSystemUserAPIKeys(id) {
    return this.request(`/api/system-users/${id}/api-keys`);
  }

  async createSystemUserAPIKey(id, { name } = {}) {
    return this.request(`/api/system-users/${id}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  // ── Alerts (persisted bell-panel records) ─────────────────────────
  // Live alerts still arrive via SSE (/api/events/stream); these
  // endpoints back the bell-on-load hydrate and the per-row dismiss
  // / pin actions. "First reader clears it" semantics with a
  // per-record pin override.
  async listAlerts() {
    return this.request('/api/alerts');
  }

  async markAlertSeen(id) {
    return this.request(`/api/alerts/${id}/seen`, { method: 'POST' });
  }

  async pinAlert(id) {
    return this.request(`/api/alerts/${id}/pin`, { method: 'POST' });
  }

  async unpinAlert(id) {
    return this.request(`/api/alerts/${id}/pin`, { method: 'DELETE' });
  }

  // ts-store Alerts extension — aggregated view over every ts-store
  // alert rule across every tsstore connection. Powers
  // /design/extensions/tsstore-alerts.
  async listTSStoreAlertRules() {
    return this.request('/api/tsstore-alerts/rules');
  }

  async deleteTSStoreAlert(connectionId, alertId) {
    const q = new URLSearchParams({ connection_id: connectionId }).toString();
    return this.request(`/api/tsstore-alerts/rules/${alertId}?${q}`, { method: 'DELETE' });
  }

  // Full alert record from the owning tsstore — status + transport
  // block (webhook/mqtt) with rule fields, restart policy, max
  // replay, etc. Used by the read-only rule-details page. ts-store
  // already redacts secret-bearing headers and the MQTT password
  // before returning.
  async getTSStoreAlertDetail(connectionId, alertId) {
    const q = new URLSearchParams({ connection_id: connectionId }).toString();
    return this.request(`/api/tsstore-alerts/rules/${alertId}?${q}`);
  }

  // Create a webhook alert rule on a tsstore connection. The server
  // mints a per-connection URL secret + builds a webhook URL pointing
  // at this dashboard's own receiver, then POSTs the rule to the
  // owning tsstore. Returns the new alert id + the generated URL.
  async createTSStoreAlertRule(body) {
    return this.request('/api/tsstore-alerts/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // Cheap authenticated probe against a tsstore connection — used by
  // the rule-create wizard to gate the submit button when the
  // connection's API key won't pass ts-store auth. Returns
  // { ok: bool, http_status?: int, error?: string }.
  async probeTSStoreConnection(connectionId) {
    const q = new URLSearchParams({ connection_id: connectionId }).toString();
    return this.request(`/api/tsstore-alerts/probe?${q}`);
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
