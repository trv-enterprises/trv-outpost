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
  Tooltip,
  ContentSwitcher,
  Switch
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
  Code,
  Copy,
  BorderFull,
  Draw
} from '@carbon/icons-react';
import html2canvas from 'html2canvas';
import DynamicComponentLoader from '../components/DynamicComponentLoader';
import ComponentExpandModal from '../components/ComponentExpandModal';
import DashboardGrid from '../components/DashboardGrid';
import DashboardRangePicker from '../components/DashboardRangePicker';
import ConnectionSwapPicker from '../components/ConnectionSwapPicker';
import FilterVariablePicker from '../components/FilterVariablePicker';
import useRangeConnectionTypes from '../hooks/useRangeConnectionTypes';
import PanelEditMenu from '../components/PanelEditMenu';
import PanelTextModal from '../components/PanelTextModal';
import ComponentEditorModal from '../components/ComponentEditorModal';
import ComponentPickerModal from '../components/ComponentPickerModal';
import ComponentSwapRulesModal from '../components/ComponentSwapRulesModal';
import AIPreflightModal from '../components/AIPreflightModal';
import ColorSwatchPicker from '../components/shared/ColorSwatchPicker';
import { TEXT_THRESHOLD_COLOR_PALETTE } from '../chart-spec/option-helpers';
import { adornmentRect } from '../components/AdornmentLayer';
import apiClient from '../api/client';
import { useDashboardVariable } from '../hooks/useDashboardVariable';
import { useSwapCompatibility } from '../hooks/useSwapCompatibility';
import { orderDashboardsForViewer } from '../utils/dashboardOrder';
import { candidateLabel } from '../utils/tagValueByPrefix';
import TagInput from '../components/shared/TagInput';
import { invalidateTagsCache } from '../components/shared/tagsApi';
import NamespaceSelect from '../components/shared/NamespaceSelect';
import { useNamespaces } from '../context/NamespaceContext';
import DashboardExportModal from '../components/DashboardExportModal';
import NameErrorBadge from '../components/NameErrorBadge';
import DiscardChangesModal from '../components/shared/DiscardChangesModal';
import PanelDeleteModal from '../components/shared/PanelDeleteModal';
import { buildComponentCopy } from '../utils/duplicateEntity';
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

// Adornment border widths — EVEN ONLY, and deliberately so. The grid gutter
// is 4px (even) and the line renders centered in it, so an odd width lands on
// a half-pixel and blurs. 2 sits inside the void, 4 fills it exactly, 6
// overlaps 1px into each neighbouring panel. Mirrors models.AdornmentWidths
// in server-go/internal/models/dashboard.go — keep the two in lockstep.
// Gutter borders hug the panel edge and grow OUTWARD, so nothing is being
// centered and odd widths are fine. The 4px gutter fits two adjacent 2px
// borders exactly; 3px+ neighbours overlap each other, which is the author's
// call rather than something the geometry forbids.
const ADORNMENT_WIDTHS = [1, 2, 3, 4];
// Panel borders grow INWARD from the panel's own edge, so there is no gutter
// to center in and no parity constraint — odd widths are fine. Mirrors
// models.PanelBorderWidths in server-go.
const PANEL_BORDER_WIDTHS = [1, 2, 3];
// 'hidden' paints nothing in either view surface but the border still EXISTS —
// it holds its rect and still groups the panels it encloses for mobile flow
// order (#180). The editor draws it as a faint hairline so it stays findable
// and selectable. Mirrors models.AdornmentLine* in server-go.
const ADORNMENT_LINE_STYLES = ['solid', 'dashed', 'dotted', 'hidden'];
// Carbon red50. Deliberately NOT blue60: edit mode outlines panels in
// `--cds-focus` (blue), so a blue 1px adornment was almost impossible to
// distinguish from ordinary edit chrome — the thing the author just added
// looked like part of the editor.
const ADORNMENT_DEFAULT_COLOR = '#fa4d56';
// Smallest border a resize may shrink to.
const ADORNMENT_MIN_CELLS = 1;
// Click-vs-drag threshold. A press that never grew past this is a CLICK: on a
// panel it attaches a panel border, on bare grid it seeds a 1x1 box to build
// from with shift-click. Anything larger is a drawn box.
const ADORNMENT_MIN_DRAW_CELLS = 2;
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
  // #4: component_id → unauthorized reason ("component" | "connection")
  // for panels whose component or connection is in a namespace the
  // viewer can't see. Drives the per-panel error panel. Empty for
  // unrestricted users.
  const [unauthorizedComponents, setUnauthorizedComponents] = useState({});
  const [loading, setLoading] = useState(true);
  // Transient spin feedback for the manual Refresh button. The refetch is
  // out-of-band (per-chart, via refreshTick) with no central completion
  // signal, so we spin the icon for a brief fixed pulse to acknowledge the
  // click — distinct from `loading` (the initial page-load flag).
  const [refreshing, setRefreshing] = useState(false);
  const refreshSpinTimerRef = useRef(null);
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
    resolveComponent,
    filterVariable: dashFilterVariable,
    filterValue: dashFilterValue,
    setFilterValue: setDashFilterValue,
    rangeVariable: dashRangeVariable,
    rangeValue: dashRangeValue,
    setRangeValue: setDashRangeValue,
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
  // Mirror of isEditMode for callbacks that must read it WITHOUT taking it as
  // a dependency (fetchDashboard is a useCallback consumed by effects — a
  // state dep there would re-trigger those effects on every mode flip).
  const isEditModeRef = useRef(false);
  useEffect(() => { isEditModeRef.current = isEditMode; }, [isEditMode]);
  const [editablePanels, setEditablePanels] = useState([]);
  const [, setOriginalPanels] = useState([]);
  const [editHasChanges, setEditHasChanges] = useState(false);

  // ── Adornment (decoration) edit state ────────────────────────────
  // Adornments are visual only — border boxes drawn in the panel gutter.
  // They live in their own dashboard array, so none of the panel state
  // above is involved. Adornment mode makes panels inert and routes all
  // grid mouse events to the adornment layer.
  const [editableAdornments, setEditableAdornments] = useState([]);
  const [adornmentMode, setAdornmentMode] = useState(false);
  const [selectedAdornmentId, setSelectedAdornmentId] = useState(null);
  const [draggingAdornment, setDraggingAdornment] = useState(null);
  const [resizingAdornment, setResizingAdornment] = useState(null);
  const [drawingAdornment, setDrawingAdornment] = useState(null);
  // Last style the user picked, so a newly drawn border matches the one
  // before it instead of resetting to the default every time.
  const [lastAdornmentStyle, setLastAdornmentStyle] = useState({
    color: ADORNMENT_DEFAULT_COLOR,
    width: ADORNMENT_WIDTHS[0],
    line_style: 'solid',
  });
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  // Mode-switch intercept when the user has dirty edits. The pendingResolve
  // ref carries the guard's promise resolver so each button in the modal
  // can decide proceed/stay.
  const [modeSwitchPromptOpen, setModeSwitchPromptOpen] = useState(false);
  // True when the "Unsaved changes" dialog was triggered by the in-editor
  // View button rather than a header mode switch. In that case the three
  // dialog actions operate in place (goToPreview) instead of resolving the
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

  // Guard a browser refresh / tab-close / external navigation away while the
  // editor has unsaved changes. The in-app mode-switch intercept (below) only
  // catches React-Router navigations; a hard reload bypasses it and silently
  // drops edits. beforeunload triggers the browser's native "Leave site?"
  // confirmation — the only hook a page has into a reload. Only armed while
  // actually dirty in edit mode so it never nags a read-only viewer.
  useEffect(() => {
    if (!isEditMode || !editHasChanges) return undefined;
    const handleBeforeUnload = (e) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set; the prompt text itself
      // is fixed by the browser and our string is ignored by modern ones.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isEditMode, editHasChanges]);

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
  // Per-dashboard override of the deployment's transparent_panels setting.
  // '' = inherit the global (the default, and what every existing dashboard
  // stores — i.e. nothing). 'solid' / 'transparent' force one or the other.
  const [editablePanelBackground, setEditablePanelBackground] = useState('');
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
  // Range variable authoring (an INDEPENDENT variable, fixed name
  // "dashboard-range"). It coexists with the connection_swap/filter variable
  // above — a dashboard can carry both. The header shows the range picker after
  // the connection/filter control; time-series components opt in via the
  // {{range_from}}/{{range_to}} tokens (SQL/EdgeLake) or pick up the window
  // automatically (ts-store/Prometheus). Presets are duration tokens ("1h",
  // "24h"); the format that renders the tokens is per-component, not here.
  const [editableRangeEnabled, setEditableRangeEnabled] = useState(false);
  const [editableRangeLabel, setEditableRangeLabel] = useState('');
  const [editableRangePresets, setEditableRangePresets] = useState([]);
  const [editableRangeDefaultPreset, setEditableRangeDefaultPreset] = useState('');
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [varsModalOpen, setVarsModalOpen] = useState(false);
  // Draft buffers for the Settings and Vars modals. Inputs edit the draft, NOT
  // the shared editable* state — so Cancel discards cleanly and an abandoned
  // change can't ride along on a later Save. Apply copies the draft into the
  // editable* state (+ marks dirty). Seeded from editable* when each modal opens.
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [varsDraft, setVarsDraft] = useState(null);
  // Which variable panel the Dashboard Variables modal's content switcher shows:
  // 0 = Connection / Filter, 1 = Time range. Pure view state (not persisted) —
  // each panel keeps its own enable toggle; the switcher only selects which is
  // visible, while both variables' On/Off status stays readable on the buttons.
  const [varsPanel, setVarsPanel] = useState(0);

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
        panelBackground: editablePanelBackground,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsModalOpen]);

  // PANEL BACKGROUND OVERRIDE (per-dashboard).
  //
  // Writes its OWN root attribute rather than reusing the global
  // `data-transparent-panels`. Sharing that one didn't work: App.jsx sets it
  // from the deployment setting when `identityResolved` flips, which happens
  // AFTER the viewer mounts, so the global effect ran second and wiped the
  // override every time. Instrumented and confirmed — the viewer applied the
  // attribute, then the global removed it with no cleanup in between.
  //
  // With a separate attribute the two never race: the SCSS gives
  // `data-panel-background` higher precedence than the global flag, so
  // whichever effect runs last, the override still wins.
  //
  // The saved value is read while VIEWING; the editable state is what's live
  // while EDITING, so a change previews immediately without saving. Cleared
  // on unmount so an override can't leak onto the next dashboard.
  useEffect(() => {
    const override = isEditMode
      ? editablePanelBackground
      : (dashboard?.settings?.panel_background || '');
    const root = document.documentElement;
    if (!override) {
      root.removeAttribute('data-panel-background');
      return undefined;
    }
    root.setAttribute('data-panel-background', override);
    return () => root.removeAttribute('data-panel-background');
  }, [isEditMode, editablePanelBackground, dashboard?.settings?.panel_background]);

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
        rangeEnabled: editableRangeEnabled,
        rangeLabel: editableRangeLabel,
        rangePresets: editableRangePresets,
        rangeDefaultPreset: editableRangeDefaultPreset,
      });
      setVarsPanel(0); // always open on the Connection / Filter panel
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
  // Multi-select: ids of panels picked out by a shift-drag marquee, plus the
  // transient marquee rect while the drag is in flight, plus the in-flight
  // batch move. Selection survives until an outside click clears it.
  const [selectedPanelIds, setSelectedPanelIds] = useState([]);
  // Gutter borders enclosed by the marquee. Carried by a batch move but NOT
  // selected — they get no outline and no style bar.
  const [carriedAdornmentIds, setCarriedAdornmentIds] = useState([]);

  // Clear the panel selection AND its carried borders together. Single entry
  // point on purpose: the two are set as a pair by the marquee, so clearing
  // one without the other would leave borders armed to move with a selection
  // that no longer exists.
  const clearPanelSelection = useCallback(() => {
    setSelectedPanelIds([]);
    setCarriedAdornmentIds([]);
  }, []);
  const [marquee, setMarquee] = useState(null);
  const [batchMove, setBatchMove] = useState(null);
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

  // Component-swap rules modal state (which panel's rules are being edited)
  const [swapRulesPanelId, setSwapRulesPanelId] = useState(null);

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

  // Lock the cursor for the WHOLE resize drag. Without this the cursor is
  // driven by whatever element the pointer happens to be over, so mid-drag —
  // when the pointer moves off the thin edge grip and into the panel body (the
  // move-cursor area) — it flips to the move cursor even though we're still
  // resizing. A plain body-cursor doesn't help: descendant elements set their
  // own `cursor: move` which wins. So toggle a body class per edge; the SCSS
  // forces the resize cursor with `!important` on EVERY element under it, which
  // beats the inner move/pointer cursors until mouseup.
  useEffect(() => {
    if (!resizingPanel) return undefined;
    const cls = `dash-resizing dash-resizing--${resizingPanel.edge || 'corner'}`.split(' ');
    document.body.classList.add(...cls);
    return () => document.body.classList.remove(...cls);
  }, [resizingPanel]);

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
      // #114: ids_only returns the FULL id set — pruning against the old
      // no-param call (first 20 only) wrongly dropped valid entries.
      apiClient.getDashboards({ ids_only: true }).catch(() => ({ dashboards: [] })),
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
  const adornments = isEditMode ? editableAdornments : (dashboard?.adornments || []);
  const selectedAdornment = useMemo(
    () => editableAdornments.find(a => a.id === selectedAdornmentId) || null,
    [editableAdornments, selectedAdornmentId]
  );
  // Legal widths depend on the kind — see PANEL_BORDER_WIDTHS.
  const selectedAdornmentWidths = selectedAdornment?.kind === 'panel_border'
    ? PANEL_BORDER_WIDTHS
    : ADORNMENT_WIDTHS;

  // Connection-swap column compatibility (detection only). For each panel,
  // resolve its EFFECTIVE component (post component-override) so a panel the
  // author already substituted (NA placeholder, variable-free chart) is
  // checked as its substitute and doesn't false-warn. The hook is a no-op
  // unless a connection_swap variable is active with a selection.
  const effectivePanelComponents = useMemo(() => {
    if (!dashVariable?.name || !dashVariableValue) return {};
    const map = {};
    for (const p of panels) {
      if (!p?.id) continue;
      const compId = resolveComponent ? resolveComponent(p) : p.component_id;
      if (compId) map[p.id] = compId;
    }
    return map;
    // resolveComponent is stable per selection; panels + selection drive it.
  }, [panels, dashVariable?.name, dashVariableValue, resolveComponent]);

  const { issuesByPanel: swapIssuesByPanel } = useSwapCompatibility({
    dashboardId: id,
    variableName: dashVariable?.name || '',
    selectedConnId: dashVariableValue || '',
    panelComponents: effectivePanelComponents,
  });

  // (Filter-variable `connection`-sourced value discovery moved to the shared
  // useFilterVariableDiscovery hook, consumed by FilterVariablePicker.)

  // Range-scoped connection-type classification (Prometheus step field +
  // mixed-type guard) is shared with the mobile viewer via this hook.
  const { rangeConnType, rangeSupportsStep, rangeHasConsumer } = useRangeConnectionTypes({
    rangeVariable: dashRangeVariable,
    panels,
    chartsMap,
    dashboard,
    pushToast,
    addNotification,
  });

  // (Filter-variable discovery + session-regenerate machinery moved to the
  // shared useFilterVariableDiscovery hook, consumed by FilterVariablePicker.)

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

  // Fixed fallback budget for edit mode when no dimension is resolved yet
  // (gridCols/gridRows null — e.g. the brief async window after opening a
  // new dashboard, before getSystemConfig lands). Generous enough not to
  // clip a 4K canvas (~118×58). The resize/drag handlers key off this
  // (editBudgetCols/Rows) rather than the render-time maxGridCol so the
  // cell-size denominator can NEVER grow from panel extent — that
  // self-referential loop (resize grows extent → grows maxGridCol →
  // shrinks the cell → next mousemove maps bigger → runaway reflow of
  // every panel) was the new-dashboard resize bug.
  const EDIT_FALLBACK_COLS = 200;
  const EDIT_FALLBACK_ROWS = 120;
  const editBudgetCols = gridCols || EDIT_FALLBACK_COLS;
  const editBudgetRows = gridRows || EDIT_FALLBACK_ROWS;

  // In edit mode, the grid template is PINNED to the fixed dimension budget
  // (editBudgetCols/Rows) — NEVER panel extent. Deriving it from extent made
  // the grid re-lay-out on every panel change: resizing past the edge grew
  // the template (runaway), and even deleting a panel shifted the extent and
  // reflowed every other panel ("whole dashboard went flaky"). A fixed
  // template means panel mutations only move the touched panel. Panels are
  // already clamped to the budget on drag/resize, so nothing renders past it.
  // In view mode, grid fits tightly around panels.
  const maxGridCol = isEditMode
    ? editBudgetCols
    : (panelExtentCol || 60);

  const maxGridRow = isEditMode
    ? editBudgetRows
    : (panelExtentRow || 60);

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

  // GAP / CONTAINER_PADDING feed the edit-mode zoom-to-fit math below.
  // (The view-mode fit-to-screen transform now lives in <DashboardGrid>,
  // which is the single grid render for both modes.)
  const GAP = 4; // spacing.$spacing-02
  const CONTAINER_PADDING = 4;

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
    // The editor renders the grid at the design-canvas size TIMES the
    // build/display scaleFactor (DashboardGrid applies scale(editScaleFactor)
    // on the grid, then scale(editZoom/100) on the wrapper). So the on-screen
    // canvas we're fitting is scaleFactor× the design px — include it here, or a
    // dashboard with scale_percent > 100 under-measures and zoom-to-fit leaves
    // the canvas overflowing (the reported regression: fit stops working past
    // 100%). scaleFactor is 1 at 100%, so this is a no-op for normal dashboards.
    const canvasW = (cols * CELL_WIDTH + (cols - 1) * GAP) * scaleFactor;
    const canvasH = (rows * CELL_HEIGHT + (rows - 1) * GAP) * scaleFactor;
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
  }, [containerSize.width, containerSize.height, gridCols, gridRows, maxGridCol, maxGridRow, CELL_WIDTH, CELL_HEIGHT, GAP, CONTAINER_PADDING, scaleFactor]);

  // Fetch dashboard data and referenced charts
  const fetchDashboard = useCallback(async () => {
    try {
      const data = await apiClient.getDashboard(id);
      // While editing, NEVER let a refetch clobber the authoring state. The
      // editor's unsaved panels/adornments live in editable* state, but a
      // save spreads `...dashboard` under its payload and enterEditMode
      // re-seeds FROM `dashboard` — so replacing it mid-edit with the
      // server's (pre-edit) copy silently reverted in-flight adornments.
      // Keep the server's data for everything else; preserve the authoring
      // arrays until the save that persists them.
      setDashboard((prev) => (
        isEditModeRef.current && prev
          ? { ...data, panels: prev.panels, adornments: prev.adornments }
          : data
      ));

      if (data.panels && data.panels.length > 0) {
        // Batch-fetch every component the panels reference (defaults + every
        // component-swap override, so a swap renders instantly) in ONE request
        // (#60), replacing the old per-panel getComponent N+1. The server
        // returns latest FINAL versions de-duped; we key them by component id.
        const { components: charts, unauthorized } = await apiClient
          .getDashboardComponentsAuthorized(id)
          .catch(() => ({ components: [], unauthorized: [] }));
        const newChartsMap = {};
        charts.forEach(chart => {
          if (chart) newChartsMap[chart.id] = chart;
        });
        setChartsMap(newChartsMap);
        // #4: component ids the caller can't see → error panels. Map id →
        // reason ("component" | "connection") so the panel shows the right
        // message. Empty for unrestricted users.
        const unauthMap = {};
        (unauthorized || []).forEach((u) => { if (u?.id) unauthMap[u.id] = u.reason; });
        setUnauthorizedComponents(unauthMap);
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
        // #114: prev/next only needs ids + the sort fields — fetch the
        // lightweight nav projection of the FULL set instead of full docs
        // (the old no-param call silently truncated at the server's
        // default page size of 20).
        const data = await apiClient.getDashboards({ ids_only: true });
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
    // Navigating to a DIFFERENT dashboard (e.g. the Assistant's "Open in
    // viewer" button while editing another dashboard) must drop out of edit
    // mode — otherwise the page keeps isEditMode=true and renders the NEW
    // dashboard through the OLD dashboard's stale editablePanels, showing empty
    // "Add chart" cells instead of the real panels. View mode reads from
    // `dashboard` (refetched on id change), so just exiting edit mode is enough;
    // editable* state re-seeds from the new dashboard if the user edits again.
    // An incoming autoEdit navigation re-enters edit mode via its own effect.
    if (!location.state?.autoEdit) {
      setIsEditMode(false);
      setEditHasChanges(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Honor a refetch signal carried in navigation state (#117 follow-up). The
  // Assistant's "Open in viewer" button stamps location.state.refetchAt; when
  // it targets the dashboard already open, the :id is unchanged so neither the
  // mount fetch nor the id-change effect re-runs — chartsMap keeps the stale
  // component and an AI edit doesn't mount until a manual reload. Re-running
  // fetchDashboard pulls the updated component (and its new `updated` stamp,
  // which bumps the panel key → remount). Tracked by value so it fires once per
  // distinct press and never on the initial mount (refetchAt is unset then).
  const lastRefetchAtRef = useRef(null);
  useEffect(() => {
    const stamp = location.state?.refetchAt;
    if (!stamp || stamp === lastRefetchAtRef.current) return;
    lastRefetchAtRef.current = stamp;
    fetchDashboard();
  }, [location.state, fetchDashboard]);

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
    // Acknowledge the click with a brief spin pulse (the per-chart refetches
    // don't report completion centrally). Reset any in-flight timer so rapid
    // clicks keep spinning rather than stop early.
    if (refreshSpinTimerRef.current) clearTimeout(refreshSpinTimerRef.current);
    setRefreshing(true);
    refreshSpinTimerRef.current = setTimeout(() => {
      setRefreshing(false);
      refreshSpinTimerRef.current = null;
    }, 800);
  };

  // Clear the manual-refresh spin timer on unmount (avoid a state update after
  // the page is gone).
  useEffect(() => () => {
    if (refreshSpinTimerRef.current) clearTimeout(refreshSpinTimerRef.current);
  }, []);

  const handleBack = () => {
    if (fromDesign) {
      navigate('/design/dashboards');
    } else {
      navigate('/view/dashboards');
    }
  };


  // Thumbnail capture — auto-fires on save (#97); see captureAndPutThumbnail.
  const [downloadingPng, setDownloadingPng] = useState(false);
  const [creatingThumbnail, setCreatingThumbnail] = useState(false);

  // Auto-thumbnail-on-save: a structural signature of everything that
  // affects the rendered thumbnail (panel geometry + which component/text is
  // in each panel + each component's look + canvas size), so we only re-run
  // the (non-trivial) html2canvas capture when the layout actually changed —
  // NOT on non-visual saves (description/tags) or live-data ticks. Updated
  // after each successful capture; compared on the next save.
  const lastThumbnailSigRef = useRef(null);
  const autoThumbnailInFlightRef = useRef(false);

  const computeThumbnailSignature = useCallback(() => {
    const panelsSig = (editablePanels || []).map((p) => {
      const chart = p.component_id ? chartsMap[p.component_id] : null;
      const look = chart
        ? `${chart.component_type || ''}:${chart.chart_type || ''}:${chart.display_config?.display_type || ''}:${chart.control_config?.control_type || ''}:${chart.title || chart.name || ''}`
        : '';
      const text = p.text_config
        ? `${p.text_config.content || ''}|${p.text_config.size || ''}|${p.text_config.align || ''}|${p.text_config.display_content || ''}`
        : '';
      return `${p.x},${p.y},${p.w},${p.h}|${p.component_id || ''}|${text}|${look}`;
    });
    return JSON.stringify({ d: currentDimension, s: scalePercent, p: panelsSig });
  }, [editablePanels, chartsMap, currentDimension, scalePercent]);

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

      // Capture tight to the PANEL BOUNDING BOX, never the design-canvas
      // budget. Auto-thumbnail-on-save fires while still in edit mode, where
      // maxGridCol/Row = editBudgetCols/Rows (the full preset canvas, or the
      // 200×120 fallback) — capturing that left a wide black gutter
      // (backgroundColor below) wherever panels didn't reach the canvas edge.
      // panelExtentCol/Row is the rightmost/bottommost panel edge, so the
      // capture matches what the user sees in stretch mode (panels filling the
      // frame) regardless of edit vs view mode.
      const captureCols = panelExtentCol || maxGridCol;
      const captureRows = panelExtentRow || maxGridRow;
      const gridNativeW = captureCols * CELL_WIDTH + (captureCols - 1) * GAP;
      const gridNativeH = captureRows * CELL_HEIGHT + (captureRows - 1) * GAP;

      // The element's own position in the page. html2canvas clones the document
      // and lays it out inside a virtual window; anything outside that window
      // is never laid out and renders as bare background.
      const gridBox = grid.getBoundingClientRect();

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
        // Size the CLONE WINDOW to hold the whole grid, not the real viewport.
        //
        // These default to window.innerWidth/innerHeight. A dashboard bigger
        // than the browser window — a 2K/4K canvas, or any board at a high
        // scale percent — is then only PARTLY inside the clone, and the
        // overflow is captured as background: the thumbnail shows content in
        // the top-left corner and black everywhere else.
        //
        // Observed: a 3056x1652 grid at offset 260,108 cloned into a 1464x554
        // window — 39% of the width and 27% of the height on screen, ~11% of
        // the area. That is exactly the partial fill users reported, and it
        // explains why it looked intermittent: it depends on the browser window
        // size versus the dashboard's, so the SAME dashboard captures fine on a
        // large window and badly on a small one.
        //
        // Include the element's own offset so a grid pushed right/down by the
        // app chrome still fits.
        //
        // If a partial-fill report ever recurs, html2canvas's own console
        // output diagnoses it: compare "Starting document clone with size
        // WxH" against "element located at X,Y with size WxH". If the element
        // doesn't fit inside the clone, it's this bug again.
        windowWidth: Math.ceil(gridBox.left + gridNativeW + 1),
        windowHeight: Math.ceil(gridBox.top + gridNativeH + 1),
        onclone: (clonedDoc) => {
          const clonedGrid = clonedDoc.querySelector('.dashboard-grid');
          if (clonedGrid) {
            // Remove all edit mode classes and elements
            clonedGrid.classList.remove('edit-active');
            clonedGrid.querySelectorAll('.edit-hover-header, .edit-drag-overlay, .edit-resize-handle, .edit-resize-edge, .edit-panel-menu-anchor').forEach(el => el.remove());
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

  // Capture the grid and persist ONLY the thumbnail. The blob lives in a
  // separate collection (#19), upserted via its own endpoint — this never
  // touches the dashboard's panels/settings. Records the structural
  // signature so an unchanged subsequent save can skip the capture.
  const captureAndPutThumbnail = useCallback(async () => {
    const canvas = await captureGridCanvas(0.25);
    if (!canvas) return false;
    const thumbnailDataUrl = canvas.toDataURL('image/png');
    await apiClient.putDashboardThumbnail(id, thumbnailDataUrl);
    lastThumbnailSigRef.current = computeThumbnailSignature();
    return true;
  }, [id, computeThumbnailSignature]);

  // Manual thumbnail capture from the overflow menu. The auto-on-save path
  // can miss a good frame — slow/late streaming data when editing, or an
  // AI-built dashboard that was never saved out of edit mode — so this lets
  // the user capture the currently-rendered grid on demand. Unlike the
  // silent auto path, this surfaces success/failure via a toast and refetches
  // so the tile thumbnail updates immediately.
  const createThumbnail = useCallback(async () => {
    setCreatingThumbnail(true);
    try {
      const ok = await captureAndPutThumbnail();
      if (ok) {
        pushToast({ kind: 'success', title: 'Thumbnail created', duration: 2000 });
        fetchDashboard();
      } else {
        pushToast({ kind: 'error', title: 'Thumbnail capture failed', subtitle: 'The dashboard grid was not ready to capture.' });
      }
    } catch (err) {
      console.error('Manual thumbnail capture failed:', err);
      pushToast({ kind: 'error', title: 'Thumbnail capture failed', subtitle: err?.message || 'Unexpected error.' });
    } finally {
      setCreatingThumbnail(false);
    }
  }, [captureAndPutThumbnail, pushToast, fetchDashboard]);

  // Auto-capture after a dashboard save (fire-and-forget). Skips when the
  // structural signature is unchanged since the last thumbnail (non-visual
  // saves, repeat saves of the same layout). Best-effort: errors are logged,
  // never surfaced, and never block the save. Guarded against overlap from
  // rapid round-trip saves.
  const maybeAutoThumbnail = useCallback(() => {
    if (autoThumbnailInFlightRef.current) return;
    const sig = computeThumbnailSignature();
    if (sig === lastThumbnailSigRef.current) return; // nothing visual changed
    autoThumbnailInFlightRef.current = true;
    // Defer a beat so the just-saved DOM has settled before capture.
    setTimeout(async () => {
      try {
        await captureAndPutThumbnail();
      } catch (err) {
        console.error('Auto-thumbnail capture failed (non-fatal):', err);
      } finally {
        autoThumbnailInFlightRef.current = false;
      }
    }, 300);
  }, [computeThumbnailSignature, captureAndPutThumbnail]);

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
    // Re-seeding replaces every panel, so any selection now points at the
    // pre-revert set. Clear it — this runs on entering the editor and on
    // Discard (which is a revert-in-place), and a stale selection there would
    // arm a batch move over panels the user just discarded.
    clearPanelSelection();
    setMarquee(null);
    setBatchMove(null);
    setOriginalPanels(panelsCopy.map(p => ({ ...p })));
    // Coerce geometry on load. A rect border with a non-finite x/y/w/h is
    // permanently stuck — `NaN !== NaN` makes every change-check report true,
    // so each drag rewrites NaN and the border can never move, while the grip
    // cursor insists it should. Records can carry NaN from older sessions, so
    // repair on the way in rather than leaving a dead border on the canvas.
    // panel_border has no rect by design and is left untouched.
    setEditableAdornments((dashboard?.adornments || []).map(a => {
      if (a.kind === 'panel_border') return { ...a };
      return {
        ...a,
        x: Number.isFinite(a.x) ? a.x : 0,
        y: Number.isFinite(a.y) ? a.y : 0,
        w: Number.isFinite(a.w) && a.w > 0 ? a.w : 1,
        h: Number.isFinite(a.h) && a.h > 0 ? a.h : 1,
      };
    }));
    // Always start in panel mode — adornment mode is an explicit opt-in.
    setAdornmentMode(false);
    setSelectedAdornmentId(null);
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
    // '' when absent — inherit the deployment setting.
    setEditablePanelBackground(dashboard?.settings?.panel_background || '');
    // Dashboard-variable authoring state. The connection/filter variable and the
    // range variable are INDEPENDENT; each toggle reflects the presence of its
    // OWN variable, NOT the shared `variables_enabled` master gate (which is true
    // when EITHER exists — keying the filter toggle off it falsely turns the
    // filter section on for a range-only dashboard).
    {
      const vars = dashboard?.settings?.variables || [];
      const v0 = vars.find((v) => v?.mode === 'filter') || vars.find((v) => v?.mode === 'connection_swap') || null;
      setEditableVariablesEnabled(!!v0);
      setEditableVariableMode(v0?.mode || 'connection_swap');
      setEditableVariableLabel(v0?.label || '');
      setEditableVariableTags(v0?.connection_swap?.tags || []);
      setEditableVariableSchemaStrict(v0?.connection_swap?.schema_strict || 'type_only');
      setEditableVariableSameNamespace(!!v0?.connection_swap?.same_namespace);
      setEditableVariableLabelTagPrefix(v0?.connection_swap?.label_tag_prefix || '');
      setEditableVariableValueSource(v0?.filter_value?.value_source || 'static');
      setEditableVariableOptions(v0?.filter_value?.options || []);
      setEditableVariableDefault(v0?.filter_value?.default_value || '');
      // The range variable is independent (own fixed name "dashboard-range").
      const vr = vars.find((v) => v?.mode === 'range') || null;
      setEditableRangeEnabled(!!vr);
      setEditableRangeLabel(vr?.label || '');
      setEditableRangePresets(vr?.range?.presets || []);
      setEditableRangeDefaultPreset(vr?.range?.default_preset || '');
    }
    setEditHasChanges(false);
    setZoom(100);
    setIsEditMode(true);
  };

  // Panel-header "shared component" indicator (#221 follow-up).
  //
  // Components are shared entities, so a panel may be showing something that
  // several other dashboards also depend on — editing it there is a wider
  // change than it looks. Mark those panels in edit mode so the author knows
  // before they open the editor.
  //
  // One include_usage list request rather than N per-component /usage calls:
  // the components list already denormalizes dashboard_count server-side
  // (#21), and a dashboard's panels can reference many components. Edit-mode
  // only — view mode never needs it.
  const [componentUsageCounts, setComponentUsageCounts] = useState({});
  const placedComponentKey = useMemo(
    () => (editablePanels || [])
      .map((p) => p?.component_id)
      .filter(Boolean)
      .sort()
      .join(','),
    [editablePanels]
  );
  useEffect(() => {
    if (!isEditMode) return undefined;
    let cancelled = false;
    apiClient
      .getComponents({ include_usage: true, page_size: 'all' })
      .then((data) => {
        if (cancelled) return;
        const counts = {};
        (data?.components || []).forEach((c) => {
          if (c?.id) counts[c.id] = c.dashboard_count || 0;
        });
        setComponentUsageCounts(counts);
      })
      .catch((err) => {
        // Indicator-only: a failure just means no badges, never a broken editor.
        console.error('[DashboardViewerPage] usage counts failed:', err);
      });
    return () => { cancelled = true; };
    // Keyed on the SET of placed component ids, not editablePanels itself —
    // otherwise every drag/resize would refetch the whole list. Adding or
    // swapping a component changes the key and picks up its badge.
  }, [isEditMode, placedComponentKey]);

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
    // Dirty Cancel → Discard REVERTS the unsaved edits and STAYS in the
    // editor on this dashboard (re-seeding from the last-saved version),
    // rather than leaving to the dashboard list. enterEditMode() reloads
    // all editable state from `dashboard` and clears the dirty flag — i.e.
    // a revert-in-place. (Only the NOT-dirty Cancel exits to the list, via
    // exitEditMode → finishCancelNavigation.)
    enterEditMode();
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
  //     in place (goToPreview) rather than resolving the header guard.
  // The editor's "Preview" button drops into PREVIEW — the design-mode
  // viewer. It must STAY in DESIGN mode (keep fromDesign true); only the
  // app-level VIEW-mode selector leaves DESIGN. So: exit edit, keep the
  // design-origin framing. (Same for both the clean path and the
  // save-and-switch modal path — both call this.)
  //
  // Clear the sticky `autoEdit` route state on the way out. Without this,
  // exiting edit resets the autoEdit latch (see the latch-reset effect),
  // and because location.state.autoEdit is still set the autoEdit effect
  // immediately re-enters the editor — the "drops to preview for a beat,
  // then jumps back into the editor" bug. Keep fromDesign so we stay in
  // the design-mode preview, not View mode.
  const goToPreview = () => {
    setIsEditMode(false);
    setEditHasChanges(false);
    if (location.state?.autoEdit) {
      navigate(location.pathname, { replace: true, state: { fromDesign: true } });
    }
  };

  const handleViewClick = () => {
    if (editHasChanges) {
      setViewNavMode(true);
      setModeSwitchPromptOpen(true);
      return;
    }
    goToPreview();
  };

  const handleDimensionChange = (newDimension) => {
    setCurrentDimension(newDimension);
    setEditHasChanges(true);
  };

  // Per-panel edit chrome (hover header with title/actions/delete, full-panel
  // drag overlay, empty-panel Add button, resize handle). Passed to
  // <DashboardGrid> as its renderPanelChrome render-prop so the editor's grid
  // and the view/kiosk grid share ONE panel subtree (the streaming-safe
  // edit↔view fix) while keeping all editor closures here in the page.
  const renderEditPanelChrome = (panel, { chart, hasText, hasChart, hasContent }) => (
    <>
      {/* Hover header overlay with title, actions, and delete */}
      <div className="edit-hover-header" onMouseDown={(e) => startDragging(e, panel)}>
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
          {/* Shared-component indicator: this panel's component is also on
              other dashboards, so editing it here changes them too. Count is
              total dashboards; "others" is what the author doesn't already
              know about. */}
          {chart?.id && (componentUsageCounts[chart.id] || 0) > 1 && (
            <span
              className="panel-shared-indicator"
              title={`Shared component — also used on ${componentUsageCounts[chart.id] - 1} other dashboard${componentUsageCounts[chart.id] - 1 === 1 ? '' : 's'}. Editing it changes them too.`}
              aria-label={`Shared component, used on ${componentUsageCounts[chart.id]} dashboards`}
            >
              <Copy size={14} />
              <span className="panel-shared-count">{componentUsageCounts[chart.id]}</span>
            </span>
          )}
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
                // Duplicating an empty panel would just clone a blank
                // rectangle — offer it only when there's content to copy.
                // Suppressed while a copy is in flight so the menu can't
                // queue a second one behind the component create.
                onDuplicate={
                  hasChart && duplicatingPanelId !== panel.id
                    ? () => duplicatePanel(panel.id)
                    : undefined
                }
                onText={() => setTextPanel(panel.id)}
                showSwapRulesOption={(!!dashVariable || !!dashFilterVariable) && hasChart}
                hasSwapRules={Array.isArray(panel.component_overrides) && panel.component_overrides.length > 0}
                onEditSwapRules={() => openSwapRulesModal(panel.id)}
              />
            )}
          </div>
          <IconButton
            kind="ghost"
            size="sm"
            label="Delete panel"
            className="panel-delete-btn"
            onClick={(e) => { e.stopPropagation(); requestDeletePanel(panel.id); }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <TrashCan size={14} />
          </IconButton>
        </div>
      </div>

      {/* Full-panel drag overlay */}
      <div className="edit-drag-overlay" onMouseDown={(e) => startDragging(e, panel)} />

      {/* Add button for empty panels */}
      {!hasContent && (
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

      {/* Resize grips: bottom-right corner (both axes) + top/left/right/bottom
          edges (single axis). Left/top move the near edge with the opposite
          edge anchored; right/bottom grow from a fixed top-left. */}
      {/* Short/narrow panels get tighter grip insets. The defaults reserve
          24px vertically (corner + top grip) and 24px horizontally, which is
          most of a 1-cell panel (32px) — the side grips end up with almost no
          hittable length and the edge feels missing. See `.is-short` /
          `.is-narrow` in the SCSS. */}
      <div className={`edit-resize-handle ${panel.h <= 2 || panel.w <= 1 ? 'is-compact' : ''}`} onMouseDown={(e) => startResizing(e, panel, 'corner')} />
      <div className={`edit-resize-edge edit-resize-edge--top ${panel.w <= 1 ? 'is-narrow' : ''}`} onMouseDown={(e) => startResizing(e, panel, 'top')} />
      <div className={`edit-resize-edge edit-resize-edge--left ${panel.h <= 2 ? 'is-short' : ''}`} onMouseDown={(e) => startResizing(e, panel, 'left')} />
      <div className={`edit-resize-edge edit-resize-edge--right ${panel.h <= 2 ? 'is-short' : ''}`} onMouseDown={(e) => startResizing(e, panel, 'right')} />
      <div className={`edit-resize-edge edit-resize-edge--bottom ${panel.w <= 1 ? 'is-narrow' : ''}`} onMouseDown={(e) => startResizing(e, panel, 'bottom')} />
    </>
  );

  // Edit-only grid extras: the drawing preview (shown while dragging out a
  // new panel) and the canvas boundary lines. Passed to <DashboardGrid> as
  // gridExtras so they render INSIDE the same .dashboard-grid.
  const editGridExtras = (
    <>
      {marquee && (
        <div
          className="marquee-preview"
          style={{
            gridColumn: `${marquee.x + 1} / span ${marquee.w}`,
            gridRow: `${marquee.y + 1} / span ${marquee.h}`,
          }}
        />
      )}
      {drawingPanel && (
        <div
          className="drawing-panel-preview"
          style={{
            gridColumn: `${drawingPanel.x + 1} / span ${drawingPanel.w}`,
            gridRow: `${drawingPanel.y + 1} / span ${drawingPanel.h}`,
          }}
        >
          <span>{drawingPanel.w}×{drawingPanel.h}</span>
        </div>
      )}
      {drawingAdornment && (
        <div
          className="drawing-adornment-preview"
          style={{
            // Native px via the SAME helper the committed border uses, so
            // the preview lands exactly where the border will.
            ...(() => {
              const r = adornmentRect({ ...drawingAdornment, width: lastAdornmentStyle.width });
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            })(),
            borderColor: lastAdornmentStyle.color,
            // A `hidden` border paints nothing once committed, but the DRAG
            // must always be visible — you cannot size a box you can't see.
            // Preview it as the same 1px dashed hairline the editor uses for a
            // committed hidden border, so the drag looks like what it makes.
            borderWidth: lastAdornmentStyle.line_style === 'hidden'
              ? '1px'
              : `${lastAdornmentStyle.width}px`,
            borderStyle: lastAdornmentStyle.line_style === 'hidden'
              ? 'dashed'
              : lastAdornmentStyle.line_style,
          }}
        />
      )}
      {gridCols && (
        <>
          <div
            className="grid-boundary-right"
            style={{
              left: gridCols * CELL_WIDTH + (gridCols - 1) * VIEWER_GAP,
              height: gridRows * CELL_HEIGHT + (gridRows - 1) * VIEWER_GAP,
            }}
          />
          <div
            className="grid-boundary-bottom"
            style={{
              top: gridRows * CELL_HEIGHT + (gridRows - 1) * VIEWER_GAP,
              width: gridCols * CELL_WIDTH + (gridCols - 1) * VIEWER_GAP,
            }}
          />
        </>
      )}
    </>
  );

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
      // Build the dashboard-variable list from the two INDEPENDENT authoring
      // surfaces: the connection_swap/filter variable (gated by
      // editableVariablesEnabled, fixed name "dashboard-variable") AND the range
      // variable (gated by editableRangeEnabled, fixed name "dashboard-range").
      // They coexist — the header renders both controls — so the array can hold
      // one or both. variables_enabled is the master feature gate and is on when
      // EITHER surface is enabled.
      const builtVariables = [];
      if (editableVariablesEnabled) {
        builtVariables.push(
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
        );
      }
      if (editableRangeEnabled) {
        builtVariables.push({
          name: 'dashboard-range',
          label: editableRangeLabel || 'Range',
          mode: 'range',
          range: {
            presets: editableRangePresets || [],
            default_preset: (editableRangeDefaultPreset || '').trim(),
          },
        });
      }

      const updatedSettings = {
        ...dashboard.settings,
        layout_dimension: currentDimension,
        scale_percent: scalePercent,
        refresh_interval: editableRefreshInterval,
        // ALWAYS send this key, including as "" for Default/inherit.
        //
        // It used to be `|| undefined`, which JSON.stringify drops — and the
        // server's partial-settings merge writes only the keys the request
        // actually contained (models.UpdateDashboardRequest.SettingsFields).
        // So switching a dashboard from transparent/solid BACK to Default sent
        // nothing, the old value survived, and the change silently reverted on
        // the next load. Sending "" explicitly is what makes Default reachable
        // — the same reason the BSON tag deliberately has no omitempty (see
        // models.DashboardSettings.PanelBackground).
        panel_background: editablePanelBackground || '',
        variables_enabled: editableVariablesEnabled || editableRangeEnabled,
        variables: builtVariables,
      };
      const payload = {
        name: editableName,
        namespace: editableNamespace,
        description: editableDescription,
        tags: editableTags,
        panels: editablePanels,
        adornments: editableAdornments,
        settings: updatedSettings
      };

      // options.stayInEdit=true (the plain Save button) persists + clears
      // dirty but KEEPS the editor open on the saved dashboard, rather than
      // dropping to the post-save preview. The save-and-switch callers omit
      // it so they still exit edit (and the switch handler navigates).
      const stayInEdit = options?.stayInEdit === true;
      if (isNewDashboard) {
        const created = await apiClient.createDashboard(payload);
        invalidateTagsCache();
        // Clear dirty regardless of who navigates next.
        setEditHasChanges(false);
        if (stayInEdit) {
          // Stay in the editor on the freshly-created dashboard: keep
          // isEditMode true, re-point the route from "new" → the real id
          // (so reloads/saves target it), and reset the saved-state baseline
          // to what we just persisted so Cancel/Discard compares correctly.
          setOriginalPanels(editablePanels.map(p => ({ ...p })));
          // A save is a commit point — the selection was a working aid for
          // the edits just persisted, so it shouldn't linger with its move
          // affordance still armed.
          clearPanelSelection();
          navigate(`/view/dashboards/${created.id}`, {
            replace: true,
            state: { autoEdit: true, fromDesign: true },
          });
          pushToast({ kind: 'success', title: 'Dashboard saved', duration: 2000 });
          maybeAutoThumbnail();
          return created.id;
        }
        // Drop out of edit (preview/switch paths). Without this the
        // new-dashboard route param changes from "new" to <created.id>, the
        // component instance survives, and isEditMode would stay true with
        // stale dirty state.
        setIsEditMode(false);
        if (!options?.skipNavigate) {
          navigate(`/view/dashboards/${created.id}`, {
            replace: true,
            state: { fromDesign: true }
          });
        }
        return created.id;
      } else {
        // `payload` is spread LAST and carries both authoring arrays, so the
        // stale-`dashboard` spread underneath can never win over them.
        await apiClient.updateDashboard(id, { ...dashboard, ...payload });
        invalidateTagsCache();
        setEditHasChanges(false);
        if (stayInEdit) {
          // Saved, keep editing — same session, no network reload. But we
          // MUST update the in-memory `dashboard` to the just-saved values:
          // enterEditMode() re-seeds all editable* state (including the
          // variable/range toggles) FROM `dashboard.settings`, so a later
          // re-entry (View→Edit) would otherwise resurrect the PRE-save
          // variable state from a stale `dashboard`. Update it locally from
          // the payload we just persisted. Reset the saved-state baseline too
          // so Cancel/Discard reverts to this version.
          setDashboard((prev) => ({ ...prev, ...payload }));
          setOriginalPanels(editablePanels.map(p => ({ ...p })));
          // A save is a commit point — the selection was a working aid for
          // the edits just persisted, so it shouldn't linger with its move
          // affordance still armed.
          clearPanelSelection();
          pushToast({ kind: 'success', title: 'Dashboard saved', duration: 2000 });
          maybeAutoThumbnail();
          return id;
        }
        setIsEditMode(false);
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
        // Refresh the dashboard thumbnail in the background (only if the
        // layout/components actually changed — see maybeAutoThumbnail). The
        // grid is still mounted (save drops edit→view-preview within the
        // editor, not out of DESIGN), so the capture sees the saved state.
        maybeAutoThumbnail();
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
      if (ok) goToPreview();
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
      goToPreview();
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

  // Find the first free rectangle of w×h, scanning row-major from the source
  // panel so the copy lands near its original. Falls back to directly below
  // the source (the grid grows) when the visible canvas is full.
  const findFreeSlot = (w, h, from, panels) => {
    const fits = (x, y) => !panels.some(
      p => p.x < x + w && p.x + p.w > x && p.y < y + h && p.y + p.h > y
    );
    for (let y = from.y; y <= maxGridRow - h; y += 1) {
      // On the source's own row, start scanning to its right.
      const startX = y === from.y ? from.x + from.w : 0;
      for (let x = startX; x <= maxGridCol - w; x += 1) {
        if (fits(x, y)) return { x, y };
      }
    }
    return { x: from.x, y: from.y + from.h };
  };

  // Duplicate a panel, and its component with it.
  //
  // The component copy is created IMMEDIATELY (not deferred to dashboard save),
  // matching the picker's "create a duplicate" checkbox: the new panel points
  // at a real component you can open and edit right away. Note the asymmetry
  // that follows — cancelling the dashboard edit drops the panel but leaves the
  // component in the library, same as the picker.
  //
  // Text panels duplicate their text; empty panels duplicate their geometry.
  const [duplicatingPanelId, setDuplicatingPanelId] = useState(null);
  const duplicatingPanelRef = useRef(false);
  const duplicatePanel = async (panelId) => {
    if (duplicatingPanelRef.current) return;
    const src = editablePanels.find(p => p.id === panelId);
    if (!src) return;
    duplicatingPanelRef.current = true;
    setDuplicatingPanelId(panelId);
    try {
      let newComponentId = null;
      if (src.component_id) {
        const source = chartsMap[src.component_id]
          || await apiClient.getComponent(src.component_id);
        // Collision set is the components already loaded for this dashboard —
        // a server-side (namespace, name) clash still surfaces as an error.
        const existingNames = new Set(
          Object.values(chartsMap).map(c => c?.name).filter(Boolean)
        );
        const created = await apiClient.createComponent(
          buildComponentCopy(source, existingNames)
        );
        newComponentId = created.id;
        setChartsMap(prev => ({ ...prev, [created.id]: created }));
      }

      const slot = findFreeSlot(src.w, src.h, src, editablePanels);
      const newPanelId = `panel-${Date.now()}`;
      setEditablePanels(prev => [...prev, {
        ...src,
        id: newPanelId,
        component_id: newComponentId,
        x: slot.x,
        y: slot.y,
        // Swap rules reference this panel's own component; they don't carry
        // over to a copy pointing at a different one.
        component_overrides: undefined,
      }]);

      // Carry the panel's border, if it has one. A panel_border is part of how
      // the panel LOOKS, so a copy without it isn't really a copy. It binds by
      // panel_id and derives its geometry from the panel, so the copy just
      // needs a fresh id pointed at the new panel — the styling (color, width,
      // line_style) comes across as-is.
      const srcBorder = editableAdornments.find(
        a => a.kind === 'panel_border' && a.panel_id === panelId
      );
      if (srcBorder) {
        setEditableAdornments(prev => [...prev, {
          ...srcBorder,
          id: `adorn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          panel_id: newPanelId,
        }]);
      }
      setEditHasChanges(true);
    } catch (err) {
      console.error('[DashboardViewerPage] Panel duplicate failed:', err);
      pushToast({
        kind: 'error',
        title: 'Duplicate failed',
        subtitle: err.message || 'Could not duplicate the panel',
      });
    } finally {
      duplicatingPanelRef.current = false;
      setDuplicatingPanelId(null);
    }
  };

  // Panel delete, with an offer to clean up a component the delete would
  // orphan. Two conditions have to hold before we even ask:
  //   1. no OTHER panel on this dashboard uses the component, and
  //   2. no other dashboard references it (server lookup).
  // Otherwise the delete is unambiguous and runs immediately — a dialog on
  // every panel delete would be pure friction.
  const [panelDeleteTarget, setPanelDeleteTarget] = useState(null); // {panelId, componentId, componentName}
  const [panelDeleteChecking, setPanelDeleteChecking] = useState(false);
  const requestDeletePanel = async (panelId) => {
    const panel = editablePanels.find(p => p.id === panelId);
    const componentId = panel?.component_id;
    if (!componentId) return deletePanel(panelId);

    // Cheap local check first: another panel here still needs it.
    const usedElsewhereHere = editablePanels.some(
      p => p.id !== panelId && p.component_id === componentId
    );
    if (usedElsewhereHere) return deletePanel(panelId);

    const name = chartsMap[componentId]?.name || 'this component';
    setPanelDeleteTarget({ panelId, componentId, componentName: name });
    setPanelDeleteChecking(true);
    try {
      const usage = await apiClient.getComponentUsage(componentId);
      // Referenced by a dashboard OTHER than this one → not orphaned, so
      // there's nothing to offer; just delete the panel.
      const others = (usage?.dashboards || []).filter(
        d => d.unauthorized || d.id !== id
      );
      if (others.length > 0) {
        setPanelDeleteTarget(null);
        deletePanel(panelId);
      }
    } catch (err) {
      // Can't confirm it's an orphan → don't offer to delete it. Removing the
      // panel is still safe and is what the user asked for.
      console.error('[DashboardViewerPage] usage lookup failed:', err);
      setPanelDeleteTarget(null);
      deletePanel(panelId);
    } finally {
      setPanelDeleteChecking(false);
    }
    return undefined;
  };

  const confirmDeletePanel = async (alsoDeleteComponent) => {
    const target = panelDeleteTarget;
    setPanelDeleteTarget(null);
    if (!target) return;
    deletePanel(target.panelId);
    if (!alsoDeleteComponent) return;
    try {
      await apiClient.deleteComponent(target.componentId);
      setChartsMap(prev => {
        const next = { ...prev };
        delete next[target.componentId];
        return next;
      });
      pushToast({
        kind: 'success',
        title: 'Component deleted',
        subtitle: `"${target.componentName}" was removed from the library.`,
      });
    } catch (err) {
      // The panel is already gone (local, undone by cancelling the edit). Say
      // plainly that the component itself survived rather than implying the
      // whole delete failed.
      console.error('[DashboardViewerPage] component delete failed:', err);
      pushToast({
        kind: 'error',
        title: 'Component not deleted',
        subtitle: `The panel was removed, but "${target.componentName}" could not be deleted: ${err.message}`,
      });
    }
  };

  // Delete a panel
  const deletePanel = (panelId) => {
    setEditablePanels(prev => prev.filter(p => p.id !== panelId));
    // Drop any panel_border bound to it. The server prunes orphans on save
    // too, but doing it here keeps the in-editor state honest — otherwise a
    // border would linger invisibly until the round trip.
    setEditableAdornments(prev => prev.filter(
      a => !(a.kind === 'panel_border' && a.panel_id === panelId)
    ));
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

  // Single source of truth for rect→cell geometry.
  //
  // `.dashboard-grid` has no padding (see the SCSS for why — the canvas
  // budget can't spare it), so the cell tracks fill the element's box
  // exactly and the origin is the rect's own top-left.
  //
  // Every gesture — panel drag, panel resize, panel draw, adornment
  // draw/move/resize — goes through here, so a geometry change lands in one
  // place instead of six.
  const gridCellGeometry = useCallback(() => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    return {
      originX: rect.left,
      originY: rect.top,
      cellW: rect.width / maxGridCol,
      cellH: rect.height / maxGridRow,
    };
  }, [maxGridCol, maxGridRow]);

  const getGridPosition = useCallback((e) => {
    const g = gridCellGeometry();
    if (!g) return null;
    const x = Math.floor((e.clientX - g.originX) / g.cellW);
    const y = Math.floor((e.clientY - g.originY) / g.cellH);
    return { x: Math.max(0, Math.min(x, maxGridCol - 1)), y: Math.max(0, y) };
  }, [gridCellGeometry, maxGridCol]);

  // Like getGridPosition, but also reports WHERE inside the cell the pointer
  // landed. A cell is 32px of panel plus a 4px gutter, so a press in that
  // last ~11% of the stride is really "on the seam between two cells" — the
  // author is aiming at an edge, not at either cell.
  //
  // getGridPosition floors, so a gutter press silently resolves to whichever
  // cell the pixel math happens to land in. That's fine for dragging a panel
  // (it's grabbing the panel body, never the gutter) but it makes starting a
  // border ON an edge feel arbitrary. Kept separate rather than folded into
  // getGridPosition so the panel gestures keep their existing behavior.
  const getGridPositionDetailed = useCallback((e) => {
    const g = gridCellGeometry();
    if (!g) return null;
    const rawX = (e.clientX - g.originX) / g.cellW;
    const rawY = (e.clientY - g.originY) / g.cellH;
    const x = Math.floor(rawX);
    const y = Math.floor(rawY);
    // Fraction of the way through the cell, 0..1. The gutter is the tail of
    // the stride (32px cell + 4px gap = 36), so >= 32/36 is in the gap.
    // Same geometry as AdornmentLayer's CELL_WIDTH/GAP and DashboardGrid's.
    const GUTTER_START = 32 / 36;
    return {
      x: Math.max(0, Math.min(x, maxGridCol - 1)),
      y: Math.max(0, y),
      inGutterX: rawX - x >= GUTTER_START,
      inGutterY: rawY - y >= GUTTER_START,
    };
  }, [gridCellGeometry, maxGridCol]);

  // Snap a border edge to the NEAREST cell boundary rather than flooring into
  // whatever cell the pointer happens to be inside.
  //
  // Flooring makes an edge feel like it lags the cursor: to place a right edge
  // at the end of column 6 you had to drag all the way to the START of column
  // 6's successor — roughly a full 36px stride PAST the edge you were aiming
  // at. Worst at the canvas edge, where there is no next cell to reach into,
  // so the last column/row was the hardest of all to land on.
  //
  // `kind` picks which boundary the grip owns:
  //   'far'  (right/bottom) — the edge is the END of a cell, at k*S + CELL
  //   'near' (left/top)     — the edge is the START of a cell, at k*S
  //
  // TOL gives 4px of grace on the APPROACHING side, so being a hair short of
  // the line still snaps to it — landing exactly on a 1px boundary is not a
  // reasonable ask of a mouse. Anywhere else in the stride resolves to
  // whichever boundary is nearer.
  const EDGE_SNAP_TOL = 4;
  const snapEdgeToCell = useCallback((px, origin, stride, kind) => {
    const rel = px - origin;
    const k = Math.floor(rel / stride);
    const frac = rel - k * stride;
    // Cell body is CELL_SIZE of the stride; the remainder is the gutter.
    const body = stride * (32 / 36);
    if (kind === 'far') {
      if (frac >= body - EDGE_SNAP_TOL) return k;      // on/near this cell's end
      if (frac <= EDGE_SNAP_TOL) return k - 1;         // just past the previous end
      return frac >= stride / 2 ? k : k - 1;           // nearest
    }
    if (frac <= EDGE_SNAP_TOL) return k;               // on/just past this start
    if (frac >= stride - EDGE_SNAP_TOL) return k + 1;  // near the next start
    return frac >= stride / 2 ? k + 1 : k;             // nearest
  }, []);

  const startDragging = (e, panel) => {
    // A shift-press is the marquee gesture and must reach the grid handler.
    // Panels normally claim their own presses, so without this passthrough a
    // selection box could never be started on top of a panel.
    if (e.shiftKey) return;

    e.stopPropagation();
    e.preventDefault();
    didDragRef.current = false;
    const pos = getGridPosition(e);
    if (!pos) return;

    // Pressing a panel that is part of the current selection moves the WHOLE
    // selection. Pressing an unselected panel is an ordinary single drag and
    // drops the selection — "click outside" in the sense that matters, since
    // the intent is clearly to work on that panel instead.
    if (selectedPanelIds.length > 0 && selectedPanelIds.includes(panel.id)) {
      setBatchMove({
        startX: pos.x,
        startY: pos.y,
        // Snapshot the group's geometry at grab time. Deltas are applied to
        // THIS, not to the live panels, so accumulated rounding can't make
        // the group creep or drift apart over a long drag.
        origins: editablePanels
          .filter(p => selectedPanelIds.includes(p.id))
          .map(p => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h })),
        // Same snapshot treatment for the carried borders.
        adornOrigins: editableAdornments
          .filter(a => carriedAdornmentIds.includes(a.id))
          .map(a => ({ id: a.id, x: a.x, y: a.y, w: a.w, h: a.h })),
      });
      return;
    }
    if (selectedPanelIds.length > 0) clearPanelSelection();

    setDraggingPanel({
      id: panel.id,
      offsetX: pos.x - panel.x,
      offsetY: pos.y - panel.y
    });
  };

  // edge: which grip is being dragged — 'corner' (bottom-right, resizes both
  // axes), 'right' (w only), 'bottom' (h only), 'left' (moves x, right edge
  // anchored → x+w changes). Offset is captured against the edge that MOVES so
  // the first mouse movement doesn't snap a cell: right/corner anchor the right
  // edge, bottom/corner anchor the bottom edge, left anchors the left edge.
  const startResizing = (e, panel, edge = 'corner') => {
    e.stopPropagation();
    e.preventDefault();
    const g = gridCellGeometry();
    if (g) {
      // The moving edge's current pixel position, per grip. Left/top move the
      // near edge (x / y); right/bottom/corner move the far edge (x+w / y+h).
      const movingLeft = edge === 'left';
      const movingTop = edge === 'top';
      const edgePixelX = g.originX + (movingLeft ? panel.x : panel.x + panel.w) * g.cellW;
      const edgePixelY = g.originY + (movingTop ? panel.y : panel.y + panel.h) * g.cellH;
      const offsetX = e.clientX - edgePixelX;
      const offsetY = e.clientY - edgePixelY;
      setResizingPanel({ id: panel.id, edge, offsetX, offsetY });
    } else {
      setResizingPanel({ id: panel.id, edge, offsetX: 0, offsetY: 0 });
    }
  };

  // Start drawing a new panel by clicking empty grid space
  const handleGridMouseDown = (e) => {
    if (!isEditMode) return;

    // SHIFT-DRAG = marquee select. Allowed to start anywhere, including over
    // a panel — panels let shift-presses fall through (see the drag overlay)
    // precisely so a selection box can start on top of one.
    if (e.shiftKey) {
      const pos = getGridPosition(e);
      if (!pos) return;
      e.preventDefault();
      setMarquee({ startX: pos.x, startY: pos.y, x: pos.x, y: pos.y, w: 1, h: 1 });
      return;
    }

    // A live selection absorbs the next outside click: it DESELECTS and does
    // nothing else. Only the click after that draws. Without this, a click
    // that lands slightly outside the selection both loses the selection and
    // silently leaves a stray 1-cell panel behind — the same two-stage rule
    // borders use, so the editor behaves consistently.
    if (selectedPanelIds.length > 0) {
      clearPanelSelection();
      return;
    }

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
    if (!isEditMode || (!draggingPanel && !resizingPanel && !drawingPanel
        && !marquee && !batchMove)) return;

    // Clamp against the STABLE edit budget, never maxGridCol — maxGridCol
    // grows with panel extent (to render legacy oversized panels), so using
    // it here let a resize push the panel past the budget, which grew
    // maxGridCol further: the runaway-reflow loop. editBudgetCols is the
    // fixed dimension budget (or a generous constant before it resolves).
    const boundCols = editBudgetCols;
    const boundRows = editBudgetRows;

    const handleMouseMove = (e) => {
      const pos = getGridPosition(e);
      if (!pos) return;

      if (marquee) {
        setMarquee(prev => ({
          ...prev,
          x: Math.min(prev.startX, pos.x),
          y: Math.min(prev.startY, pos.y),
          w: Math.abs(pos.x - prev.startX) + 1,
          h: Math.abs(pos.y - prev.startY) + 1,
        }));
        return;
      }

      if (batchMove) {
        // One delta for the whole group, applied to the grab-time snapshot.
        // Clamped so the group as a WHOLE stays on canvas: the delta is
        // limited by whichever member would hit an edge first, which keeps
        // the panels' relative positions rigid. Clamping each panel
        // independently would squash the group against the edge instead.
        let dx = pos.x - batchMove.startX;
        let dy = pos.y - batchMove.startY;
        for (const o of batchMove.origins) {
          dx = Math.max(dx, -o.x);
          dy = Math.max(dy, -o.y);
          dx = Math.min(dx, boundCols - (o.x + o.w));
          dy = Math.min(dy, boundRows - (o.y + o.h));
        }
        // NO early return on a zero delta. dx/dy are measured from the
        // GRAB POINT, not from the panels' current position, so dx === 0
        // means "back where the drag started" — which is precisely when the
        // panels are displaced and need writing back. Returning early there
        // stranded the group at its last non-zero offset: it would move out
        // happily and then refuse to come home.
        setEditablePanels(prev => prev.map(p => {
          const o = batchMove.origins.find(v => v.id === p.id);
          if (!o) return p;
          const nx = o.x + dx;
          const ny = o.y + dy;
          return (nx === p.x && ny === p.y) ? p : { ...p, x: nx, y: ny };
        }));
        // Carried borders take the SAME delta, deliberately without their own
        // clamp: the delta is already bounded by the panels, and re-clamping
        // per border would let a border stop short of the group and break the
        // alignment that carrying them exists to preserve.
        if (batchMove.adornOrigins?.length) {
          setEditableAdornments(prev => prev.map(a => {
            const o = batchMove.adornOrigins.find(v => v.id === a.id);
            if (!o) return a;
            const nx = o.x + dx;
            const ny = o.y + dy;
            return (nx === a.x && ny === a.y) ? a : { ...a, x: nx, y: ny };
          }));
        }
        setEditHasChanges(true);
        return;
      }

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
          // Raw pixel position adjusted by the initial offset for smooth resizing.
          const g = gridCellGeometry();
          if (!g) return;
          const adjustedX = e.clientX - (resizingPanel.offsetX || 0);
          const adjustedY = e.clientY - (resizingPanel.offsetY || 0);
          const gridX = Math.floor((adjustedX - g.originX) / g.cellW);
          const gridY = Math.floor((adjustedY - g.originY) / g.cellH);
          const edge = resizingPanel.edge || 'corner';

          // Start from the panel's current geometry; each grip mutates only
          // the axis/edge it owns. Right edge (x+w) grows via w; bottom edge
          // (y+h) grows via h; left edge moves x while keeping the RIGHT edge
          // anchored (so x and w both change, x+w constant).
          let next = { x: panel.x, y: panel.y, w: panel.w, h: panel.h };
          if (edge === 'right' || edge === 'corner') {
            next.w = Math.max(minSize.w, Math.min(gridX - panel.x + 1, boundCols - panel.x));
          }
          if (edge === 'bottom' || edge === 'corner') {
            next.h = Math.max(minSize.h, Math.min(gridY - panel.y + 1, boundRows - panel.y));
          }
          if (edge === 'left') {
            const rightEdge = panel.x + panel.w; // anchored
            // Proposed new left column from the mouse, clamped to [0, rightEdge - minW].
            const newX = Math.max(0, Math.min(gridX, rightEdge - minSize.w));
            next.x = newX;
            next.w = rightEdge - newX;
          }
          if (edge === 'top') {
            const bottomEdge = panel.y + panel.h; // anchored (mirror of 'left')
            const newY = Math.max(0, Math.min(gridY, bottomEdge - minSize.h));
            next.y = newY;
            next.h = bottomEdge - newY;
          }

          if (next.x !== panel.x || next.y !== panel.y || next.w !== panel.w || next.h !== panel.h) {
            updateEditablePanel(resizingPanel.id, next);
          }
        }
      }
    };

    const handleMouseUp = () => {
      if (marquee) {
        // FULLY ENCLOSED only — a panel the box merely clips is not selected.
        // Predictable enough to trust without checking, and it makes "grab
        // everything in this area" a deliberate act rather than a guess.
        const mx2 = marquee.x + marquee.w;
        const my2 = marquee.y + marquee.h;
        const encloses = (r) => r.x >= marquee.x && r.x + r.w <= mx2
                             && r.y >= marquee.y && r.y + r.h <= my2;
        const hits = editablePanels.filter(encloses).map(p => p.id);
        setSelectedPanelIds(hits);
        // Gutter borders fully inside the box are CARRIED, not selected: no
        // outline, no style bar, no entry in selectedPanelIds. A border is a
        // decoration AROUND panels rather than a peer of them, so it should
        // travel with the group it frames — otherwise a batch move visibly
        // tears a framed group apart from its own border. panel_border kinds
        // need no handling: they have no rect and follow their panel already.
        setCarriedAdornmentIds(
          editableAdornments
            .filter(a => a.kind === 'border'
                      && Number.isFinite(a.x) && Number.isFinite(a.y)
                      && Number.isFinite(a.w) && Number.isFinite(a.h)
                      && encloses(a))
            .map(a => a.id)
        );
        setMarquee(null);
        return;
      }
      if (batchMove) {
        setBatchMove(null);
        return;
      }
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
  }, [isEditMode, draggingPanel, resizingPanel, drawingPanel, marquee, batchMove, editablePanels, maxGridCol, maxGridRow, gridCols, gridRows, editBudgetCols, editBudgetRows, getGridPosition, gridCellGeometry]);

  // Escape clears a panel selection. Ignored while typing so it can never
  // eat an Escape meant for a field or modal.
  useEffect(() => {
    if (!isEditMode || selectedPanelIds.length === 0) return undefined;
    const onKeyDown = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') clearPanelSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isEditMode, selectedPanelIds, clearPanelSelection]);

  // Leaving edit mode or switching dashboards must not strand a selection.
  useEffect(() => {
    if (!isEditMode) clearPanelSelection();
  }, [isEditMode, clearPanelSelection]);

  // ── Adornment (decoration) editing ───────────────────────────────

  const updateAdornment = useCallback((adornmentId, updates) => {
    // Refuse to write a non-finite rect. A single NaN here is permanent
    // corruption, not a transient glitch: `NaN !== NaN`, so every later
    // "did it change?" comparison reports true, every drag rewrites NaN, and
    // the border can never be moved or resized again — it just sits there
    // while the cursor says it should be dragging. Cheaper to reject the bad
    // write than to explain the dead border later.
    for (const k of ['x', 'y', 'w', 'h']) {
      if (k in updates && !Number.isFinite(updates[k])) {
        console.warn(`[adornment] refusing non-finite ${k}:`, updates[k], updates);
        return;
      }
    }
    setEditableAdornments(prev =>
      prev.map(a => (a.id === adornmentId ? { ...a, ...updates } : a))
    );
    setEditHasChanges(true);
  }, []);

  const deleteAdornment = useCallback((adornmentId) => {
    setEditableAdornments(prev => prev.filter(a => a.id !== adornmentId));
    setSelectedAdornmentId(prev => (prev === adornmentId ? null : prev));
    setEditHasChanges(true);
  }, []);

  // Apply a style change to the selected border AND remember it, so the next
  // border drawn matches rather than reverting to the default.
  const applyAdornmentStyle = useCallback((updates) => {
    // Remember color/style for the next border drawn, but NOT width — the two
    // kinds use different width scales (2/4/6 vs 1/2/3), so carrying a panel
    // border's 1px over to a gutter border would be an illegal value.
    const { width: _w, ...remembered } = updates;
    if (Object.keys(remembered).length) {
      setLastAdornmentStyle(prev => ({ ...prev, ...remembered }));
    }
    if (selectedAdornmentId) updateAdornment(selectedAdornmentId, updates);
  }, [selectedAdornmentId, updateAdornment]);

  // Entering adornment mode cancels any in-flight panel gesture — the two
  // modes must never be mid-drag at the same time.
  const toggleAdornmentMode = useCallback(() => {
    setAdornmentMode(prev => {
      const next = !prev;
      if (next) {
        setDraggingPanel(null);
        setResizingPanel(null);
        setDrawingPanel(null);
        // Drop any multi-selection too. Shift means "marquee" in normal mode
        // and "extend/shrink the border" in adornment mode, so a selection
        // that survived the switch would leave two gestures fighting over the
        // same modifier — and the selected panels would keep their move
        // affordance while panels are supposed to be inert.
        clearPanelSelection();
        setMarquee(null);
        setBatchMove(null);
      } else {
        setSelectedAdornmentId(null);
        setDraggingAdornment(null);
        setResizingAdornment(null);
        setDrawingAdornment(null);
      }
      return next;
    });
  }, [clearPanelSelection]);

  // Mouse-down on an existing border: select it, and start a move or a
  // resize depending on which grip was hit.
  const handleAdornmentMouseDown = useCallback((adornment, e) => {
    e.preventDefault();
    setSelectedAdornmentId(adornment.id);

    const edge = e.target?.dataset?.adornmentGrip || null;
    const pos = getGridPosition(e);
    if (!pos) return;

    // Only a rect border can be moved or resized. A panel_border has NO
    // geometry — the server zeroes x/y/w/h for that kind, because it renders
    // as its panel's own CSS border and follows the panel. Reading
    // `adornment.w` on one yields undefined, which turns the grab offset into
    // NaN and poisons every later comparison: the resize then computes NaN
    // bounds, the "did anything change" guard rejects them, and the edge
    // appears frozen — grip cursor showing, nothing moving.
    if (adornment.kind !== 'border') return;

    if (edge) {
      // Capture the grab point's pixel offset from the edge being moved, the
      // same way startResizing does for panels. Without it, a grip click that
      // lands past the edge's cell midpoint floors to the NEXT cell and the
      // border jumps a full cell before the mouse has moved at all — about
      // half the grip band's grab area.
      let offsetX = 0;
      let offsetY = 0;
      const g = gridCellGeometry();
      if (g) {
        const movingLeft = edge === 'left';
        const movingTop = edge === 'top';
        const edgePixelX = g.originX + (movingLeft ? adornment.x : adornment.x + adornment.w) * g.cellW;
        const edgePixelY = g.originY + (movingTop ? adornment.y : adornment.y + adornment.h) * g.cellH;
        offsetX = e.clientX - edgePixelX;
        offsetY = e.clientY - edgePixelY;
      }
      setResizingAdornment({ id: adornment.id, edge, offsetX, offsetY });
    } else {
      setDraggingAdornment({
        id: adornment.id,
        offsetX: pos.x - adornment.x,
        offsetY: pos.y - adornment.y,
      });
    }
  }, [getGridPosition, gridCellGeometry]);

  // Live preview of a pending shift-click extend: the cell the cursor is over
  // while Shift is held. Null whenever the gesture isn't armed.
  const [extendHoverCell, setExtendHoverCell] = useState(null);

  // What a shift-click or double-click is pointing AT: the full rect of the
  // panel under the cursor, or the single clicked cell when there is none.
  const extendTargetRect = useCallback((panelId, pos) => {
    if (panelId) {
      const panel = editablePanels.find(p => p.id === panelId);
      if (panel) return { x: panel.x, y: panel.y, w: panel.w, h: panel.h };
    }
    return { x: pos.x, y: pos.y, w: 1, h: 1 };
  }, [editablePanels]);

  // Collapse a border inward so `pos` becomes a CORNER of the result: the
  // nearer horizontal edge and the nearer vertical edge each move in to meet
  // it. Ties resolve toward left/top. Returns null when the cell is outside
  // the border or the shrink would be a no-op.
  //
  // Shared by both shrink gestures (shift-click inside, double-click inside)
  // so the two can never disagree about what "shrink to here" means.
  const collapseToCorner = useCallback((a, pos, target = null) => {
    const right = a.x + a.w - 1;
    const bottom = a.y + a.h - 1;
    if (pos.x < a.x || pos.x > right || pos.y < a.y || pos.y > bottom) return null;

    const next = { x: a.x, y: a.y, w: a.w, h: a.h };

    // Snap to the clicked PANEL's outer edge when there is one, not to the
    // single cell under the cursor. Grow already works this way (it unions
    // the whole panel rect), so shrinking to a bare cell would cut a panel in
    // half and leave the two gestures disagreeing about what "the thing you
    // clicked" means. `target` is the panel rect; without it, fall back to
    // the cell, which is the right answer on bare grid.
    const tLeft = target ? target.x : pos.x;
    const tRight = target ? target.x + target.w - 1 : pos.x;
    const tTop = target ? target.y : pos.y;
    const tBottom = target ? target.y + target.h - 1 : pos.y;

    // Distance is still measured from the CURSOR — that's what says which
    // edge the author is pulling — but the boundary lands on the panel edge.
    if (pos.x - a.x <= right - pos.x) {
      next.x = tLeft;
      next.w = right - tLeft + 1;
    } else {
      next.w = tRight - a.x + 1;
    }

    if (pos.y - a.y <= bottom - pos.y) {
      next.y = tTop;
      next.h = bottom - tTop + 1;
    } else {
      next.h = tBottom - a.y + 1;
    }

    next.w = Math.max(ADORNMENT_MIN_CELLS, next.w);
    next.h = Math.max(ADORNMENT_MIN_CELLS, next.h);

    const unchanged = next.x === a.x && next.y === a.y
      && next.w === a.w && next.h === a.h;
    return unchanged ? null : next;
  }, []);

  // DOUBLE-CLICK SHRINK — collapse the selected border inward so the clicked
  // cell becomes a CORNER of the result.
  //
  // Both the nearest horizontal edge (left or right) and the nearest vertical
  // edge (top or bottom) move in on the same gesture, so one double-click
  // fully re-corners the box. Grips remain the way to move a single edge with
  // precision; this is the coarse fast path.
  //
  // Only fires for a click strictly INSIDE the selected border — a
  // double-click anywhere else is left alone, so it can't silently mangle a
  // box the author wasn't aiming at.
  const handleAdornmentDoubleClick = useCallback((e) => {
    if (!selectedAdornmentId) return;
    const a = editableAdornments.find(v => v.id === selectedAdornmentId);
    if (!a || a.kind !== 'border') return;

    const pos = getGridPosition(e);
    if (!pos) return;

    // Snap to the panel under the cursor, matching shift-click shrink.
    const panelEl = e.target?.closest?.('[data-panel-id]');
    const next = collapseToCorner(
      a, pos, extendTargetRect(panelEl?.dataset?.panelId || null, pos)
    );
    if (!next) return;

    e.preventDefault();
    updateAdornment(a.id, next);
  }, [
    selectedAdornmentId, editableAdornments, getGridPosition,
    updateAdornment, collapseToCorner, extendTargetRect,
  ]);

  // Track the cursor cell while Shift is held with a border selected, so the
  // panels a shift-click would consume can be outlined before committing.
  // Armed only in that exact state — outside it the listeners aren't attached
  // at all, so this costs nothing during normal editing.
  useEffect(() => {
    if (!isEditMode || !adornmentMode || !selectedAdornmentId) return undefined;

    const clear = () => setExtendHoverCell(null);

    const onMove = (e) => {
      if (!e.shiftKey) { clear(); return; }
      const pos = getGridPosition(e);
      if (!pos) { clear(); return; }
      const panelEl = e.target?.closest?.('[data-panel-id]');
      setExtendHoverCell({ ...pos, panelId: panelEl?.dataset?.panelId || null });
    };
    // Releasing Shift must drop the preview even if the mouse never moves.
    const onKeyUp = (e) => { if (e.key === 'Shift') clear(); };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      clear();
    };
  }, [isEditMode, adornmentMode, selectedAdornmentId, getGridPosition]);

  // Panels that a shift-click at the hovered cell would end up crossing.
  // Computed from the UNION rect (current border + extend target), so it
  // shows exactly what the commit will overlap.
  const adornmentPreviewPanelIds = useMemo(() => {
    if (!extendHoverCell || !selectedAdornmentId) return null;
    const a = editableAdornments.find(v => v.id === selectedAdornmentId);
    if (!a || a.kind !== 'border') return null;

    // Inside the border, shift-click shrinks rather than extends — and a
    // shrink never sweeps in new panels, so there is nothing to warn about.
    const inside = extendHoverCell.x >= a.x && extendHoverCell.x < a.x + a.w
      && extendHoverCell.y >= a.y && extendHoverCell.y < a.y + a.h;
    if (inside) return null;

    const target = extendTargetRect(extendHoverCell.panelId, extendHoverCell);
    const x = Math.min(a.x, target.x);
    const y = Math.min(a.y, target.y);
    const right = Math.max(a.x + a.w, target.x + target.w);
    const bottom = Math.max(a.y + a.h, target.y + target.h);

    const ids = new Set();
    for (const p of editablePanels) {
      // Half-open interval overlap on both axes.
      if (p.x < right && p.x + p.w > x && p.y < bottom && p.y + p.h > y) {
        ids.add(p.id);
      }
    }
    return ids.size ? ids : null;
  }, [
    extendHoverCell, selectedAdornmentId, editableAdornments,
    editablePanels, extendTargetRect,
  ]);

  // Mouse-down anywhere in the grid while in adornment mode: deselect and
  // start drawing a new border.
  //
  // Note this does NOT require `e.target === gridRef.current` the way the
  // panel draw-out does. In adornment mode panels are inert and a border's
  // interior is click-through, so the target is whatever happens to sit
  // under the cursor — a panel, a chart, the grid itself. Requiring bare
  // grid would make it impossible to draw a box over existing panels, or to
  // nest a box inside another border. Anything that should NOT start a draw
  // (edge strips, resize grips) stops propagation before reaching here.
  const handleAdornmentGridMouseDown = useCallback((e) => {
    const pos = getGridPositionDetailed(e);
    if (!pos) return;

    // Record the panel under the press (if any). If the gesture turns out to
    // be a click rather than a drag, mouseup attaches a border to it instead
    // of committing a 1x1 box.
    const panelEl = e.target?.closest?.('[data-panel-id]');
    const panelId = panelEl?.dataset?.panelId || null;

    // SHIFT-CLICK EXTEND — grow the selected border to swallow the clicked
    // target, then stop. No draw gesture starts, so the shift-click can't
    // also leave a stray box behind.
    //
    // The target is the whole PANEL when one is under the cursor, otherwise
    // the single cell. Consuming the panel's full rect is the point of the
    // gesture: clicking any part of a panel means "include that panel",
    // which would otherwise take several clicks along its edge.
    //
    // Extending across an unrelated panel is allowed and deliberate — a
    // rectangle can't dodge one, and trying to make it would produce results
    // that are far harder to explain than an overlap the author can see.
    if (e.shiftKey && selectedAdornmentId) {
      const a = editableAdornments.find(v => v.id === selectedAdornmentId);
      if (a && a.kind === 'border') {
        // INSIDE the border, shift-click SHRINKS: the clicked cell becomes a
        // corner, exactly as double-click does. One modifier with one
        // meaning — "shift-click sets the boundary" — rather than shift
        // growing and a different gesture shrinking. The union below can
        // only ever grow, so without this branch a click inside would be a
        // silent no-op (the target is already contained).
        const inside = pos.x >= a.x && pos.x < a.x + a.w
          && pos.y >= a.y && pos.y < a.y + a.h;

        if (inside) {
          // Same target resolution as the grow branch below, so shrinking to
          // a panel lands on its outer edge rather than mid-panel.
          const next = collapseToCorner(a, pos, extendTargetRect(panelId, pos));
          if (next) updateAdornment(a.id, next);
          return;
        }

        const target = extendTargetRect(panelId, pos);
        if (target) {
          const x = Math.min(a.x, target.x);
          const y = Math.min(a.y, target.y);
          const right = Math.max(a.x + a.w, target.x + target.w);
          const bottom = Math.max(a.y + a.h, target.y + target.h);
          updateAdornment(a.id, {
            x,
            y,
            w: Math.min(right - x, editBudgetCols - x),
            h: Math.min(bottom - y, editBudgetRows - y),
          });
        }
      }
      return;
    }

    // The SECOND press of a double-click must not start anything. A
    // double-click is the shrink gesture, and it arrives as two full
    // mousedown/mouseup pairs — without this the first pair would already
    // have deselected the border and seeded a stray 1x1, leaving the
    // dblclick handler with nothing selected to shrink.
    //
    // Deselection is skipped for the whole double-click (detail >= 2), which
    // is what keeps the target border selected long enough to shrink it.
    if (e.detail >= 2) return;

    // A press INSIDE the currently-selected border keeps the selection and
    // never seeds. That interior is the double-click shrink's working area,
    // and the first press of a shrink would otherwise deselect the target
    // and drop a stray 1x1 in it. Dragging still works — a real drag from
    // here draws a nested box on mouseup as before.
    const sel = selectedAdornmentId
      ? editableAdornments.find(v => v.id === selectedAdornmentId)
      : null;
    const insideSelected = sel && sel.kind === 'border'
      && pos.x >= sel.x && pos.x < sel.x + sel.w
      && pos.y >= sel.y && pos.y < sel.y + sel.h;

    if (!insideSelected) setSelectedAdornmentId(null);

    // A plain click on empty grid means DESELECT whenever something is
    // selected — it only seeds a new box when nothing is.
    //
    // Without this, plain click carries three jobs at once (seed / select /
    // deselect) and they collide: with two borders on the canvas, clearing
    // the current selection to get at the other one would itself drop a
    // stray 1x1 box. Deselect-first also keeps the seed gesture honest —
    // "click empty grid to start a box" is only reachable from a clean
    // slate, which is exactly when it's unambiguous.
    //
    // Selecting the OTHER border needs no gesture of its own: every border's
    // edge strips are always hittable, so clicking its edge selects it
    // directly, whether or not something else is selected.
    setDrawingAdornment({
      startX: pos.x, startY: pos.y, x: pos.x, y: pos.y, w: 1, h: 1,
      panelId,
      // Where in the cell the press landed — the draw resolves a gutter
      // press by drag direction once there IS a direction to read.
      inGutterX: pos.inGutterX,
      inGutterY: pos.inGutterY,
      // Suppresses the 1x1 seed on mouseup; a real drag ignores this, so
      // dragging out a box still works from either state.
      noSeed: !!insideSelected || !!selectedAdornmentId,
    });
  }, [
    getGridPositionDetailed, selectedAdornmentId, editableAdornments,
    updateAdornment, extendTargetRect, collapseToCorner,
    editBudgetCols, editBudgetRows,
  ]);

  // Attach a border to a panel, or select the one it already has. Clicking a
  // bordered panel never removes the border — removal is explicit (Delete or
  // the trash button), so an accidental click can't lose a styled border.
  const attachPanelBorder = useCallback((panelId) => {
    const existing = editableAdornments.find(
      a => a.kind === 'panel_border' && a.panel_id === panelId
    );
    if (existing) {
      setSelectedAdornmentId(existing.id);
      return;
    }
    const created = {
      id: `adorn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'panel_border',
      panel_id: panelId,
      color: lastAdornmentStyle.color,
      // Panel borders use their own width scale (1–3, inward from the panel
      // edge), so the gutter-border width can't carry over.
      width: PANEL_BORDER_WIDTHS[0],
      line_style: lastAdornmentStyle.line_style,
    };
    setEditableAdornments(prev => [...prev, created]);
    setSelectedAdornmentId(created.id);
    setEditHasChanges(true);
  }, [editableAdornments, lastAdornmentStyle]);

  // Adornment drag/resize/draw. Deliberately a SEPARATE effect from the panel
  // gesture handler: adornment mode makes panels inert, so the two can never
  // run at once, and keeping them apart avoids threading another set of
  // branches through an already-dense handler.
  useEffect(() => {
    if (!isEditMode || !adornmentMode) return undefined;
    if (!draggingAdornment && !resizingAdornment && !drawingAdornment) return undefined;

    // Same rule as panels: clamp to the STABLE budget, never maxGridCol,
    // which grows with content and would feed a reflow loop.
    const boundCols = editBudgetCols;
    const boundRows = editBudgetRows;

    const handleMouseMove = (e) => {
      const pos = getGridPosition(e);
      if (!pos) return;

      if (drawingAdornment) {
        // A press that landed in the GUTTER is aiming at the seam, not at
        // either neighbouring cell. Resolve it by the drag direction: the
        // cell BEHIND the drag is excluded, so dragging right from a gutter
        // starts at the cell to the right, dragging left starts at the cell
        // to the left. Per-axis, so a diagonal drag resolves each
        // independently. Without this, flooring picks a cell arbitrarily and
        // starting a border on an edge feels like a coin flip.
        let startX = drawingAdornment.startX;
        let startY = drawingAdornment.startY;
        if (drawingAdornment.inGutterX && pos.x > startX) startX += 1;
        if (drawingAdornment.inGutterY && pos.y > startY) startY += 1;

        const x = Math.min(startX, pos.x);
        const y = Math.min(startY, pos.y);
        const w = Math.abs(pos.x - startX) + 1;
        const h = Math.abs(pos.y - startY) + 1;
        setDrawingAdornment(prev => ({
          ...prev, x, y,
          w: Math.min(w, boundCols - x),
          h: Math.min(h, boundRows - y),
        }));
        return;
      }

      if (draggingAdornment) {
        const a = editableAdornments.find(v => v.id === draggingAdornment.id);
        if (!a) return;
        const newX = Math.max(0, Math.min(pos.x - draggingAdornment.offsetX, boundCols - a.w));
        const newY = Math.max(0, Math.min(pos.y - draggingAdornment.offsetY, boundRows - a.h));
        if (newX !== a.x || newY !== a.y) updateAdornment(a.id, { x: newX, y: newY });
        return;
      }

      if (resizingAdornment) {
        const a = editableAdornments.find(v => v.id === resizingAdornment.id);
        if (!a || !gridRef.current) return;
        // Heal a rect that is already corrupt. Records written before the
        // guard in updateAdornment can carry NaN geometry, which makes the
        // border permanently undraggable. Snap it back to something sane on
        // first touch rather than making the user delete and redraw.
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)
            || !Number.isFinite(a.w) || !Number.isFinite(a.h)) {
          updateAdornment(a.id, {
            x: Number.isFinite(a.x) ? a.x : 0,
            y: Number.isFinite(a.y) ? a.y : 0,
            w: Number.isFinite(a.w) ? a.w : 1,
            h: Number.isFinite(a.h) ? a.h : 1,
          });
          return;
        }
        const edge = resizingAdornment.edge;

        // Subtract the grab offset before resolving to a cell, so the edge
        // tracks the pointer smoothly instead of snapping on mousedown.
        const g = gridCellGeometry();
        if (!g) return;
        const px = e.clientX - (resizingAdornment.offsetX || 0);
        const py = e.clientY - (resizingAdornment.offsetY || 0);
        // Far grips (right/bottom) own a cell's END boundary; near grips
        // (left/top) own its START. snapEdgeToCell rounds to whichever
        // boundary is closest instead of flooring into the containing cell,
        // so the edge lands where the cursor is rather than a stride later.
        const farX = snapEdgeToCell(px, g.originX, g.cellW, 'far');
        const farY = snapEdgeToCell(py, g.originY, g.cellH, 'far');
        const nearX = snapEdgeToCell(px, g.originX, g.cellW, 'near');
        const nearY = snapEdgeToCell(py, g.originY, g.cellH, 'near');

        const next = { x: a.x, y: a.y, w: a.w, h: a.h };

        // Each grip owns one edge. Left/top move the near edge while the far
        // edge stays anchored (x and w both change, x+w constant) — the same
        // model the panel resize uses.
        if (edge === 'right' || edge === 'corner') {
          next.w = Math.max(ADORNMENT_MIN_CELLS, Math.min(farX - a.x + 1, boundCols - a.x));
        }
        if (edge === 'bottom' || edge === 'corner') {
          next.h = Math.max(ADORNMENT_MIN_CELLS, Math.min(farY - a.y + 1, boundRows - a.y));
        }
        if (edge === 'left') {
          const rightEdge = a.x + a.w;
          const newX = Math.max(0, Math.min(nearX, rightEdge - ADORNMENT_MIN_CELLS));
          next.x = newX;
          next.w = rightEdge - newX;
        }
        if (edge === 'top') {
          const bottomEdge = a.y + a.h;
          const newY = Math.max(0, Math.min(nearY, bottomEdge - ADORNMENT_MIN_CELLS));
          next.y = newY;
          next.h = bottomEdge - newY;
        }

        if (next.x !== a.x || next.y !== a.y || next.w !== a.w || next.h !== a.h) {
          updateAdornment(a.id, next);
        }
      }
    };

    const handleMouseUp = () => {
      // A press that never grew past 1x1 is a CLICK, not a draw. If it landed
      // on a panel, attach a border to that panel instead of committing a
      // useless 1-cell box.
      const isClick = drawingAdornment
        && drawingAdornment.w < ADORNMENT_MIN_DRAW_CELLS
        && drawingAdornment.h < ADORNMENT_MIN_DRAW_CELLS;
      if (isClick && drawingAdornment.panelId) {
        attachPanelBorder(drawingAdornment.panelId);
        setDrawingAdornment(null);
        setDraggingAdornment(null);
        setResizingAdornment(null);
        return;
      }
      // A click inside the selected border seeds nothing — it's the first
      // half of a possible double-click shrink. Drags are unaffected.
      if (isClick && drawingAdornment?.noSeed) {
        setDrawingAdornment(null);
        setDraggingAdornment(null);
        setResizingAdornment(null);
        return;
      }
      // Otherwise commit the box. A click that never moved commits as a 1x1
      // seed surrounding the clicked cell — the starting point for building a
      // box by shift-click instead of by dragging. (A click on a PANEL is
      // handled above and never reaches here, so the two click meanings stay
      // disjoint.)
      if (drawingAdornment) {
        const created = {
          // Random suffix, not a bare timestamp: two borders drawn in the
          // same millisecond would otherwise share an id, and selection +
          // updateAdornment both resolve by find() → first match wins.
          id: `adorn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'border',
          x: drawingAdornment.x,
          y: drawingAdornment.y,
          w: drawingAdornment.w,
          h: drawingAdornment.h,
          ...lastAdornmentStyle,
        };
        setEditableAdornments(prev => [...prev, created]);
        setSelectedAdornmentId(created.id);
        setEditHasChanges(true);
      }
      setDrawingAdornment(null);
      setDraggingAdornment(null);
      setResizingAdornment(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [
    isEditMode, adornmentMode, draggingAdornment, resizingAdornment, drawingAdornment,
    editableAdornments, editBudgetCols, editBudgetRows, getGridPosition, gridCellGeometry,
    updateAdornment, lastAdornmentStyle, maxGridCol, maxGridRow,
    attachPanelBorder, snapEdgeToCell,
  ]);

  // Delete / Escape on the selected border. Ignored while typing in a field
  // so it can never eat a Backspace meant for a text input.
  useEffect(() => {
    if (!isEditMode || !adornmentMode || !selectedAdornmentId) return undefined;
    const onKeyDown = (e) => {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (e.key === 'Escape') {
        setSelectedAdornmentId(null);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteAdornment(selectedAdornmentId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isEditMode, adornmentMode, selectedAdornmentId, deleteAdornment]);

  // Resize grips on the selected border. The grip identity travels via a data
  // attribute so the single mousedown handler can tell move from resize.
  const renderAdornmentChrome = useCallback((a) => {
    // A panel_border has no rect of its own — it IS its panel's border and
    // moves with the panel. Offering resize grips on one is a lie: the
    // cursor changes but there is no geometry to change, so the drag reads
    // as broken. Only rect borders get chrome.
    if (a?.kind !== 'border') return null;
    return (
      <>
        <div className="adornment-grip adornment-grip--top" data-adornment-grip="top" />
        <div className="adornment-grip adornment-grip--left" data-adornment-grip="left" />
        <div className="adornment-grip adornment-grip--right" data-adornment-grip="right" />
        <div className="adornment-grip adornment-grip--bottom" data-adornment-grip="bottom" />
        <div className="adornment-grip adornment-grip--corner" data-adornment-grip="corner" />
      </>
    );
  }, []);

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

  const openSwapRulesModal = (panelId) => setSwapRulesPanelId(panelId);
  const closeSwapRulesModal = () => setSwapRulesPanelId(null);
  const handleSaveSwapRules = ({ component_id, component_overrides }) => {
    if (!swapRulesPanelId) return;
    updateEditablePanel(swapRulesPanelId, { component_id, component_overrides });
    // Pull any newly-referenced override components into chartsMap so the swap
    // renders immediately (the dashboard-load pre-fetch only covers saved rules).
    const ids = [component_id, ...(component_overrides || []).map((o) => o.component_id)].filter(Boolean);
    const missing = ids.filter((cid) => !chartsMap[cid]);
    if (missing.length > 0) {
      Promise.all(missing.map((cid) => apiClient.getComponent(cid).catch(() => null)))
        .then((comps) => {
          const add = {};
          comps.forEach((c) => { if (c) add[c.id] = c; });
          if (Object.keys(add).length) setChartsMap((prev) => ({ ...prev, ...add }));
        });
    }
    setEditHasChanges(true);
    closeSwapRulesModal();
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
      // Carry adornments too — this save is a checkpoint before navigating
      // away, so omitting them would discard in-flight border edits.
      await apiClient.updateDashboard(id, { ...dashboard, panels: editablePanels, adornments: editableAdornments });
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
              // bottom-left (not bottom): this button hugs the viewport's left
              // edge, so a centered tooltip overflows past it and clips ("k to
              // dashboards"). bottom-left anchors the tooltip to the button's
              // start edge so it extends rightward into view.
              align="bottom-left"
              onClick={handleBack}
            >
              <ArrowLeft size={20} />
            </IconButton>
          )}
          {/* Edit (design) mode gets a back arrow in front of the name too,
              mirroring view mode's arrow. It behaves exactly like Cancel —
              exitEditMode prompts to discard unsaved changes, then navigates
              back to wherever the user came from. */}
          {!isFullscreen && isEditMode && (
            <IconButton
              kind="ghost"
              label="Cancel"
              // Same left-edge slot as the view-mode back arrow — anchor the
              // tooltip to the start edge so it can't clip on the viewport left.
              align="bottom-left"
              onClick={exitEditMode}
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
              <Tooltip
                label={dashboard?.name || ''}
                align="bottom-left"
                enterDelayMs={2000}
                leaveDelayMs={100}
              >
                {/* The title can ellipsize (it yields space to the range
                    picker before the toolbar wraps), so the tooltip surfaces
                    the full name on hover. 2s enter delay — the 5s default
                    feels far too slow. */}
                <h1 className="dashboard-title" tabIndex={0}>{dashboard?.name}</h1>
              </Tooltip>
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
            {!isEditMode && (
              <ConnectionSwapPicker
                variable={dashVariable}
                candidates={dashVariableCandidates}
                value={dashVariableValue}
                onChange={setDashVariableValue}
              />
            )}

            {/* Filter-type variable picker. A value the viewer chooses that is
                substituted server-side into the query ({{dashboard-variable}})
                and client-side into filters. Static options → Dropdown;
                freetext → TextInput. Coexists with the connection picker. */}
            {!isEditMode && (
              <FilterVariablePicker
                variable={dashFilterVariable}
                value={dashFilterValue}
                onChange={setDashFilterValue}
                panels={panels}
                chartsMap={chartsMap}
                dashboard={dashboard}
                pushToast={pushToast}
                addNotification={addNotification}
              />
            )}

            {/* Range-type variable picker. A [from, to] time window the viewer
                chooses, clamping time-series panels. Renders AFTER the
                connection + filter pickers. Presets resolve to absolute
                instants; "Custom…" reveals absolute from/to inputs. Hidden when
                no panel actually consumes the range (rangeHasConsumer) — a
                picker that drives nothing is worse than no picker. */}
            {!isEditMode && dashRangeVariable && rangeHasConsumer && (
              <DashboardRangePicker
                variable={dashRangeVariable}
                value={dashRangeValue}
                onChange={setDashRangeValue}
                showStep={rangeSupportsStep}
                stepType={rangeConnType}
              />
            )}
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
              {/* Adornment mode. While active, panels go inert and every
                  grid click draws or selects a border. The style controls
                  appear only once a border is selected, so the toolbar
                  doesn't carry dead widgets in the common case. */}
              {adornmentMode && selectedAdornment && (
                <div className="adornment-style-bar">
                  {/* Popover picker, not an inline swatch row — the toolbar
                      has no room for the full palette laid out flat.
                      Dropped entirely for a `hidden` border: it paints nothing
                      on the dashboard, so a colour would only ever tint the
                      editor's own hairline — a control whose only effect is on
                      the chrome that reveals it. The stored colour survives, so
                      switching back to a visible style restores it. */}
                  {selectedAdornment.line_style !== 'hidden' && (
                    <ColorSwatchPicker
                      value={selectedAdornment.color || lastAdornmentStyle.color}
                      onChange={(hex) => applyAdornmentStyle({ color: hex })}
                      palette={TEXT_THRESHOLD_COLOR_PALETTE}
                      // A border must have a color, so "Auto" has no meaning here.
                      allowAuto={false}
                      allowCustom
                      label="Border color"
                    />
                  )}
                  <Select
                    id="adornment-width"
                    labelText=""
                    hideLabel
                    size="sm"
                    className="adornment-style-select"
                    // A hidden border paints no line, so a width would do
                    // nothing. Disable rather than leave a live control with no
                    // effect — the stored value still round-trips, so switching
                    // back to a visible style restores the author's width.
                    disabled={selectedAdornment.line_style === 'hidden'}
                    value={selectedAdornment.width || selectedAdornmentWidths[0]}
                    onChange={(e) => applyAdornmentStyle({ width: Number(e.target.value) })}
                  >
                    {/* Width set depends on the kind: a gutter border is
                        centered in the 4px gap (even only), a panel border
                        grows inward from a real edge (1–3 all fine). */}
                    {selectedAdornmentWidths.map(w => (
                      <SelectItem key={w} value={w} text={`${w} px`} />
                    ))}
                  </Select>
                  <Select
                    id="adornment-line-style"
                    labelText=""
                    hideLabel
                    size="sm"
                    className="adornment-style-select"
                    value={selectedAdornment.line_style || lastAdornmentStyle.line_style}
                    onChange={(e) => applyAdornmentStyle({ line_style: e.target.value })}
                  >
                    {ADORNMENT_LINE_STYLES.map(s => (
                      <SelectItem key={s} value={s} text={s[0].toUpperCase() + s.slice(1)} />
                    ))}
                  </Select>
                  <IconButton
                    kind="ghost"
                    size="sm"
                    label="Delete border"
                    onClick={() => deleteAdornment(selectedAdornmentId)}
                  >
                    <TrashCan size={16} />
                  </IconButton>
                  <span className="edit-toolbar-divider" aria-hidden="true" />
                </div>
              )}
              <Button
                kind={adornmentMode ? 'primary' : 'ghost'}
                size="sm"
                onClick={toggleAdornmentMode}
                renderIcon={adornmentMode ? Draw : BorderFull}
                title={
                  adornmentMode
                    ? 'Exit adornment mode (drag on the grid to draw a border)'
                    : 'Adornment mode — draw borders around panels'
                }
              >
                {adornmentMode ? 'Done' : 'Borders'}
              </Button>
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
                onClick={() => saveEditMode({ stayInEdit: true })}
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
              {/* Refresh section, compact: [Data refresh pill][refresh icon].
                  The pill's tooltip shows a live "Next refresh in: Ns"
                  countdown (replacing the old always-on "Last refresh" text). */}
              {dashboard?.settings?.refresh_interval > 0 && (
                <RefreshIntervalPill
                  intervalSec={dashboard.settings.refresh_interval}
                  lastRefresh={lastRefresh}
                />
              )}
              {/* RefreshControls renders the refresh button AND its trailing
                  divider together — both vanish when there's nothing to refresh,
                  so a streaming-only dashboard doesn't show a doubled separator. */}
              <RefreshControls
                loading={loading}
                spinning={refreshing}
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
                // Carbon caps option width at a fixed 13rem and ellipsizes
                // longer labels ("Measure screen s…", "Create dashboard…").
                // Widen JUST this menu so its full item text shows.
                menuOptionsClass="dashboard-actions-menu"
              >
                {/* No "Edit" item here in view mode: it's redundant with the
                    Design mode switch (which opens this dashboard in the editor)
                    and was inconsistent. The design workflow (fromDesign) still
                    shows a prominent ghost Edit button — see above. */}
                {/* "Save Thumbnail" item removed — the thumbnail now
                    auto-captures on save when the layout changed (#97), so
                    a manual button is redundant. */}
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
                {/* Manual thumbnail capture. Auto-on-save covers the common
                    path, but late streaming data or an AI-built dashboard
                    that was never saved out of edit mode can leave a stale or
                    blank tile — this captures the current grid on demand. */}
                {canDesign && (
                  <OverflowMenuItem
                    itemText={creatingThumbnail ? "Creating thumbnail…" : "Create dashboard thumbnail"}
                    onClick={createThumbnail}
                    disabled={creatingThumbnail}
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

      {/* Dashboard grid — ONE <DashboardGrid> for BOTH view and edit, at a
          STABLE tree slot, so the in-place edit↔view flip reconciles the panel
          subtree instead of remounting it (streaming charts keep their live
          subscription). Edit chrome is injected via renderPanelChrome/gridExtras;
          view/kiosk pass none. Regressed at v0.26.0 when this was split into two
          trees — see PanelContent + DashboardGrid docs. */}
      {(panels && panels.length > 0) || isEditMode ? (
        <DashboardGrid
          panels={panels}
          chartsMap={chartsMap}
          dashboard={dashboard}
          resolveConnectionId={resolveConnectionId}
          resolveComponent={resolveComponent}
          swapIssuesByPanel={swapIssuesByPanel}
          unauthorizedComponents={unauthorizedComponents}
          dashboardVariableText={dashboardVariableText}
          variableValues={variableValues}
          dashboardVariableValue={dashFilterValue}
          rangeValue={dashRangeValue}
          dashboardCommand={dashboardCommand}
          canControl={canControl}
          refreshTick={refreshTick}
          fitMode={fitMode}
          scalePercent={scalePercent}
          isFullscreen={isFullscreen}
          onExpandPanel={isEditMode ? null : setExpandedPanelId}
          // Edit-mode wiring (no-ops in view/kiosk):
          editMode={isEditMode}
          editGridCols={gridCols}
          editGridRows={gridRows}
          editZoom={zoom}
          editScaleFactor={scaleFactor}
          onGridMouseDown={adornmentMode ? handleAdornmentGridMouseDown : handleGridMouseDown}
          onGridDoubleClick={adornmentMode ? handleAdornmentDoubleClick : undefined}
          adornmentPreviewPanelIds={adornmentPreviewPanelIds}
          selectedPanelIds={selectedPanelIds}
          renderPanelChrome={renderEditPanelChrome}
          gridExtras={editGridExtras}
          // Decorations: editable copy while editing, saved record in view.
          adornments={adornments}
          adornmentMode={isEditMode && adornmentMode}
          selectedAdornmentId={selectedAdornmentId}
          onAdornmentMouseDown={handleAdornmentMouseDown}
          renderAdornmentChrome={renderAdornmentChrome}
          containerRef={containerRef}
          gridRef={gridRef}
        />
      ) : (
        <div className="no-layout">
          <p>No panels configured for this dashboard.</p>
          <Button onClick={() => navigate(`/design/dashboards/${id}`)}>
            Configure Dashboard
          </Button>
        </div>
      )}

      {/* Chart Editor Modal (edit mode) */}
      {/* Panel delete — offers to clean up a component the delete orphans */}
      <PanelDeleteModal
        open={!!panelDeleteTarget}
        checking={panelDeleteChecking}
        componentName={panelDeleteTarget?.componentName}
        onCancel={() => setPanelDeleteTarget(null)}
        onConfirm={confirmDeletePanel}
      />

      <ComponentEditorModal
        open={componentEditorOpen}
        onClose={closeComponentEditor}
        onSave={handleChartSave}
        chart={editingChart}
        panelId={editingPanelId}
        // Lets the shared-component save warning exclude THIS dashboard from
        // the "also affects…" list — the user knows they're editing here.
        dashboardId={id}
      />

      {/* Component Picker Modal (edit mode). allowDuplicate offers the
          "create a duplicate" checkbox (#221) — building a dashboard often
          means wanting a slight variant of an existing chart. */}
      <ComponentPickerModal
        open={componentPickerOpen}
        onClose={closeComponentPicker}
        onSelect={handleComponentSelect}
        category={componentPickerCategory}
        allowDuplicate
      />

      {/* Component-swap rules editor (edit mode, dashboard-variable active) */}
      {swapRulesPanelId && (
        <ComponentSwapRulesModal
          open={!!swapRulesPanelId}
          onClose={closeSwapRulesModal}
          onSave={handleSaveSwapRules}
          panel={editablePanels.find((p) => p.id === swapRulesPanelId)}
          chartsMap={chartsMap}
          variableMode={dashVariable ? 'connection_swap' : 'filter'}
          variableLabel={(dashVariable || dashFilterVariable)?.label || (dashVariable || dashFilterVariable)?.name || 'variable'}
        />
      )}

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
      {/* (The filter-variable live-capture modal now lives inside
          FilterVariablePicker, rendered in the toolbar above.) */}

      {/* Dashboard settings modal */}
      <DashboardExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        dashboardIds={dashboard?.id ? [dashboard.id] : []}
        dashboards={dashboard ? [dashboard] : []}
      />
      {expandedPanelId && (() => {
        const expandedPanel = panels.find(p => p.id === expandedPanelId);
        // Apply BOTH swaps to the expanded panel so it matches the grid: the
        // component-swap rules pick the effective component, then connection-swap
        // repoints it at the selected connection.
        const expandedComponentId = resolveComponent
          ? resolveComponent(expandedPanel)
          : expandedPanel?.component_id;
        const rawExpandedChart = expandedComponentId ? chartsMap[expandedComponentId] : null;
        if (!rawExpandedChart) return null;
        const resolvedConnId = resolveConnectionId(rawExpandedChart);
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
            // Same active variable/range the inline grid uses, so the expanded
            // chart substitutes the dashboard variable instead of running with
            // dashboard_variable="" (server rejects: "dashboard variable not set").
            dashboardVariableValue={dashFilterValue}
            rangeValue={dashRangeValue}
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
            setEditablePanelBackground(settingsDraft.panelBackground || '');
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
          <Select
            id="settings-panel-background"
            labelText="Panel background"
            value={settingsDraft?.panelBackground ?? ''}
            onChange={(e) => setSettingsDraft((d) => ({ ...d, panelBackground: e.target.value }))}
            helperText="Default follows the deployment's Transparent Panels setting. Choose Solid or Transparent to override it for this dashboard only."
          >
            <SelectItem value="" text="Default (follow deployment setting)" />
            <SelectItem value="solid" text="Solid background" />
            <SelectItem value="transparent" text="Transparent background" />
          </Select>
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
            setEditableRangeEnabled(varsDraft.rangeEnabled);
            setEditableRangeLabel(varsDraft.rangeLabel);
            setEditableRangePresets(varsDraft.rangePresets);
            setEditableRangeDefaultPreset(varsDraft.rangeDefaultPreset);
            setEditHasChanges(true);
          }
          setVarsModalOpen(false);
        }}
        modalHeading="Dashboard Variables"
        primaryButtonText="Apply"
        secondaryButtonText="Cancel"
        size="lg"
        className="dashboard-variables-modal"
      >
        {/* Two independent variables that coexist on a dashboard: the
            connection/filter variable and the time-range variable. A content
            switcher selects which one's config is shown; each button carries
            that variable's live On/Off status so both stay readable no matter
            which panel is open. The selected panel keeps its own enable toggle
            (the switcher is navigation, not the enable control). */}
        <div className="dashboard-variable-settings">
          <ContentSwitcher
            selectedIndex={varsPanel}
            onChange={({ index }) => setVarsPanel(index)}
            size="lg"
          >
            <Switch name="conn-filter">
              <span className="dvar-switch-label">
                Connection / Filter
                <span className={`dvar-status${varsDraft?.enabled ? ' dvar-status--on' : ''}`}>
                  {varsDraft?.enabled ? 'On' : 'Off'}
                </span>
              </span>
            </Switch>
            <Switch name="time-range">
              <span className="dvar-switch-label">
                Time range
                <span className={`dvar-status${varsDraft?.rangeEnabled ? ' dvar-status--on' : ''}`}>
                  {varsDraft?.rangeEnabled ? 'On' : 'Off'}
                </span>
              </span>
            </Switch>
          </ContentSwitcher>

          {varsPanel === 0 && (
                <div className="dvar-panel">
                  <Toggle
                    id="settings-variable-enabled"
                    size="sm"
                    labelText="Enable connection / filter variable"
                    labelA="Off"
                    labelB="On"
                    toggled={!!varsDraft?.enabled}
                    onToggle={(checked) => setVarsDraft((d) => ({ ...d, enabled: checked }))}
                  />
                  {varsDraft?.enabled && (
                    <>
                      <div className="dvar-grid">
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
                      </div>

                      {varsDraft?.mode === 'connection_swap' && (
                        <>
                          <TagInput
                            id="settings-variable-tags"
                            label="Connection tags"
                            value={varsDraft?.tags ?? []}
                            onChange={(t) => setVarsDraft((d) => ({ ...d, tags: t }))}
                          />
                          <div className="dvar-grid">
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
                          </div>
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
                            <p className="dvar-note">
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
          )}

          {varsPanel === 1 && (
                <div className="dvar-panel">
                  <Toggle
                    id="settings-range-enabled"
                    size="sm"
                    labelText="Enable time range variable"
                    labelA="Off"
                    labelB="On"
                    toggled={!!varsDraft?.rangeEnabled}
                    onToggle={(checked) => setVarsDraft((d) => ({ ...d, rangeEnabled: checked }))}
                  />
                  {varsDraft?.rangeEnabled && (
                    <>
                      <div className="dvar-grid">
                        <TextInput
                          id="settings-range-label"
                          labelText="Range label"
                          value={varsDraft?.rangeLabel ?? ''}
                          onChange={(e) => setVarsDraft((d) => ({ ...d, rangeLabel: e.target.value }))}
                          placeholder="e.g. Time range"
                          helperText="Shown next to the range picker in the header."
                        />
                        <TextInput
                          id="settings-range-default-preset"
                          labelText="Default preset (optional)"
                          value={varsDraft?.rangeDefaultPreset ?? ''}
                          onChange={(e) => setVarsDraft((d) => ({ ...d, rangeDefaultPreset: e.target.value }))}
                          placeholder="e.g. 24h"
                          helperText="Applied on first load when no shared URL / saved window."
                        />
                      </div>
                      <TagInput
                        id="settings-range-presets"
                        label="Presets (duration tokens)"
                        value={varsDraft?.rangePresets ?? []}
                        onChange={(p) => setVarsDraft((d) => ({ ...d, rangePresets: p }))}
                      />
                      <p className="dvar-note">
                        Tokens like <code>1h</code>, <code>6h</code>, <code>24h</code>, <code>7d</code>, <code>30d</code>
                        {' '}(units m/h/d/w). Leave empty for a default set. Each resolves to an absolute
                        window ending &ldquo;now&rdquo; when picked. A <code>+n</code> offset / absolute-pair
                        builder is coming later.
                      </p>
                      <p className="dvar-note">
                        Components opt in: SQL/EdgeLake queries use the
                        {' '}<code>{'{{range_from}}'}</code> / <code>{'{{range_to}}'}</code> tokens (plus a
                        per-component Range format); ts-store and Prometheus panels pick up the window
                        automatically.
                      </p>
                    </>
                  )}
                </div>
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
// polling cadence. Hovering it shows a live "Next refresh in: Ns" countdown
// (this replaces the old always-visible "Last refresh: …" text — the live
// countdown makes the absolute timestamp redundant). Gated on the same
// context as RefreshControls so a streaming-only dashboard doesn't see a
// refresh-interval label that applies to nothing currently rendered.
function RefreshIntervalPill({ intervalSec, lastRefresh }) {
  const { hasRefreshable } = useRefreshableComponentsContext();
  const [hovered, setHovered] = useState(false);
  // Tick once a second only while the tooltip is open, so the countdown is
  // live when you're reading it and there's no background timer otherwise.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hovered) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [hovered]);

  if (!hasRefreshable) return null;

  // FREE-RUNNING cycle countdown. The per-panel auto-polls run on their own
  // timers inside useData; the parent's `lastRefresh` only advances on a
  // manual refresh / dashboard switch, NOT on each poll — so a
  // "(lastRefresh + interval) - now" countdown would stick at 0 after the
  // first cycle. Instead, count down interval→1 continuously, anchored at the
  // last known refresh and wrapped by the interval, which matches the polling
  // cadence (phase is approximate but the cadence is right).
  const anchor = lastRefresh?.getTime?.() || Date.now();
  const elapsedSec = Math.max(0, (Date.now() - anchor) / 1000);
  const remaining = intervalSec - (Math.floor(elapsedSec) % intervalSec);

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Tooltip align="bottom" label={`Next refresh in: ${remaining}s`}>
        <Tag type="green" size="sm">
          <Time size={12} />
          Data refresh: {intervalSec}s
        </Tag>
      </Tooltip>
    </span>
  );
}

// Toolbar manual-refresh button — extracted so we can read the
// RefreshableComponents context, which only resolves inside the provider
// that wraps the rendered viewer. Hidden when no mounted component on the
// dashboard would do anything with a refresh (streaming-only dashboards see
// no toolbar noise). The last-refresh time / next-refresh countdown now lives
// in the interval pill's tooltip, so this is just the button.
function RefreshControls({ loading, spinning, onRefresh }) {
  const { hasRefreshable } = useRefreshableComponentsContext();
  // Nothing to refresh → render NOTHING, including the trailing divider, so a
  // streaming-only dashboard doesn't leave a doubled separator where the
  // refresh section would have been.
  if (!hasRefreshable) return null;
  // Spin on the initial page load OR the transient manual-refresh pulse, so a
  // click visibly acknowledges (the per-chart refetch reports no completion).
  // `disabled` stays tied to the initial load only — never disable mid-use.
  return (
    <>
      <IconButton
        kind="ghost"
        label="Refresh"
        align="bottom"
        className="toolbar-refresh-btn"
        onClick={onRefresh}
        disabled={loading}
      >
        <Renew size={20} className={loading || spinning ? 'spinning' : ''} />
      </IconButton>
      <span className="toolbar-divider" aria-hidden="true" />
    </>
  );
}

export default DashboardViewerPage;
