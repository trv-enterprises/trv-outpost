// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  Button,
  Loading,
  IconButton,
  Tag,
  OverflowMenu,
  OverflowMenuItem,
  Modal,
  ComposedModal,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Select,
  SelectItem,
  TextInput,
  NumberInput,
  Toggle,
  Dropdown,
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
  Information,
  StarFilled,
  Edit,
  View,
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
  Download,
  Notification,
  Code
} from '@carbon/icons-react';
import html2canvas from 'html2canvas';
import DynamicComponentLoader from '../components/DynamicComponentLoader';
import VariableValuePickerModal from '../components/VariableValuePickerModal';
import ComponentPanelWithActions from '../components/ComponentPanelWithActions';
import ComponentExpandModal from '../components/ComponentExpandModal';
import DashboardGrid from '../components/DashboardGrid';
import { ControlRenderer } from '../components/controls';
import FrigateCameraViewer from '../components/frigate/FrigateCameraViewer';
import FrigateAlertsGrid from '../components/frigate/FrigateAlertsGrid';
import WeatherDisplay from '../components/weather/WeatherDisplay';
import PanelEditMenu from '../components/PanelEditMenu';
import PanelText from '../components/PanelText';
import PanelTextModal from '../components/PanelTextModal';
import ComponentEditorModal from '../components/ComponentEditorModal';
import ComponentPickerModal from '../components/ComponentPickerModal';
import AIPreflightModal from '../components/AIPreflightModal';
import apiClient, { API_BASE } from '../api/client';
import { useDashboardVariable } from '../hooks/useDashboardVariable';
import { orderDashboardsForViewer } from '../utils/dashboardOrder';
import { deriveVariableColumn } from '../utils/deriveVariableColumn';
import { DASHBOARD_VARIABLE_TOKEN } from '../utils/dataTransforms';
import { candidateLabel } from '../utils/tagValueByPrefix';
import TagInput from '../components/shared/TagInput';
import { invalidateTagsCache } from '../components/shared/tagsApi';
import NamespaceSelect from '../components/shared/NamespaceSelect';
import { useNamespaces } from '../context/NamespaceContext';
import DashboardExportModal from '../components/DashboardExportModal';
import NameErrorBadge from '../components/NameErrorBadge';
import DiscardChangesModal from '../components/shared/DiscardChangesModal';
import { useModeGuard } from '../context/ModeGuardContext';
import useAssistantSurface from '../hooks/useAssistantSurface';
import { useAIAvailability } from '../context/AIAvailabilityContext';
import { RefreshableComponentsProvider, useRefreshableComponentsContext } from '../context/RefreshableComponentsContext';
import { syncKioskFromUrl, getKioskDashboardIds } from '../utils/kioskMode';

// Module-scope helper so the toolbar's RefreshControls subcomponent
// (also module-scope) can see it. Pure — no closure over component
// state needed.
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Platform-aware label for the Alt/Option modifier shown in the
// prev/next dashboard tooltips. macOS users expect ⌥, everyone else
// expects "Alt". Resolved once at module load via userAgent — good
// enough for a tooltip; we're not gating behavior on it.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const ALT_KEY_LABEL = IS_MAC ? '⌥' : 'Alt';
import { useNotifications } from '../context/NotificationContext';
import StreamConnectionManager from '../utils/streamConnectionManager';
import { getComponentMinSize, MODES } from '../config/layoutConfig';
import './DashboardViewerPage.scss';

// Icon wrapper components for Carbon's OverflowMenu `renderIcon` prop.
// Carbon calls `React.createElement(renderIcon, { className, aria-label })`
// without passing a size, and the raw Carbon icons default to size=16.
// These wrappers lock the size at 20 to match the surrounding toolbar
// Defined at module scope so the component identity is stable across
// re-renders — passing an inline function to `renderIcon` causes Carbon
// to unmount/remount the trigger icon every render.
//
// The fit-mode menu uses a SINGLE fixed trigger icon (this one): Carbon
// caches the trigger's renderIcon and won't reliably swap it per mode,
// so we no longer try to convey the active mode via the icon. The active
// mode is shown by the ✓ on the menu items instead. FitToScreen reads as
// a generic "fit options" glyph for the trigger.
const FitModeWindowIcon = (props) => <FitToScreen size={20} {...props} />;

// Download-PNG action is built but disabled — html2canvas capture is not yet
// faithful (text letter-spacing, occasional dropped chart panel). Flip to true
// once capture quality is fixed. See dashboard-png-download-todo.
const PNG_DOWNLOAD_ENABLED = false;

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
function DashboardViewerPage({ canDesign = false, canControl = true }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isNewDashboard = id === 'new';

  const [dashboard, setDashboard] = useState(null);
  const [chartsMap, setChartsMap] = useState({}); // Chart data keyed by component_id
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Dashboard command subscription (voice control / kiosk integration)
  const [dashboardCommand, setDashboardCommand] = useState(null); // Latest command: { target, action, ... }
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  // "Measure screen size" helper. The published dimension names (2K, 4K)
  // overstate the usable area — the OS steals top space (menu bar / notch
  // / window chrome), so a dashboard built to a nominal dimension won't
  // fill the real screen. This captures the ACTUAL fullscreen viewport so
  // an admin can set a preset's real geometry in Manage → Settings →
  // Layout Dimensions (keeping the published name, fixing the numbers).
  const [screenMeasure, setScreenMeasure] = useState(null); // { w, h } or null = dialog closed
  // refreshTick: refetch-without-remount signal (used when only the
  // *data* should refresh — manual Refresh button, dashboard navigation).
  // Preserves streaming buffers and dynamic-component state. Server-side
  // chart-definition edits trigger a real remount via the chart.updated
  // segment of each panel's key, so no separate "force remount" counter
  // is needed.
  const [refreshTick, setRefreshTick] = useState(0);
  // Dashboard fit mode: "actual" | "window" | "width" | "stretch".
  // Storage is strictly per-user-per-dashboard; the load effect below
  // resolves: user's dashboard_fit_modes[id] → admin setting
  // default_dashboard_fit_mode → "stretch" hardcoded fallback.
  // Initial state is "stretch" to avoid a visible flicker before the
  // async load completes.
  const [fitMode, setFitMode] = useState('stretch');

  // Dashboard-variable feature: global admin gate (dashboard_variable.enabled).
  // The per-dashboard toggle + variable definitions live in dashboard.settings;
  // the hook below combines both gates with the component-level flag.
  const [dashboardVariableEnabled, setDashboardVariableEnabled] = useState(false);
  useEffect(() => {
    apiClient.getSetting('dashboard_variable.enabled')
      .then((s) => setDashboardVariableEnabled((s?.value ?? s) !== false))
      .catch(() => setDashboardVariableEnabled(false));
  }, []);

  // Keep a ref to the latest searchParams so the hook's callbacks read current
  // URL state without re-subscribing on every navigation.
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const getSearchParam = useCallback(() => searchParamsRef.current, []);
  const setSearchParam = useCallback((key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null || value === '') next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const {
    variable: dashVariable,
    candidates: dashVariableCandidates,
    selectedConnId: dashVariableValue,
    setValue: setDashVariableValue,
    resolveConnectionId,
    filterVariable: dashFilterVariable,
    filterValue: dashFilterValue,
    setFilterValue: setDashFilterValue,
  } = useDashboardVariable({
    dashboard,
    globalEnabled: dashboardVariableEnabled,
    getSearchParam,
    setSearchParam,
  });

  // Resolved display value of the connection-swap variable: the selected
  // connection's label (tag-prefix label when configured, else its name),
  // falling back to the reference (baseline) connection when nothing is
  // selected. Empty when the feature is inactive.
  const dashboardVariableText = useMemo(() => {
    if (!dashVariable) return '';
    const cands = dashVariableCandidates || [];
    const prefix = dashVariable.connection_swap?.label_tag_prefix || '';
    const selected = cands.find((c) => c.id === dashVariableValue);
    if (selected) return candidateLabel(selected, prefix);
    const reference = cands.find((c) => c.reference);
    return reference ? candidateLabel(reference, prefix) : '';
  }, [dashVariable, dashVariableCandidates, dashVariableValue]);

  // Map of variable NAME → resolved display value, for {{variable:NAME}} tokens
  // embedded in text-panel content. Covers both variable kinds: the
  // connection-swap variable (its label/tag-prefix value) and the filter
  // variable (its chosen string value). Keyed on each variable's stable name.
  const variableValues = useMemo(() => {
    const map = {};
    if (dashVariable?.name) map[dashVariable.name] = dashboardVariableText;
    if (dashFilterVariable?.name) map[dashFilterVariable.name] = dashFilterValue || '';
    return map;
  }, [dashVariable, dashboardVariableText, dashFilterVariable, dashFilterValue]);

  // The variables a text-panel editor can offer as insertable pills: every
  // defined variable, by name + label. Empty when the feature is inactive.
  const definedVariables = useMemo(() => {
    const list = [];
    if (dashVariable?.name) list.push({ name: dashVariable.name, label: dashVariable.label || dashVariable.name });
    if (dashFilterVariable?.name) list.push({ name: dashFilterVariable.name, label: dashFilterVariable.label || dashFilterVariable.name });
    return list;
  }, [dashVariable, dashFilterVariable]);

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

  // "Preview from design" mode: user just saved/opened this dashboard from the
  // designer. Hide multi-dashboard navigation (prev/next/home, Alt+arrow) and
  // route the back arrow to the design list instead of the viewer list — the
  // user came from design and should return there, not jump into view mode.
  const [fromDesign, setFromDesign] = useState(() => !!location.state?.fromDesign);

  // The ORIGIN of this edit session, captured once at mount and never
  // mutated. `fromDesign` (above) doubles as a post-save preview-framing
  // flag — saveEditMode flips it true to show single-dashboard chrome —
  // which makes it the wrong thing to gate Cancel's destination on. A
  // chart reached from the viewer, edited, and saved would otherwise have
  // fromDesign=true and route a subsequent Cancel to the design list
  // instead of back to the viewer. cancelOrigin stays put: "did this
  // session start from the design list?" decides where Cancel/discard go.
  const cancelOrigin = useRef(!!location.state?.fromDesign || id === 'new');

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
  // True when the "Unsaved changes" dialog was triggered by the in-editor
  // View button rather than a header mode switch. In that case the three
  // dialog actions operate in place (goToViewer) instead of resolving the
  // header mode-switch guard promise.
  const [viewNavMode, setViewNavMode] = useState(false);
  const modeSwitchResolveRef = useRef(null);
  // The mode being switched TO when the dirty-edit prompt defers the guard, so
  // the prompt's Save/Discard resolvers can clear the design-origin flag when
  // proceeding into VIEW (symmetry with the clean-path guard below).
  const modeSwitchTargetRef = useRef(null);
  const { setModeGuard, clearModeGuard, setIsEditingDashboard } = useModeGuard();

  // Tell App.jsx's mode sync to keep the header pill on DESIGN while we're
  // editing, or while we're viewing this dashboard as a design-mode preview
  // (eye icon in the design list). When neither applies, clear the flag so
  // the normal /view/... → VIEW sync takes over.
  useEffect(() => {
    setIsEditingDashboard(isEditMode || fromDesign);
    return () => setIsEditingDashboard(false);
  }, [isEditMode, fromDesign, setIsEditingDashboard]);
  const { pushToast, addNotification, notifications, togglePanel: toggleNotificationPanel } = useNotifications();
  const [editSaving, setEditSaving] = useState(false);
  const [editableName, setEditableName] = useState('');
  // Server-rejection error for the dashboard name (e.g., duplicate
  // name in the target namespace). Cleared when the user edits the
  // name input, set when the save fails with a name-related error.
  const [nameError, setNameError] = useState('');
  const nameInputRef = useRef(null);
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
  // Dashboard-variable authoring (connection-swap, v1). The single variable
  // uses the fixed token name "dashboard-variable"; the designer sets its
  // display label, discovery tags, and schema-strictness.
  const [editableVariablesEnabled, setEditableVariablesEnabled] = useState(false);
  // The variable's TYPE drives both authoring fields and how the header
  // surfaces the selection: 'connection_swap' (connection picker) or 'filter'
  // (a string value substituted into queries/filters). 'range' (time window) is
  // a planned future type — the selector is built to grow.
  const [editableVariableMode, setEditableVariableMode] = useState('connection_swap');
  const [editableVariableLabel, setEditableVariableLabel] = useState('');
  const [editableVariableTags, setEditableVariableTags] = useState([]);
  const [editableVariableSchemaStrict, setEditableVariableSchemaStrict] = useState('type_only');
  const [editableVariableSameNamespace, setEditableVariableSameNamespace] = useState(false);
  // Optional tag prefix whose matched value labels each connection in the
  // dropdown (e.g. "host" → show "trv-srv-001" from a "host:trv-srv-001" tag),
  // falling back to the connection name. Connection-swap only.
  const [editableVariableLabelTagPrefix, setEditableVariableLabelTagPrefix] = useState('');
  // Filter-type fields: how the header sources the value, and (for static) the
  // option list + default. Data-driven discovery (query the connection for valid
  // values) is a deferred seam — see the dashboard-variable-picker TODO.
  const [editableVariableValueSource, setEditableVariableValueSource] = useState('static');
  const [editableVariableOptions, setEditableVariableOptions] = useState([]);
  const [editableVariableDefault, setEditableVariableDefault] = useState('');
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [varsModalOpen, setVarsModalOpen] = useState(false);
  // Draft buffers for the Settings and Vars modals. Inputs edit the draft, NOT
  // the shared editable* state — so Cancel discards cleanly and an abandoned
  // change can't ride along on a later Save. Apply copies the draft into the
  // editable* state (+ marks dirty). Seeded from editable* when each modal opens.
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [varsDraft, setVarsDraft] = useState(null);

  // Seed the Settings modal draft from the live editable* state when it opens,
  // so the modal edits a buffer and Cancel discards without mutating anything.
  // (Declared here, AFTER the editable*/draft state, to avoid a TDZ on the
  // dependency.)
  useEffect(() => {
    if (settingsModalOpen) {
      setSettingsDraft({
        description: editableDescription,
        namespace: editableNamespace,
        tags: editableTags,
        refreshInterval: editableRefreshInterval,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsModalOpen]);

  // Seed the Vars modal draft likewise.
  useEffect(() => {
    if (varsModalOpen) {
      setVarsDraft({
        enabled: editableVariablesEnabled,
        mode: editableVariableMode,
        label: editableVariableLabel,
        tags: editableVariableTags,
        schemaStrict: editableVariableSchemaStrict,
        sameNamespace: editableVariableSameNamespace,
        labelTagPrefix: editableVariableLabelTagPrefix,
        valueSource: editableVariableValueSource,
        options: editableVariableOptions,
        defaultValue: editableVariableDefault,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varsModalOpen]);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [expandedPanelId, setExpandedPanelId] = useState(null);

  // Zoom state (edit mode only)
  const [zoom, setZoom] = useState(100);
  const zoomIn = () => setZoom(z => Math.min(z + 10, 100));
  const zoomOut = () => setZoom(z => Math.max(z - 10, 10));
  const zoomReset = () => setZoom(100);
  // Zoom-to-fit: shrink the design canvas so it fits inside the editor's
  // visible area. Mirrors the view-mode "window" fit, but for the editor's
  // manual zoom (which only scales DOWN — never above 100%). Defined later,
  // after the design-canvas + container sizes are computed; see zoomToFit.

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

  // Text panel editor state — the panel whose text_config the modal is editing
  // (null = closed).
  const [textEditorPanelId, setTextEditorPanelId] = useState(null);

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
  // "Everything bigger" zoom. The dashboard is BUILT on a design canvas
  // of target/(scalePercent/100); the viewer renders at the target dim
  // and transform:scales it up, so a higher % enlarges fonts+lines+layout
  // uniformly. 100 = build at target. Persisted as settings.scale_percent.
  const [scalePercent, setScalePercent] = useState(100);

  // Load the persisted scale in BOTH view and edit mode (it drives the
  // view-mode "actual size" zoom-up and the fit math, not just the editor
  // controls). The dimension-preset fetch below is edit-only, but the
  // scale value is needed everywhere.
  useEffect(() => {
    if (!dashboard) return;
    const savedScale = Number(dashboard.settings?.scale_percent);
    setScalePercent(Number.isFinite(savedScale) && savedScale > 0 ? savedScale : 100);
  }, [dashboard]);

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
        // (scale_percent is loaded by the mode-agnostic effect above.)
      })
      .catch(() => {});
  }, [isEditMode, dashboard]);

  // Resolved current dimension object = the render TARGET.
  const layoutDimension = useMemo(() => {
    return dimensions.find(d => d.name === currentDimension) || null;
  }, [dimensions, currentDimension]);

  // Grid bounds from layout dimension.
  // Vertical chrome = the 57px viewer toolbar (56px + 1px border) that
  // sits above the grid in view/fullscreen. The dashboard is designed for
  // and displayed at the TARGET dimension minus this toolbar — there is
  // no app-header in the displayed (view/fullscreen) dashboard, so the
  // budget reserves only the toolbar. This makes "actual size" in the
  // editor a pixel-perfect preview of the fullscreen render. Kept in sync
  // with the server's gridChromeV (registry/catalog.go) so the AI plans
  // to the same cell budget.
  const VIEWER_CHROME_V = 57;
  const VIEWER_CHROME_H = 4;
  const VIEWER_GAP = 4;

  // DESIGN dimension = target / (scale/100). The grid budget (cell
  // cols/rows) is computed against the DESIGN canvas, so a higher scale
  // shrinks the build area → fewer cells → everything renders bigger when
  // the viewer transform:scales the design canvas up to the target. The
  // chrome subtraction stays applied to the design dim (same formula +
  // constants the server's computeCells uses), so building rules are
  // unchanged — they just operate on the smaller canvas.
  const scaleFactor = (Number.isFinite(scalePercent) && scalePercent > 0 ? scalePercent : 100) / 100;
  const designDimension = useMemo(() => {
    if (!layoutDimension) return null;
    return {
      max_width: Math.round(layoutDimension.max_width / scaleFactor),
      max_height: Math.round(layoutDimension.max_height / scaleFactor),
    };
  }, [layoutDimension, scaleFactor]);

  const gridCols = useMemo(() => {
    if (!designDimension) return null;
    const availableWidth = designDimension.max_width - VIEWER_CHROME_H;
    return Math.floor((availableWidth + VIEWER_GAP) / (CELL_WIDTH + VIEWER_GAP));
  }, [designDimension]);

  const gridRows = useMemo(() => {
    if (!designDimension) return null;
    const availableHeight = designDimension.max_height - VIEWER_CHROME_V;
    return Math.floor((availableHeight + VIEWER_GAP) / (CELL_HEIGHT + VIEWER_GAP));
  }, [designDimension]);

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

  // ── Runtime value discovery for a `connection`-sourced filter variable ──
  // When the filter variable's value_source is "connection", the header
  // dropdown's options are discovered live: query distinct values of the bound
  // column from the connection used by the dashboard's variable-driven
  // components. Column/table are derived from the component's query the same way
  // the editor's value picker does. If the variable-driven components span more
  // than one connection, use the FIRST and warn (toast + notification, once).
  const discoveryWarnedRef = useRef(null);
  const discoveryTarget = useMemo(() => {
    const cfg = dashFilterVariable?.filter_value || {};
    if (!dashFilterVariable || cfg.value_source !== 'connection') return null;

    // Components that actually consume the token (query OR a filter value).
    const driven = [];
    for (const panel of panels || []) {
      const comp = panel?.component_id ? chartsMap[panel.component_id] : null;
      if (!comp || !comp.connection_id) continue;
      const raw = comp.query_config?.raw;
      const usesInQuery = typeof raw === 'string' && raw.includes(DASHBOARD_VARIABLE_TOKEN);
      const usesInFilter = Array.isArray(comp.data_mapping?.filters)
        && comp.data_mapping.filters.some((f) => typeof f.value === 'string' && f.value.trim() === DASHBOARD_VARIABLE_TOKEN);
      if (usesInQuery || usesInFilter) driven.push(comp);
    }
    if (driven.length === 0) return null;

    const connIds = [...new Set(driven.map((c) => c.connection_id))];
    // Pick the first component on the first connection to derive column/table.
    const firstConnId = connIds[0];
    const comp = driven.find((c) => c.connection_id === firstConnId);
    const raw = comp.query_config?.raw || '';
    let { column, table } = deriveVariableColumn(raw);
    // Non-SQL filter components: the bound column is the filter row whose value
    // is the token (no table needed for those adapters).
    if (!column && Array.isArray(comp.data_mapping?.filters)) {
      const f = comp.data_mapping.filters.find((x) => typeof x.value === 'string' && x.value.trim() === DASHBOARD_VARIABLE_TOKEN);
      if (f?.field) column = f.field;
    }
    const database = comp.query_config?.params?.database || '';
    return { connId: firstConnId, column, table, database, multiConn: connIds.length > 1 };
  }, [dashFilterVariable, panels, chartsMap]);

  // Warn once per dashboard when discovery spans >1 connection (use first).
  useEffect(() => {
    if (!discoveryTarget?.multiConn) return;
    const key = `${dashboard?.id || ''}`;
    if (discoveryWarnedRef.current === key) return;
    discoveryWarnedRef.current = key;
    const msg = "This dashboard's variable spans more than one connection; using the first for value discovery.";
    pushToast({ kind: 'warning', title: 'Multiple connections', subtitle: msg });
    addNotification({ kind: 'warning', title: 'Dashboard variable: multiple connections', subtitle: msg });
  }, [discoveryTarget, dashboard?.id, pushToast, addNotification]);

  // Discovered options + fetch state for the connection-sourced filter variable.
  // Dispatch by connection type:
  //   - SQL/EdgeLake/API → getVariableValues (server-side DISTINCT / one-shot;
  //     low latency, no storage).
  //   - stream/socket → read the connection's persisted discovered_values[column]
  //     (captured at authoring time; view-time stream capture is too slow). A
  //     session-only "regenerate" (below) can override this list for this user.
  const [discoveredOptions, setDiscoveredOptions] = useState(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  // Session-only override the viewer's "regenerate" sets; wins over the stored
  // list but is NOT persisted (persistence needs design authority in the editor).
  const [sessionDiscoveredOverride, setSessionDiscoveredOverride] = useState(null);
  // The connection type backing discovery (drives path + whether regenerate is
  // offered). Set by the discovery effect.
  const [discoveryConnType, setDiscoveryConnType] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSessionDiscoveredOverride(null); // clear stale session override on target change
    if (!discoveryTarget || !discoveryTarget.connId || !discoveryTarget.column) {
      setDiscoveredOptions(null);
      setDiscoveryLoading(false);
      setDiscoveryConnType(null);
      return undefined;
    }
    setDiscoveryLoading(true);
    (async () => {
      try {
        // Resolve the connection type (cached) to choose the discovery path.
        const conn = await apiClient.getConnection(discoveryTarget.connId).catch(() => null);
        if (cancelled) return;
        const type = conn?.type || conn?.config?.type || null;
        setDiscoveryConnType(type);
        // Only RAW socket / mqtt are truly stream-only (no query API) — those
        // read the authoring-captured stored list. tsstore (even streaming
        // transport) answers "newest" over HTTP, so it uses the server path
        // like SQL/EdgeLake/API — no stored list, no view-time capture.
        const isStreamLike = type === 'socket' || type === 'mqtt';

        if (isStreamLike) {
          // Raw socket/mqtt: read the authoring-time captured list off the
          // connection record. No view-time capture (too slow).
          const stored = conn?.discovered_values?.[discoveryTarget.column];
          setDiscoveredOptions(Array.isArray(stored?.values) ? stored.values : null);
        } else {
          // SQL/EdgeLake/API/tsstore: server-side discovery (DISTINCT for SQL/
          // EdgeLake; one-shot fetch + harvest for API; newest 1000 for tsstore).
          const res = await apiClient.getVariableValues(discoveryTarget.connId, {
            column: discoveryTarget.column,
            table: discoveryTarget.table,
            database: discoveryTarget.database,
          });
          if (cancelled) return;
          setDiscoveredOptions(res?.success && Array.isArray(res.values) ? res.values : null);
        }
      } catch {
        if (!cancelled) setDiscoveredOptions(null); // fall back to static options
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Key on the resolved triple so it doesn't refire on unrelated renders.
  }, [discoveryTarget?.connId, discoveryTarget?.column, discoveryTarget?.table, discoveryTarget?.database]);

  // Session-only regenerate for a stream/socket variable: live-capture records
  // via the connection's SSE stream, unique the bound column, and override the
  // dropdown list for THIS session (not persisted — a designer makes it
  // permanent via the editor). Mirrors the editor's capture-with-stop.
  const regenerateCaptureRef = useRef(null);
  const [regenerating, setRegenerating] = useState(false);
  // Live-accumulating distinct values during a regenerate capture + the capture
  // modal's open state. The modal shows the list growing in real time with a
  // Stop button, so the user can watch and stop when it stabilizes.
  const [regenLiveValues, setRegenLiveValues] = useState([]);
  const [regenModalOpen, setRegenModalOpen] = useState(false);
  const regenSeenRef = useRef(null);
  // Set true on Stop so, after the modal closes, the dropdown auto-opens to
  // signal the freshly-captured list is ready to pick from.
  const [autoOpenFilterDropdown, setAutoOpenFilterDropdown] = useState(false);

  const startSessionRegenerate = useCallback(() => {
    const target = discoveryTarget;
    if (!target?.connId || !target.column) return;
    if (regenerateCaptureRef.current) { regenerateCaptureRef.current.close(); regenerateCaptureRef.current = null; }
    const seen = new Set();
    regenSeenRef.current = seen;
    setRegenLiveValues([]);
    setRegenModalOpen(true);
    setRegenerating(true);
    const authParam = apiClient.streamAuthQuery();
    const sseUrl = `${API_BASE}/api/connections/${target.connId}/stream?${authParam}`;
    const es = new EventSource(sseUrl);
    regenerateCaptureRef.current = es;
    const values = [];
    const CAP = 1000;
    const finish = () => {
      if (regenerateCaptureRef.current !== es) return;
      es.close();
      regenerateCaptureRef.current = null;
      setRegenerating(false);
    };
    es.addEventListener('record', (event) => {
      try {
        const rec = JSON.parse(event.data);
        const v = rec?.[target.column];
        if (v != null) {
          const s = String(v);
          if (s !== '' && !seen.has(s)) {
            seen.add(s);
            values.push(s);
            setRegenLiveValues([...values]); // live update → modal re-renders
          }
        }
        if (values.length >= CAP) finish();
      } catch { /* ignore parse errors */ }
    });
    es.onerror = () => { if (regenerateCaptureRef.current === es) finish(); };
    // Safety cap: stop after 5 minutes if the user walks away.
    setTimeout(() => { if (regenerateCaptureRef.current === es) finish(); }, 300000);
  }, [discoveryTarget]);

  // Stop capturing — close the SSE, commit the accumulated list as the session
  // override, close the modal, and flag the dropdown to auto-open so the user
  // sees the new list is ready to pick from.
  const stopSessionRegenerate = useCallback(() => {
    if (regenerateCaptureRef.current) { regenerateCaptureRef.current.close(); regenerateCaptureRef.current = null; }
    setRegenerating(false);
    setSessionDiscoveredOverride([...regenLiveValues]);
    setRegenModalOpen(false);
    setAutoOpenFilterDropdown(true);
  }, [regenLiveValues]);

  // Tear down any in-flight capture on unmount.
  useEffect(() => () => {
    if (regenerateCaptureRef.current) { regenerateCaptureRef.current.close(); regenerateCaptureRef.current = null; }
  }, []);

  // After a regenerate completes, auto-open the filter dropdown so the user
  // sees the freshly-captured list is ready to pick from. Carbon's Dropdown has
  // no controlled-open prop (Downshift-driven), so we click its trigger.
  const filterDropdownRef = useRef(null);
  useEffect(() => {
    if (!autoOpenFilterDropdown || regenModalOpen) return;
    setAutoOpenFilterDropdown(false);
    const t = setTimeout(() => {
      const trigger = filterDropdownRef.current?.querySelector('[role="combobox"], .cds--list-box__field');
      if (trigger) trigger.click();
    }, 50);
    return () => clearTimeout(t);
  }, [autoOpenFilterDropdown, regenModalOpen]);

  // The list the dropdown actually uses: session override wins, else discovered.
  const effectiveDiscoveredOptions = sessionDiscoveredOverride ?? discoveredOptions;
  // Regenerate (live SSE re-capture) is only meaningful for RAW socket/mqtt
  // variables, where the list is stored (no query API). tsstore uses the HTTP
  // "newest" server path like SQL/API — it re-discovers on load, so no
  // Regenerate button.
  const discoveryIsStream = discoveryConnType === 'socket' || discoveryConnType === 'mqtt';

  const panelExtentCol = useMemo(() => {
    if (!panels || panels.length === 0) return 0;
    return panels.reduce((max, panel) => Math.max(max, panel.x + panel.w), 0);
  }, [panels]);

  const panelExtentRow = useMemo(() => {
    if (!panels || panels.length === 0) return 0;
    return panels.reduce((max, panel) => Math.max(max, panel.y + panel.h), 0);
  }, [panels]);

  // Publish the current dashboard surface to the Dashboard Assistant
  // so it can resolve "this dashboard / this panel" without a tool
  // round trip.
  //
  // Perf-critical: this memo runs on every editablePanels change,
  // which during a drag is 30+ frames/sec. The output payload doesn't
  // include x/y/w/h (geometry isn't useful to the agent), so derive
  // a *stable signature* — id + component_id + title only — and use
  // that as the dep instead of the live panels array. While the user
  // drags, the signature stays byte-identical and the heavy memo
  // doesn't re-run. Panel cap stays at 100 to bound token cost on
  // pathological dashboards.
  //
  // Surface registration is also gated on chat-agent availability —
  // if the env key isn't set / admin disabled the assistant, no
  // sidecard exists to consume the surface and the registration is
  // pure waste. We rely on chatAgentEnabled here; the per-user
  // capability gate that hides the launcher icon happens upstream in
  // App.jsx and isn't reachable from here without prop drilling.
  // Worst case: a non-designer pays the (now-cheap) registration on
  // every dashboard mount.
  const { chatAgentEnabled } = useAIAvailability();
  const surfaceEligible = chatAgentEnabled;

  const panelSignature = useMemo(() => {
    if (!surfaceEligible) return '';
    const list = panels || [];
    const out = [];
    const cap = Math.min(list.length, 100);
    for (let i = 0; i < cap; i++) {
      const p = list[i];
      const chart = p.component_id ? chartsMap[p.component_id] : null;
      const title = chart?.title || chart?.name || '';
      out.push(`${p.id}|${p.component_id || ''}|${title}|${chart?.component_type || ''}|${chart?.chart_type || ''}`);
    }
    return out.join('\n');
  }, [surfaceEligible, panels, chartsMap]);

  const assistantSurface = useMemo(() => {
    if (!surfaceEligible || !dashboard?.id) return null;
    const summarized = (panels || []).slice(0, 100).map((p) => {
      const chart = p.component_id ? chartsMap[p.component_id] : null;
      const entry = { id: p.id };
      if (chart?.title || chart?.name) entry.title = chart.title || chart.name;
      if (p.component_id) entry.componentId = p.component_id;
      if (chart?.component_type) entry.componentType = chart.component_type;
      if (chart?.chart_type) entry.chartType = chart.chart_type;
      return entry;
    });
    return {
      mode: isEditMode ? 'EDIT' : 'VIEW',
      surface: 'DASHBOARD',
      surfaceId: dashboard.id,
      surfaceName: dashboard.name,
      panels: summarized,
    };
    // panelSignature carries the only panel-state we render into the
    // payload; depending on it instead of `panels` directly lets drag
    // frames skip this memo entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceEligible, dashboard?.id, dashboard?.name, panelSignature, isEditMode]);
  useAssistantSurface(assistantSurface);

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
  //
  // We watch both the window AND the container element. The window
  // listener catches obvious cases (browser resize, fullscreen
  // toggle). The ResizeObserver catches cases where the window
  // stays the same size but the container's available width
  // shrinks or grows — like when the Dashboard Assistant sidecard
  // opens/closes and pushes the page reflow via CSS padding (no
  // window resize fires for that).
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

    // ResizeObserver picks up container-size changes that don't
    // cause a window resize — the assistant-sidecard open/close
    // is the primary case but anything that adds/removes padding
    // on a parent container will trigger this too.
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(() => { measure(); });
      ro.observe(containerRef.current);
    }

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener('resize', measure);
      if (ro) ro.disconnect();
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
    if (isEditMode) {
      return { transform: '', scaledW: 0, scaledH: 0 };
    }
    // The panels are BUILT at the design canvas (gridNative px), but the
    // dashboard's true render size is the TARGET = gridNative * scaleFactor
    // (scale_percent). So the content the viewer presents/fits is the
    // target-sized version, not the raw built size.
    const gridNativeW = maxGridCol * CELL_WIDTH + (maxGridCol - 1) * GAP;
    const gridNativeH = maxGridRow * CELL_HEIGHT + (maxGridRow - 1) * GAP;
    const targetW = gridNativeW * scaleFactor;
    const targetH = gridNativeH * scaleFactor;

    // "actual" = native TARGET size, no fit-to-window. With a scale > 100%
    // this is the zoomed-up render (the "everything bigger" result); at
    // 100% scaleFactor is 1 so it's the plain native size as before.
    if (fitMode === 'actual') {
      if (scaleFactor === 1) return { transform: '', scaledW: 0, scaledH: 0 };
      return { transform: `scale(${scaleFactor})`, scaledW: targetW, scaledH: targetH };
    }

    if (!containerSize.width || !containerSize.height) {
      return { transform: '', scaledW: 0, scaledH: 0 };
    }
    const availW = containerSize.width - 2 * CONTAINER_PADDING;
    const availH = containerSize.height - 2 * CONTAINER_PADDING;
    // Fit ratios computed against the TARGET-sized content...
    const sx = availW / targetW;
    const sy = availH / targetH;
    // ...and the applied transform is fitRatio * scaleFactor, since the
    // untransformed content is still at the smaller built (design) size.
    if (fitMode === 'stretch') {
      return {
        transform: `scale(${sx * scaleFactor}, ${sy * scaleFactor})`,
        scaledW: targetW * sx,
        scaledH: targetH * sy,
      };
    }
    if (fitMode === 'width') {
      return {
        transform: `scale(${sx * scaleFactor})`,
        scaledW: targetW * sx,
        scaledH: targetH * sx,
      };
    }
    // "window" — uniform, both axes fit
    const s = Math.min(sx, sy);
    return {
      transform: `scale(${s * scaleFactor})`,
      scaledW: targetW * s,
      scaledH: targetH * s,
    };
  }, [isEditMode, fitMode, containerSize.width, containerSize.height, maxGridCol, maxGridRow, CELL_WIDTH, CELL_HEIGHT, scaleFactor]);

  // Zoom-to-fit (edit mode): pick the zoom % that makes the whole design
  // canvas fit inside the editor's visible area. The editor zoom scales the
  // grid-scale-wrapper, whose unscaled size IS the design canvas
  // (gridNative px), so fit% = min(containerW/gridNativeW, containerH/
  // gridNativeH) × 100. Clamped to the same 10–100 range as the +/- buttons
  // (zoom only ever shrinks the big canvas to fit — never magnifies past
  // actual). No-op until the container has been measured.
  const zoomToFit = useCallback(() => {
    // Fit the DESIGN CANVAS (the dimension boundary the user sees — drawn at
    // gridCols/gridRows), NOT maxGridCol/maxGridRow. The latter is
    // max(dimension, panelExtent), so a panel placed past the boundary would
    // shrink the fit below what the visible canvas needs (the reported 74% vs
    // 84%). Fall back to maxGrid* when the dimension isn't known (no preset).
    const cols = gridCols || maxGridCol;
    const rows = gridRows || maxGridRow;
    const canvasW = cols * CELL_WIDTH + (cols - 1) * GAP;
    const canvasH = rows * CELL_HEIGHT + (rows - 1) * GAP;
    if (!canvasW || !canvasH) return;
    // Measure the container LIVE at click time, not from the containerSize
    // state — that's only refreshed by the ResizeObserver/resize effect, so a
    // layout change just before the click (e.g. collapsing the left nav to
    // reclaim width) may not have propagated to state yet, and zoom-to-fit
    // would use the stale (narrower) size. clientWidth/Height reflect the
    // current DOM.
    const el = containerRef.current;
    const measuredW = el ? el.clientWidth : containerSize.width;
    const measuredH = el ? el.clientHeight : containerSize.height;
    if (!measuredW || !measuredH) return;
    // Subtract container padding so the fit matches the actual usable area
    // (consistent with the view-mode fitTransform).
    const availW = measuredW - 2 * CONTAINER_PADDING;
    const availH = measuredH - 2 * CONTAINER_PADDING;
    const ratio = Math.min(availW / canvasW, availH / canvasH);
    const fitPct = Math.max(10, Math.min(100, Math.floor(ratio * 100)));
    setZoom(fitPct);
  }, [containerSize.width, containerSize.height, gridCols, gridRows, maxGridCol, maxGridRow, CELL_WIDTH, CELL_HEIGHT, GAP, CONTAINER_PADDING]);

  // Fetch dashboard data and referenced charts
  const fetchDashboard = useCallback(async () => {
    try {
      const data = await apiClient.getDashboard(id);
      setDashboard(data);

      if (data.panels && data.panels.length > 0) {
        const chartIds = [...new Set(data.panels.map(p => p.component_id).filter(Boolean))];
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
  // sees there — both the saved sort preference
  // (app_config.user.<guid>.settings.dashboard_tile_sort) and the
  // manual drag-and-drop order
  // (app_config.user.<guid>.settings.dashboard_tile_order).
  //
  // Honor the tile page's active filters: when the user navigates
  // here from a filtered tile page, the filtered ID list arrives in
  // route state. We cache it in sessionStorage (keyed `viewer:filter`)
  // so a tab reload keeps the filter; a fresh tab / direct URL gets
  // unfiltered (which is the right default for kiosks). Cleared
  // explicitly when route state explicitly says { clearFilter: true }.
  //
  // Reruns on tab focus / visibility-change so sort or manual-order
  // changes the user makes on the tile page take effect the next
  // time they return to the viewer (no cross-component event needed).
  useEffect(() => {
    let cancelled = false;

    // Kiosk mode trumps everything: a kiosk URL payload locks the
    // dashboard set + order. URL is consumed (query string cleaned)
    // and cached so reloads without the query string keep working.
    // The regular viewer only needs the flat dashboard-id lock (filter + order);
    // the entry/connection/rotation richness is the /kiosk surface's concern.
    // syncKioskFromUrl() now returns the full config object, so derive ids from
    // it (or the cached flat list) and dedupe — the viewer can't repeat ids.
    const kioskConfig = syncKioskFromUrl();
    const kioskIds = kioskConfig
      ? [...new Set(kioskConfig.entries.map((e) => e.dashboardId))]
      : getKioskDashboardIds();

    // For non-kiosk sessions: read filter from route state first
    // (this navigation); fall back to sessionStorage (page reload of
    // an already-filtered view).
    let filteredIds = null;
    if (!kioskIds) {
      const stateIds = location.state?.filteredDashboardIds;
      if (Array.isArray(stateIds)) {
        filteredIds = stateIds;
        try { sessionStorage.setItem('viewer:filter', JSON.stringify(stateIds)); } catch { /* quota / disabled */ }
      } else {
        try {
          const cached = sessionStorage.getItem('viewer:filter');
          const parsed = cached ? JSON.parse(cached) : null;
          if (Array.isArray(parsed)) filteredIds = parsed;
        } catch { /* malformed cache — ignore */ }
      }
    }

    const fetchDashboardList = async () => {
      try {
        const data = await apiClient.getDashboards();
        let dashboards = data.dashboards || [];

        if (kioskIds && kioskIds.length > 0) {
          // Kiosk mode: lock to the kiosk set in the kiosk order.
          // Both filter AND order come from the URL — the operator's
          // manifest wins over any saved user preference.
          const allowed = new Set(kioskIds);
          const filtered = dashboards.filter(d => allowed.has(d.id));
          // orderDashboardsForViewer({key:'manual'}) honors the
          // explicit tileOrder verbatim, which is what we want.
          if (!cancelled) {
            setDashboardList(
              orderDashboardsForViewer(filtered, kioskIds, { key: 'manual', direction: 'asc' }),
            );
          }
          return;
        }

        if (filteredIds && filteredIds.length > 0) {
          const allowed = new Set(filteredIds);
          dashboards = dashboards.filter(d => allowed.has(d.id));
        }
        let tileOrder = null;
        let tileSort = null;
        const userGuid = apiClient.getCurrentUserGuid();
        if (userGuid) {
          try {
            const config = await apiClient.getUserConfig(userGuid);
            const storedOrder = config?.settings?.dashboard_tile_order;
            tileOrder = Array.isArray(storedOrder) ? storedOrder : null;
            const storedSort = config?.settings?.dashboard_tile_sort;
            if (storedSort && typeof storedSort.key === 'string') {
              tileSort = storedSort;
            }
          } catch {
            // No user config yet — use the default sort.
          }
        }
        if (cancelled) return;
        setDashboardList(orderDashboardsForViewer(dashboards, tileOrder, tileSort));
      } catch (err) {
        console.warn('Failed to fetch dashboard list:', err);
      }
    };
    fetchDashboardList();

    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchDashboardList();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', fetchDashboardList);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', fetchDashboardList);
    };
  }, [location.state]);

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

  // Dashboard navigation helpers
  const currentDashboardIndex = useMemo(() => {
    return dashboardList.findIndex(d => d.id === id);
  }, [dashboardList, id]);

  const canGoPrev = currentDashboardIndex > 0;
  const canGoNext = currentDashboardIndex >= 0 && currentDashboardIndex < dashboardList.length - 1;

  const goToPrevDashboard = useCallback(() => {
    if (!canGoPrev) return;
    const prev = dashboardList[currentDashboardIndex - 1];
    navigate(`/view/dashboards/${prev.id}`);
  }, [canGoPrev, dashboardList, currentDashboardIndex, navigate]);

  const goToNextDashboard = useCallback(() => {
    if (!canGoNext) return;
    const next = dashboardList[currentDashboardIndex + 1];
    navigate(`/view/dashboards/${next.id}`);
  }, [canGoNext, dashboardList, currentDashboardIndex, navigate]);

  const goToDefaultDashboard = useCallback(() => {
    if (!defaultDashboardId || defaultDashboardId === id) return;
    navigate(`/view/dashboards/${defaultDashboardId}`);
  }, [defaultDashboardId, id, navigate]);

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
      navigate(`/view/dashboards/${next.id}`);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dashboardList, id, navigate, isEditMode, fromDesign]);

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

  // When the user navigates between dashboards, bump the refresh-tick so
  // POLLING charts re-issue their queries (they don't carry rolling
  // buffers, so a refetch is harmless). Streaming charts ignore the tick
  // and keep their warm grace-period subscription + buffered series, so
  // the user comes back to a chart that's already drawing instead of a
  // blank one. The tick is forwarded to ComponentPanelWithActions
  // → DynamicComponentLoader → useData, which calls refetch() in
  // response without remounting.
  const firstIdRef = useRef(true);
  useEffect(() => {
    if (firstIdRef.current) {
      firstIdRef.current = false;
      return;
    }
    setRefreshTick(t => t + 1);
    setLastRefresh(new Date());
  }, [id]);

  // Auto-enter edit mode when navigated from design mode (or new dashboard).
  // The latch stops a single autoEdit navigation from re-triggering on
  // unrelated re-renders; it is reset whenever edit mode is exited (below) so a
  // LATER autoEdit navigation (e.g. View→Design again on the same open
  // dashboard) can re-enter the editor.
  const autoEditTriggered = useRef(false);
  useEffect(() => {
    if (dashboard && !autoEditTriggered.current && (location.state?.autoEdit || isNewDashboard) && canDesign) {
      autoEditTriggered.current = true;
      enterEditMode();
    }
  }, [dashboard, location.state, isNewDashboard]);

  // Reset the auto-edit latch when we leave edit mode, so the next autoEdit
  // navigation re-fires. Without this, the latch stays armed after the first
  // View→Design→View round-trip and a second View→Design leaves the user stuck
  // in the viewer.
  useEffect(() => {
    if (!isEditMode) autoEditTriggered.current = false;
  }, [isEditMode]);

  // Switching View→Design with this dashboard already open navigates to the
  // SAME /view/dashboards/:id with { fromDesign: true } (App.handleModeChange).
  // The component is already mounted, so the mount-time initializers for
  // `fromDesign` / `cancelOrigin` don't re-run — sync them here when the flag
  // arrives, so the session behaves as design-originated (Cancel → design list).
  useEffect(() => {
    if (location.state?.fromDesign) {
      setFromDesign(true);
      cancelOrigin.current = true;
    }
  }, [location.state]);

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

  // Measure the REAL fullscreen viewport. If not already fullscreen,
  // request it first and measure once the browser has applied it
  // (fullscreenchange + a frame), since innerWidth/Height only reflect
  // the true usable area in fullscreen. Opens the result dialog.
  const measureScreenSize = async () => {
    const capture = () => {
      // Two rAFs so the fullscreen layout has settled before we read.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        setScreenMeasure({ w: window.innerWidth, h: window.innerHeight });
      }));
    };
    if (!document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
        // requestFullscreen resolves before the resize fully applies on
        // some browsers; wait for the next fullscreenchange to measure.
        const once = () => {
          document.removeEventListener('fullscreenchange', once);
          capture();
        };
        document.addEventListener('fullscreenchange', once);
      } catch {
        // Fullscreen denied/unavailable — measure the current viewport so
        // the user still gets a (less accurate) number rather than nothing.
        capture();
      }
    } else {
      capture();
    }
  };

  const handleManualRefresh = () => {
    // Trigger an out-of-band refetch on every polling chart by bumping
    // the refresh-tick. Polling charts watch the tick and call
    // useData's refetch() in response — no remount, no buffer loss.
    // Streaming charts ignore the tick (their data is already live and
    // a refetch would only blip the chart). We deliberately do NOT
    // re-fetch the dashboard record here — that would reload the panel
    // layout and config, which is unrelated to the user's intent (they
    // want fresh data, not a fresh layout). If the dashboard record
    // itself changed, the user should reload the page.
    setRefreshTick(t => t + 1);
    setLastRefresh(new Date());
  };

  const handleBack = () => {
    if (fromDesign) {
      navigate('/design/dashboards');
    } else {
      navigate('/view/dashboards');
    }
  };


  // Save thumbnail — captures the live grid at native resolution
  const [savingThumbnail, setSavingThumbnail] = useState(false);
  const [downloadingPng, setDownloadingPng] = useState(false);

  // Render the full dashboard grid to a PNG canvas via html2canvas at the
  // given scale (thumbnails use a small scale; the PNG download uses 1 for a
  // crisp full-res image). Temporarily neutralizes the fit-mode transform and
  // container clipping so the whole grid is captured, then restores them.
  const captureGridCanvas = async (scale) => {
    // Resolve by selector rather than gridRef/containerRef: in view mode the
    // grid now lives inside the shared <DashboardGrid> component (which doesn't
    // expose the page's refs), while in edit mode the page renders its own.
    // Either way there is exactly one .dashboard-grid on screen.
    const grid = document.querySelector('.dashboard-grid');
    const container = document.querySelector('.dashboard-grid-container');
    if (!grid || !container) return null;

    const origGridTransform = grid.style.transform;
    const origGridOrigin = grid.style.transformOrigin;
    const origContainerOverflow = container.style.overflow;

    try {
      grid.style.transform = 'none';
      grid.style.transformOrigin = '';
      container.style.overflow = 'visible';

      // Wait for paint
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const gridNativeW = maxGridCol * CELL_WIDTH + (maxGridCol - 1) * GAP;
      const gridNativeH = maxGridRow * CELL_HEIGHT + (maxGridRow - 1) * GAP;

      return await html2canvas(grid, {
        backgroundColor: '#161616',
        scale,
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
    } finally {
      // Always restore, even on error
      grid.style.transform = origGridTransform;
      grid.style.transformOrigin = origGridOrigin;
      container.style.overflow = origContainerOverflow;
    }
  };

  const saveThumbnail = async () => {
    setSavingThumbnail(true);
    try {
      const canvas = await captureGridCanvas(0.25);
      if (!canvas) return;
      const thumbnailDataUrl = canvas.toDataURL('image/png');
      await apiClient.updateDashboard(id, { ...dashboard, thumbnail: thumbnailDataUrl });
      fetchDashboard();
    } catch (err) {
      console.error('Failed to save thumbnail:', err);
    } finally {
      setSavingThumbnail(false);
    }
  };

  // Capture the dashboard grid at full resolution and trigger a browser
  // download as a PNG file named after the dashboard.
  const downloadPng = async () => {
    setDownloadingPng(true);
    try {
      const canvas = await captureGridCanvas(1);
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/png');
      const safeName = (dashboard?.name || 'dashboard')
        .trim()
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'dashboard';
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `${safeName}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Failed to download PNG:', err);
    } finally {
      setDownloadingPng(false);
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
    // Dashboard-variable authoring state. v1 carries a single variable (fixed
    // token); read whichever mode is defined and populate the matching fields.
    setEditableVariablesEnabled(!!dashboard?.settings?.variables_enabled);
    {
      const vars = dashboard?.settings?.variables || [];
      const v0 = vars.find((v) => v?.mode === 'filter') || vars.find((v) => v?.mode === 'connection_swap') || null;
      setEditableVariableMode(v0?.mode || 'connection_swap');
      setEditableVariableLabel(v0?.label || '');
      setEditableVariableTags(v0?.connection_swap?.tags || []);
      setEditableVariableSchemaStrict(v0?.connection_swap?.schema_strict || 'type_only');
      setEditableVariableSameNamespace(!!v0?.connection_swap?.same_namespace);
      setEditableVariableLabelTagPrefix(v0?.connection_swap?.label_tag_prefix || '');
      setEditableVariableValueSource(v0?.filter_value?.value_source || 'static');
      setEditableVariableOptions(v0?.filter_value?.options || []);
      setEditableVariableDefault(v0?.filter_value?.default_value || '');
    }
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
    // Use the stable origin, NOT the mutable fromDesign — a from-viewer
    // edit that was previously saved has fromDesign=true but should still
    // return to the viewer, not the design list.
    if (cancelOrigin.current) {
      navigate('/design/dashboards', { replace: true });
      return;
    }
    // Stay on this dashboard but drop out of edit mode (back to viewer).
    setIsEditMode(false);
    setEditHasChanges(false);
  };

  // VIEW button (design-mode editor): jump to the read-only viewer of the
  // dashboard being edited without leaving the page. View always lands on
  // the viewer in place; it never routes to the design list, because
  // "view what I'm editing" has one meaning regardless of origin.
  //
  //   - Clean → straight to viewer.
  //   - Dirty → the SAME three-option "Unsaved changes" dialog the header
  //     mode-switch uses (Keep Editing / Discard and switch / Save and
  //     switch). Pressing View isn't a cancel, so the user deserves the
  //     save path too. The dialog's handlers branch on viewNavMode to act
  //     in place (goToViewer) rather than resolving the header guard.
  const goToViewer = () => {
    setIsEditMode(false);
    setEditHasChanges(false);
  };

  const handleViewClick = () => {
    if (editHasChanges) {
      setViewNavMode(true);
      setModeSwitchPromptOpen(true);
      return;
    }
    goToViewer();
  };

  const handleDimensionChange = (newDimension) => {
    setCurrentDimension(newDimension);
    setEditHasChanges(true);
  };

  // Scale % is persisted in the dashboard record, so changing it marks
  // the dashboard dirty (same as a dimension/panel edit). Clamp 50–200.
  const handleScaleChange = (next) => {
    const v = Number(next);
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(200, Math.max(50, Math.round(v)));
    setScalePercent(clamped);
    setEditHasChanges(true);
  };

  // saveEditMode persists current edits and returns the resolved
  // dashboard ID (existing or freshly-minted for a new dashboard).
  // Callers that don't care can ignore the return; the mode-switch
  // guard uses it to land the post-switch route on the right id.
  // options.skipNavigate=true suppresses the post-create navigate so
  // a caller (the mode guard) can do its own navigation instead.
  const saveEditMode = async (options) => {
    // Validate-on-submit (Carbon pattern): Save stays enabled while dirty, but a
    // required empty Name blocks the save with an inline field error + focus,
    // rather than a silently-disabled button. The error clears as the user types
    // (see the name input's onChange).
    if (!editableName.trim()) {
      setNameError('Name is required');
      nameInputRef.current?.focus();
      return null;
    }
    setEditSaving(true);
    try {
      // Spread the existing settings first so removed-from-editor fields
      // (theme, is_public, allow_export, title_scale) round-trip
      // unchanged. We only overwrite the fields the user can actually
      // edit now.
      const updatedSettings = {
        ...dashboard.settings,
        layout_dimension: currentDimension,
        scale_percent: scalePercent,
        refresh_interval: editableRefreshInterval,
        variables_enabled: editableVariablesEnabled,
        // Persist the single variable (fixed token name) when the feature is
        // enabled; clear it otherwise so a disabled dashboard carries no stale
        // definition. The type-specific config block is keyed by the mode.
        variables: editableVariablesEnabled ? [
          editableVariableMode === 'filter'
            ? {
                name: 'dashboard-variable',
                label: editableVariableLabel || 'Filter',
                mode: 'filter',
                filter_value: {
                  value_source: editableVariableValueSource || 'static',
                  // Persist options for both 'static' (the list) and 'connection'
                  // (the fallback list). 'freetext' carries none.
                  options: (editableVariableValueSource === 'static' || editableVariableValueSource === 'connection')
                    ? (editableVariableOptions || [])
                    : [],
                  default_value: editableVariableDefault || '',
                },
              }
            : {
                name: 'dashboard-variable',
                label: editableVariableLabel || 'Variable',
                mode: 'connection_swap',
                connection_swap: {
                  tags: editableVariableTags || [],
                  schema_strict: editableVariableSchemaStrict || 'type_only',
                  same_namespace: editableVariableSameNamespace,
                  label_tag_prefix: (editableVariableLabelTagPrefix || '').trim(),
                },
              },
        ] : [],
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
        // Post-save framing depends on where the edit session began:
        //   - DESIGN origin (cancelOrigin) → show the finished dashboard
        //     as a single-dashboard design preview (no prev/next/home),
        //     so the designer reviews exactly what they built.
        //   - VIEW origin → return to normal VIEW mode with full viewer
        //     chrome restored. Leave fromDesign untouched (false) so the
        //     prev/next/home nav and viewer-list back-arrow come back.
        if (cancelOrigin.current) {
          setFromDesign(true);
        }
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
          cancelOrigin.current = false;
        }
        return Promise.resolve({ proceed: true, dashboardId: currentId });
      }
      return new Promise((resolve) => {
        modeSwitchResolveRef.current = resolve;
        modeSwitchTargetRef.current = newMode;
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
    // View-button path: save in place, then drop to the viewer. saveEditMode's
    // own post-save framing handles the rest (design-origin → single-dashboard
    // preview). No header guard to resolve.
    if (viewNavMode) {
      setViewNavMode(false);
      const ok = await saveEditMode();
      if (ok) goToViewer();
      return;
    }
    // Skip the post-save navigate inside saveEditMode — App.jsx is
    // about to handle the destination based on the new mode.
    const savedId = await saveEditMode({ skipNavigate: true });
    const resolver = modeSwitchResolveRef.current;
    modeSwitchResolveRef.current = null;
    const targetMode = modeSwitchTargetRef.current;
    modeSwitchTargetRef.current = null;
    if (!resolver) return;
    if (savedId) {
      // The switch is proceeding. Into VIEW ends the design workflow — clear
      // the design-origin flag so the session is view-originated after the
      // switch (mirrors the clean-path guard).
      if (targetMode === MODES.VIEW) {
        setFromDesign(false);
        cancelOrigin.current = false;
      }
      resolver({ proceed: true, dashboardId: savedId });
    } else {
      // Save failed (e.g., duplicate name). saveEditMode already
      // pushed an error notification — block the mode switch so the
      // user can fix the problem and try again. (Origin flags untouched —
      // the switch didn't happen.)
      resolver({ proceed: false });
    }
  };
  const modeSwitchDiscard = () => {
    setModeSwitchPromptOpen(false);
    // View-button path: discard edits and drop to the viewer in place.
    if (viewNavMode) {
      setViewNavMode(false);
      goToViewer();
      return;
    }
    setIsEditMode(false);
    setEditHasChanges(false);
    const resolver = modeSwitchResolveRef.current;
    modeSwitchResolveRef.current = null;
    // Proceeding into VIEW ends the design workflow — clear the design-origin
    // flag so the session is view-originated after the switch.
    const targetMode = modeSwitchTargetRef.current;
    modeSwitchTargetRef.current = null;
    if (targetMode === MODES.VIEW) {
      setFromDesign(false);
      cancelOrigin.current = false;
    }
    // New unsaved dashboards have no id to land on; existing ones
    // keep theirs. App.jsx falls back to default when dashboardId is
    // null/undefined.
    const currentId = isNewDashboard ? null : id;
    if (resolver) resolver({ proceed: true, dashboardId: currentId });
  };
  const modeSwitchStay = () => {
    setModeSwitchPromptOpen(false);
    // View-button path: just close the dialog, stay in the editor.
    if (viewNavMode) {
      setViewNavMode(false);
      return;
    }
    const resolver = modeSwitchResolveRef.current;
    modeSwitchResolveRef.current = null;
    modeSwitchTargetRef.current = null; // switch cancelled — leave origin flags as-is
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
      component_id: null,
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
    if (!panel.component_id) return getComponentMinSize('default');
    const chart = chartsMap[panel.component_id];
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
      setEditingChart(panel?.component_id ? chartsMap[panel.component_id] : null);
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
    // the component editor. Only swapping the panel's component_id (e.g.
    // converting a placeholder to a saved component) or growing the panel
    // to satisfy a new min-size is a genuine dashboard mutation.
    const subtype = chartInfo.control_config?.control_type || chartInfo.display_config?.display_type || chartInfo.chart_type;
    const minSize = getComponentMinSize(subtype);
    let panelChanged = false;
    setEditablePanels(prev => prev.map(p => {
      if (p.id !== panel_id) return p;
      const newW = Math.max(p.w, Math.min(minSize.w, maxGridCol - p.x));
      const newH = Math.max(p.h, minSize.h);
      const idChanged = p.component_id !== chartInfo.id;
      const sizeChanged = newW !== p.w || newH !== p.h;
      if (!idChanged && !sizeChanged) return p;
      panelChanged = true;
      return { ...p, component_id: chartInfo.id, w: newW, h: newH };
    }));
    if (panelChanged) {
      setEditHasChanges(true);
    }
  };

  const openAIEditor = (panelId) => {
    const panel = editablePanels.find(p => p.id === panelId);
    const chartId = panel?.component_id;
    if (chartId) {
      navigate(`/design/components/ai/${chartId}`, {
        state: { from: `/view/dashboards/${id}`, dashboardId: id, panelId }
      });
    }

  };

  // ── Text panel helpers ────────────────────────────────────────────
  // Convert a panel into a text panel (default config) and open the editor
  // modal on it. The modal edits a draft and commits on Apply (dirtying the
  // dashboard), same as the Settings/Variables modals.
  const setTextPanel = (panelId) => {
    updateEditablePanel(panelId, {
      component_id: null,
      text_config: { content: '', display_content: 'title', size: 20, align: 'center' },
    });
    setTextEditorPanelId(panelId);
  };

  const openTextEditor = (panelId) => {
    setTextEditorPanelId(panelId);
  };

  // Apply: commit the modal's draft config to the panel (marks dirty).
  const handleTextConfigApply = (textConfig) => {
    if (textEditorPanelId) updateEditablePanel(textEditorPanelId, { text_config: textConfig });
  };

  const closeTextEditor = () => {
    setTextEditorPanelId(null);
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
      return { ...p, component_id: component.id, w: newW, h: newH };
    }));
    setEditHasChanges(true);
    closeComponentPicker();
  };

  const openAIPreflightModal = (panelId) => {
    updateEditablePanel(panelId, { component_id: null });
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
    <RefreshableComponentsProvider>
    <div className={`dashboard-viewer-page ${isFullscreen ? 'fullscreen' : ''} ${isEditMode ? 'edit-mode-active' : ''}`}>
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
                  ref={nameInputRef}
                  className={`dashboard-name-input ${nameError ? 'has-error' : ''}`}
                  type="text"
                  value={editableName}
                  placeholder="Dashboard name (required)"
                  aria-label="Dashboard name"
                  aria-required="true"
                  aria-invalid={!!nameError}
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
            {/* Variables editor trigger — hugs the name in edit mode. Styled
                like the Cancel button (secondary) for consistency with the
                edit-mode action cluster + the Settings gear. */}
            {isEditMode && dashboardVariableEnabled && (
              <Button
                kind="secondary"
                size="sm"
                className="variables-button"
                onClick={() => setVarsModalOpen(true)}
              >
                Variables
              </Button>
            )}
            {/* Dashboard-variable picker (connection-swap). Renders only in
                view mode when the feature is active for this dashboard. */}
            {!isEditMode && dashVariable && (() => {
              const items = (dashVariableCandidates || []).filter((c) => c.compatible);
              const selected = items.find((c) => c.id === dashVariableValue) || null;
              // Optional: label each candidate from a prefixed tag (e.g. a
              // "host:trv-srv-001" tag → "trv-srv-001"), falling back to name.
              const labelPrefix = dashVariable.connection_swap?.label_tag_prefix || '';
              return (
                <div className="dashboard-variable-picker">
                  <Dropdown
                    id="dashboard-variable-picker"
                    size="sm"
                    titleText={dashVariable.label || 'Variable'}
                    label={`${dashVariable.label || 'Variable'}: select…`}
                    items={items}
                    itemToString={(item) => candidateLabel(item, labelPrefix)}
                    selectedItem={selected}
                    onChange={({ selectedItem }) => setDashVariableValue(selectedItem?.id || null)}
                  />
                </div>
              );
            })()}

            {/* Filter-type variable picker. A value the viewer chooses that is
                substituted server-side into the query ({{dashboard-variable}})
                and client-side into filters. Static options → Dropdown;
                freetext → TextInput. Coexists with the connection picker. */}
            {!isEditMode && dashFilterVariable && (() => {
              const cfg = dashFilterVariable.filter_value || {};
              const label = dashFilterVariable.label || 'Filter';
              if (cfg.value_source === 'freetext') {
                return (
                  <div className="dashboard-variable-picker">
                    <TextInput
                      id="dashboard-filter-variable"
                      size="sm"
                      labelText={label}
                      placeholder="Enter a value…"
                      value={dashFilterValue || ''}
                      onChange={(e) => setDashFilterValue(e.target.value)}
                    />
                  </div>
                );
              }
              // 'static' → the authored list; 'connection' → discovered values
              // (server-side for SQL/API, stored list for stream/socket; session
              // override wins), falling back to the static list (seed) on
              // failure/empty.
              const staticOptions = Array.isArray(cfg.options) ? cfg.options : [];
              const options = cfg.value_source === 'connection'
                ? (effectiveDiscoveredOptions ?? staticOptions)
                : staticOptions;
              const selectedOpt = options.includes(dashFilterValue) ? dashFilterValue : null;
              const loading = cfg.value_source === 'connection' && discoveryLoading;
              // Stream/socket variables store their list; offer a session-only
              // "regenerate" (live re-capture) since the stored list can go
              // stale or have been stopped too early. Not persisted (a designer
              // makes it permanent via the editor).
              const showRegenerate = cfg.value_source === 'connection' && discoveryIsStream;
              return (
                <div className="dashboard-variable-picker" ref={filterDropdownRef}>
                  <Dropdown
                    id="dashboard-filter-variable"
                    size="sm"
                    titleText={label}
                    label={loading ? 'Loading…' : `${label}: select…`}
                    items={options}
                    disabled={loading || regenerating}
                    itemToString={(item) => (item == null ? '' : String(item))}
                    selectedItem={selectedOpt}
                    onChange={({ selectedItem }) => setDashFilterValue(selectedItem ?? null)}
                  />
                  {/* Regenerate (live re-capture) opens a modal that accumulates
                      the distinct values in real time with a Stop button. Only
                      for raw socket/mqtt variables (stored list); tsstore/API/SQL
                      re-discover on load. */}
                  {showRegenerate && (
                    <Button
                      kind="ghost"
                      size="sm"
                      hasIconOnly
                      renderIcon={Renew}
                      iconDescription="Refresh values (live capture, this session)"
                      onClick={startSessionRegenerate}
                      disabled={regenerating}
                    />
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        <div className="toolbar-center">
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
                    text={dim.name}
                  />
                ))}
              </Select>
            </div>
          )}
          {isEditMode && layoutDimension && (
            <div className="scale-controls">
              <Tooltip
                align="bottom"
                label="Builds the dashboard bigger for large displays. You design at this scale directly: 100% = actual size; higher % makes every component's text, lines, and layout render uniformly larger (proportions are preserved). Distinct from the Zoom control, which only magnifies your editing view and isn't saved."
              >
                <span className="scale-label scale-label--tooltip">Scale</span>
              </Tooltip>
              <NumberInput
                id="viewer-scale-percent"
                size="sm"
                hideLabel
                label="Scale %"
                min={50}
                max={200}
                step={5}
                value={scalePercent}
                onChange={(e, { value }) => handleScaleChange(value ?? e?.target?.value)}
              />
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
              {/* Live zoom % readout. Click to reset to 100% (keeps that
                  affordance now that the dropdown is gone). */}
              <button
                type="button"
                className="zoom-pct"
                onClick={zoomReset}
                title="Reset to 100%"
              >
                {zoom}%
              </button>
              <IconButton
                kind="ghost"
                size="sm"
                label="Zoom to fit"
                align="bottom"
                onClick={zoomToFit}
              >
                <FitToScreen size={16} />
              </IconButton>
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
          {/* "Unsaved changes" pill removed — the Save button turning primary
              (blue) on dirty + the navigation/cancel guards convey this. */}
        </div>

        <div className="toolbar-right">
          {isEditMode ? (
            <>
              {/* View jumps to the read-only viewer of the dashboard
                  being edited (drops edit mode in place). Shown for both
                  DESIGN- and VIEW-originated edits for consistency — in
                  either case it lands on the viewer of the dashboard you're
                  editing. Hidden only for new dashboards, which have no
                  saved record to view yet. */}
              {!isNewDashboard && (
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={handleViewClick}
                  renderIcon={View}
                >
                  View
                </Button>
              )}
              <Button
                kind="secondary"
                size="sm"
                onClick={exitEditMode}
                renderIcon={Close}
              >
                Cancel
              </Button>
              <Button
                kind="primary"
                size="sm"
                onClick={saveEditMode}
                disabled={!editHasChanges || editSaving}
                renderIcon={Save}
              >
                {editSaving ? 'Saving...' : 'Save'}
              </Button>
              {/* Settings sits in its own group, separated from the
                  View/Cancel/Save action cluster by a Carbon divider and
                  given a bordered (secondary) hit target so it reads as a
                  distinct toolbar action rather than floating ghost icon. */}
              <span className="edit-toolbar-divider" aria-hidden="true" />
              <IconButton
                className="edit-toolbar-settings"
                kind="secondary"
                size="sm"
                label="Dashboard settings"
                // bottom-end: this sits near the right edge of the header, so
                // a centered (plain "bottom") tooltip overhangs the right side
                // of the screen. Anchor it right so it opens leftward.
                align="bottom-end"
                onClick={() => setSettingsModalOpen(true)}
              >
                <Settings size={20} />
              </IconButton>
            </>
          ) : (
            <>
              {/* Dashboard nav (prev / home / next) sits just before the
                  right-side control group, separated by a vertical divider.
                  Moved out of toolbar-center to free up the center for the
                  dashboard name + variable pickers. */}
              {!fromDesign && dashboardList.length > 1 && (
                <>
                  <div className="dashboard-nav-buttons">
                    <IconButton
                      kind="ghost"
                      size="sm"
                      label={`Previous dashboard  ${ALT_KEY_LABEL} ←`}
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
                      label={`Next dashboard  ${ALT_KEY_LABEL} →`}
                      align="bottom"
                      onClick={goToNextDashboard}
                      disabled={!canGoNext}
                    >
                      <ChevronRight size={20} />
                    </IconButton>
                  </div>
                  <span className="toolbar-divider" aria-hidden="true" />
                </>
              )}
              {/* Refresh section: [Data refresh pill][Last refresh][refresh
                  icon] grouped together. (Slated to be replaced by a single
                  compressed control.) */}
              {dashboard?.settings?.refresh_interval > 0 && (
                <RefreshIntervalPill intervalSec={dashboard.settings.refresh_interval} />
              )}
              <RefreshControls
                lastRefresh={lastRefresh}
                loading={loading}
                onRefresh={handleManualRefresh}
              />
              {/* Design workflow: a prominent ghost Edit button (mirror of the
                  editor's ghost View button) to jump back into the editor, sitting
                  to the RIGHT of the refresh section. Plain viewers get Edit in
                  the overflow menu instead. */}
              {fromDesign && canDesign && (
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={enterEditMode}
                  renderIcon={Edit}
                >
                  Edit
                </Button>
              )}
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
              {/* Notifications bell — only rendered in fullscreen,
                  because outside fullscreen the App-level header
                  already shows one and double-rendering would be
                  confusing. In fullscreen the App header is hidden
                  but the panel itself (mounted in App) still
                  overlays the viewer, so we just need a trigger. */}
              {isFullscreen && (
                <IconButton
                  kind="ghost"
                  label="Notifications"
                  align="bottom"
                  onClick={toggleNotificationPanel}
                  className="notification-badge"
                >
                  <Notification size={20} />
                  {notifications.length > 0 && (
                    <span className="notification-badge__count">
                      {notifications.length > 99 ? '99+' : notifications.length}
                    </span>
                  )}
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
                // FIXED trigger icon — it just opens the fit-mode menu.
                // We do NOT swap renderIcon per mode: Carbon caches the
                // trigger icon component and won't reliably re-render it,
                // so a per-mode icon kept showing the wrong glyph. The
                // ACTIVE mode is conveyed by the ✓ on the menu items
                // below instead. iconDescription names the current mode
                // for the tooltip/aria so it's still discoverable.
                size="lg"
                renderIcon={FitModeWindowIcon}
                iconDescription={
                  (fitMode === 'window' ? 'Fit to window'
                  : fitMode === 'width' ? 'Fit to width'
                  : fitMode === 'stretch' ? 'Stretch to fill'
                  : 'Actual size') + ' — change view fit'
                }
                // align="bottom" puts the iconDescription tooltip BELOW the
                // trigger, matching the surrounding IconButtons. Without it
                // Carbon's OverflowMenu defaults to a side (right) tooltip.
                align="bottom"
                flipped
                direction="bottom"
                className="fit-mode-menu"
              >
                <OverflowMenuItem
                  itemText={
                    <span className="fit-mode-item">
                      <span className="fit-mode-check">{fitMode === 'actual' ? '✓' : ''}</span>
                      Actual size
                    </span>
                  }
                  onClick={() => selectFitMode('actual')}
                  isDelete={false}
                />
                <OverflowMenuItem
                  itemText={
                    <span className="fit-mode-item">
                      <span className="fit-mode-check">{fitMode === 'window' ? '✓' : ''}</span>
                      Fit to window
                    </span>
                  }
                  onClick={() => selectFitMode('window')}
                />
                <OverflowMenuItem
                  itemText={
                    <span className="fit-mode-item">
                      <span className="fit-mode-check">{fitMode === 'width' ? '✓' : ''}</span>
                      Fit to width
                    </span>
                  }
                  onClick={() => selectFitMode('width')}
                />
                <OverflowMenuItem
                  itemText={
                    <span className="fit-mode-item fit-mode-item-with-info">
                      <span className="fit-mode-check">{fitMode === 'stretch' ? '✓' : ''}</span>
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
              <OverflowMenu
                renderIcon={() => <OverflowMenuVertical size={20} />}
                flipped
                direction="bottom"
                // bottom-end: this is the last icon on the right edge of the
                // header, so a centered ("bottom") tooltip overhangs the edge.
                // Anchor it right so the tooltip opens leftward. (Matches the
                // Dashboard-settings gear's reasoning.)
                align="bottom-end"
                iconDescription="Dashboard actions"
              >
                {/* Edit lives in the overflow for PLAIN viewers (reclaims
                    header space). In the design workflow (fromDesign) a
                    prominent ghost Edit button is shown instead — see above. */}
                {canDesign && !fromDesign && (
                  <OverflowMenuItem
                    itemText="Edit"
                    onClick={enterEditMode}
                  />
                )}
                {canDesign && (
                  <OverflowMenuItem
                    itemText={savingThumbnail ? "Saving..." : "Save Thumbnail"}
                    onClick={saveThumbnail}
                    disabled={savingThumbnail}
                  />
                )}
                {/* Download PNG — DISABLED pending capture-quality fixes.
                    html2canvas mangles letter-spacing in text panels and
                    occasionally drops a chart panel (e.g. temperatures). The
                    downloadPng/captureGridCanvas code is kept; flip
                    PNG_DOWNLOAD_ENABLED to re-enable once capture is faithful.
                    See dashboard-png-download-todo. */}
                {PNG_DOWNLOAD_ENABLED && (
                  <OverflowMenuItem
                    itemText={downloadingPng ? "Downloading…" : "Download PNG"}
                    onClick={downloadPng}
                    disabled={downloadingPng}
                  />
                )}
                {canDesign && (
                  <OverflowMenuItem
                    itemText="Measure screen size…"
                    onClick={measureScreenSize}
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

      {/* Dashboard grid. View mode delegates to the shared presentational
          <DashboardGrid> (also used by the kiosk surface); edit mode keeps its
          own inline grid with drag/resize/hover chrome below. */}
      {!isEditMode && panels && panels.length > 0 ? (
        <DashboardGrid
          panels={panels}
          chartsMap={chartsMap}
          dashboard={dashboard}
          resolveConnectionId={resolveConnectionId}
          dashboardVariableText={dashboardVariableText}
          variableValues={variableValues}
          dashboardVariableValue={dashFilterValue}
          dashboardCommand={dashboardCommand}
          canControl={canControl}
          refreshTick={refreshTick}
          fitMode={fitMode}
          scalePercent={scalePercent}
          isFullscreen={isFullscreen}
          onExpandPanel={setExpandedPanelId}
        />
      ) : isEditMode ? (
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
            style={{
              // Reserve the post-transform size whenever there IS one — now
              // includes "actual" at scale>100% (scaledW>0 there), so the
              // scaled-up content scrolls correctly. At 100% actual,
              // scaledW is 0 → no reserved size, native flow as before.
              ...(!isEditMode && fitTransform.scaledW > 0
                ? { width: fitTransform.scaledW, height: fitTransform.scaledH }
                : {}),
              // Edit-mode manual ZOOM lives HERE (wrapper level) so it scales
              // EVERYTHING in the scene — the grid AND the target (blue)
              // boundary line that sits in this wrapper. Zoom = "magnify the
              // whole view to see it." The build/display toggle's scaleFactor
              // is applied on the inner .dashboard-grid only (below), so the
              // blue line stays fixed for the toggle (content grows to meet
              // it) but DOES scale with zoom.
              ...(isEditMode && zoom !== 100 ? {
                transform: `scale(${zoom / 100})`,
                transformOrigin: 'top left'
              } : {})
            }}
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
              // Edit mode: ALWAYS design at the display (scaled) size — the
              // content is scaled by scaleFactor so what you place is what
              // renders (100% = actual size). No build-vs-display toggle.
              // The manual zoom (wrapper above) is a separate view magnifier.
              ...(isEditMode && scaleFactor !== 1 ? {
                transform: `scale(${scaleFactor})`,
                transformOrigin: 'top left'
              } : {})
            }}
          >
            {panels.map((panel) => {
              const chart = panel.component_id ? chartsMap[panel.component_id] : null;
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
                        {/* Custom-code indicator: the panel's component renders
                            from hand-written component_code, not the config form.
                            Non-interactive marker (title tooltip on hover). */}
                        {chart?.use_custom_code && (
                          <span
                            className="panel-custom-code-indicator"
                            title="This component uses custom code"
                            aria-label="Uses custom code"
                          >
                            <Code size={14} />
                          </span>
                        )}
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
                                if (hasChart) updateEditablePanel(panel.id, { component_id: null, text_config: null });
                                openComponentEditor(panel.id, null);
                              }}
                              onNewWithAI={() => openAIPreflightModal(panel.id)}
                              onSelectExisting={() => openComponentPicker(panel.id, 'all')}
                              onText={() => setTextPanel(panel.id)}
                              showPinOption={!!dashVariable && hasChart}
                              pinned={!!panel.pin_connection}
                              onTogglePin={() => updateEditablePanel(panel.id, { pin_connection: !panel.pin_connection })}
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
                      <PanelText config={panel.text_config} dashboardVariableText={dashboardVariableText} variableValues={variableValues} />
                    </div>
                  ) : hasChart ? (
                    <>
                      {chart.component_type === 'control' ? (
                        <div className="component-wrapper control-wrapper" onDoubleClick={(e) => e.stopPropagation()}>
                          <ControlRenderer control={chart} canControl={canControl} />
                        </div>
                      ) : chart.component_type === 'display' ? (
                        <div className="component-wrapper display-wrapper">
                          {chart.display_config?.display_type === 'weather' ? (
                            <WeatherDisplay config={chart.display_config} />
                          ) : chart.display_config?.display_type === 'frigate_camera' ? (
                            <FrigateCameraViewer config={chart.display_config} dashboardCommand={dashboardCommand} />
                          ) : chart.display_config?.display_type === 'frigate_alerts' ? (
                            <FrigateAlertsGrid config={chart.display_config} dashboardCommand={dashboardCommand} canControl={canControl} refreshTick={refreshTick} />
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
                          {/* has-title → a title band actually renders at the
                              top (datatable's external header, or the
                              ChartShell/DataViewGrid 2.5rem title when showTitle
                              isn't disabled AND there's a title/name). When set,
                              the SCSS drops the wrapper's TOP padding so the band
                              sits flush — reclaiming the otherwise-wasted top
                              margin. When NOT set (title off), the top inset
                              stays so the hover action icons don't land on the
                              plot. */}
                          <div className={`component-wrapper ${chart.chart_type === 'datatable' ? 'with-header' : ''} ${chart.chart_type === 'dataview' ? 'dataview-wrapper' : ''} ${(chart.chart_type === 'datatable' || (chart.options?.showTitle !== false && (chart.title || chart.name))) ? 'has-title' : ''}`}>
                            <ComponentPanelWithActions
                              // Key includes chart.updated so a config-refresh poll
                              // that picks up a server-side chart edit forces this
                              // panel to remount and the DynamicComponentLoader to
                              // re-eval the new component_code. Note: refreshTick
                              // is intentionally NOT in the key — it triggers an
                              // out-of-band refetch via useData without remounting
                              // (preserves streaming buffers + dynamic state).
                              key={`${panel.component_id}-${chart.updated || ''}`}
                              chart={chart}
                              loaderProps={{
                                code: chart.component_code,
                                props: {},
                                componentMeta: chart,
                                dataMapping: chart.data_mapping,
                                // Dashboard-variable connection-swap: override the
                                // component's design-time connection when the feature
                                // is active, the component opts in, and a value is
                                // selected. Otherwise returns chart.connection_id.
                                connectionId: resolveConnectionId(chart, panel),
                                queryConfig: chart.query_config,
                                // Edit-mode preview reuses the dashboard's
                                // resolved variable value (the hook seeds it
                                // URL → saved userConfig → default_value), so
                                // variable-driven panels render instead of
                                // failing on an unsubstituted token.
                                dashboardVariableValue: dashFilterValue,
                                dataRefreshInterval: !isEditMode && dashboard?.settings?.refresh_interval > 0 ? dashboard.settings.refresh_interval * 1000 : null,
                                refreshTick,
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

            {/* CANVAS boundary — the single edge of the design grid. It
                lives INSIDE the always-scaled .dashboard-grid, so at
                scale>100% it renders at the display extent automatically,
                marking exactly where the dashboard ends at the scale
                you're designing at. (We design at display size directly,
                so there's no separate target line.) */}
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
      <PanelTextModal
        open={!!textEditorPanelId}
        config={editablePanels.find((p) => p.id === textEditorPanelId)?.text_config}
        onApply={handleTextConfigApply}
        onClose={closeTextEditor}
        variables={definedVariables}
        variableValues={variableValues}
      />

      {/* Live value-capture modal for a raw socket/mqtt variable Regenerate.
          Shows the distinct values accumulating in real time with a Stop button;
          Stop commits the list (session-only) and closes — the dropdown then
          auto-opens. No selection inside the modal (the dashboard's pick UI is
          the dropdown). */}
      <VariableValuePickerModal
        open={regenModalOpen}
        onClose={stopSessionRegenerate}
        onSelect={() => {}}
        connectionId={discoveryTarget?.connId}
        providedValues={regenLiveValues}
        providedLoading={regenerating}
        providedPartial
        onStop={stopSessionRegenerate}
        captureOnly
      />

      {/* Dashboard settings modal */}
      <DashboardExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        dashboardIds={dashboard?.id ? [dashboard.id] : []}
        dashboards={dashboard ? [dashboard] : []}
      />
      {expandedPanelId && (() => {
        const expandedPanel = panels.find(p => p.id === expandedPanelId);
        const rawExpandedChart = expandedPanel?.component_id ? chartsMap[expandedPanel.component_id] : null;
        if (!rawExpandedChart) return null;
        // Apply the dashboard-variable connection-swap to the expanded chart too,
        // so an expanded panel reads from the selected connection like the grid.
        const resolvedConnId = resolveConnectionId(rawExpandedChart, expandedPanel);
        const expandedChart = resolvedConnId === rawExpandedChart.connection_id
          ? rawExpandedChart
          : { ...rawExpandedChart, connection_id: resolvedConnId };
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
          // Commit the draft into the live editable* state on Apply.
          if (settingsDraft) {
            setEditableDescription(settingsDraft.description);
            setEditableNamespace(settingsDraft.namespace);
            setEditableTags(settingsDraft.tags);
            setEditableRefreshInterval(settingsDraft.refreshInterval);
            setEditHasChanges(true);
          }
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
            value={settingsDraft?.description ?? ''}
            onChange={(e) => setSettingsDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder="Enter dashboard description"
          />
          <NamespaceSelect
            id="settings-namespace"
            value={settingsDraft?.namespace ?? ''}
            onChange={(v) => setSettingsDraft((d) => ({ ...d, namespace: v }))}
          />
          <TagInput
            id="settings-tags"
            label="Tags"
            value={settingsDraft?.tags ?? []}
            onChange={(t) => setSettingsDraft((d) => ({ ...d, tags: t }))}
          />
          <NumberInput
            id="settings-refresh"
            label="Auto Refresh (seconds)"
            value={settingsDraft?.refreshInterval ?? 30}
            onChange={(e, { value }) => setSettingsDraft((d) => ({ ...d, refreshInterval: value }))}
            min={0}
            max={3600}
            step={5}
            helperText="Polling pauses while the browser tab is hidden. Set to 0 to disable auto refresh entirely."
          />
          {/* Dashboard-variable editing moved to its own "Variables" modal,
              triggered from the toolbar between the name and the dimension
              selector. */}
        </div>
      </Modal>

      {/* Dashboard Variables editor — moved out of the general Settings form
          into its own modal (triggered by the toolbar "Vars" button). Edits the
          same editableVariable* state; like Settings, Apply just commits the
          dirty flag and the values persist with the main edit-mode Save. */}
      <Modal
        open={varsModalOpen}
        onRequestClose={() => setVarsModalOpen(false)}
        onRequestSubmit={() => {
          // Commit the draft into the live editable* state on Apply.
          if (varsDraft) {
            setEditableVariablesEnabled(varsDraft.enabled);
            setEditableVariableMode(varsDraft.mode);
            setEditableVariableLabel(varsDraft.label);
            setEditableVariableTags(varsDraft.tags);
            setEditableVariableSchemaStrict(varsDraft.schemaStrict);
            setEditableVariableSameNamespace(varsDraft.sameNamespace);
            setEditableVariableLabelTagPrefix(varsDraft.labelTagPrefix);
            setEditableVariableValueSource(varsDraft.valueSource);
            setEditableVariableOptions(varsDraft.options);
            setEditableVariableDefault(varsDraft.defaultValue);
            setEditHasChanges(true);
          }
          setVarsModalOpen(false);
        }}
        modalHeading="Dashboard Variables"
        primaryButtonText="Apply"
        secondaryButtonText="Cancel"
        size="sm"
      >
        <div className="dashboard-variable-settings">
          <Toggle
            id="settings-variable-enabled"
            size="sm"
            labelText="Dashboard Variable"
            labelA="Off"
            labelB="On"
            toggled={!!varsDraft?.enabled}
            onToggle={(checked) => setVarsDraft((d) => ({ ...d, enabled: checked }))}
          />
          {varsDraft?.enabled && (
            <>
              <Select
                id="settings-variable-mode"
                labelText="Variable type"
                value={varsDraft?.mode ?? 'connection_swap'}
                onChange={(e) => setVarsDraft((d) => ({ ...d, mode: e.target.value }))}
                helperText="What the variable drives, and how the header surfaces it."
              >
                <SelectItem value="connection_swap" text="Connection — repoint panels to a chosen connection" />
                <SelectItem value="filter" text="Filter value — substitute a value into queries/filters" />
              </Select>
              <TextInput
                id="settings-variable-label"
                labelText="Variable label"
                value={varsDraft?.label ?? ''}
                onChange={(e) => setVarsDraft((d) => ({ ...d, label: e.target.value }))}
                placeholder={varsDraft?.mode === 'filter' ? 'e.g. Host' : 'e.g. Site'}
                helperText="Shown next to the dashboard name in the header control."
              />

              {varsDraft?.mode === 'connection_swap' && (
                <>
                  <TagInput
                    id="settings-variable-tags"
                    label="Connection tags"
                    value={varsDraft?.tags ?? []}
                    onChange={(t) => setVarsDraft((d) => ({ ...d, tags: t }))}
                  />
                  <Select
                    id="settings-variable-schema-strict"
                    labelText="Compatibility check"
                    value={varsDraft?.schemaStrict ?? 'type_only'}
                    onChange={(e) => setVarsDraft((d) => ({ ...d, schemaStrict: e.target.value }))}
                    helperText="How strictly candidate connections must match. Type only is recommended (one store per site)."
                  >
                    <SelectItem value="type_only" text="Type only (recommended)" />
                    <SelectItem value="superset" text="Columns: superset of reference" />
                    <SelectItem value="exact" text="Columns: exact match" />
                  </Select>
                  <Toggle
                    id="settings-variable-same-namespace"
                    size="sm"
                    labelText="Same namespace only"
                    labelA="Off (any namespace)"
                    labelB="On"
                    toggled={!!varsDraft?.sameNamespace}
                    onToggle={(checked) => setVarsDraft((d) => ({ ...d, sameNamespace: checked }))}
                  />
                  <TextInput
                    id="settings-variable-label-tag-prefix"
                    labelText="Label tag prefix (optional)"
                    value={varsDraft?.labelTagPrefix ?? ''}
                    onChange={(e) => setVarsDraft((d) => ({ ...d, labelTagPrefix: e.target.value }))}
                    placeholder="e.g. host"
                    helperText="Show a connection's tag value in the dropdown instead of its name: prefix &quot;host&quot; shows &quot;trv-srv-001&quot; from a &quot;host:trv-srv-001&quot; tag. Falls back to the connection name when no matching tag."
                  />
                </>
              )}

              {varsDraft?.mode === 'filter' && (
                <>
                  <Select
                    id="settings-variable-value-source"
                    labelText="Value source"
                    value={varsDraft?.valueSource ?? 'static'}
                    onChange={(e) => setVarsDraft((d) => ({ ...d, valueSource: e.target.value }))}
                    helperText="Where the header gets the value. Use the {{dashboard-variable}} token in a component's query or filter to consume it."
                  >
                    <SelectItem value="static" text="Pick from a list" />
                    <SelectItem value="freetext" text="Type a value (free text)" />
                    <SelectItem value="connection" text="From connection (live)" />
                  </Select>
                  {varsDraft?.valueSource === 'connection' && (
                    <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-helper)', margin: '0' }}>
                      Options are discovered live from the variable-driven component&apos;s
                      connection at view time. The static list below (optional) is used as a
                      fallback if discovery fails.
                    </p>
                  )}
                  {/* Static options: the explicit list for "static", and the
                      optional fallback list for "connection". */}
                  {(varsDraft?.valueSource === 'static' || varsDraft?.valueSource === 'connection') && (
                    <TagInput
                      id="settings-variable-options"
                      label={varsDraft?.valueSource === 'connection' ? 'Fallback options (optional)' : 'Options'}
                      value={varsDraft?.options ?? []}
                      onChange={(o) => setVarsDraft((d) => ({ ...d, options: o }))}
                    />
                  )}
                  <TextInput
                    id="settings-variable-default"
                    labelText="Default value (optional)"
                    value={varsDraft?.defaultValue ?? ''}
                    onChange={(e) => setVarsDraft((d) => ({ ...d, defaultValue: e.target.value }))}
                    placeholder="Pre-selected on first load"
                  />
                </>
              )}
            </>
          )}
        </div>
      </Modal>

      {/* Discard changes confirmation */}
      <DiscardChangesModal
        open={showDiscardModal}
        onKeepEditing={() => setShowDiscardModal(false)}
        onDiscard={confirmDiscard}
        body="You have unsaved layout changes. Are you sure you want to discard them?"
      />

      {/* Measure-screen-size helper result. Reports the REAL fullscreen
          viewport so an admin can correct a layout-dimension preset's
          geometry (the published name overstates usable space because the
          OS reserves the top). Read-only here; the preset edit lives in
          Manage → Settings → Layout Dimensions. */}
      {screenMeasure && (
        <Modal
          open
          modalHeading="Measured screen size"
          passiveModal
          onRequestClose={() => setScreenMeasure(null)}
          size="sm"
        >
          <p style={{ marginBottom: '1rem' }}>
            Actual usable fullscreen area on this display:
          </p>
          <div style={{ display: 'flex', gap: '2rem', marginBottom: '1rem' }}>
            <div>
              <div style={{ color: 'var(--cds-text-secondary)', fontSize: '0.75rem' }}>Max Width</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{screenMeasure.w}</div>
            </div>
            <div>
              <div style={{ color: 'var(--cds-text-secondary)', fontSize: '0.75rem' }}>Max Height</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{screenMeasure.h}</div>
            </div>
          </div>
          <p style={{ color: 'var(--cds-text-secondary)', fontSize: '0.875rem' }}>
            The published resolution (e.g. 2560×1440) overstates this — the OS
            reserves space at the top (menu bar / notch / window chrome). To make
            a dashboard fill this screen, note these numbers and set the matching
            layout-dimension preset to this Max Width and Max Height in Manage →
            Settings → Layout Dimensions (keep its published name; just fix the
            numbers). Requires Manage capability.
          </p>
        </Modal>
      )}

      {/* Mode-switch interception: three options so "cancel" can't be
          misread as either "abandon edits" or "abandon the mode switch". */}
      {modeSwitchPromptOpen && (
        <ComposedModal
          open={modeSwitchPromptOpen}
          onClose={() => { modeSwitchStay(); return true; }}
          size="sm"
        >
          <ModalHeader
            title="Unsaved changes"
            closeModal={modeSwitchStay}
            buttonOnClick={modeSwitchStay}
          />
          <ModalBody>
            <p>This dashboard has unsaved changes. Save before switching to view?</p>
          </ModalBody>
          {/* ModalFooter with 3 buttons docks them full-bleed at the
              bottom edge — matching the native Modal's two-button footer
              (Discard Changes? dialog). Order maps to Carbon footer
              convention: secondary, then the two primary-ish actions. */}
          <ModalFooter>
            <Button kind="secondary" onClick={modeSwitchStay}>Keep Editing</Button>
            <Button kind="danger" onClick={modeSwitchDiscard}>Discard and switch</Button>
            <Button kind="primary" onClick={modeSwitchSave}>Save and switch</Button>
          </ModalFooter>
        </ComposedModal>
      )}
    </div>
    </RefreshableComponentsProvider>
  );
}

// "Data refresh: 10s" green pill — surfaces the dashboard's configured
// polling cadence. Gated on the same context as RefreshControls so a
// streaming-only dashboard doesn't see a refresh-interval label that
// applies to nothing currently rendered.
function RefreshIntervalPill({ intervalSec }) {
  const { hasRefreshable } = useRefreshableComponentsContext();
  if (!hasRefreshable) return null;
  return (
    <Tag type="green" size="sm">
      <Time size={12} />
      Data refresh: {intervalSec}s
    </Tag>
  );
}

// Toolbar refresh controls — extracted so we can read the
// RefreshableComponents context, which only resolves inside the
// provider that wraps the rendered viewer. Hides the button (and
// the "Last refresh" timestamp) when no mounted component on the
// dashboard would actually do anything with a refresh — streaming-
// only dashboards see no toolbar noise.
function RefreshControls({ lastRefresh, loading, onRefresh }) {
  const { hasRefreshable } = useRefreshableComponentsContext();
  if (!hasRefreshable) return null;
  return (
    <>
      <span className="last-refresh">
        Last refresh: {formatTime(lastRefresh)}
      </span>
      <IconButton
        kind="ghost"
        label="Refresh"
        align="bottom"
        onClick={onRefresh}
        disabled={loading}
      >
        <Renew size={20} className={loading ? 'spinning' : ''} />
      </IconButton>
    </>
  );
}

export default DashboardViewerPage;
