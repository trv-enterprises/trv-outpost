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

// Redirect /design/dashboards/:id to /view/dashboards/:id with auto-edit
function DashboardEditRedirect() {
  const { id } = useParams();
  if (id === 'new') {
    return <Navigate to="/view/dashboards/new" state={{ autoEdit: true, isNew: true }} replace />;
  }
  return <Navigate to={`/view/dashboards/${id}`} state={{ autoEdit: true }} replace />;
}

function AppContent({ onDisconnect }) {
  const [isSideNavExpanded, setIsSideNavExpanded] = useState(true);
  const [currentMode, setCurrentMode] = useState(() => {
    // Load mode from localStorage or default to VIEW
    const savedMode = localStorage.getItem('dashboardMode');
    return savedMode || MODES.VIEW;
  });
  const [firstDashboardId, setFirstDashboardId] = useState(null);
  const [dashboardsLoaded, setDashboardsLoaded] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const { notifications } = useNotifications();
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [userCapabilities, setUserCapabilities] = useState({ can_design: false, can_manage: false });
  const location = useLocation();
  const navigate = useNavigate();
  const electronMode = isElectron();

  // Fetch users list on mount
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await apiClient.getUsers();
        if (response.users) {
          setUsers(response.users);
          // If no current user set, use the saved one from localStorage or default to first user
          const savedGuid = apiClient.getCurrentUserGuid();
          const savedUser = savedGuid ? response.users.find(u => u.guid === savedGuid) : null;
          if (savedUser) {
            setCurrentUser(savedUser);
            // Sync the API client with the restored user
            apiClient.setCurrentUser(savedUser.guid);
          } else if (response.users.length > 0) {
            // Default to first user (Admin)
            handleUserChange(response.users[0]);
          }
        }
      } catch (err) {
        console.error('Failed to fetch users:', err);
      }
    };
    fetchUsers();
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

  const { runModeGuard } = useModeGuard();

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
              <NamespacePicker />
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
              ) : (
                // Browser mode: Show user selection dropdown
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
