// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button,
  Loading,
  IconButton,
  Tag,
  OverflowMenu,
  OverflowMenuItem,
  Modal,
  Select,
  SelectItem,
  TextInput,
  NumberInput,
  Tooltip
} from '@carbon/react';
import {
  ArrowLeft,
  Maximize,
  Minimize,
  Renew,
  Time,
  OverflowMenuVertical,
  FitToScreen,
  FitToWidth,
  CenterToFit,
  Information,
  StarFilled,
  Edit,
  Save,
  Close,
  TrashCan,
  Add,
  ZoomIn,
  ZoomOut,
  Settings,
  ChevronLeft,
  ChevronRight,
  Home,
  Download
} from '@carbon/icons-react';
import html2canvas from 'html2canvas';
import DynamicComponentLoader from '../components/DynamicComponentLoader';
import ComponentPanelWithActions from '../components/ComponentPanelWithActions';
import ComponentExpandModal from '../components/ComponentExpandModal';
import { ControlRenderer } from '../components/controls';
import FrigateCameraViewer from '../components/frigate/FrigateCameraViewer';
import FrigateAlertsGrid from '../components/frigate/FrigateAlertsGrid';
import WeatherDisplay from '../components/weather/WeatherDisplay';
import PanelEditMenu from '../components/PanelEditMenu';
import PanelText from '../components/PanelText';
import PanelTextEditor from '../components/PanelTextEditor';
import ComponentEditorModal from '../components/ComponentEditorModal';
import ComponentPickerModal from '../components/ComponentPickerModal';
import AIPreflightModal from '../components/AIPreflightModal';
import apiClient from '../api/client';
import { orderDashboardsForViewer } from '../utils/dashboardOrder';
import TagInput from '../components/shared/TagInput';
import { invalidateTagsCache } from '../components/shared/tagsApi';
import NamespaceSelect from '../components/shared/NamespaceSelect';
import { useNamespaces } from '../context/NamespaceContext';
import DashboardExportModal from '../components/DashboardExportModal';
import NameErrorBadge from '../components/NameErrorBadge';
import { useModeGuard } from '../context/ModeGuardContext';
import { useNotifications } from '../context/NotificationContext';
import StreamConnectionManager from '../utils/streamConnectionManager';
import { getComponentMinSize, MODES } from '../config/layoutConfig';
import './DashboardViewerPage.scss';

// Icon wrapper components for Carbon's OverflowMenu `renderIcon` prop.
// Carbon calls `React.createElement(renderIcon, { className, aria-label })`
// without passing a size, and the raw Carbon icons default to size=16.
// These wrappers lock the size at 20 to match the surrounding toolbar
// controls. They are defined at module scope so the component identity is
// stable across re-renders — passing an inline function to `renderIcon`
// causes Carbon to unmount/remount the trigger icon every render, which
// produced a visible "revert to old icon" flicker when the fit mode changed.
const FitModeActualIcon = (props) => <CenterToFit size={20} {...props} />;
const FitModeWindowIcon = (props) => <FitToScreen size={20} {...props} />;
const FitModeWidthIcon = (props) => <FitToWidth size={20} {...props} />;

// "Stretch to fill" uses a custom SVG because Carbon's `Maximize` (four
// corner arrows) is already used by the adjacent fullscreen button, and
// having two identical icons side-by-side was confusing. This SVG shows
// a double-headed horizontal arrow crossed with a double-headed vertical
// arrow — the "stretch both axes" metaphor — visually distinct from
// `Maximize`'s corner arrows.
const FitModeStretchIcon = ({ size = 20, ...rest }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 32 32"
    width={size}
    height={size}
    fill="currentColor"
    {...rest}
  >
    {/* Horizontal double-headed arrow: left arrowhead + bar + right arrowhead */}
    <path d="M3 16 L8 11 L8 15 L24 15 L24 11 L29 16 L24 21 L24 17 L8 17 L8 21 Z" />
    {/* Vertical double-headed arrow: top arrowhead + bar + bottom arrowhead */}
    <path d="M16 3 L21 8 L17 8 L17 24 L21 24 L16 29 L11 24 L15 24 L15 8 L11 8 Z" />
  </svg>
);

/**
 * DashboardViewerPage Component
 *
 * Renders a dashboard in view mode with all components positioned
 * according to the layout grid. Supports:
 * - Auto-refresh based on dashboard settings
 * - Fullscreen mode
 * - Real-time component rendering
 * - Edit mode: drag/resize panels over live components
 */
function DashboardViewerPage({ canDesign = false }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNewDashboard = id === 'new';

  const [dashboard, setDashboard] = useState(null);
  const [chartsMap, setChartsMap] = useState({}); // Chart data keyed by chart_id
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Dashboard command subscription (voice control / kiosk integration)
  const [dashboardCommand, setDashboardCommand] = useState(null); // Latest command: { target, action, ... }
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [refreshKey, setRefreshKey] = useState(0);
  // Dashboard fit mode: "actual" | "window" | "width" | "stretch".
  // Storage is strictly per-user-per-dashboard; the load effect below
  // resolves: user's dashboard_fit_modes[id] → admin setting
  // default_dashboard_fit_mode → "stretch" hardcoded fallback.
  // Initial state is "stretch" to avoid a visible flicker before the
  // async load completes.
  const [fitMode, setFitMode] = useState('stretch');
  // Cadence (seconds) for the slow-poll refresh of the dashboard
  // record itself — picks up edits made by another author so an
  // unattended kiosk display reflects them without manual reload.
  // Loaded from the admin setting `dashboard_config_refresh_interval`
  // (default 300 s, set to 0 to disable). Null means "not yet
  // loaded"; the polling effect waits for a real value before
  // starting.
  const [configRefreshIntervalSec, setConfigRefreshIntervalSec] = useState(null);
  const [isDefaultDashboard, setIsDefaultDashboard] = useState(false);
  const [defaultDashboardId, setDefaultDashboardId] = useState(null);

  // Dashboard switching state
  const [dashboardList, setDashboardList] = useState([]);
  const [switchIndicator, setSwitchIndicator] = useState(null);
  const switchTimerRef = useRef(null);

  // "Preview from design" mode: user just saved/opened this dashboard from the
  // designer. Hide multi-dashboard navigation (prev/next/home, Alt+arrow) and
  // route the back arrow to the design list instead of the viewer list — the
  // user came from design and should return there, not jump into view mode.
  const [fromDesign, setFromDesign] = useState(() => !!location.state?.fromDesign);

  // ── Edit mode state ──────────────────────────────────────────────
  const [isEditMode, setIsEditMode] = useState(false);
  const [editablePanels, setEditablePanels] = useState([]);
  const [, setOriginalPanels] = useState([]);
  const [editHasChanges, setEditHasChanges] = useState(false);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  // Mode-switch intercept when the user has dirty edits. The pendingResolve
  // ref carries the guard's promise resolver so each button in the modal
  // can decide proceed/stay.
  const [modeSwitchPromptOpen, setModeSwitchPromptOpen] = useState(false);
  const modeSwitchResolveRef = useRef(null);
  const { setModeGuard, clearModeGuard, setIsEditingDashboard } = useModeGuard();

  // Tell App.jsx's mode sync to keep the header pill on DESIGN while we're
  // editing, or while we're viewing this dashboard as a design-mode preview
  // (eye icon in the design list). When neither applies, clear the flag so
  // the normal /view/... → VIEW sync takes over.
  useEffect(() => {
    setIsEditingDashboard(isEditMode || fromDesign);
    return () => setIsEditingDashboard(false);
  }, [isEditMode, fromDesign, setIsEditingDashboard]);
  const { pushToast } = useNotifications();
  const [editSaving, setEditSaving] = useState(false);
  const [editableName, setEditableName] = useState('');
  // Server-rejection error for the dashboard name (e.g., duplicate
  // name in the target namespace). Cleared when the user edits the
  // name input, set when the save fails with a name-related error.
  const [nameError, setNameError] = useState('');
  const [editableNamespace, setEditableNamespace] = useState('');
  const { activeNamespace } = useNamespaces();

  // Dashboard settings (editable in settings modal). Theme, is_public,
  // allow_export, and title_scale were removed from the modal — they
  // were never wired to runtime behavior in the current chart pipeline
  // (title_scale only scaled `.chart-name` on the legacy `datatable`
  // chart type, which nothing can create anymore). The fields still
  // exist on the server-side model as no-ops for back-compat; we just
  // stop reading or writing them from this UI.
  const [editableDescription, setEditableDescription] = useState('');
  const [editableTags, setEditableTags] = useState([]);
  const [editableRefreshInterval, setEditableRefreshInterval] = useState(30);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [expandedPanelId, setExpandedPanelId] = useState(null);

  // Zoom state (edit mode only)
  const [zoom, setZoom] = useState(100);
  const zoomIn = () => setZoom(z => Math.min(z + 10, 100));
  const zoomOut = () => setZoom(z => Math.max(z - 10, 10));
  const zoomReset = () => setZoom(100);

  // Fit-to-screen scale calculation
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // Drag/resize/draw state
  const [draggingPanel, setDraggingPanel] = useState(null);
  const [resizingPanel, setResizingPanel] = useState(null);
  const [drawingPanel, setDrawingPanel] = useState(null);
  const gridRef = useRef(null);
  const didDragRef = useRef(false); // Distinguishes click from drag in compact mode


  // Chart editor modal state
  const [componentEditorOpen, setComponentEditorOpen] = useState(false);
  const [editingPanelId, setEditingPanelId] = useState(null);
  const [editingChart, setEditingChart] = useState(null);

  // Component picker modal state
  const [componentPickerOpen, setComponentPickerOpen] = useState(false);
  const [componentPickerCategory, setComponentPickerCategory] = useState('all');
  const [componentPickerPanelId, setComponentPickerPanelId] = useState(null);

  // AI pre-flight modal state
  const [aiPreflightOpen, setAiPreflightOpen] = useState(false);
  const [aiPreflightPanelId, setAiPreflightPanelId] = useState(null);

  // Text panel editor state
  const [textEditorPanelId, setTextEditorPanelId] = useState(null);
  const [textEditorAnchorRect, setTextEditorAnchorRect] = useState(null);

  // Close all SSE connections when leaving the dashboard viewer
  // (frees browser connection slots so other pages load instantly)
  useEffect(() => {
    return () => StreamConnectionManager.getInstance().closeAll();
  }, []);

  // Grid configuration - 32x32px cells
  const CELL_WIDTH = 32;
  const CELL_HEIGHT = 32;

  // Layout dimension presets — defines the hard grid boundary
  const [dimensions, setDimensions] = useState([]);
  const [currentDimension, setCurrentDimension] = useState('');

  // Fetch all dimension presets and resolve the dashboard's current one
  useEffect(() => {
    if (!isEditMode || !dashboard) return;

    apiClient.getSystemConfig()
      .then(config => {
        const dims = config.layout_dimensions || {};
        const list = Object.entries(dims).map(([name, dim]) => ({
          name, max_width: dim.max_width, max_height: dim.max_height
        }));
        list.sort((a, b) => a.max_width - b.max_width);
        setDimensions(list);

        const saved = dashboard.settings?.layout_dimension;
        if (saved && dims[saved]) {
          setCurrentDimension(saved);
        } else if (config.default_dimension && dims[config.default_dimension]) {
          setCurrentDimension(config.default_dimension);
        } else if (list.length > 0) {
          setCurrentDimension(list[0].name);
        }
      })
      .catch(() => {});
  }, [isEditMode, dashboard]);

  // Resolved current dimension object
  const layoutDimension = useMemo(() => {
    return dimensions.find(d => d.name === currentDimension) || null;
  }, [dimensions, currentDimension]);

  // Grid bounds from layout dimension
  const VIEWER_CHROME_V = 109; // 48px app header + 57px toolbar + 4px padding
  const VIEWER_CHROME_H = 4;
  const VIEWER_GAP = 4;

  const gridCols = useMemo(() => {
    if (!layoutDimension) return null;
    const availableWidth = layoutDimension.max_width - VIEWER_CHROME_H;
    return Math.floor((availableWidth + VIEWER_GAP) / (CELL_WIDTH + VIEWER_GAP));
  }, [layoutDimension]);

  const gridRows = useMemo(() => {
    if (!layoutDimension) return null;
    const availableHeight = layoutDimension.max_height - VIEWER_CHROME_V;
    return Math.floor((availableHeight + VIEWER_GAP) / (CELL_HEIGHT + VIEWER_GAP));
  }, [layoutDimension]);

  // Load fit mode for the *current* dashboard. Resolution order:
  //   1. user's dashboard_fit_modes[id] — explicit per-user per-dashboard
  //   2. admin setting default_dashboard_fit_mode — deployment-wide default
  //   3. "stretch" — hardcoded last-resort safety
  //
  // One user's selection NEVER affects another user, and a selection on
  // dashboard X NEVER affects dashboard Y. The old "user's last-used
  // global default" (dashboard_fit_mode singleton) is no longer
  // consulted — it caused fit modes to bleed across un-touched
  // dashboards.
  useEffect(() => {
    if (!id) return;
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;
    Promise.all([
      apiClient.getUserConfig(userGuid).catch(() => ({ settings: {} })),
      apiClient.getSetting('default_dashboard_fit_mode').catch(() => null),
    ]).then(([userCfg, adminDefault]) => {
      const valid = (v) => v && ['actual', 'window', 'width', 'stretch'].includes(v);
      const perDashboard = userCfg?.settings?.dashboard_fit_modes || {};
      if (valid(perDashboard[id])) {
        setFitMode(perDashboard[id]);
        return;
      }
      const adminValue = adminDefault?.value ?? adminDefault;
      if (valid(adminValue)) {
        setFitMode(adminValue);
        return;
      }
      setFitMode('stretch');
    });
  }, [id]);

  // Save a fit-mode selection scoped to the current dashboard only.
  // Writes a single key on the current user's config — never touches
  // any user-level global and never touches other dashboards.
  // Also garbage-collects stale entries for dashboards the user no
  // longer has access to.
  const selectFitMode = useCallback((next) => {
    if (!['actual', 'window', 'width', 'stretch'].includes(next)) return;
    if (!id) return;
    setFitMode(next);

    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;

    Promise.all([
      apiClient.getUserConfig(userGuid).catch(() => ({ settings: {} })),
      apiClient.getDashboards().catch(() => ({ dashboards: [] })),
    ]).then(([cfg, dashboardsRes]) => {
      const existing = cfg?.settings?.dashboard_fit_modes || {};
      const liveList = dashboardsRes?.dashboards || dashboardsRes?.Dashboards || [];
      const liveIds = new Set(liveList.map(d => d.id).filter(Boolean));
      liveIds.add(id); // always preserve the one we're actively setting

      const pruned = {};
      for (const [dashId, mode] of Object.entries(existing)) {
        if (liveIds.has(dashId)) pruned[dashId] = mode;
      }
      pruned[id] = next;

      apiClient.updateUserConfig(userGuid, {
        dashboard_fit_modes: pruned,
      }).catch(() => {});
    });
  }, [id]);

  // Calculate grid dimensions
  // In edit mode: use layout dimension preset for bounds (allows dragging into empty space)
  // In view mode: use panel extent (tight fit)
  const panels = isEditMode ? editablePanels : (dashboard?.panels || []);

  const panelExtentCol = useMemo(() => {
    if (!panels || panels.length === 0) return 0;
    return panels.reduce((max, panel) => Math.max(max, panel.x + panel.w), 0);
  }, [panels]);

  const panelExtentRow = useMemo(() => {
    if (!panels || panels.length === 0) return 0;
    return panels.reduce((max, panel) => Math.max(max, panel.y + panel.h), 0);
  }, [panels]);

  // In edit mode, grid extends to the layout dimension boundary (or panel extent if larger)
  // In view mode, grid fits tightly around panels
  const maxGridCol = isEditMode && gridCols
    ? Math.max(gridCols, panelExtentCol)
    : (isEditMode ? Math.max(panelExtentCol, 40) : (panelExtentCol || 60));

  const maxGridRow = isEditMode && gridRows
    ? Math.max(gridRows, panelExtentRow)
    : (isEditMode ? Math.max(panelExtentRow, 24) : (panelExtentRow || 60));

  // Track container size for fit-to-screen scale calculation.
  // The resize handler is guarded: it only updates state when the measured
  // dimensions actually change. This prevents Carbon Modal's body-overflow
  // toggle from triggering a spurious resize → re-measure → re-scale cycle
  // that shifts the dashboard grid (especially visible in stretch-to-fill
  // mode during fullscreen).
  const hasPanels = panels && panels.length > 0;
  const lastSizeRef = useRef({ width: 0, height: 0 });
  useEffect(() => {
    if (!hasPanels) return;
    const measure = () => {
      const el = containerRef.current;
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w !== lastSizeRef.current.width || h !== lastSizeRef.current.height) {
        lastSizeRef.current = { width: w, height: h };
        setContainerSize({ width: w, height: h });
      }
    };
    // Double rAF ensures CSS class changes (overflow: hidden) have been painted
    // before we measure the container dimensions
    let raf1, raf2;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(measure);
    });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener('resize', measure);
    };
  }, [hasPanels, isFullscreen, fitMode]);

  // Calculate fit-to-screen transform based on the active fit mode.
  //
  //   actual  → no transform (native pixel size, may overflow viewport)
  //   window  → scale(min(sx, sy)) — uniform, centered, nothing clipped
  //   width   → scale(sx)           — fill width exactly, vertical scroll if needed
  //   stretch → scale(sx, sy)       — fill both axes, may distort round charts
  //
  // All modes use `transform-origin: top left`. Centering for `window` is
  // handled by the container via flexbox (see DashboardViewerPage.scss).
  const GAP = 4; // spacing.$spacing-02
  const CONTAINER_PADDING = 4;
  const fitTransform = useMemo(() => {
    // Skip fit transform entirely in edit mode (edit mode uses its own zoom).
    if (isEditMode || fitMode === 'actual' || !containerSize.width || !containerSize.height) {
      return { transform: '', scaledW: 0, scaledH: 0 };
    }
    const gridNativeW = maxGridCol * CELL_WIDTH + (maxGridCol - 1) * GAP;
    const gridNativeH = maxGridRow * CELL_HEIGHT + (maxGridRow - 1) * GAP;
    const availW = containerSize.width - 2 * CONTAINER_PADDING;
    const availH = containerSize.height - 2 * CONTAINER_PADDING;
    const sx = availW / gridNativeW;
    const sy = availH / gridNativeH;

    if (fitMode === 'stretch') {
      return {
        transform: `scale(${sx}, ${sy})`,
        scaledW: gridNativeW * sx,
        scaledH: gridNativeH * sy,
      };
    }
    if (fitMode === 'width') {
      return {
        transform: `scale(${sx})`,
        scaledW: gridNativeW * sx,
        scaledH: gridNativeH * sx,
      };
    }
    // "window" — uniform, both axes fit
    const s = Math.min(sx, sy);
    return {
      transform: `scale(${s})`,
      scaledW: gridNativeW * s,
      scaledH: gridNativeH * s,
    };
  }, [isEditMode, fitMode, containerSize.width, containerSize.height, maxGridCol, maxGridRow, CELL_WIDTH, CELL_HEIGHT]);

  // Fetch dashboard data and referenced charts
  const fetchDashboard = useCallback(async () => {
    try {
      const data = await apiClient.getDashboard(id);
      setDashboard(data);

      if (data.panels && data.panels.length > 0) {
        const chartIds = [...new Set(data.panels.map(p => p.chart_id).filter(Boolean))];
        if (chartIds.length > 0) {
          const chartPromises = chartIds.map(chartId =>
            apiClient.getComponent(chartId).catch(() => null)
          );
          const charts = await Promise.all(chartPromises);
          const newChartsMap = {};
          charts.forEach(chart => {
            if (chart) newChartsMap[chart.id] = chart;
          });
          setChartsMap(newChartsMap);
        }
      }

      setLastRefresh(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);


  // Fetch dashboard list for keyboard switching + prev/next arrow
  // navigation. Orders the list to match the View Mode tile page so
  // the arrow buttons walk dashboards in the same sequence the user
  // arranged via drag-and-drop on the listing page (stored under
  // app_config.user.<guid>.settings.dashboard_tile_order). Falls
  // back to most-recently-updated first when the user hasn't
  // arranged anything yet — same default the tile page uses.
  useEffect(() => {
    const fetchDashboardList = async () => {
      try {
        const data = await apiClient.getDashboards();
        const dashboards = data.dashboards || [];
        let tileOrder = null;
        const userGuid = apiClient.getCurrentUserGuid();
        if (userGuid) {
          try {
            const config = await apiClient.getUserConfig(userGuid);
            const stored = config?.settings?.dashboard_tile_order;
            tileOrder = Array.isArray(stored) ? stored : null;
          } catch {
            // No user config yet — use the default sort.
          }
        }
        setDashboardList(orderDashboardsForViewer(dashboards, tileOrder));
      } catch (err) {
        console.warn('Failed to fetch dashboard list:', err);
      }
    };
    fetchDashboardList();
  }, []);

  // Load the deployment-wide dashboard config-refresh cadence on mount.
  // The setting is stored under app_config (system tier) — see
  // server-go/config/user-configurable.yaml. Default 300 s. Failures
  // resolve to 0 (disabled) so a missing/unreachable settings endpoint
  // never starts surprise polling.
  useEffect(() => {
    let cancelled = false;
    apiClient.getSetting('dashboard_config_refresh_interval')
      .then(item => {
        if (cancelled) return;
        const n = Number(item?.value);
        setConfigRefreshIntervalSec(Number.isFinite(n) && n >= 0 ? n : 300);
      })
      .catch(() => {
        if (!cancelled) setConfigRefreshIntervalSec(0);
      });
    return () => { cancelled = true; };
  }, []);

  // Show switch indicator briefly
  const showSwitchIndicator = useCallback((name, index, total) => {
    setSwitchIndicator({ name, index, total });
    if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
    switchTimerRef.current = setTimeout(() => setSwitchIndicator(null), 2000);
  }, []);

  // Dashboard navigation helpers
  const currentDashboardIndex = useMemo(() => {
    return dashboardList.findIndex(d => d.id === id);
  }, [dashboardList, id]);

  const canGoPrev = currentDashboardIndex > 0;
  const canGoNext = currentDashboardIndex >= 0 && currentDashboardIndex < dashboardList.length - 1;

  const goToPrevDashboard = useCallback(() => {
    if (!canGoPrev) return;
    const prev = dashboardList[currentDashboardIndex - 1];
    showSwitchIndicator(prev.name, currentDashboardIndex, dashboardList.length);
    navigate(`/view/dashboards/${prev.id}`);
  }, [canGoPrev, dashboardList, currentDashboardIndex, showSwitchIndicator, navigate]);

  const goToNextDashboard = useCallback(() => {
    if (!canGoNext) return;
    const next = dashboardList[currentDashboardIndex + 1];
    showSwitchIndicator(next.name, currentDashboardIndex + 2, dashboardList.length);
    navigate(`/view/dashboards/${next.id}`);
  }, [canGoNext, dashboardList, currentDashboardIndex, showSwitchIndicator, navigate]);

  const goToDefaultDashboard = useCallback(() => {
    if (!defaultDashboardId || defaultDashboardId === id) return;
    const def = dashboardList.find(d => d.id === defaultDashboardId);
    if (def) {
      const defIndex = dashboardList.indexOf(def);
      showSwitchIndicator(def.name, defIndex + 1, dashboardList.length);
    }
    navigate(`/view/dashboards/${defaultDashboardId}`);
  }, [defaultDashboardId, id, dashboardList, showSwitchIndicator, navigate]);

  // Keyboard navigation: Alt+Left/Right to switch dashboards (disabled in edit mode
  // and in "from design" preview mode, where we want a single-dashboard view)
  useEffect(() => {
    if (dashboardList.length < 2 || isEditMode || fromDesign) return;

    const handleKeyDown = (e) => {
      if (!e.altKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

      e.preventDefault();
      const currentIndex = dashboardList.findIndex(d => d.id === id);
      if (currentIndex === -1) return;

      let nextIndex;
      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % dashboardList.length;
      } else {
        nextIndex = (currentIndex - 1 + dashboardList.length) % dashboardList.length;
      }

      const next = dashboardList[nextIndex];
      showSwitchIndicator(next.name, nextIndex + 1, dashboardList.length);
      navigate(`/view/dashboards/${next.id}`);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
    };
  }, [dashboardList, id, navigate, showSwitchIndicator, isEditMode, fromDesign]);

  // Initial load
  useEffect(() => {
    if (isNewDashboard) {
      // New dashboard — skip fetch, initialize empty client-side state
      const emptyDashboard = {
        name: 'Untitled Dashboard',
        description: '',
        panels: [],
        // refresh_interval defaults to 30s — polling is gated on tab
        // visibility, so a backgrounded tab doesn't poll. Set to 0
        // in the editor to disable entirely.
        settings: { refresh_interval: 30 }
      };
      setDashboard(emptyDashboard);
      setLoading(false);
    } else {
      fetchDashboard();
    }
  }, [fetchDashboard, isNewDashboard]);

  // Auto-enter edit mode when navigated from design mode (or new dashboard)
  const autoEditTriggered = useRef(false);
  useEffect(() => {
    if (dashboard && !autoEditTriggered.current && (location.state?.autoEdit || isNewDashboard) && canDesign) {
      autoEditTriggered.current = true;
      enterEditMode();
    }
  }, [dashboard, location.state, isNewDashboard]);

  // Check if this dashboard is the user's default
  useEffect(() => {
    const checkIfDefault = async () => {
      const userGuid = apiClient.getCurrentUserGuid();
      if (!userGuid || !id) return;
      try {
        const config = await apiClient.getUserConfig(userGuid);
        const defId = config.settings?.default_dashboard_id || null;
        setDefaultDashboardId(defId);
        setIsDefaultDashboard(defId === id);
      } catch {
        // User may not have config yet
      }
    };
    checkIfDefault();
  }, [id]);

  const handleSetAsDefault = async () => {
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;
    try {
      await apiClient.updateUserConfig(userGuid, { default_dashboard_id: id });
      setIsDefaultDashboard(true);
    } catch (err) {
      console.error('Failed to set default dashboard:', err);
    }
  };

  // Config refresh — poll the dashboard record on a slow cadence so
  // an unattended viewer (kiosk display, wall monitor) picks up
  // dashboard edits made by another author without a manual reload.
  //
  //   - Cadence is the deployment-wide admin setting
  //     `dashboard_config_refresh_interval` (seconds; 0 disables).
  //   - Paused while the user is editing the dashboard they're
  //     viewing — never overwrite in-progress edits.
  //   - Paused while the browser tab is hidden so backgrounded tabs
  //     don't poll. Resumes immediately on visibility return.
  //   - fetchDashboard() updates state via setDashboard / setChartsMap.
  //     React diffs and re-renders only what changed; chart panels
  //     remount only when chart.updated changes (key includes it).
  useEffect(() => {
    if (isEditMode) return;
    if (!configRefreshIntervalSec || configRefreshIntervalSec <= 0) return;
    const intervalMs = configRefreshIntervalSec * 1000;

    let timer = null;
    const start = () => { if (timer == null) timer = setInterval(fetchDashboard, intervalMs); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isEditMode, configRefreshIntervalSec, fetchDashboard]);

  // Dashboard command subscription — listen for voice/kiosk commands via MQTT
  // Subscribes once on mount (not gated by isEditMode — commands are ignored during edit
  // by the individual component handlers, but the subscription stays alive to avoid
  // buffer replay issues on edit mode toggle).
  const commandSubscribedRef = useRef(false);
  useEffect(() => {
    if (commandSubscribedRef.current) return; // Only subscribe once

    let unsubscribe = null;

    const setupCommandSubscription = async () => {
      try {
        const [topicSetting, connSetting] = await Promise.all([
          apiClient.getSetting('dashboard_command_topic').catch(() => null),
          apiClient.getSetting('dashboard_command_connection').catch(() => null)
        ]);

        const commandTopic = topicSetting?.value || '';
        const commandConnectionId = connSetting?.value || '';

        if (!commandTopic || !commandConnectionId) return;

        commandSubscribedRef.current = true;
        const manager = StreamConnectionManager.getInstance();
        unsubscribe = manager.subscribe(
          commandConnectionId,
          (record) => {
            const target = record.target;
            const action = record.action;
            if (target && action) {
              console.log(`[DashboardCommand] ${target}.${action}`, record);
              setDashboardCommand({ ...record, _ts: Date.now() });
            }
          },
          {
            topics: commandTopic,
            skipBufferReplay: true, // Don't replay old commands from buffer
            onConnect: () => console.log('[DashboardCommand] Connected to command topic:', commandTopic)
          }
        );
      } catch (err) {
        console.warn('[DashboardCommand] Failed to subscribe:', err.message);
      }
    };

    setupCommandSubscription();

    return () => {
      if (unsubscribe) unsubscribe();
      commandSubscribedRef.current = false;
    };
  }, []); // Subscribe once on mount, unsubscribe on unmount

  // Fullscreen handling
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const handleManualRefresh = () => {
    // Force every chart panel to re-mount and re-query. The keying
    // pattern at <ComponentPanelWithActions key={`${panel.chart_id}-${refreshKey}`}>
    // tears down each useData instance and starts a fresh fetch.
    // We deliberately do NOT re-fetch the dashboard record here —
    // that would reload the panel layout and config, which is
    // unrelated to the user's intent (they want fresh data, not a
    // fresh layout). If the dashboard record itself changed, the
    // user should reload the page.
    setRefreshKey(k => k + 1);
    setLastRefresh(new Date());
  };

  const handleBack = () => {
    if (fromDesign) {
      navigate('/design/dashboards');
    } else {
      navigate('/view/dashboards');
    }
  };

  const formatTime = (date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // Save thumbnail — captures the live grid at native resolution
  const [savingThumbnail, setSavingThumbnail] = useState(false);
  const saveThumbnail = async () => {
    const grid = gridRef.current;
    const container = containerRef.current;
    if (!grid || !container) return;

    setSavingThumbnail(true);
    try {
      // Save original styles
      const origGridTransform = grid.style.transform;
      const origGridOrigin = grid.style.transformOrigin;
      const origContainerOverflow = container.style.overflow;

      // Remove transform and allow overflow so html2canvas can see the full grid
      grid.style.transform = 'none';
      grid.style.transformOrigin = '';
      container.style.overflow = 'visible';

      // Wait for paint
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      // Calculate the native grid size from panel extent
      const gridNativeW = maxGridCol * CELL_WIDTH + (maxGridCol - 1) * GAP;
      const gridNativeH = maxGridRow * CELL_HEIGHT + (maxGridRow - 1) * GAP;

      const canvas = await html2canvas(grid, {
        backgroundColor: '#161616',
        scale: 0.25,
        useCORS: true,
        allowTaint: true,
        width: gridNativeW,
        height: gridNativeH,
        scrollX: 0,
        scrollY: 0,
        windowScrollX: 0,
        windowScrollY: 0,
        onclone: (clonedDoc) => {
          const clonedGrid = clonedDoc.querySelector('.dashboard-grid');
          if (clonedGrid) {
            // Remove all edit mode classes and elements
            clonedGrid.classList.remove('edit-active');
            clonedGrid.querySelectorAll('.edit-hover-header, .edit-drag-overlay, .edit-resize-handle, .edit-panel-menu-anchor').forEach(el => el.remove());
            clonedGrid.querySelectorAll('.panel-container.edit-mode').forEach(el => {
              el.classList.remove('edit-mode', 'dragging', 'resizing');
            });
          }
          // Remove ALL CSS gradient backgrounds that crash html2canvas
          // html2canvas can't parse certain gradient stop values
          clonedDoc.querySelectorAll('*').forEach(el => {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg.includes('gradient')) {
              el.style.backgroundImage = 'none';
            }
          });
        }
      });

      // Restore styles
      grid.style.transform = origGridTransform;
      grid.style.transformOrigin = origGridOrigin;
      container.style.overflow = origContainerOverflow;

      const thumbnailDataUrl = canvas.toDataURL('image/png');
      await apiClient.updateDashboard(id, { ...dashboard, thumbnail: thumbnailDataUrl });
      fetchDashboard();
    } catch (err) {
      console.error('Failed to save thumbnail:', err);
      // Restore styles on error
      if (grid) {
        grid.style.transform = '';
        grid.style.transformOrigin = '';
      }
      if (container) {
        container.style.overflow = '';
      }
    } finally {
      setSavingThumbnail(false);
    }
  };

  // ── Edit mode logic ──────────────────────────────────────────────

  const enterEditMode = () => {
    const panelsCopy = (dashboard?.panels || []).map(p => ({ ...p }));
    setEditablePanels(panelsCopy);
    setOriginalPanels(panelsCopy.map(p => ({ ...p })));
    setEditableName(dashboard?.name || '');
    // On a new dashboard the dashboard stub has no namespace yet; fall
    // back to the header's active namespace so newly-created dashboards
    // land where the user currently thinks they are.
    setEditableNamespace(dashboard?.namespace || activeNamespace || 'default');
    setEditableDescription(dashboard?.description || '');
    setEditableTags(dashboard?.tags || []);
    // refresh_interval defaults to 30s when unset on legacy dashboards.
    // The editor's number input lets the user explicitly set 0 to
    // disable polling.
    setEditableRefreshInterval(
      dashboard?.settings?.refresh_interval == null ? 30 : dashboard.settings.refresh_interval
    );
    setEditHasChanges(false);
    setZoom(100);
    setIsEditMode(true);
  };

  // Cancel returns to wherever the user came from:
  //   - Came from design list (fromDesign=true) → back to /design/dashboards
  //   - Came from view mode (clicked Edit on a dashboard they were
  //     viewing) → drop edit mode in place; the viewer keeps showing
  //     the same dashboard with normal view-mode chrome restored.
  // For new dashboards there's nothing to view, so always go to the
  // design list.
  const exitEditMode = () => {
    if (editHasChanges) {
      setShowDiscardModal(true);
      return;
    }
    finishCancelNavigation();
  };

  const confirmDiscard = () => {
    setShowDiscardModal(false);
    finishCancelNavigation();
  };

  const finishCancelNavigation = () => {
    if (isNewDashboard || fromDesign) {
      navigate('/design/dashboards', { replace: true });
      return;
    }
    // Stay on this dashboard but drop out of edit mode.
    setIsEditMode(false);
    setEditHasChanges(false);
  };

  const handleDimensionChange = (newDimension) => {
    setCurrentDimension(newDimension);
    setEditHasChanges(true);
  };

  // saveEditMode persists current edits and returns the resolved
  // dashboard ID (existing or freshly-minted for a new dashboard).
  // Callers that don't care can ignore the return; the mode-switch
  // guard uses it to land the post-switch route on the right id.
  // options.skipNavigate=true suppresses the post-create navigate so
  // a caller (the mode guard) can do its own navigation instead.
  const saveEditMode = async (options) => {
    setEditSaving(true);
    try {
      // Spread the existing settings first so removed-from-editor fields
      // (theme, is_public, allow_export, title_scale) round-trip
      // unchanged. We only overwrite the fields the user can actually
      // edit now.
      const updatedSettings = {
        ...dashboard.settings,
        layout_dimension: currentDimension,
        refresh_interval: editableRefreshInterval,
      };
      const payload = {
        name: editableName,
        namespace: editableNamespace,
        description: editableDescription,
        tags: editableTags,
        panels: editablePanels,
        settings: updatedSettings
      };

      if (isNewDashboard) {
        const created = await apiClient.createDashboard(payload);
        invalidateTagsCache();
        // Reset edit-mode state regardless of who's navigating after.
        // Without this, the new-dashboard route param changes from
        // "new" to <created.id>, the component instance survives, and
        // isEditMode stays true — the user lands in the new viewer
        // route still in edit mode with stale dirty state.
        setIsEditMode(false);
        setEditHasChanges(false);
        if (!options?.skipNavigate) {
          navigate(`/view/dashboards/${created.id}`, {
            replace: true,
            state: { fromDesign: true }
          });
        }
        return created.id;
      } else {
        await apiClient.updateDashboard(id, { ...dashboard, ...payload });
        invalidateTagsCache();
        setIsEditMode(false);
        setEditHasChanges(false);
        // After Save from the designer, show the finished dashboard in a
        // single-dashboard view (no prev/next/home). The user returned to
        // this route from design, so mark it as a design-origin preview.
        setFromDesign(true);
        fetchDashboard();
        return id;
      }
    } catch (err) {
      console.error('Failed to save dashboard:', err);
      const msg = err?.message || 'Unknown error';
      // Pin the message under the name input when the server's error
      // points at a name collision so the user sees what to fix
      // without rereading the toast.
      if (/already exists|name/i.test(msg)) {
        setNameError(msg);
      }
      pushToast({
        kind: 'error',
        title: 'Failed to save dashboard',
        subtitle: msg,
      });
      return null;
    } finally {
      setEditSaving(false);
    }
  };

  // Intercept app-level mode switches while we're in edit mode. Clean
  // state → silently leave edit mode and let the switch proceed (the
  // user clearly meant to move on); when switching to View, hand the
  // current dashboard id back so the user lands on it instead of
  // their default dashboard. Dirty state → pop a Save / Discard /
  // Stay prompt and wait for the user to pick.
  useEffect(() => {
    // Register a guard whenever the dashboard is being treated as part of
    // the design workflow — either an active edit session (isEditMode) or
    // a design-origin preview (fromDesign). In both cases the App pins
    // the header pill on DESIGN, and a VIEW press needs an explicit clear
    // of the design-preview flag so the URL→mode sync doesn't snap the
    // pill back. Without a guard at all (the previous behavior for
    // fromDesign && !isEditMode), the pill flickers and stays on DESIGN.
    if (!isEditMode && !fromDesign) {
      clearModeGuard();
      return undefined;
    }
    const guard = (newMode) => {
      // For new dashboards we don't have a saved id to hand back —
      // App.jsx will fall back to the default dashboard.
      const currentId = isNewDashboard ? null : id;
      // Clean (no edit, or edit with no changes): proceed immediately.
      if (!isEditMode || !editHasChanges) {
        if (isEditMode) setIsEditMode(false);
        // Switching INTO view mode is the user explicitly leaving
        // the design workflow. Clear the design-origin preview flag
        // so isEditingDashboard goes false and the header pill
        // settles on VIEW immediately, instead of the App's
        // /view/* → DESIGN exception (set when fromDesign is true)
        // snapping the pill back.
        if (newMode === MODES.VIEW) {
          setFromDesign(false);
        }
        return Promise.resolve({ proceed: true, dashboardId: currentId });
      }
      return new Promise((resolve) => {
        modeSwitchResolveRef.current = resolve;
        setModeSwitchPromptOpen(true);
      });
    };
    setModeGuard(guard);
    return () => {
      clearModeGuard();
    };
  }, [isEditMode, fromDesign, editHasChanges, isNewDashboard, id, setModeGuard, clearModeGuard]);

  // Mode-switch prompt actions. Each resolves the pending guard
  // promise with { proceed, dashboardId? }. The dashboardId tells the
  // App-level router to land View mode on the just-edited dashboard
  // (Save) or fall back to the user's default (Discard on a new
  // dashboard).
  const modeSwitchSave = async () => {
    setModeSwitchPromptOpen(false);
    // Skip the post-save navigate inside saveEditMode — App.jsx is
    // about to handle the destination based on the new mode.
    const savedId = await saveEditMode({ skipNavigate: true });
    const resolver = modeSwitchResolveRef.current;
    modeSwitchResolveRef.current = null;
    if (!resolver) return;
    if (savedId) {
      resolver({ proceed: true, dashboardId: savedId });
    } else {
      // Save failed (e.g., duplicate name). saveEditMode already
      // pushed an error notification — block the mode switch so the
      // user can fix the problem and try again.
      resolver({ proceed: false });
    }
  };
  const modeSwitchDiscard = () => {
    setModeSwitchPromptOpen(false);
    setIsEditMode(false);
    setEditHasChanges(false);
    const resolver = modeSwitchResolveRef.current;
    modeSwitchResolveRef.current = null;
    // New unsaved dashboards have no id to land on; existing ones
    // keep theirs. App.jsx falls back to default when dashboardId is
    // null/undefined.
    const currentId = isNewDashboard ? null : id;
    if (resolver) resolver({ proceed: true, dashboardId: currentId });
  };
  const modeSwitchStay = () => {
    setModeSwitchPromptOpen(false);
    const resolver = modeSwitchResolveRef.current;
    modeSwitchResolveRef.current = null;
    if (resolver) resolver({ proceed: false });
  };

  // Update a single panel's properties
  const updateEditablePanel = (panelId, updates) => {
    setEditablePanels(prev => prev.map(p =>
      p.id === panelId ? { ...p, ...updates } : p
    ));
    setEditHasChanges(true);
  };

  // Add a new empty panel
  const addPanel = (panelData) => {
    const newPanel = {
      id: `panel-${Date.now()}`,
      chart_id: null,
      ...panelData
    };
    setEditablePanels(prev => [...prev, newPanel]);
    setEditHasChanges(true);
  };

  // Delete a panel
  const deletePanel = (panelId) => {
    setEditablePanels(prev => prev.filter(p => p.id !== panelId));
    setEditHasChanges(true);
  };

  // Get minimum panel size based on assigned component
  const getMinSizeForPanel = (panelId) => {
    const panel = editablePanels.find(p => p.id === panelId);
    if (!panel) return getComponentMinSize('default');
    if (panel.text_config) return { w: 2, h: 1 };
    if (!panel.chart_id) return getComponentMinSize('default');
    const chart = chartsMap[panel.chart_id];
    if (!chart) return getComponentMinSize('default');
    const subtype = chart.control_config?.control_type || chart.display_config?.display_type || chart.chart_type;
    return getComponentMinSize(subtype);
  };

  // ── Drag/resize logic ────────────────────────────────────────────

  const getGridPosition = useCallback((e) => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const cellW = rect.width / maxGridCol;
    const cellH = rect.height / maxGridRow;
    const x = Math.floor((e.clientX - rect.left) / cellW);
    const y = Math.floor((e.clientY - rect.top) / cellH);
    return { x: Math.max(0, Math.min(x, maxGridCol - 1)), y: Math.max(0, y) };
  }, [maxGridCol, maxGridRow]);

  const startDragging = (e, panel) => {
    e.stopPropagation();
    e.preventDefault();
    didDragRef.current = false;
    const pos = getGridPosition(e);
    if (pos) {
      setDraggingPanel({
        id: panel.id,
        offsetX: pos.x - panel.x,
        offsetY: pos.y - panel.y
      });
    }
  };

  const startResizing = (e, panel) => {
    e.stopPropagation();
    e.preventDefault();
    // Capture offset from the panel's bottom-right corner so the first
    // mouse movement doesn't immediately snap to the next grid cell.
    if (gridRef.current) {
      const rect = gridRef.current.getBoundingClientRect();
      const cellW = rect.width / maxGridCol;
      const cellH = rect.height / maxGridRow;
      const edgePixelX = rect.left + (panel.x + panel.w) * cellW;
      const edgePixelY = rect.top + (panel.y + panel.h) * cellH;
      // How far inside the current cell the mouse started
      const offsetX = e.clientX - edgePixelX;
      const offsetY = e.clientY - edgePixelY;
      setResizingPanel({ id: panel.id, offsetX, offsetY });
    } else {
      setResizingPanel({ id: panel.id, offsetX: 0, offsetY: 0 });
    }
  };

  // Start drawing a new panel by clicking empty grid space
  const handleGridMouseDown = (e) => {
    if (!isEditMode) return;
    // Only trigger on clicks directly on the grid (not on panels)
    if (e.target !== gridRef.current) return;
    const pos = getGridPosition(e);
    if (pos) {
      setDrawingPanel({
        startX: pos.x,
        startY: pos.y,
        x: pos.x,
        y: pos.y,
        w: 1,
        h: 1
      });
    }
  };

  useEffect(() => {
    if (!isEditMode || (!draggingPanel && !resizingPanel && !drawingPanel)) return;

    const boundCols = gridCols || maxGridCol;
    const boundRows = gridRows || maxGridRow;

    const handleMouseMove = (e) => {
      const pos = getGridPosition(e);
      if (!pos) return;

      if (drawingPanel) {
        const x = Math.min(drawingPanel.startX, pos.x);
        const y = Math.min(drawingPanel.startY, pos.y);
        const w = Math.abs(pos.x - drawingPanel.startX) + 1;
        const h = Math.abs(pos.y - drawingPanel.startY) + 1;
        setDrawingPanel(prev => ({
          ...prev,
          x,
          y,
          w: Math.min(w, boundCols - x),
          h: Math.min(h, boundRows - y)
        }));
      }

      if (draggingPanel) {
        const panel = editablePanels.find(p => p.id === draggingPanel.id);
        if (panel) {
          const newX = Math.max(0, Math.min(pos.x - draggingPanel.offsetX, boundCols - panel.w));
          const newY = Math.max(0, Math.min(pos.y - draggingPanel.offsetY, boundRows - panel.h));
          if (newX !== panel.x || newY !== panel.y) {
            didDragRef.current = true;
            updateEditablePanel(draggingPanel.id, { x: newX, y: newY });
          }
        }
      }

      if (resizingPanel) {
        const panel = editablePanels.find(p => p.id === resizingPanel.id);
        if (panel && gridRef.current) {
          const minSize = getMinSizeForPanel(resizingPanel.id);
          // Use raw pixel position adjusted by initial offset for smooth resizing
          const rect = gridRef.current.getBoundingClientRect();
          const adjustedX = e.clientX - (resizingPanel.offsetX || 0);
          const adjustedY = e.clientY - (resizingPanel.offsetY || 0);
          const cellW = rect.width / maxGridCol;
          const cellH = rect.height / maxGridRow;
          const gridX = Math.floor((adjustedX - rect.left) / cellW);
          const gridY = Math.floor((adjustedY - rect.top) / cellH);
          const newW = Math.max(minSize.w, Math.min(gridX - panel.x + 1, boundCols - panel.x));
          const newH = Math.max(minSize.h, Math.min(gridY - panel.y + 1, boundRows - panel.y));
          if (newW !== panel.w || newH !== panel.h) {
            updateEditablePanel(resizingPanel.id, { w: newW, h: newH });
          }
        }
      }
    };

    const handleMouseUp = () => {
      if (drawingPanel && drawingPanel.w >= 2 && drawingPanel.h >= 1) {
        addPanel({
          x: drawingPanel.x,
          y: drawingPanel.y,
          w: drawingPanel.w,
          h: drawingPanel.h
        });
      }
      setDrawingPanel(null);
      setDraggingPanel(null);
      setResizingPanel(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isEditMode, draggingPanel, resizingPanel, drawingPanel, editablePanels, maxGridCol, maxGridRow, gridCols, gridRows, getGridPosition]);

  // ── Chart editor / component picker / AI preflight ───────────────

  const openComponentEditor = (panelId, chart = undefined) => {
    setEditingPanelId(panelId);
    if (chart === undefined) {
      const panel = editablePanels.find(p => p.id === panelId);
      setEditingChart(panel?.chart_id ? chartsMap[panel.chart_id] : null);
    } else {
      setEditingChart(chart);
    }
    setComponentEditorOpen(true);

  };

  const closeComponentEditor = () => {
    setComponentEditorOpen(false);
    setEditingPanelId(null);
    setEditingChart(null);
  };

  const handleChartSave = async (chartData) => {
    const { panel_id, ...chartInfo } = chartData;
    setChartsMap(prev => ({ ...prev, [chartInfo.id]: chartInfo }));

    // Detect whether the panel itself actually needs to change. Editing a
    // component's name/code/config shouldn't dirty the dashboard — the
    // component lives in its own collection and was already persisted by
    // the component editor. Only swapping the panel's chart_id (e.g.
    // converting a placeholder to a saved component) or growing the panel
    // to satisfy a new min-size is a genuine dashboard mutation.
    const subtype = chartInfo.control_config?.control_type || chartInfo.display_config?.display_type || chartInfo.chart_type;
    const minSize = getComponentMinSize(subtype);
    let panelChanged = false;
    setEditablePanels(prev => prev.map(p => {
      if (p.id !== panel_id) return p;
      const newW = Math.max(p.w, Math.min(minSize.w, maxGridCol - p.x));
      const newH = Math.max(p.h, minSize.h);
      const idChanged = p.chart_id !== chartInfo.id;
      const sizeChanged = newW !== p.w || newH !== p.h;
      if (!idChanged && !sizeChanged) return p;
      panelChanged = true;
      return { ...p, chart_id: chartInfo.id, w: newW, h: newH };
    }));
    if (panelChanged) {
      setEditHasChanges(true);
    }
  };

  const openAIEditor = (panelId) => {
    const panel = editablePanels.find(p => p.id === panelId);
    const chartId = panel?.chart_id;
    if (chartId) {
      navigate(`/design/components/ai/${chartId}`, {
        state: { from: `/view/dashboards/${id}`, dashboardId: id, panelId }
      });
    }

  };

  // ── Text panel helpers ────────────────────────────────────────────
  const getPanelRect = (panelId) => {
    if (!gridRef.current) return null;
    const panelEl = gridRef.current.querySelector(`[data-panel-id="${panelId}"]`);
    return panelEl ? panelEl.getBoundingClientRect() : null;
  };

  const setTextPanel = (panelId) => {
    // Set default text config and clear chart_id
    updateEditablePanel(panelId, {
      chart_id: null,
      text_config: { content: '', display_content: 'title', size: 20, align: 'center' }
    });
    // Open the text editor anchored to the panel
    // Use requestAnimationFrame to ensure the panel has re-rendered with text_config
    requestAnimationFrame(() => {
      setTextEditorAnchorRect(getPanelRect(panelId));
      setTextEditorPanelId(panelId);
    });
  };

  const openTextEditor = (panelId) => {
    setTextEditorAnchorRect(getPanelRect(panelId));
    setTextEditorPanelId(panelId);
  };

  const handleTextConfigUpdate = (panelId, textConfig) => {
    updateEditablePanel(panelId, { text_config: textConfig });
  };

  const closeTextEditor = () => {
    setTextEditorPanelId(null);
    setTextEditorAnchorRect(null);
  };

  const openComponentPicker = (panelId, category) => {
    setComponentPickerPanelId(panelId);
    setComponentPickerCategory(category);
    setComponentPickerOpen(true);

  };

  const closeComponentPicker = () => {
    setComponentPickerOpen(false);
    setComponentPickerPanelId(null);
  };

  const handleComponentSelect = async (component) => {
    if (!componentPickerPanelId) return;
    if (!chartsMap[component.id]) {
      setChartsMap(prev => ({ ...prev, [component.id]: component }));
    }

    const subtype = component.control_config?.control_type || component.display_config?.display_type || component.chart_type;
    const minSize = getComponentMinSize(subtype);
    setEditablePanels(prev => prev.map(p => {
      if (p.id !== componentPickerPanelId) return p;
      const newW = Math.max(p.w, Math.min(minSize.w, maxGridCol - p.x));
      const newH = Math.max(p.h, minSize.h);
      return { ...p, chart_id: component.id, w: newW, h: newH };
    }));
    setEditHasChanges(true);
    closeComponentPicker();
  };

  const openAIPreflightModal = (panelId) => {
    updateEditablePanel(panelId, { chart_id: null });
    setAiPreflightPanelId(panelId);
    setAiPreflightOpen(true);

  };

  const handleAIPreflightContinue = async (context) => {
    setAiPreflightOpen(false);
    const panelId = aiPreflightPanelId;
    setAiPreflightPanelId(null);

    // Save dashboard first so panel persists, then navigate to AI builder
    try {
      await apiClient.updateDashboard(id, { ...dashboard, panels: editablePanels });
    } catch (err) {
      console.error('Failed to save before AI navigation:', err);
    }

    navigate('/design/components/ai/new', {
      state: {
        from: `/view/dashboards/${id}`,
        dashboardId: id,
        panelId,
        preflight: context
      }
    });
  };

  // ── Render ───────────────────────────────────────────────────────

  if (loading && !dashboard) {
    return (
      <div className="dashboard-viewer-page">
        <Loading description="Loading dashboard..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-viewer-page">
        <div className="error-container">
          <div className="error-message">Error: {error}</div>
          <Button onClick={handleBack}>Back to Dashboards</Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`dashboard-viewer-page ${isFullscreen ? 'fullscreen' : ''} ${isEditMode ? 'edit-mode-active' : ''}`}>
      {/* Dashboard switch indicator */}
      {switchIndicator && (
        <div className="dashboard-switch-indicator">
          <span className="switch-name">{switchIndicator.name}</span>
          <span className="switch-position">{switchIndicator.index} of {switchIndicator.total}</span>
        </div>
      )}

      {/* Header toolbar */}
      <div className="viewer-toolbar">
        <div className="toolbar-left">
          {!isFullscreen && !isEditMode && (
            <IconButton
              kind="ghost"
              label="Back to dashboards"
              align="bottom"
              onClick={handleBack}
            >
              <ArrowLeft size={20} />
            </IconButton>
          )}
          <div className="dashboard-info">
            {isEditMode ? (
              <div className="dashboard-name-wrapper">
                <input
                  className={`dashboard-name-input ${nameError ? 'has-error' : ''}`}
                  type="text"
                  value={editableName}
                  onChange={(e) => {
                    setEditableName(e.target.value);
                    setEditHasChanges(true);
                    if (nameError) setNameError('');
                  }}
                />
                {nameError && (
                  <NameErrorBadge message={nameError} />
                )}
              </div>
            ) : (
              <h1>{dashboard?.name}</h1>
            )}
          </div>
        </div>

        <div className="toolbar-center">
          {!isEditMode && !fromDesign && dashboardList.length > 1 && (
            <div className="dashboard-nav-buttons">
              <IconButton
                kind="ghost"
                size="sm"
                label="Previous dashboard"
                align="bottom"
                onClick={goToPrevDashboard}
                disabled={!canGoPrev}
              >
                <ChevronLeft size={20} />
              </IconButton>
              <IconButton
                kind="ghost"
                size="sm"
                label={isDefaultDashboard ? 'This is the default dashboard' : 'Go to default dashboard'}
                align="bottom"
                onClick={goToDefaultDashboard}
                disabled={isDefaultDashboard || !defaultDashboardId}
              >
                <Home size={16} />
              </IconButton>
              <IconButton
                kind="ghost"
                size="sm"
                label="Next dashboard"
                align="bottom"
                onClick={goToNextDashboard}
                disabled={!canGoNext}
              >
                <ChevronRight size={20} />
              </IconButton>
            </div>
          )}
          {isEditMode && dimensions.length > 0 && (
            <div className="dimension-selector">
              <Select
                id="viewer-dimension-select"
                labelText=""
                hideLabel
                size="sm"
                value={currentDimension}
                onChange={(e) => handleDimensionChange(e.target.value)}
              >
                {dimensions.map((dim) => (
                  <SelectItem
                    key={dim.name}
                    value={dim.name}
                    text={`${dim.name} (${dim.max_width}×${dim.max_height})`}
                  />
                ))}
              </Select>
            </div>
          )}
          {isEditMode && (
            <div className="zoom-controls">
              <IconButton
                kind="ghost"
                size="sm"
                label="Zoom out"
                align="bottom"
                onClick={zoomOut}
                disabled={zoom <= 10}
              >
                <ZoomOut size={16} />
              </IconButton>
              <button
                type="button"
                className="zoom-reset"
                onClick={zoomReset}
                title="Reset to 100%"
              >
                {zoom}%
              </button>
              <IconButton
                kind="ghost"
                size="sm"
                label="Zoom in"
                align="bottom"
                onClick={zoomIn}
                disabled={zoom >= 100}
              >
                <ZoomIn size={16} />
              </IconButton>
            </div>
          )}
          {isEditMode && editHasChanges && (
            <Tag type="blue" size="sm">Unsaved changes</Tag>
          )}
        </div>

        <div className="toolbar-right">
          {!isEditMode && dashboard?.settings?.refresh_interval > 0 && (
            <Tag type="green" size="sm">
              <Time size={12} />
              Data refresh: {dashboard.settings.refresh_interval}s
            </Tag>
          )}
          {isEditMode ? (
            <>
              <Button
                kind="ghost"
                size="sm"
                onClick={exitEditMode}
                renderIcon={Close}
              >
                Cancel
              </Button>
              <IconButton
                kind="ghost"
                size="sm"
                label="Dashboard settings"
                align="bottom"
                onClick={() => setSettingsModalOpen(true)}
              >
                <Settings size={20} />
              </IconButton>
              <Button
                kind="primary"
                size="sm"
                onClick={saveEditMode}
                disabled={!editHasChanges || editSaving}
                renderIcon={Save}
              >
                {editSaving ? 'Saving...' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              <span className="last-refresh">
                Last refresh: {formatTime(lastRefresh)}
              </span>
              <IconButton
                kind="ghost"
                label="Refresh"
                align="bottom"
                onClick={handleManualRefresh}
                disabled={loading}
              >
                <Renew size={20} className={loading ? 'spinning' : ''} />
              </IconButton>
              {canDesign && dashboard?.id && !isNewDashboard && (
                <IconButton
                  kind="ghost"
                  label="Export this dashboard and its related components and connections"
                  align="bottom"
                  onClick={() => setExportModalOpen(true)}
                >
                  <Download size={20} />
                </IconButton>
              )}
              <IconButton
                kind="ghost"
                label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onClick={toggleFullscreen}
                align="bottom"
              >
                {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
              </IconButton>
              <OverflowMenu
                size="lg"
                renderIcon={
                  fitMode === 'window' ? FitModeWindowIcon
                  : fitMode === 'width' ? FitModeWidthIcon
                  : fitMode === 'stretch' ? FitModeStretchIcon
                  : FitModeActualIcon
                }
                iconDescription={
                  fitMode === 'window' ? 'Fit to window'
                  : fitMode === 'width' ? 'Fit to width'
                  : fitMode === 'stretch' ? 'Stretch to fill'
                  : 'Actual size'
                }
                flipped
                direction="bottom"
                className="fit-mode-menu"
              >
                <OverflowMenuItem
                  itemText="Actual size"
                  onClick={() => selectFitMode('actual')}
                  isDelete={false}
                />
                <OverflowMenuItem
                  itemText="Fit to window"
                  onClick={() => selectFitMode('window')}
                />
                <OverflowMenuItem
                  itemText="Fit to width"
                  onClick={() => selectFitMode('width')}
                />
                <OverflowMenuItem
                  itemText={
                    <span className="fit-mode-item-with-info">
                      Stretch to fill
                      <Information
                        size={16}
                        className="fit-mode-info-icon"
                        // Native browser tooltip via the title attribute.
                        // Full Carbon Tooltip here would nest inside Carbon's
                        // menu popover and fight its focus management.
                      >
                        <title>May distort round chart elements like gauges and pies.</title>
                      </Information>
                    </span>
                  }
                  onClick={() => selectFitMode('stretch')}
                  hasDivider
                />
              </OverflowMenu>
              {canDesign && (
                <IconButton
                  kind="ghost"
                  label="Edit dashboard"
                  align="bottom"
                  onClick={enterEditMode}
                >
                  <Edit size={20} />
                </IconButton>
              )}
              <OverflowMenu
                renderIcon={() => <OverflowMenuVertical size={20} />}
                flipped
                direction="bottom"
                iconDescription="Dashboard actions"
              >
                {canDesign && (
                  <OverflowMenuItem
                    itemText={savingThumbnail ? "Saving..." : "Save Thumbnail"}
                    onClick={saveThumbnail}
                    disabled={savingThumbnail}
                  />
                )}
                <OverflowMenuItem
                  itemText={isDefaultDashboard ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <StarFilled size={16} style={{ color: '#f1c21b' }} />
                      Default Dashboard
                    </span>
                  ) : 'Set as Default'}
                  disabled={isDefaultDashboard}
                  onClick={handleSetAsDefault}
                />
              </OverflowMenu>
            </>
          )}
        </div>
      </div>

      {/* Dashboard grid */}
      {(panels && panels.length > 0) || isEditMode ? (
        <div
          ref={containerRef}
          className={`dashboard-grid-container fit-mode-${isEditMode ? 'edit' : fitMode}`}
        >
          {/*
            Wrapper around the grid: reserves the post-scale size so the
            container can flex-center the grid in "window" mode and
            measure scroll height correctly in "width" mode. In "actual"
            and "edit" modes the wrapper has no explicit dimensions — the
            grid flows at native size.
          */}
          <div
            className="dashboard-grid-scale-wrapper"
            style={
              !isEditMode && fitMode !== 'actual' && fitTransform.scaledW > 0
                ? { width: fitTransform.scaledW, height: fitTransform.scaledH }
                : undefined
            }
          >
          <div
            ref={gridRef}
            className={`dashboard-grid ${isEditMode ? 'edit-active' : ''}`}
            onMouseDown={handleGridMouseDown}
            style={{
              gridTemplateColumns: `repeat(${maxGridCol}, ${CELL_WIDTH}px)`,
              gridTemplateRows: `repeat(${maxGridRow}, ${CELL_HEIGHT}px)`,
              // Fit-mode transform: varies by mode. See `fitTransform` useMemo.
              ...(!isEditMode && fitTransform.transform ? {
                transform: fitTransform.transform,
                transformOrigin: 'top left'
              } : {}),
              // Edit mode: manual zoom (mutually exclusive with fit-mode transform
              // because fitTransform returns empty string when isEditMode is true).
              ...(isEditMode && zoom !== 100 ? {
                transform: `scale(${zoom / 100})`,
                transformOrigin: 'top left'
              } : {})
            }}
          >
            {panels.map((panel) => {
              const chart = panel.chart_id ? chartsMap[panel.chart_id] : null;
              const hasText = !!panel.text_config;
              const hasChart = !hasText && (!!chart?.component_code || chart?.component_type === 'control' || chart?.component_type === 'display');
              const hasContent = hasText || hasChart;
              // Double-click expand: charts and "live view" displays only.
              // Controls, frigate_alerts, text, and empty panels are excluded.
              // Some legacy components were saved with `component_type=""`
              // before the type was made required; treat any non-control,
              // non-display component with custom code as a chart so they
              // get the expand affordance too.
              const expandableDisplayTypes = new Set(['weather', 'frigate_camera']);
              const isLegacyChart = !!chart?.component_code
                && chart?.component_type !== 'control'
                && chart?.component_type !== 'display';
              const canExpand = !isEditMode && hasChart && (
                chart?.component_type === 'chart' ||
                isLegacyChart ||
                (chart?.component_type === 'display' && expandableDisplayTypes.has(chart?.display_config?.display_type))
              );

              return (
                <div
                  key={panel.id}
                  data-panel-id={panel.id}
                  className={`panel-container ${hasContent ? 'has-component' : 'empty-panel'} ${hasText ? 'text-panel' : ''} ${chart?.control_config?.control_type === 'text_label' ? 'text-label-panel' : ''} ${isEditMode ? 'edit-mode' : ''} ${draggingPanel?.id === panel.id ? 'dragging' : ''} ${resizingPanel?.id === panel.id ? 'resizing' : ''}`}
                  style={{
                    gridColumn: `${panel.x + 1} / span ${panel.w}`,
                    gridRow: `${panel.y + 1} / span ${panel.h}`,
                    cursor: isEditMode ? 'default' : (hasChart ? 'pointer' : 'default')
                  }}
                  onDoubleClick={canExpand ? () => setExpandedPanelId(panel.id) : undefined}
                >
                  {/* Edit mode: hover header overlay with title, actions, and delete */}
                  {isEditMode && (
                    <div className="edit-hover-header"
                      onMouseDown={(e) => startDragging(e, panel)}
                    >
                      <span className="panel-title-label">
                        {hasText ? (panel.text_config.content || 'Text') : (chart?.title || chart?.name || 'Empty')}
                      </span>
                      <div className="panel-header-right" style={{ pointerEvents: (draggingPanel || resizingPanel) ? 'none' : 'auto' }}>
                        {chart?.data_mapping?.sliding_window?.duration > 0 && (
                          <span className="panel-window-label">
                            {chart.data_mapping.sliding_window.duration >= 60
                              ? `${Math.round(chart.data_mapping.sliding_window.duration / 60)}m window`
                              : `${chart.data_mapping.sliding_window.duration}s window`}
                          </span>
                        )}
                        <span className="panel-size-label">{panel.w}×{panel.h}</span>
                        <div className="panel-header-edit-menu" onMouseDown={(e) => e.stopPropagation()}>
                          {hasText ? (
                            <IconButton
                              kind="ghost"
                              size="sm"
                              label="Edit text"
                              className="panel-text-edit-btn"
                              onClick={(e) => { e.stopPropagation(); textEditorPanelId === panel.id ? closeTextEditor() : openTextEditor(panel.id); }}
                              onMouseDown={(e) => e.stopPropagation()}
                            >
                              <Edit size={14} />
                            </IconButton>
                          ) : (
                            <PanelEditMenu
                              minimal
                              minimalIcon={hasChart ? <Edit size={14} /> : <Add size={14} />}
                              hasExisting={hasChart}
                              onEdit={hasChart ? () => openComponentEditor(panel.id) : undefined}
                              onEditWithAI={hasChart ? () => openAIEditor(panel.id) : undefined}
                              onNew={() => {
                                if (hasChart) updateEditablePanel(panel.id, { chart_id: null, text_config: null });
                                openComponentEditor(panel.id, null);
                              }}
                              onNewWithAI={() => openAIPreflightModal(panel.id)}
                              onSelectExisting={() => openComponentPicker(panel.id, 'all')}
                              onText={() => setTextPanel(panel.id)}
                            />
                          )}
                        </div>
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label="Delete panel"
                          className="panel-delete-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            deletePanel(panel.id);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <TrashCan size={14} />
                        </IconButton>
                      </div>
                    </div>
                  )}

                  {/* Panel content */}
                  {hasText ? (
                    <div className="component-wrapper text-wrapper">
                      <PanelText config={panel.text_config} />
                    </div>
                  ) : hasChart ? (
                    <>
                      {chart.component_type === 'control' ? (
                        <div className="component-wrapper control-wrapper" onDoubleClick={(e) => e.stopPropagation()}>
                          <ControlRenderer control={chart} />
                        </div>
                      ) : chart.component_type === 'display' ? (
                        <div className="component-wrapper display-wrapper">
                          {chart.display_config?.display_type === 'weather' ? (
                            <WeatherDisplay config={chart.display_config} />
                          ) : chart.display_config?.display_type === 'frigate_camera' ? (
                            <FrigateCameraViewer config={chart.display_config} dashboardCommand={dashboardCommand} />
                          ) : chart.display_config?.display_type === 'frigate_alerts' ? (
                            <FrigateAlertsGrid config={chart.display_config} dashboardCommand={dashboardCommand} />
                          ) : (
                            <div className="display-empty">Unknown display type</div>
                          )}
                        </div>
                      ) : (
                        <>
                          {chart.chart_type === 'datatable' && (
                            <div className="chart-header">
                              <span className="chart-name">{chart.title || chart.name || 'Untitled Chart'}</span>
                            </div>
                          )}
                          <div className={`component-wrapper ${chart.chart_type === 'datatable' ? 'with-header' : ''} ${chart.chart_type === 'dataview' ? 'dataview-wrapper' : ''}`}>
                            <ComponentPanelWithActions
                              // Key includes chart.updated so a config-refresh poll
                              // that picks up a server-side chart edit forces this
                              // panel to remount and the DynamicComponentLoader to
                              // re-eval the new component_code.
                              key={`${panel.chart_id}-${chart.updated || ''}-${refreshKey}`}
                              chart={chart}
                              loaderProps={{
                                code: chart.component_code,
                                props: {},
                                componentMeta: chart,
                                dataMapping: chart.data_mapping,
                                connectionId: chart.connection_id,
                                queryConfig: chart.query_config,
                                dataRefreshInterval: !isEditMode && dashboard?.settings?.refresh_interval > 0 ? dashboard.settings.refresh_interval * 1000 : null,
                              }}
                            />
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="empty-panel-placeholder">
                      <span>No chart</span>
                    </div>
                  )}

                  {/* Edit mode: full-panel drag overlay */}
                  {isEditMode && (
                    <div
                      className="edit-drag-overlay"
                      onMouseDown={(e) => startDragging(e, panel)}
                    />
                  )}

                  {/* Edit mode: Add button for empty panels */}
                  {isEditMode && !hasContent && (
                    <div className="edit-panel-menu-anchor" style={{ pointerEvents: (draggingPanel || resizingPanel) ? 'none' : 'auto' }}>
                      <PanelEditMenu
                        buttonLabel="Add"
                        hasExisting={false}
                        onNew={() => openComponentEditor(panel.id, null)}
                        onNewWithAI={() => openAIPreflightModal(panel.id)}
                        onSelectExisting={() => openComponentPicker(panel.id, 'all')}
                        onText={() => setTextPanel(panel.id)}
                      />
                    </div>
                  )}

                  {/* Edit mode: resize handle */}
                  {isEditMode && (
                    <div
                      className="edit-resize-handle"
                      onMouseDown={(e) => startResizing(e, panel)}
                    />
                  )}
                </div>
              );
            })}

            {/* Drawing preview — shown while dragging to create a new panel */}
            {drawingPanel && (
              <div
                className="drawing-panel-preview"
                style={{
                  gridColumn: `${drawingPanel.x + 1} / span ${drawingPanel.w}`,
                  gridRow: `${drawingPanel.y + 1} / span ${drawingPanel.h}`
                }}
              >
                <span>{drawingPanel.w}×{drawingPanel.h}</span>
              </div>
            )}

            {/* Dimension boundary lines — rendered as real elements to paint above grid items */}
            {isEditMode && gridCols && (
              <>
                <div
                  className="grid-boundary-right"
                  style={{
                    left: gridCols * CELL_WIDTH + (gridCols - 1) * VIEWER_GAP,
                    height: gridRows * CELL_HEIGHT + (gridRows - 1) * VIEWER_GAP
                  }}
                />
                <div
                  className="grid-boundary-bottom"
                  style={{
                    top: gridRows * CELL_HEIGHT + (gridRows - 1) * VIEWER_GAP,
                    width: gridCols * CELL_WIDTH + (gridCols - 1) * VIEWER_GAP
                  }}
                />
              </>
            )}
          </div>
          </div>
        </div>
      ) : (
        <div className="no-layout">
          <p>No panels configured for this dashboard.</p>
          <Button onClick={() => navigate(`/design/dashboards/${id}`)}>
            Configure Dashboard
          </Button>
        </div>
      )}

      {/* Chart Editor Modal (edit mode) */}
      <ComponentEditorModal
        open={componentEditorOpen}
        onClose={closeComponentEditor}
        onSave={handleChartSave}
        chart={editingChart}
        panelId={editingPanelId}
      />

      {/* Component Picker Modal (edit mode) */}
      <ComponentPickerModal
        open={componentPickerOpen}
        onClose={closeComponentPicker}
        onSelect={handleComponentSelect}
        category={componentPickerCategory}
      />

      {/* AI Pre-flight Modal (edit mode) */}
      <AIPreflightModal
        open={aiPreflightOpen}
        onClose={() => {
          setAiPreflightOpen(false);
          setAiPreflightPanelId(null);
        }}
        onContinue={handleAIPreflightContinue}
      />

      {/* Text panel editor */}
      {textEditorPanelId && (
        <PanelTextEditor
          config={editablePanels.find(p => p.id === textEditorPanelId)?.text_config}
          onUpdate={(config) => handleTextConfigUpdate(textEditorPanelId, config)}
          onClose={closeTextEditor}
          anchorRect={textEditorAnchorRect}
        />
      )}

      {/* Dashboard settings modal */}
      <DashboardExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        dashboardIds={dashboard?.id ? [dashboard.id] : []}
        dashboards={dashboard ? [dashboard] : []}
      />
      {expandedPanelId && (() => {
        const expandedPanel = panels.find(p => p.id === expandedPanelId);
        const expandedChart = expandedPanel?.chart_id ? chartsMap[expandedPanel.chart_id] : null;
        if (!expandedChart) return null;
        return (
          <ComponentExpandModal
            open={!!expandedPanelId}
            onClose={() => setExpandedPanelId(null)}
            chart={expandedChart}
            dashboardSettings={dashboard?.settings}
            lastRefresh={lastRefresh}
            formatTime={formatTime}
            dashboardCommand={dashboardCommand}
          />
        );
      })()}
      <Modal
        open={settingsModalOpen}
        onRequestClose={() => setSettingsModalOpen(false)}
        onRequestSubmit={() => {
          setEditHasChanges(true);
          setSettingsModalOpen(false);
        }}
        modalHeading="Dashboard Settings"
        primaryButtonText="Apply"
        secondaryButtonText="Cancel"
        size="sm"
      >
        <div className="dashboard-settings-form">
          <TextInput
            id="settings-description"
            labelText="Description"
            value={editableDescription}
            onChange={(e) => setEditableDescription(e.target.value)}
            placeholder="Enter dashboard description"
          />
          <NamespaceSelect
            id="settings-namespace"
            value={editableNamespace}
            onChange={(v) => { setEditableNamespace(v); setEditHasChanges(true); }}
          />
          <TagInput
            id="settings-tags"
            label="Tags"
            value={editableTags}
            onChange={setEditableTags}
          />
          <NumberInput
            id="settings-refresh"
            label="Auto Refresh (seconds)"
            value={editableRefreshInterval}
            onChange={(e, { value }) => setEditableRefreshInterval(value)}
            min={0}
            max={3600}
            step={5}
            helperText="Polling pauses while the browser tab is hidden. Set to 0 to disable auto refresh entirely."
          />
        </div>
      </Modal>

      {/* Discard changes confirmation */}
      {showDiscardModal && (
        <Modal
          open={true}
          onRequestClose={() => setShowDiscardModal(false)}
          onRequestSubmit={confirmDiscard}
          modalHeading="Discard Changes?"
          primaryButtonText="Discard"
          secondaryButtonText="Keep Editing"
          danger
        >
          <p>You have unsaved layout changes. Are you sure you want to discard them?</p>
        </Modal>
      )}

      {/* Mode-switch interception: three options so "cancel" can't be
          misread as either "abandon edits" or "abandon the mode switch". */}
      {modeSwitchPromptOpen && (
        <Modal
          open={true}
          onRequestClose={modeSwitchStay}
          modalHeading="Unsaved changes"
          passiveModal
          size="sm"
        >
          <p style={{ marginBottom: '1.5rem' }}>
            This dashboard has unsaved changes. Save before switching modes?
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button kind="ghost" onClick={modeSwitchStay}>Stay and keep editing</Button>
            <Button kind="danger--ghost" onClick={modeSwitchDiscard}>Discard and switch</Button>
            <Button kind="primary" onClick={modeSwitchSave}>Save and switch</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default DashboardViewerPage;
