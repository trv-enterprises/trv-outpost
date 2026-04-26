// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Header,
  HeaderContainer,
  HeaderName,
  HeaderGlobalBar,
  HeaderGlobalAction,
  SideNav,
  Content,
  OverflowMenu,
  OverflowMenuItem,
  Loading
} from '@carbon/react';
import {
  Help,

  Notification,
  UserAvatar,
  ChartMultitype,
  Menu,
  Close,
  Checkmark,
  Logout
} from '@carbon/icons-react';
import apiClient, { API_BASE } from './api/client';
import { isElectron } from './utils/electron';
import { getCredentials, clearCredentials } from './utils/secureStorage';
import { hydrateListPrefs } from './utils/listPrefs';
import LoginPage from './pages/LoginPage';
import ConnectionsPage from './pages/ConnectionsPage';
import ConnectionDetailPage from './pages/ConnectionDetailPage';
import ChartsListPage from './pages/ChartsListPage';
import ChartDetailPage from './pages/ChartDetailPage';
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
import { NotificationProvider, useNotifications } from './context/NotificationContext';
import { EnabledTypesProvider } from './context/EnabledTypesContext';
import { NamespaceProvider } from './context/NamespaceContext';
import NamespacePicker from './components/NamespacePicker';
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
        const response = await apiClient.getUsers().catch(() => ({ users: [] }));
        const list = response?.users || [];
        setUsers(list);

        // Tier 1: URL param. Strip from address bar after capture so
        // a refresh doesn't perpetually re-apply (and so it doesn't
        // sit in the user's history bar).
        const urlParams = new URLSearchParams(window.location.search);
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
              {electronMode ? (
                // Electron mode: Show current user with disconnect option
                <OverflowMenu
                  aria-label="User Account"
                  renderIcon={() => <UserAvatar size={20} />}
                  flipped
                  menuOptionsClass="user-menu-options"
                >
                  <OverflowMenuItem
                    itemText={
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <UserAvatar size={16} />
                        <span>{currentUser?.name || 'Connected'}</span>
                      </span>
                    }
                    disabled
                  />
                  <OverflowMenuItem
                    itemText={
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Logout size={16} />
                        <span>Disconnect</span>
                      </span>
                    }
                    onClick={onDisconnect}
                    hasDivider
                  />
                </OverflowMenu>
              ) : import.meta.env.DEV ? (
                // Dev mode: full user-switching dropdown so different
                // roles can be exercised against a local server.
                // Stripped from production bundles by Vite.
                <OverflowMenu
                  aria-label="User Account"
                  renderIcon={() => <UserAvatar size={20} />}
                  flipped
                  menuOptionsClass="user-menu-options"
                >
                  {users.map((user) => (
                    <OverflowMenuItem
                      key={user.guid}
                      itemText={
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          {currentUser?.guid === user.guid && <Checkmark size={16} />}
                          <span style={{ marginLeft: currentUser?.guid === user.guid ? 0 : '1.5rem' }}>
                            {user.name}
                          </span>
                        </span>
                      }
                      onClick={() => handleUserChange(user)}
                    />
                  ))}
                </OverflowMenu>
              ) : (
                // Production browser mode: read-only label showing
                // the bootstrapped identity. Clicking does not open
                // a switcher — to act as a different user, visit
                // with `?user_id=<their-guid>` in the URL.
                <HeaderGlobalAction
                  aria-label="Current user"
                  tooltipAlignment="end"
                  // Use HeaderGlobalAction's tooltip to surface the name
                  title={currentUser?.name ? `Signed in as ${currentUser.name}` : 'No user'}
                  onClick={(e) => e.preventDefault()}
                  style={{ cursor: 'default' }}
                >
                  <UserAvatar size={20} />
                </HeaderGlobalAction>
              )}
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
          <Route path="/design/charts" element={<ChartsListPage />} />
          <Route path="/design/charts/ai/:chartId" element={<AIBuilderPage />} />
          <Route path="/design/charts/:id" element={<ChartDetailPage />} />
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

          {/* Legacy routes for backwards compatibility - redirect to design mode */}
          <Route path="/dashboard" element={<Navigate to="/design/dashboards" replace />} />
          <Route path="/design/layouts" element={<Navigate to="/design/dashboards" replace />} />
          <Route path="/design/layouts/:id" element={<Navigate to="/design/dashboards" replace />} />
          <Route path="/nodes" element={<Navigate to="/design/connections" replace />} />
          <Route path="/queries" element={<Navigate to="/design/connections" replace />} />
          <Route path="/chart-design" element={<Navigate to="/design/charts" replace />} />
        </Routes>
      </Content>
    </div>
    </NamespaceProvider>
  );
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [connectedUser, setConnectedUser] = useState(null);
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

      // Electron mode - check for stored credentials
      try {
        const creds = await getCredentials();
        if (creds && creds.serverUrl && creds.key) {
          // Try to validate the stored credentials
          apiClient.setServerUrl(creds.serverUrl);
          try {
            const user = await apiClient.login(creds.key);
            setConnectedUser(user);
            setIsAuthenticated(true);
          } catch (err) {
            console.error('Stored credentials invalid:', err);
            // Clear invalid credentials
            await clearCredentials();
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
  const handleLoginSuccess = (loginData) => {
    setConnectedUser(loginData.user);
    setIsAuthenticated(true);
  };

  // Handle disconnect (Electron mode)
  const handleDisconnect = async () => {
    await clearCredentials();
    apiClient.clearCredentials();
    setConnectedUser(null);
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
