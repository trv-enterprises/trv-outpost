// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
// BrowserRouter derives routes from window.location.pathname, which
// is "/" on a webserver-hosted install but "/Applications/.../app/
// index.html" (the literal file path) when Electron loads the bundle
// from a file:// URL — no route matches and the app renders nothing.
// HashRouter uses the URL fragment (#/path) for routing, which works
// identically regardless of how the page was loaded. Pick at runtime
// so dev (Vite at http://localhost:5173) keeps the clean BrowserRouter
// behavior while packaged Electron uses HashRouter.
import { BrowserRouter, HashRouter, Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
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
  AiLaunch,
} from '@carbon/icons-react';
import apiClient from './api/client';
import { isElectron } from './utils/electron';
import { setStreamBufferSize } from './utils/streamBufferConfig';
import { getCredentials, clearCredentials } from './utils/secureStorage';
import { hydrateListPrefs } from './utils/listPrefs';
import LoginPage from './pages/LoginPage';
import ConnectionsPage from './pages/ConnectionsPage';
import ConnectionDetailPage from './pages/ConnectionDetailPage';
import ComponentsListPage from './pages/ComponentsListPage';
import ComponentDetailPage from './pages/ComponentDetailPage';
// AIBuilderPage is code-split: it's only reachable when the deployment has
// an Anthropic API key configured, so users without one never download it.
const AIBuilderPage = lazy(() => import('./pages/AIBuilderPage'));

// See the BrowserRouter/HashRouter import comment above: pick the router
// at runtime based on where the bundle was loaded from.
const Router = isElectron() ? HashRouter : BrowserRouter;
import DashboardsListPage from './pages/DashboardsListPage';
// Dashboard design/edit lives in DashboardViewerPage edit mode
import DashboardViewerPage from './pages/DashboardViewerPage';
import DashboardTileViewPage from './pages/DashboardTileViewPage';
import KioskPage from './pages/KioskPage';
import ModeToggle from './components/mode/ModeToggle';
import DesignModeNav from './components/navigation/DesignModeNav';
import ViewModeNav from './components/navigation/ViewModeNav';
import ManageModeNav from './components/navigation/ManageModeNav';
import UsersListPage from './pages/UsersListPage';
import UserDetailPage from './pages/UserDetailPage';
import SettingsPage from './pages/SettingsPage';
import AIUsagePage from './pages/AIUsagePage';
import SystemUsersPage from './pages/SystemUsersPage';
import DevicesPage from './pages/DevicesPage';
import NamespacesPage from './pages/NamespacesPage';
import ApiKeysListPage from './pages/ApiKeysListPage';
import TsStoreAlertsExtensionPage from './pages/TsStoreAlertsExtensionPage';
import TsStoreAlertRuleEditorPage from './pages/TsStoreAlertRuleEditorPage';
import TsStoreAlertRuleViewPage from './pages/TsStoreAlertRuleViewPage';
import EdgeLakeTerminalPage from './pages/EdgeLakeTerminalPage';
import { NotificationProvider, useNotifications } from './context/NotificationContext';
import { EnabledTypesProvider } from './context/EnabledTypesContext';
import { AIAvailabilityProvider, useAIAvailability } from './context/AIAvailabilityContext';
import { NamespaceProvider, useNamespaces } from './context/NamespaceContext';
import { AssistantSurfaceProvider } from './context/AssistantSurfaceContext';
import NamespacePicker from './components/NamespacePicker';
import AccountMenu from './components/AccountMenu';
import AboutDialog from './components/AboutDialog';
import AssistantSidecard from './components/assistant/AssistantSidecard';
import useAssistantSidecardState from './hooks/useAssistantSidecardState';
import { ModeGuardProvider, useModeGuard } from './context/ModeGuardContext';
import NotificationPanel from './components/NotificationPanel';
import ToastStack from './components/ToastStack';
import { useEventStream } from './hooks/useEventStream';
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

// Route guard for /design/components/ai/:chartId. When the deployment has
// no Anthropic API key configured, AI menu items are hidden but a stale
// bookmark / pasted link could still hit this route — send users back to
// the components list rather than loading a page that can never succeed.
// While availability is still loading we render nothing (Suspense fallback
// already shows for the lazy chunk on the success path).
function AIBuilderGate() {
  const { enabled, loading } = useAIAvailability();
  if (loading) return null;
  if (!enabled) return <Navigate to="/design/components" replace />;
  return (
    <Suspense fallback={null}>
      <AIBuilderPage />
    </Suspense>
  );
}

// Small wrapper around AssistantSidecard that lives INSIDE the
// NamespaceProvider tree so it can read activeNamespace via context.
// AppContent's body is outside the provider, so it can't call
// useNamespaces directly — this child component bridges the gap.
//
// Step 9 ships the chrome only; modelLabel is a static placeholder
// for now and will pull from /api/ai/availability once that endpoint
// surfaces the model (step 8+ work, deferred to keep step 9 focused).
function AssistantSidecardWithNamespace({ open, width, minWidth, onResize, onRequestClose, currentUser }) {
  const { activeNamespace } = useNamespaces();
  return (
    <AssistantSidecard
      open={open}
      width={width}
      minWidth={minWidth}
      onResize={onResize}
      onRequestClose={onRequestClose}
      namespace={activeNamespace || 'default'}
      modelLabel="sonnet"
      userName={currentUser?.name || currentUser?.guid || null}
    />
  );
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
  const { notifications, addNotification, hydrateFromServer: hydrateNotifications, panelOpen: notificationPanelOpen, togglePanel: toggleNotificationPanel, closePanel: closeNotificationPanel } = useNotifications();
  // `_users` is the previously-exposed dev user list. The dev
  // user-switcher pill (the only consumer) was removed in favor of
  // the `?user_id=<guid>` URL param. The state + setUsers callsites
  // in the bootstrap / Clerk paths below are intentionally kept so
  // the existing identity-resolution flow isn't disturbed; nothing
  // currently reads the array.
  // eslint-disable-next-line no-unused-vars
  const [_users, setUsers] = useState([]);
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
  const [userCapabilities, setUserCapabilities] = useState({ can_view: false, can_design: false, can_manage: false, can_control: false });
  const [aboutOpen, setAboutOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const electronMode = isElectron();

  // Dashboard Assistant sidecard state. Render-gated by the
  // chatAgentEnabled flag from /api/ai/availability (step 0 of the
  // dashboard-assistant work). Hook owns open/close + width state,
  // persists to localStorage (instant) + user prefs (cross-device).
  const { chatAgentEnabled } = useAIAvailability();
  const assistantSidecard = useAssistantSidecardState();

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
        // Step 1: gather whatever inbound credential the URL has,
        // stamp it onto apiClient, strip it from the address bar.
        // These channels are what the SERVER's IdP registry knows
        // how to read at /api/auth/session — we just pre-load them.
        const urlParams = new URLSearchParams(window.location.search);
        let urlCleaned = false;
        const fromKey = urlParams.get('key');
        if (fromKey && fromKey.startsWith('trve_')) {
          apiClient.setApiKey(fromKey);
          urlParams.delete('key');
          urlCleaned = true;
        }
        const fromUrlGuid = urlParams.get('user_id');
        if (fromUrlGuid) {
          apiClient.setCurrentUser(fromUrlGuid);
          urlParams.delete('user_id');
          urlCleaned = true;
        }
        if (urlCleaned) {
          const cleanQuery = urlParams.toString();
          const cleanUrl = window.location.pathname +
            (cleanQuery ? '?' + cleanQuery : '') +
            window.location.hash;
          window.history.replaceState(null, '', cleanUrl);
        }

        // Step 2: if we have NO inbound credential yet, consult the
        // admin-default-browser-user-guid setting (public). This
        // is the kiosk pattern for deployments where one device
        // shouldn't have to type anything to identify itself.
        const hasInbound = !!(apiClient.apiKey || apiClient.tokenProvider || apiClient.getCurrentUserGuid());
        if (!hasInbound) {
          try {
            const adminDefault = await apiClient.getSetting('default_browser_user_guid');
            const def = (adminDefault?.value || '').toString().trim();
            if (def) apiClient.setCurrentUser(def);
          } catch {
            // Setting may not exist on older deployments — fall through.
          }
        }

        // Dev-only fallback: when no inbound credential has been
        // established at this point, pick the first cached user from
        // the dev-switcher's localStorage cache so we have something
        // to bootstrap with. The live directory call below would
        // 401 pre-bootstrap; the cache survives between sessions
        // and is good enough for picking SOME user to start with.
        // In prod this is intentionally skipped — a fresh visitor
        // with no URL key / no localStorage GUID / no admin default
        // sees the sign-in stub.
        if (!apiClient.apiKey && !apiClient.tokenProvider && !apiClient.getCurrentUserGuid() && import.meta.env.DEV) {
          try {
            const cached = localStorage.getItem('devUserSwitcher.users');
            if (cached) {
              const parsed = JSON.parse(cached);
              if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].guid) {
                apiClient.setCurrentUser(parsed[0].guid);
              }
            }
          } catch {
            // Malformed cache — non-fatal.
          }
        }

        // Step 3: SINGLE bootstrap call. The server walks its IdP
        // registry, finds whichever credential is presented (API
        // key, Clerk JWT, X-User-ID, ?user_id=), validates it, and
        // returns an access JWT + sets the refresh cookie.
        // After this, every other request just rides the access
        // token from apiClient.
        if (!apiClient.apiKey && !apiClient.tokenProvider && !apiClient.getCurrentUserGuid()) {
          // No inbound credential, no point asking — render the
          // sign-in stub.
          return;
        }
        // Snapshot which credential channel we're bootstrapping with
        // BEFORE createSession runs — the call itself sets state
        // (accessToken, etc.) but doesn't tell us which IdP resolved.
        // We need this to decide whether to show the Sign-Out
        // affordance: that only makes sense for Clerk SSO sessions,
        // not API-key kiosks or X-User-ID dev mode.
        const bootstrappedViaClerk = !!apiClient.tokenProvider;
        const session = await apiClient.createSession();
        if (session?.user) {
          const me = session.user;
          setCurrentUser({
            id: me.user_id,
            guid: me.guid || me.user_id,
            name: me.name,
            active: me.active !== false,
            capabilities: me.capabilities,
          });
          // Sync the GUID side-channel so legacy callsites that
          // still call getCurrentUserGuid() (config-user routes,
          // any straggler logic) keep working during the transition.
          if (me.guid) apiClient.setCurrentUser(me.guid);
          // Flip clerkActive when the Clerk SDK provided the inbound
          // token. AccountMenu reads this to decide whether to render
          // the Sign-Out item — kiosks and dev-mode acts-as flows
          // intentionally don't surface it (there's no Clerk session
          // to sign out of).
          if (bootstrappedViaClerk) {
            setClerkActive(true);
          }
        }

        // Step 4: load the user directory for the in-header switcher.
        // MUST run AFTER createSession or every call 401s — apiClient
        // attaches the access token, which doesn't exist pre-bootstrap.
        // Best-effort; 403 for non-Manage callers is expected and
        // doesn't block anything. Dev-mode keeps a localStorage cache
        // so the switcher survives an act-as-non-admin reload.
        const response = await apiClient.getUsers().catch(() => ({ users: [] }));
        let list = response?.users || [];
        if (import.meta.env.DEV) {
          const DEV_SWITCHER_CACHE_KEY = 'devUserSwitcher.users';
          if (list.length > 0) {
            try {
              localStorage.setItem(DEV_SWITCHER_CACHE_KEY, JSON.stringify(list));
            } catch {
              // localStorage may be full or unavailable — non-fatal.
            }
          } else {
            try {
              const cached = localStorage.getItem(DEV_SWITCHER_CACHE_KEY);
              if (cached) {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed) && parsed.length > 0) list = parsed;
              }
            } catch {
              // Malformed cache JSON — non-fatal.
            }
          }
        }
        setUsers(list);
      } catch (err) {
        console.error('Failed to bootstrap user identity:', err);
      } finally {
        setIdentityResolved(true);
      }
    };

    // Wire the session-expired handler: when refresh permanently
    // fails (cookie gone, family revoked), re-bootstrap from scratch.
    // App.jsx is the only place that knows the inbound-credential
    // chain, so it owns the recovery path.
    apiClient.setSessionExpiredHandler(() => {
      console.warn('Session expired; re-bootstrapping');
      bootstrap();
    });

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
      // can_view is derived client-side from the capabilities list.
      // Server returns can_design and can_manage as convenience
      // booleans but doesn't (yet) ship can_view — keep the
      // derivation here so the contract is forward-compatible if
      // the server adds it later.
      const can_view = Array.isArray(capabilities.capabilities) &&
        capabilities.capabilities.includes('view');
      setUserCapabilities({ ...capabilities, can_view });
      // Hydrate persisted list prefs from user config (view mode, sort, filters per list page)
      hydrateListPrefs();
      // If current mode isn't allowed, switch to whatever IS.
      // Cascade: prefer view, then design, then manage. If none
      // are allowed, leave mode where it is (the route-tree guard
      // will surface a "no UI access" stub).
      const fallback = can_view
        ? MODES.VIEW
        : capabilities.can_design
          ? MODES.DESIGN
          : capabilities.can_manage
            ? MODES.MANAGE
            : null;
      if (currentMode === MODES.VIEW && !can_view && fallback) {
        handleModeChange(fallback);
      } else if (currentMode === MODES.DESIGN && !capabilities.can_design && fallback) {
        handleModeChange(fallback);
      } else if (currentMode === MODES.MANAGE && !capabilities.can_manage && fallback) {
        handleModeChange(fallback);
      }
    } catch (err) {
      console.error('Failed to fetch capabilities:', err);
      setUserCapabilities({ can_view: false, can_design: false, can_manage: false, can_control: false });
    }
  }, [currentUser, currentMode]);

  useEffect(() => {
    fetchCapabilities();
  }, [fetchCapabilities]);

  // Server-pushed events (alerts today) land here via SSE. Only
  // opened once identity is resolved AND we have a user — the
  // unauthenticated sign-in stub doesn't need a stream.
  useEventStream({
    ready: identityResolved && !!currentUser,
    addNotification,
  });

  // Hydrate the bell from /api/alerts once auth is settled — covers
  // the "alert fired while no one was logged in" case. SSE picks up
  // anything new after this; the reducer dedupes on alertId so live
  // pushes don't double-render an already-hydrated row.
  useEffect(() => {
    if (identityResolved && currentUser) {
      hydrateNotifications();
    }
  }, [identityResolved, currentUser, hydrateNotifications]);

  // Fetch default dashboard (user preference or first alphabetically).
  //
  // If the user has a configured default_dashboard_id but that dashboard
  // no longer exists (it was deleted out from under the pointer), we
  // CLEAR the stale pointer (set it to "") so the config self-heals and
  // the detection runs only once, surface a notice telling the user to
  // set a new default, and fall through to the alphabetical-first
  // dashboard so they still land somewhere instead of a 404.
  const fetchDefaultDashboard = async () => {
    try {
      // First check if user has a configured default dashboard
      const userGuid = apiClient.getCurrentUserGuid();
      if (userGuid) {
        try {
          const userConfig = await apiClient.getUserConfig(userGuid);
          const configuredId = userConfig.settings?.default_dashboard_id;
          if (configuredId) {
            // Validate it still exists before handing it back — a deleted
            // dashboard leaves a dangling pointer here.
            try {
              await apiClient.getDashboard(configuredId);
              return configuredId;
            } catch {
              // Configured default is gone. Clear the stale pointer
              // (best-effort — a failed clear must not break the
              // redirect), notify the user, then fall through to the
              // alphabetical-first fallback below. Clearing makes this
              // self-limiting: next load there's no pointer to detect.
              apiClient.updateUserConfig(userGuid, { default_dashboard_id: '' }).catch(() => {});
              addNotification({
                kind: 'warning',
                title: 'Default dashboard was deleted',
                subtitle: 'Your default dashboard no longer exists, so it has been cleared. Open Dashboards and choose "Set as Default" to pick a new one.',
              });
            }
          }
        } catch {
          // Ignore errors - user may not have config yet
        }
      }

      // Fall back to first dashboard alphabetically. Use apiClient (not raw
      // fetch) so the request carries auth — a bare fetch here 401s and the
      // fallback silently fails.
      const data = await apiClient.getDashboards({ page: 1, page_size: 1 });
      if (data?.dashboards && data.dashboards.length > 0) {
        return data.dashboards[0].id;
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
    // /account/* and any other off-mode route resolves to null so the
    // header pill is unlit. Otherwise the user gets stranded on a page
    // that highlights a mode whose nav doesn't match what they're
    // looking at, and clicking the lit pill does nothing because
    // handleModeChange short-circuits when newMode === currentMode.
    if (routeMode !== currentMode) {
      setCurrentMode(routeMode);
      if (routeMode) localStorage.setItem('dashboardMode', routeMode);
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

  // Initial fetch of default dashboard for app load redirect.
  //
  // Gated on identityResolved so we read the user's own
  // default_dashboard_id, not the global "first alphabetical"
  // fallback. The bootstrap chain that resolves a Clerk session,
  // a ?key=trve_... URL param, or an X-User-ID header is
  // asynchronous; the original empty-deps effect ran during the
  // brief window where apiClient.getCurrentUserGuid() still
  // returns null. fetchDefaultDashboard fell through to the
  // alphabetical-first dashboard, the Navigate fired, and the
  // URL replaced before identity resolved — the kiosk landed on
  // the wrong board.
  //
  // Now: wait for identityResolved; rerun if currentUser flips
  // (e.g. dev user-switcher). The Route path="/" guard at the
  // bottom of the tree already renders null while
  // dashboardsLoaded is false, so the redirect doesn't race with
  // this fetch.
  useEffect(() => {
    if (!identityResolved) return;
    const loadDefaultDashboard = async () => {
      const defaultId = await fetchDefaultDashboard();
      setFirstDashboardId(defaultId);
      setDashboardsLoaded(true);
    };
    loadDefaultDashboard();
  }, [identityResolved, currentUser]);

  // Load the deployment-wide streaming buffer depth (admin setting
  // stream_buffer_size) once identity resolves, and push it into the
  // shared stream-buffer config so every streaming chart (spec-driven
  // and custom-code) and the StreamConnectionManager use it. Read at
  // load only — a change applies on the next page load, matching the
  // setting's "applies on next page load" semantics.
  useEffect(() => {
    if (!identityResolved) return;
    (async () => {
      try {
        const s = await apiClient.getSetting('stream_buffer_size');
        if (s?.value != null) setStreamBufferSize(s.value);
      } catch {
        // Older deployments may not have the setting — keep the 1000 default.
      }
    })();
  }, [identityResolved]);

  // Load the component title scale (admin setting title_font_size, a
  // percentage of the 1rem base) once identity resolves and set the
  // --title-scale CSS variable on :root. The spec title bands (ChartShell
  // / NumberView / DataViewGrid) and the datatable header all multiply
  // their font + band height by var(--title-scale, 1), so one variable
  // scales every component title consistently. Clamped 50–200%. Read at
  // load only (applies on next page load), matching the setting's note.
  useEffect(() => {
    if (!identityResolved) return;
    (async () => {
      try {
        const s = await apiClient.getSetting('title_font_size');
        const pct = Number(s?.value);
        if (Number.isFinite(pct) && pct > 0) {
          const clamped = Math.min(200, Math.max(50, pct));
          document.documentElement.style.setProperty('--title-scale', String(clamped / 100));
        }
      } catch {
        // Older deployments may not have the setting — --title-scale
        // falls back to 1 (the default in every calc()).
      }
    })();
  }, [identityResolved]);

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

  // Bootstrap is still in flight (initial load or post-refresh).
  // Don't render the route tree yet — pages mount eagerly and fire
  // /api/* calls in their own useEffect, which would race the
  // session bootstrap and 401. Soft navigation doesn't have this
  // issue (App stays mounted, accessToken is already in memory);
  // hard refresh does, because access tokens live in JS memory only
  // and the new page has to re-bootstrap from URL/admin-default.
  //
  // We hold here ONLY while identity is unresolved. Once resolved,
  // either the route tree renders (currentUser present) or the
  // sign-in-not-configured stub above kicks in (currentUser nil in
  // prod). Dev mode never sees the stub but still benefits from
  // the bootstrap wait — pages no longer pre-render with a null
  // access token.
  if (!identityResolved) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: 'var(--cds-text-secondary)',
        background: 'var(--cds-background)',
      }}>
        <Loading description="Loading…" withOverlay={false} />
      </div>
    );
  }

  return (
    <NamespaceProvider currentUserGuid={currentUser?.guid || null}>
    <AssistantSurfaceProvider>
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
            {/*
              HeaderName's default `href="/"` produces a real navigation
              that escapes React Router. On Electron's HashRouter that
              resolves to the file:// root and bricks the app. Use a
              click handler + navigate() so the link stays inside the
              router regardless of which router is active.
            */}
            <HeaderName
              href="#"
              prefix=""
              className={currentMode === MODES.VIEW ? 'header-name--no-toggle' : ''}
              onClick={(e) => { e.preventDefault(); navigate('/'); }}
            >
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
              {/* Dashboard Assistant launcher. Sits left of the rest
                  of the header-action cluster (NamespacePicker, Help,
                  Notifications, AccountMenu). Only renders when:
                    1. The chat agent is enabled at the deployment
                       (Anthropic key set AND the unified ai.enabled
                       setting is true), AND
                    2. The caller has Design capability. The
                       assistant is a builder; View-only users
                       wouldn't have anything actionable to ask, and
                       Manage-only is system administration that the
                       chat agent isn't built for (the design doc
                       explicitly excludes Manage-shaped tools like
                       system-user creation from v1). */}
              {chatAgentEnabled && userCapabilities.can_design && (
                <HeaderGlobalAction
                  aria-label={assistantSidecard.open ? 'Hide assistant' : 'Open assistant'}
                  onClick={assistantSidecard.toggle}
                  isActive={assistantSidecard.open}
                  tooltipAlignment="end"
                  className="assistant-launcher-action"
                >
                  <AiLaunch size={20} />
                </HeaderGlobalAction>
              )}

              {/* NamespacePicker (info icon + active-namespace pill)
                  is authoring-only: it sets the default namespace for
                  *newly created* records (dashboards, components,
                  connections). Manage-only users administer the
                  system rather than author content, so they don't
                  need it. Gate on Design specifically. */}
              {userCapabilities.can_design && <NamespacePicker />}

              {/* Dev user impersonation pill removed — initial
                  load now accepts a `?user_id=<guid>` URL param,
                  which makes the in-header switcher redundant. */}

              <HeaderGlobalAction
                aria-label={`Help - Build ${buildInfo.buildNumber}`}
                tooltipAlignment="end"
                onClick={() => window.open('/docs', '_blank')}
              >
                <Help size={20} />
              </HeaderGlobalAction>

              <HeaderGlobalAction
                aria-label="Notifications"
                onClick={toggleNotificationPanel}
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
                onAbout={() => setAboutOpen(true)}
              />
            </HeaderGlobalBar>
          </Header>
        )}
      />

      <NotificationPanel
        open={notificationPanelOpen}
        onClose={closeNotificationPanel}
      />
      <ToastStack />

      <AboutDialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        currentUser={currentUser}
        clerkActive={clerkActive}
      />

      {/* Dashboard Assistant sidecard. Mount inside NamespaceProvider
          (a few lines up) so AssistantSidecardWithNamespace can read
          the active namespace via context. Render-gated upstream by
          chatAgentEnabled — App.jsx already hides the launcher icon
          when the chat agent is disabled, but we keep the gate here
          too in case the icon is bypassed (e.g. a keyboard shortcut
          path someday). */}
      {chatAgentEnabled && userCapabilities.can_design && (
        <AssistantSidecardWithNamespace
          open={assistantSidecard.open}
          width={assistantSidecard.width}
          minWidth={assistantSidecard.minWidth}
          onResize={assistantSidecard.setWidth}
          onRequestClose={() => assistantSidecard.setOpen(false)}
          currentUser={currentUser}
        />
      )}

      {/* Hide sidebar in View mode (uses tile view instead) and on
          off-mode routes like /account/* where currentMode is null —
          showing a Design/Manage sidenav there would be misleading. */}
      {currentMode && currentMode !== MODES.VIEW && (
        <SideNav
          aria-label="Side navigation"
          expanded={isSideNavExpanded}
          isPersistent={true}
          onOverlayClick={() => setIsSideNavExpanded(false)}
        >
          {renderNavigation()}
        </SideNav>
      )}

      <Content
        className={`app-content ${(!currentMode || currentMode === MODES.VIEW) ? 'app-content--no-nav' : (isSideNavExpanded ? '' : 'app-content--nav-collapsed')}`}
        // When the Dashboard Assistant sidecard is open, shrink the
        // main content area to its left so the page reflows around
        // the panel instead of being covered by it. Drag-resize on
        // the sidecard updates the width in real time.
        style={
          chatAgentEnabled && userCapabilities.can_design && assistantSidecard.open
            ? { paddingRight: `${assistantSidecard.width}px` }
            : undefined
        }
      >
        <Routes>
          {/* Default route. Cascade by capability:
              1. can_view → first dashboard (or /view/dashboards if none)
              2. can_manage → /manage
              3. can_design → /design/dashboards
              4. nothing → no permitted landing; route falls through
                 to the 404/blank, which is fine for a principal that
                 shouldn't be in a browser anyway (e.g. webhook-only
                 system user). */}
          <Route path="/" element={
            !identityResolved ? null :
              userCapabilities.can_view ? (
                dashboardsLoaded ? (
                  firstDashboardId ? (
                    <Navigate to={`/view/dashboards/${firstDashboardId}`} replace />
                  ) : (
                    <Navigate to="/view/dashboards" replace />
                  )
                ) : null
              ) : userCapabilities.can_manage ? (
                <Navigate to="/manage" replace />
              ) : userCapabilities.can_design ? (
                <Navigate to="/design/dashboards" replace />
              ) : null
          } />

          {/* Design Mode Routes */}
          <Route path="/design/connections" element={<ConnectionsPage />} />
          <Route path="/design/connections/:id" element={<ConnectionDetailPage />} />
          <Route path="/design/components" element={<ComponentsListPage />} />
          <Route path="/design/components/ai/:chartId" element={<AIBuilderGate />} />
          <Route path="/design/components/:id" element={<ComponentDetailPage />} />
          <Route path="/design/dashboards" element={<DashboardsListPage />} />
          <Route path="/design/dashboards/:id" element={<DashboardEditRedirect />} />

          {/* Design Mode — Extensions */}
          <Route path="/design/extensions/tsstore-alerts" element={<TsStoreAlertsExtensionPage />} />
          <Route path="/design/extensions/tsstore-alerts/new" element={<TsStoreAlertRuleEditorPage />} />
          <Route path="/design/extensions/tsstore-alerts/:connectionId/:alertId" element={<TsStoreAlertRuleViewPage />} />
          <Route path="/design/extensions/edgelake-terminal" element={<EdgeLakeTerminalPage />} />

          {/* View Mode Routes */}
          <Route path="/view/dashboards" element={<DashboardTileViewPage />} />
          <Route path="/view/dashboards/:id" element={<DashboardViewerPage canDesign={userCapabilities.can_design} canControl={userCapabilities.can_control} />} />
          {/* Kiosk status board — chromeless, full-bleed overlay surface. */}
          <Route path="/kiosk" element={<KioskPage />} />

          {/* Manage Mode Routes */}
          <Route path="/manage" element={<Navigate to="/manage/users" replace />} />
          <Route path="/manage/users" element={<UsersListPage />} />
          <Route path="/manage/users/:id" element={<UserDetailPage />} />
          <Route path="/manage/system-users" element={<SystemUsersPage />} />
          <Route path="/manage/devices" element={<DevicesPage />} />
          <Route path="/manage/settings" element={<SettingsPage />} />
          <Route path="/manage/ai-usage" element={<AIUsagePage />} />
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
    </AssistantSurfaceProvider>
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
      <AIAvailabilityProvider>
        <EnabledTypesProvider>
          <ModeGuardProvider>
            <Router>
              <AppContent onDisconnect={handleDisconnect} />
            </Router>
          </ModeGuardProvider>
        </EnabledTypesProvider>
      </AIAvailabilityProvider>
    </NotificationProvider>
  );
}

export default App;
