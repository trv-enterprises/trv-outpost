// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Header,
  HeaderContainer,
  HeaderName,
  HeaderGlobalBar,
  HeaderGlobalAction,
  SideNav,
  Content,
  Loading
} from '@carbon/react';
import {
  Help,

  Notification,
  ChartMultitype,
  Menu,
  Close,
} from '@carbon/icons-react';
import apiClient, { API_BASE } from './api/client';
import { isElectron } from './utils/electron';
import { getCredentials, clearCredentials } from './utils/secureStorage';
import { hydrateListPrefs } from './utils/listPrefs';
import LoginPage from './pages/LoginPage';
import ConnectionsPage from './pages/ConnectionsPage';
import ConnectionDetailPage from './pages/ConnectionDetailPage';
import ComponentsListPage from './pages/ComponentsListPage';
import ComponentDetailPage from './pages/ComponentDetailPage';
import AIBuilderPage from './pages/AIBuilderPage';
import DashboardsListPage from './pages/DashboardsListPage';
// Dashboard design/edit lives in DashboardViewerPage edit mode
import DashboardViewerPage from './pages/DashboardViewerPage';
import DashboardTileViewPage from './pages/DashboardTileViewPage';
import ModeToggle from './components/mode/ModeToggle';
import DesignModeNav from './components/navigation/DesignModeNav';
import ViewModeNav from './components/navigation/ViewModeNav';
import ManageModeNav from './components/navigation/ManageModeNav';
import UsersListPage from './pages/UsersListPage';
import UserDetailPage from './pages/UserDetailPage';
import SettingsPage from './pages/SettingsPage';
import DevicesPage from './pages/DevicesPage';
import NamespacesPage from './pages/NamespacesPage';
import ApiKeysListPage from './pages/ApiKeysListPage';
import { NotificationProvider, useNotifications } from './context/NotificationContext';
import { EnabledTypesProvider } from './context/EnabledTypesContext';
import { NamespaceProvider } from './context/NamespaceContext';
import NamespacePicker from './components/NamespacePicker';
import AccountMenu from './components/AccountMenu';
import DevUserSwitcher from './components/DevUserSwitcher';
import { ModeGuardProvider, useModeGuard } from './context/ModeGuardContext';
import NotificationPanel from './components/NotificationPanel';
import ToastStack from './components/ToastStack';
import { MODES } from './config/layoutConfig';
import buildInfo from '../build.json';
import './App.scss';

// Redirect /design/dashboards/:id to /view/dashboards/:id with auto-edit.
// fromDesign is set so cancel/save from the editor routes back to the
// design list, and the mode-sync effect keeps the header pill on DESIGN
// while the user is editing (see App.jsx mode-sync effect below).
function DashboardEditRedirect() {
  const { id } = useParams();
  if (id === 'new') {
    return <Navigate to="/view/dashboards/new" state={{ autoEdit: true, isNew: true, fromDesign: true }} replace />;
  }
  return <Navigate to={`/view/dashboards/${id}`} state={{ autoEdit: true, fromDesign: true }} replace />;
}

function AppContent({ onDisconnect }) {
  const [isSideNavExpanded, setIsSideNavExpanded] = useState(true);
  const [currentMode, setCurrentMode] = useState(() => {
    // Load mode from localStorage or default to VIEW. The URL-sync
    // effect below corrects this if the route says otherwise — that
    // way a refresh on /view/dashboards/X always lands in VIEW even
    // if the last persisted mode was MANAGE.
    const savedMode = localStorage.getItem('dashboardMode');
    return savedMode || MODES.VIEW;
  });
  const [firstDashboardId, setFirstDashboardId] = useState(null);
  const [dashboardsLoaded, setDashboardsLoaded] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const { notifications } = useNotifications();
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  // Goes true once the bootstrap chain has finished trying (success
  // or fail). Used to distinguish "still loading" from "tried,
  // nothing resolved" so we can show the right stub vs. spinner.
  const [identityResolved, setIdentityResolved] = useState(false);
  // Goes true when the Clerk auth path resolves a user (i.e. when
  // ClerkAuthGate's bridge fires `clerk-user-resolved`). Used to
  // decide whether to show the "Sign out" item in the avatar menu —
  // legacy-bootstrap deployments have nothing to sign out of, so
  // we hide it there to avoid a misleading affordance.
  const [clerkActive, setClerkActive] = useState(false);
  const [userCapabilities, setUserCapabilities] = useState({ can_design: false, can_manage: false });
  const location = useLocation();
  const navigate = useNavigate();
  const electronMode = isElectron();

  // Bootstrap the visitor's identity on mount. Resolution chain:
  //
  //   1. ?user_id=<guid> in the URL  — kiosk/share-URL pattern.
  //      The param is consumed and stripped from the URL bar so it
  //      doesn't get bookmarked; the GUID lands in localStorage.
  //   2. localStorage.currentUserGuid  — set by a prior session
  //      (including a prior Tier-1 visit or a dev-mode dropdown
  //      selection in Electron).
  //   3. Admin setting `default_browser_user_guid`  — deployment-
  //      wide default for visitors who didn't bring an identity.
  //   4. Nothing  — render the "sign-in not configured" stub so a
  //      visitor without an identity can't blunder into the app.
  //
  // Electron mode is unchanged — its credential flow runs separately
  // and `currentUser` is set by the Electron init path.
  useEffect(() => {
    const bootstrap = async () => {
      try {
        // Tier 0: ?key=trve_… in the URL — kiosk pattern, also
        // anyone hand-crafting an API-key-authenticated link.
        // Stamp the key onto apiClient so every subsequent call
        // sends Authorization: Bearer trve_…, then strip it from
        // the URL bar. The remainder of the bootstrap proceeds
        // normally; getCurrentUser() will resolve the user from
        // the API key's owner instead of the legacy GUID path.
        const urlParams = new URLSearchParams(window.location.search);
        const fromKey = urlParams.get('key');
        if (fromKey && fromKey.startsWith('trve_')) {
          apiClient.setApiKey(fromKey);
          urlParams.delete('key');
          const cleanQuery = urlParams.toString();
          const cleanUrl = window.location.pathname +
            (cleanQuery ? '?' + cleanQuery : '') +
            window.location.hash;
          window.history.replaceState(null, '', cleanUrl);
        }

        const response = await apiClient.getUsers().catch(() => ({ users: [] }));
        const list = response?.users || [];
        setUsers(list);

        // Tier 1: ?user_id=<guid> URL param. Strip from address bar
        // after capture so a refresh doesn't perpetually re-apply
        // (and so it doesn't sit in the user's history bar).
        const fromUrl = urlParams.get('user_id');
        if (fromUrl) {
          urlParams.delete('user_id');
          const cleanQuery = urlParams.toString();
          const cleanUrl = window.location.pathname +
            (cleanQuery ? '?' + cleanQuery : '') +
            window.location.hash;
          window.history.replaceState(null, '', cleanUrl);
          apiClient.setCurrentUser(fromUrl);
        }

        // If a Tier 0 API key was set above, /api/auth/me identifies
        // the user (the apikey'd request resolves them server-side).
        // This wins ahead of the localStorage / admin-default
        // tiers — the URL key was an explicit authentication signal.
        if (apiClient.apiKey) {
          try {
            const me = await apiClient.getCurrentUser();
            // /api/auth/me returns { user_id (mongo _id), name,
            // capabilities, can_design, can_manage }. Look the user
            // up in the users list (when accessible) to get the GUID,
            // otherwise synthesize a minimal user record.
            const owner = list.find((u) => u.id === me.user_id) || {
              id: me.user_id,
              guid: me.user_id, // best-effort placeholder; UI uses name primarily
              name: me.name,
              capabilities: me.capabilities,
            };
            setCurrentUser(owner);
            setIdentityResolved(true);
            return;
          } catch (e) {
            console.warn('Bootstrap: API key did not resolve a user', e);
            // Fall through to legacy tiers.
          }
        }

        // Tier 2: whatever is now in localStorage (just-set above
        // OR persisted from a prior session).
        let guid = apiClient.getCurrentUserGuid();
        let user = guid ? list.find((u) => u.guid === guid) : null;

        // Tier 3: admin-configured default. Only consulted when no
        // identity has been established yet for this browser.
        if (!user) {
          try {
            const adminDefault = await apiClient.getSetting('default_browser_user_guid');
            const def = (adminDefault?.value || '').toString().trim();
            if (def) {
              user = list.find((u) => u.guid === def) || null;
              if (user) {
                apiClient.setCurrentUser(user.guid);
              }
            }
          } catch {
            // Setting may not exist on older deployments — fall through
            // to Tier 4.
          }
        }

        // Tier 4 (dev only): default to first user. In production
        // this is intentionally skipped — a fresh visitor with no
        // URL param, no localStorage, and no admin default sees the
        // sign-in stub instead of being silently logged in as
        // someone.
        if (!user && import.meta.env.DEV && list.length > 0) {
          user = list[0];
          apiClient.setCurrentUser(user.guid);
        }

        if (user) {
          setCurrentUser(user);
        }
      } catch (err) {
        console.error('Failed to bootstrap user identity:', err);
      } finally {
        setIdentityResolved(true);
      }
    };
    bootstrap();
  }, []);

  // Clerk-resolved-user event hook. ClerkAuthGate dispatches this
  // event after a successful sign-in once /api/auth/me + the full
  // user fetch have completed. Listening here lets the avatar / name
  // / capability gates update the moment Clerk hands us an identity,
  // even if the legacy bootstrap chain ran first and resolved
  // nothing. Safe in non-Clerk deployments — the event simply never
  // fires.
  useEffect(() => {
    const onClerkUser = (e) => {
      const u = e?.detail?.user;
      if (!u) return;
      setUsers((prev) => {
        // Make sure the resolved user is in the local users list so
        // header lookups by GUID find them.
        const exists = prev.some((x) => x.guid === u.guid);
        return exists ? prev : [...prev, u];
      });
      setCurrentUser(u);
      setIdentityResolved(true);
      setClerkActive(true);
    };
    window.addEventListener('clerk-user-resolved', onClerkUser);
    return () => window.removeEventListener('clerk-user-resolved', onClerkUser);
  }, []);

  // Sign-out handler — only meaningful when Clerk is the active
  // auth path. Clears the cross-domain Clerk session via the SDK
  // (which clears its cookies via Clerk's API), then strips local
  // identity state and reloads to drop any in-flight components
  // that still hold a stale currentUser. Reload is the simplest
  // way to re-enter ClerkAuthGate's signed-out branch.
  const handleClerkSignOut = useCallback(async () => {
    try {
      if (window.Clerk?.signOut) {
        await window.Clerk.signOut();
      }
    } catch (err) {
      console.warn('Clerk sign-out failed', err);
    }
    apiClient.setTokenProvider(null);
    apiClient.setCurrentUser(null);
    try {
      sessionStorage.clear();
    } catch (err) {
      // sessionStorage can throw in private-mode or with strict
      // cookie policies; ignore — we've already cleared what we can.
      console.warn('sessionStorage.clear failed', err);
    }
    window.location.reload();
  }, []);

  // Fetch current user capabilities when user changes
  const fetchCapabilities = useCallback(async () => {
    if (!currentUser) return;
    try {
      const capabilities = await apiClient.getCurrentUser();
      setUserCapabilities(capabilities);
      // Hydrate persisted list prefs from user config (view mode, sort, filters per list page)
      hydrateListPrefs();
      // If current mode is not allowed for this user, switch to VIEW
      if (currentMode === MODES.DESIGN && !capabilities.can_design) {
        handleModeChange(MODES.VIEW);
      } else if (currentMode === MODES.MANAGE && !capabilities.can_manage) {
        handleModeChange(MODES.VIEW);
      }
    } catch (err) {
      console.error('Failed to fetch capabilities:', err);
      // Default to VIEW-only if we can't fetch capabilities
      setUserCapabilities({ can_design: false, can_manage: false });
    }
  }, [currentUser, currentMode]);

  useEffect(() => {
    fetchCapabilities();
  }, [fetchCapabilities]);

  // Handle user selection change
  const handleUserChange = (user) => {
    setCurrentUser(user);
    apiClient.setCurrentUser(user.guid);
  };

  // Fetch default dashboard (user preference or first alphabetically)
  const fetchDefaultDashboard = async () => {
    try {
      // First check if user has a configured default dashboard
      const userGuid = apiClient.getCurrentUserGuid();
      if (userGuid) {
        try {
          const userConfig = await apiClient.getUserConfig(userGuid);
          if (userConfig.settings?.default_dashboard_id) {
            return userConfig.settings.default_dashboard_id;
          }
        } catch {
          // Ignore errors - user may not have config yet
        }
      }

      // Fall back to first dashboard alphabetically
      const response = await fetch(`${API_BASE}/api/dashboards?page=1&page_size=1`);
      if (response.ok) {
        const data = await response.json();
        if (data.dashboards && data.dashboards.length > 0) {
          return data.dashboards[0].id;
        }
      }
    } catch (err) {
      console.error('Failed to fetch default dashboard:', err);
    }
    return null;
  };

  const { runModeGuard, isEditingDashboard } = useModeGuard();

  // Sync the mode to the URL prefix on every navigation. The URL is
  // the source of truth — a refresh on /view/dashboards/X should land
  // in VIEW mode even if the last persisted mode was MANAGE. Without
  // this the header pill and side nav can desync from the route.
  //
  // Exception: when the viewer signals isEditingDashboard (either in
  // active edit mode from the design list / eye icon preview, or as a
  // design-origin preview via fromDesign), we keep the pill on DESIGN
  // so the user understands they're still in the design workflow. As
  // soon as the viewer clears the flag (exit edit / navigate away),
  // the /view/... → VIEW mapping takes over.
  useEffect(() => {
    const path = location.pathname;
    let routeMode = null;
    if (path.startsWith('/design/')) routeMode = MODES.DESIGN;
    else if (path.startsWith('/view/')) routeMode = isEditingDashboard ? MODES.DESIGN : MODES.VIEW;
    else if (path.startsWith('/manage')) routeMode = MODES.MANAGE;
    if (routeMode && routeMode !== currentMode) {
      setCurrentMode(routeMode);
      localStorage.setItem('dashboardMode', routeMode);
    }
  }, [location.pathname, isEditingDashboard, currentMode]);

  // Handle mode change and persist to localStorage. If a page registered
  // a guard (e.g., dirty dashboard editor), consult it first — the guard
  // can show a confirmation, save, or block the switch entirely. The
  // guard can also return a dashboardId to land on after the switch
  // (e.g., switching to View while editing dashboard X lands on X
  // rather than the user's default).
  const handleModeChange = async (newMode) => {
    if (newMode === currentMode) return;
    const { proceed, dashboardId } = await runModeGuard(newMode);
    if (!proceed) return;
    setCurrentMode(newMode);
    localStorage.setItem('dashboardMode', newMode);
    // Navigate to appropriate default route for the mode
    if (newMode === MODES.DESIGN) {
      navigate('/design/dashboards');
    } else if (newMode === MODES.VIEW) {
      // Prefer the dashboard the guard handed us (e.g., the one we
      // were just editing). Otherwise fall back to the user's default.
      if (dashboardId) {
        navigate(`/view/dashboards/${dashboardId}`);
      } else {
        const defaultId = await fetchDefaultDashboard();
        if (defaultId) {
          navigate(`/view/dashboards/${defaultId}`);
        } else {
          navigate('/view/dashboards');
        }
      }
    } else if (newMode === MODES.MANAGE) {
      navigate('/manage');
    }
  };

  // Initial fetch of default dashboard for app load redirect
  useEffect(() => {
    const loadDefaultDashboard = async () => {
      const defaultId = await fetchDefaultDashboard();
      setFirstDashboardId(defaultId);
      setDashboardsLoaded(true);
    };
    loadDefaultDashboard();
  }, []);

  // Render navigation based on current mode
  const renderNavigation = () => {
    switch (currentMode) {
      case MODES.DESIGN:
        return <DesignModeNav location={location} navigate={navigate} />;
      case MODES.VIEW:
        return <ViewModeNav location={location} navigate={navigate} />;
      case MODES.MANAGE:
        return <ManageModeNav location={location} navigate={navigate} />;
      default:
        return <DesignModeNav location={location} navigate={navigate} />;
    }
  };

  // Production browser-mode visitor with no resolved identity:
  // show a stub. We never want to silently grant access to whoever
  // hits the URL, but we also don't want a blank screen — give the
  // visitor enough context to know what to do next.
  // Dev mode and Electron mode are intentionally excluded; the
  // dropdown / Electron credential flow handles those.
  if (!electronMode && !import.meta.env.DEV && identityResolved && !currentUser) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--cds-text-primary)',
        background: 'var(--cds-background)',
      }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 300, marginBottom: '1rem' }}>
          Sign-in not configured
        </h1>
        <p style={{ maxWidth: '36rem', color: 'var(--cds-text-secondary)', lineHeight: 1.5 }}>
          This deployment doesn't have a default user assigned and no
          identity was supplied with this request. An administrator
          can either set <code style={{ background: 'var(--cds-layer-01)', padding: '0.125rem 0.375rem', borderRadius: 3 }}>default_browser_user_guid</code> in
          Manage&nbsp;→&nbsp;Settings, or share a personal launch URL of
          the form <code style={{ background: 'var(--cds-layer-01)', padding: '0.125rem 0.375rem', borderRadius: 3 }}>?user_id=&lt;your-guid&gt;</code>.
        </p>
      </div>
    );
  }

  return (
    <NamespaceProvider currentUserGuid={currentUser?.guid || null}>
    <div className={electronMode ? 'electron-mode' : ''}>
      <HeaderContainer
        render={() => (
          <Header aria-label="My Dashboard">
            {/* Only show nav toggle in Design/Manage modes (View mode has no sidebar) */}
            {currentMode !== MODES.VIEW && (
              <button
                className="nav-toggle-button"
                aria-label={isSideNavExpanded ? 'Close menu' : 'Open menu'}
                onClick={() => setIsSideNavExpanded(!isSideNavExpanded)}
                type="button"
              >
                {isSideNavExpanded ? <Close size={20} /> : <Menu size={20} />}
              </button>
            )}
            <HeaderName href="/" prefix="" className={currentMode === MODES.VIEW ? 'header-name--no-toggle' : ''}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem' }}>
                <ChartMultitype size={20} />
                <span>TRVE Dashboards</span>
              </div>
            </HeaderName>
            <div className="header-mode-group">
              <ModeToggle
                currentMode={currentMode}
                onModeChange={handleModeChange}
                capabilities={userCapabilities}
              />
            </div>
            <HeaderGlobalBar>
              {(userCapabilities.can_design || userCapabilities.can_manage) && <NamespacePicker />}

              {/* Dev-only user impersonation pill. Sits between
                  NamespacePicker and the help/notification icons so
                  it reads as a context control alongside the
                  namespace picker. Vite tree-shakes this out of
                  production bundles via import.meta.env.DEV. */}
              {import.meta.env.DEV && !electronMode && (
                <DevUserSwitcher
                  currentUser={currentUser}
                  users={users}
                  onUserChange={handleUserChange}
                />
              )}

              <HeaderGlobalAction
                aria-label={`Help - Build ${buildInfo.buildNumber}`}
                tooltipAlignment="end"
                onClick={() => window.open('/docs', '_blank')}
              >
                <Help size={20} />
              </HeaderGlobalAction>

              <HeaderGlobalAction
                aria-label="Notifications"
                onClick={() => setNotificationPanelOpen(!notificationPanelOpen)}
                className="notification-badge"
              >
                <Notification size={20} />
                {notifications.length > 0 && (
                  <span className="notification-badge__count">
                    {notifications.length > 99 ? '99+' : notifications.length}
                  </span>
                )}
              </HeaderGlobalAction>

              {/* Avatar / account menu — single component for
                  prod, dev, and electron. The dev user-switcher
                  above handles impersonation; this menu is always
                  the *current* user's account actions (API keys
                  today; sign-out / MFA when Clerk lands). */}
              <AccountMenu
                currentUser={currentUser}
                electronMode={electronMode}
                onDisconnect={onDisconnect}
                onSignOut={clerkActive ? handleClerkSignOut : undefined}
              />
            </HeaderGlobalBar>
          </Header>
        )}
      />

      <NotificationPanel
        open={notificationPanelOpen}
        onClose={() => setNotificationPanelOpen(false)}
      />
      <ToastStack />

      {/* Hide sidebar in View mode - uses tile view instead */}
      {currentMode !== MODES.VIEW && (
        <SideNav
          aria-label="Side navigation"
          expanded={isSideNavExpanded}
          isPersistent={true}
          onOverlayClick={() => setIsSideNavExpanded(false)}
        >
          {renderNavigation()}
        </SideNav>
      )}

      <Content className={`app-content ${currentMode === MODES.VIEW ? 'app-content--no-nav' : (isSideNavExpanded ? '' : 'app-content--nav-collapsed')}`}>
        <Routes>
          {/* Default route redirects to View mode - first dashboard or fallback */}
          <Route path="/" element={
            dashboardsLoaded ? (
              firstDashboardId ? (
                <Navigate to={`/view/dashboards/${firstDashboardId}`} replace />
              ) : (
                <Navigate to="/view/dashboards" replace />
              )
            ) : null
          } />

          {/* Design Mode Routes */}
          <Route path="/design/connections" element={<ConnectionsPage />} />
          <Route path="/design/connections/:id" element={<ConnectionDetailPage />} />
          {/* Legacy datasources routes - redirect to connections */}
          <Route path="/design/datasources" element={<Navigate to="/design/connections" replace />} />
          <Route path="/design/datasources/:id" element={<Navigate to="/design/connections" replace />} />
          <Route path="/design/components" element={<ComponentsListPage />} />
          <Route path="/design/components/ai/:chartId" element={<AIBuilderPage />} />
          <Route path="/design/components/:id" element={<ComponentDetailPage />} />
          <Route path="/design/dashboards" element={<DashboardsListPage />} />
          <Route path="/design/dashboards/:id" element={<DashboardEditRedirect />} />

          {/* View Mode Routes */}
          <Route path="/view/dashboards" element={<DashboardTileViewPage />} />
          <Route path="/view/dashboards/:id" element={<DashboardViewerPage canDesign={userCapabilities.can_design} />} />

          {/* Manage Mode Routes */}
          <Route path="/manage" element={<Navigate to="/manage/users" replace />} />
          <Route path="/manage/users" element={<UsersListPage />} />
          <Route path="/manage/users/:id" element={<UserDetailPage />} />
          <Route path="/manage/devices" element={<DevicesPage />} />
          <Route path="/manage/settings" element={<SettingsPage />} />
          <Route path="/manage/namespaces" element={<NamespacesPage />} />

          {/* API Keys is per-user account settings, not Manage Mode.
              The old /manage/api-keys path redirects to the new
              /account/* surface so prior links and bookmarks still
              land in the right place. */}
          <Route path="/account/api-keys" element={<ApiKeysListPage />} />
          <Route path="/manage/api-keys" element={<Navigate to="/account/api-keys" replace />} />

          {/* Legacy routes for backwards compatibility - redirect to design mode */}
          <Route path="/dashboard" element={<Navigate to="/design/dashboards" replace />} />
          <Route path="/design/layouts" element={<Navigate to="/design/dashboards" replace />} />
          <Route path="/design/layouts/:id" element={<Navigate to="/design/dashboards" replace />} />
          <Route path="/nodes" element={<Navigate to="/design/connections" replace />} />
          <Route path="/queries" element={<Navigate to="/design/connections" replace />} />
        </Routes>
      </Content>
    </div>
    </NamespaceProvider>
  );
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const electronMode = isElectron();

  // Check for stored credentials on startup (Electron mode only)
  useEffect(() => {
    const checkCredentials = async () => {
      if (!electronMode) {
        // Browser mode - always authenticated (uses user dropdown)
        setIsAuthenticated(true);
        setIsCheckingAuth(false);
        return;
      }

      // Electron mode - check for stored credentials. The "key"
      // here is a `trve_…` API key (not a user GUID). Stamp it
      // onto apiClient and validate via /api/auth/me. On failure,
      // clear local state so the user lands back on LoginPage.
      try {
        const creds = await getCredentials();
        if (creds && creds.serverUrl && creds.key) {
          apiClient.setServerUrl(creds.serverUrl);
          apiClient.setApiKey(creds.key);
          try {
            await apiClient.getCurrentUser();
            setIsAuthenticated(true);
          } catch (err) {
            console.error('Stored credentials invalid:', err);
            await clearCredentials();
            apiClient.clearApiKey();
            apiClient.clearCredentials();
          }
        }
      } catch (err) {
        console.error('Error checking credentials:', err);
      }
      setIsCheckingAuth(false);
    };

    checkCredentials();
  }, [electronMode]);

  // Handle successful login from LoginPage
  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
  };

  // Handle disconnect (Electron mode)
  const handleDisconnect = async () => {
    await clearCredentials();
    apiClient.clearApiKey();
    apiClient.clearCredentials();
    setIsAuthenticated(false);
  };

  // Show loading while checking credentials
  if (isCheckingAuth) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: 'var(--cds-background)'
      }}>
        <Loading withOverlay={false} description="Checking credentials..." />
      </div>
    );
  }

  // Show login page if in Electron mode and not authenticated
  if (electronMode && !isAuthenticated) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  // Show main app
  return (
    <NotificationProvider>
      <EnabledTypesProvider>
        <ModeGuardProvider>
          <Router>
            <AppContent onDisconnect={handleDisconnect} />
          </Router>
        </ModeGuardProvider>
      </EnabledTypesProvider>
    </NotificationProvider>
  );
}

export default App;
