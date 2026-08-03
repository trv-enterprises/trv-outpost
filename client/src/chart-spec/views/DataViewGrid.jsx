// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
// Carbon icons, not Unicode glyphs. The header actions started as bare
// characters (⇔ / ⚙ / ✕); the arrow in particular read as nothing in
// particular, and none of them matched the icon set used everywhere else.
import { FitToWidth, Settings, Close, Add } from '@carbon/icons-react';
import { useDataviewLayout } from '../../hooks/useDataviewLayout';
import { formatCellValue } from '../../utils/dataTransforms';
import { formatNumberValue } from '../specs/number-formats';
import { resolveColumnRule, resolveRowRule, contrastPartnerFor } from '../option-helpers';

/**
 * DataViewGrid — the non-ECharts render for the `dataview` chart type.
 *
 * AG Grid Community, Quartz-dark theme. Virtualized; per-column sort /
 * filter / resize / reorder built in. Handles streaming journal data via
 * imperative applyTransaction (so open filter menus survive batches).
 * visible_columns + column_aliases are honored as chart defaults;
 * useDataviewLayout layers per-user resize/reorder overrides on top.
 *
 * Ported near-verbatim from the legacy string-codegen
 * `chartType === 'dataview'` branch in ComponentEditor. The only changes:
 * inputs arrive as props (from specs/dataview.js's buildOption descriptor)
 * + dataCtx + config instead of a generated useData() call and eval-scope
 * injection; AgGridReact / useDataviewLayout / formatCellValue are now
 * direct imports. Owns its own title + loading/error/no-data chrome (not
 * wrapped in ChartShell). See docs/design-notes/spec-driven-non-echarts-views.md.
 *
 * @param {object}        props
 * @param {object}        props.columnAliases       { col → display name }
 * @param {object}        props.columnWidths        { col → px } author-set default widths
 * @param {object}        props.columnFormats       { col → value format } — 'compact' (SI, 127G),
 *                                                  'duration', 'duration_clock', 'plain'; missing/'auto' = default
 * @param {object}        props.columnRules         { col → [{ op, value, color, target, wholeRow }] }
 *                                                  conditional formatting; first match wins
 * @param {string[]|null} props.visibleColumnsConfig ordered whitelist, or null = show all
 * @param {string}        props.xAxisFormat         timestamp format for time columns
 * @param {object}        props.config              saved config (id, title)
 * @param {object}        props.dataCtx             { data, loading, error, isStreaming }
 */
/**
 * EditorColumnHeader — the header AG Grid renders for each column when the
 * grid is mounted as the editor's visual column formatter (#214).
 *
 * Carries the direct-manipulation affordances that belong ON the column:
 * open its options (⚙), size it to its content, and hide it. Sorting is
 * dropped here deliberately — in the editor the header is a control
 * surface for layout, and a stray sort-on-click while aiming for a button
 * would reorder the author's sample data for no reason.
 *
 * A HIDDEN column (only rendered when "Show hidden" is on) shows greyed
 * with a single "show" action instead: it has no width or order to
 * manage while hidden, so offering those controls would be dead UI.
 */
function EditorColumnHeader(props) {
  const {
    displayName, column,
    hidden, hasWidth, onEditColumn, onHideColumn, onShowColumn, onAutoSizeColumn,
  } = props;
  const colId = column?.getColId?.() || '';
  // The in-flight drag width comes via the grid CONTEXT, not through
  // headerComponentParams: params live on the column defs, so threading a
  // value that changes on every mousemove would re-derive every def
  // mid-drag. Context updates without touching the defs.
  const live = props.context?.liveResize;
  const liveWidth = live && live.colId === colId ? live.width : null;

  if (hidden) {
    return (
      <div className="dvg-editor-header dvg-editor-header--hidden" title={`${colId} (hidden)`}>
        <span className="dvg-editor-header__name">{displayName}</span>
        <button
          type="button"
          className="dvg-editor-header__btn"
          title="Show this column"
          aria-label={`Show ${colId}`}
          onClick={() => onShowColumn?.(colId)}
        >
          <Add size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="dvg-editor-header" title={colId}>
      <span className="dvg-editor-header__name">{displayName}</span>
      {/* Live px readout — the answer to "what width am I actually
          setting?", which the old type-a-number-and-go-look flow never
          gave. Only rendered for the column being dragged. */}
      {liveWidth != null && (
        <span className="dvg-editor-header__width">{liveWidth}px</span>
      )}
      <span className="dvg-editor-header__actions">
        {/* Auto-size appears ONLY when the column is pinned to a width.
            On an auto-sizing column it would do nothing, and offering a
            control that can't change anything is a false affordance — it's
            what made this icon unreadable ("what does ⇔ do here?"). Its
            presence now carries information: this column has a fixed width,
            and this is how you release it. */}
        {hasWidth && (
          <button
            type="button"
            className="dvg-editor-header__btn"
            title="Release the fixed width — size this column to fit its content"
            aria-label={`Auto-size ${colId}`}
            onClick={() => onAutoSizeColumn?.(colId)}
          >
            <FitToWidth size={16} />
          </button>
        )}
        <button
          type="button"
          className="dvg-editor-header__btn"
          title="Column options — display name, format, conditional formatting"
          aria-label={`Options for ${colId}`}
          onClick={() => onEditColumn?.(colId)}
        >
          <Settings size={16} />
        </button>
        <button
          type="button"
          className="dvg-editor-header__btn dvg-editor-header__btn--hide"
          title="Hide this column"
          aria-label={`Hide ${colId}`}
          onClick={() => onHideColumn?.(colId)}
        >
          <Close size={16} />
        </button>
      </span>
    </div>
  );
}

export default function DataViewGrid({
  columnAliases = {},
  columnWidths = {},
  columnFormats = {},
  columnRules = {},
  visibleColumnsConfig = null,
  xAxisFormat = 'short',
  config,
  dataCtx,
  // Editor-only hooks (#214). In the component editor the grid IS the
  // column-layout control: a drag writes the AUTHOR's column_widths rather
  // than the viewer's per-user layout. Absent in view mode, where the
  // existing per-user behavior is unchanged.
  editable = false,
  editorHiddenColumns = [],
  onAuthorWidthChange = null,
  onAuthorOrderChange = null,
  onEditColumn = null,
  onHideColumn = null,
  onShowColumn = null,
  onAutoSizeColumn = null,
}) {
  // Per-user layout is keyed on the component id (from config, not the
  // descriptor — the descriptor's buildOption has no access to it).
  const chartId = config?.id || '';
  const data = dataCtx?.data;
  const loading = dataCtx?.loading;
  const error = dataCtx?.error;
  const isStreaming = dataCtx?.isStreaming;

  // Per-user layout override — order + widths layered on top of the
  // chart defaults. Returns the user's stored layout for this chart_id
  // and a saver to push changes back.
  const { layout: storedLayout, saveLayout } = useDataviewLayout(chartId);
  // EDITOR MODE (#214) shows the AUTHOR's configuration, not the editing
  // user's personal view of it. Ignoring the stored layout here isn't just
  // tidiness: the editor's whole job is to show what every viewer gets by
  // default, and a width this author had previously dragged in view mode
  // would otherwise silently sit on top of that — they'd be tuning a number
  // while looking at a different one.
  const userLayout = editable ? null : storedLayout;

  const allColumns = (!loading && !error && data?.columns) || [];
  // Effective order: user's saved order if it covers the same columns,
  // else chart's visible_columns config, else all columns.
  const orderedColumns = (() => {
    const baseOrder = visibleColumnsConfig
      ? visibleColumnsConfig.filter((c) => allColumns.includes(c))
      : allColumns;
    if (userLayout?.order && Array.isArray(userLayout.order) && userLayout.order.length > 0) {
      const known = new Set(baseOrder);
      const fromUser = userLayout.order.filter((c) => known.has(c));
      const missing = baseOrder.filter((c) => !userLayout.order.includes(c));
      return [...fromUser, ...missing];
    }
    return baseOrder;
  })();

  const columnsKey = orderedColumns.join('|');
  // Stable signature of the author width map so columnDefs re-derive when the
  // editor changes a width (object identity alone wouldn't be a safe dep).
  const columnWidthsKey = Object.entries(columnWidths || {})
    .map(([c, w]) => `${c}:${w}`)
    .sort()
    .join('|');
  // Same stable-signature treatment for the author format map.
  const columnFormatsKey = Object.entries(columnFormats || {})
    .map(([c, f]) => `${c}:${f}`)
    .sort()
    .join('|');
  // ...and for the alias map, which feeds headerName. This was MISSING:
  // columnDefs read columnAliases but had no dep for it, so renaming a
  // column updated the stored config and re-rendered, and the grid kept
  // showing the old header. Object identity alone wouldn't be safe here
  // either — the editor rebuilds the map on every edit.
  const columnAliasesKey = Object.entries(columnAliases || {})
    .map(([c, a]) => `${c}:${a}`)
    .sort()
    .join('|');
  // Conditional-format rules change cell styling, so columnDefs must
  // re-derive when the author edits them. Serialized because the rules are
  // nested arrays of objects — object identity would miss an in-place edit
  // from the editor, and a shallow key would miss a color/operator change.
  const columnRulesKey = JSON.stringify(columnRules || {});
  // Editor "Show hidden": columns present in the grid purely so they can be
  // un-hidden. Empty in view mode.
  const hiddenKey = (editorHiddenColumns || []).join('|');
  const hiddenSet = useMemo(
    () => new Set(editorHiddenColumns || []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hiddenKey]
  );
  // Whether ANY rule paints the whole row. Row styling costs a per-row scan
  // across every ruled column, so skip it entirely for the common case of a
  // table with no whole-row rules (or none at all).
  const hasRowRules = useMemo(() => (
    Object.values(columnRules || {}).some(
      (rules) => Array.isArray(rules) && rules.some((r) => r?.wholeRow === true)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [columnRulesKey]);
  // Row objects derived from the latest snapshot. Stable __id (content
  // hash + index) so AG Grid's filter, sort, menu state, and scroll
  // position survive streaming buffer slices.
  const latestRowObjs = useMemo(() => {
    if (!data?.rows) return [];
    // Key the cells off data.columns DIRECTLY, not the loading-gated
    // allColumns.
    //
    // allColumns is `(!loading && !error && data?.columns) || []`, so while
    // loading it is EMPTY even when data.rows is already populated — which
    // is exactly the state a streaming backfill produces (rows arrive, the
    // hook is still "loading" until the live subscription is up). Building
    // rows against [] yields objects carrying only __id and no field keys,
    // so every valueGetter reads undefined and the grid renders four
    // correctly-sized but completely BLANK rows.
    //
    // initialRowDataRef then latches those keyless objects as the grid's
    // one-shot rowData and never revisits them, so the table stayed empty
    // until a live record forced a fresh batch through applyTransaction.
    const cols = data.columns || [];
    return data.rows.map((row, idx) => {
      const o = {};
      cols.forEach((c, i) => { o[c] = row[i]; });
      let h = 0;
      for (let i = 0; i < row.length; i++) {
        const s = row[i] == null ? '' : String(row[i]);
        for (let j = 0; j < s.length; j++) { h = ((h << 5) - h + s.charCodeAt(j)) | 0; }
      }
      o.__id = String(h) + '-' + idx;
      return o;
    });
    // data.columns is a dep in its own right: columnsKey is derived from the
    // loading-gated allColumns, so it is "" during the very window this memo
    // has to rebuild in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.rows, data?.columns, columnsKey]);

  // Grid mount strategy: feed only the first snapshot as rowData, then
  // switch to imperative applyTransaction() so the grid stays mounted
  // and open filter menus don't close on every streaming batch.
  const gridRef = useRef(null);
  const initialRowDataRef = useRef(null);
  // Flipped by onGridReady. Exists purely so the seeding effect below can
  // re-run once the grid api actually exists — see the comment there.
  const [gridReady, setGridReady] = useState(false);
  // Live px readout while an editor drag is in flight: { colId, width }.
  // Editor-only — view mode never sets it, so view-mode renders are
  // unaffected.
  const [liveResize, setLiveResize] = useState(null);
  // Latch only once the snapshot has COLUMNS as well as rows — this is a
  // one-shot that never revisits, so latching a keyless snapshot would pin
  // the grid to blank rows permanently.
  if (initialRowDataRef.current === null && latestRowObjs.length > 0 && (data?.columns?.length || 0) > 0) {
    initialRowDataRef.current = latestRowObjs;
  }

  // Push the in-flight drag width to the headers. AG Grid snapshots
  // `context` rather than watching it, so the header cells have to be told
  // to re-read it — refreshHeader() is the cheap way (headers only, no row
  // re-render) and this only ever runs in editor mode.
  useEffect(() => {
    if (!editable) return;
    gridRef.current?.api?.refreshHeader();
  }, [liveResize, editable]);

  // Repaint rows when the conditional-format rules change.
  //
  // getRowStyle is a GRID-LEVEL prop: AG Grid calls it as rows render and
  // does not re-run it on already-rendered rows just because the function
  // identity changed. So editing rules left the previous row styling stuck
  // on the DOM — un-checking "color the whole row" kept every cell's TEXT
  // red (the stale inline row style) while the driving cell's background
  // updated correctly, because cellStyle re-derives through columnDefs.
  // The result was a mixed state that matched neither rule shape, and it
  // "fixed itself" on the next edit only because that re-rendered the rows.
  //
  // redrawRows() forces the row styles to be re-evaluated. Rules change on
  // author edits only — never per frame — so this is not a hot path.
  const skipFirstRedrawRef = useRef(true);
  useEffect(() => {
    if (skipFirstRedrawRef.current) { skipFirstRedrawRef.current = false; return; }
    gridRef.current?.api?.redrawRows();
  }, [columnRulesKey]);

  // Auto-size a column the moment its author width is REMOVED.
  //
  // Clearing the width only stops us from setting def.width — it does not
  // shrink the column, because AG Grid keeps whatever width it is already
  // rendering at. (autoSizeStrategy doesn't help: it runs on data render,
  // not on a columnDefs update.) So pressing Auto-size cleared the stored
  // value and nothing moved on screen, which reads as a dead button.
  //
  // Diff the author-width keys against the previous render and explicitly
  // auto-size whichever columns just lost theirs. Editor-only; view mode
  // never edits author widths.
  const prevWidthKeysRef = useRef(null);
  useEffect(() => {
    if (!editable) return;
    const current = new Set(
      Object.entries(columnWidths || {})
        .filter(([, w]) => Number.isFinite(Number(w)) && Number(w) > 0)
        .map(([c]) => c)
    );
    const prev = prevWidthKeysRef.current;
    prevWidthKeysRef.current = current;
    if (!prev) return; // first render — nothing was cleared
    const cleared = [...prev].filter((c) => !current.has(c));
    if (cleared.length === 0) return;
    const api = gridRef.current?.api;
    if (!api) return;
    // Only size columns the grid still displays; a cleared width on a
    // since-hidden column has nothing to resize.
    const live = cleared.filter((c) => api.getColumn?.(c));
    if (live.length > 0) api.autoSizeColumns(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnWidthsKey, editable]);

  // Seeding vs. streaming. The grid is fed ONCE via rowData (the
  // initialRowDataRef latch) and every later batch arrives here as an
  // applyTransaction, so the grid stays mounted and open filter menus
  // survive. That split has a hole on the seeding side:
  //
  // A backfill resolves while the component is still returning the
  // `loading` chrome below, so there is no grid yet — gridRef.current.api
  // is null and this effect bails, dropping the whole seed. The latch
  // can't cover for it either: it snapshotted the EMPTY latestRowObjs
  // before the backfill landed, so rowData stays []. latestRowObjs then
  // keeps its identity until the next live message, so nothing re-runs
  // and the table sits empty until a record happens to push — the
  // "no rows until something arrives" symptom on every streaming table.
  //
  // gridReady is the missing edge: flipped by onGridReady, it re-runs this
  // effect the moment the api exists so an already-resolved backfill gets
  // applied. Live batches are unaffected (they arrive with the grid up).
  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api || latestRowObjs.length === 0) return;
    const existingIds = new Set();
    api.forEachNode((node) => { if (node.data?.__id) existingIds.add(node.data.__id); });
    const incomingIds = new Set(latestRowObjs.map((r) => r.__id));
    const toAdd = latestRowObjs.filter((r) => !existingIds.has(r.__id));
    const toRemove = [];
    api.forEachNode((node) => {
      if (node.data?.__id && !incomingIds.has(node.data.__id)) {
        toRemove.push(node.data);
      }
    });
    if (toAdd.length || toRemove.length) {
      api.applyTransaction({ add: toAdd, remove: toRemove });
    }
  }, [latestRowObjs, gridReady]);

  const columnDefs = useMemo(() => {
    return orderedColumns.map((col) => {
      const isTimeCol = /time/i.test(col) || col === 'ts';
      const sampleVal = latestRowObjs[0]?.[col];
      const isNumCol = !isTimeCol && typeof sampleVal === 'number';
      // Width precedence: a viewer's live drag-resize (per-user, via
      // useDataviewLayout) wins; else the author-set config width; else the
      // grid's content autosize. EXCEPT: when the author has since CHANGED the
      // config width for this column, the stale per-user drag is discarded so
      // the new author value shows. We detect that by comparing the author
      // width the user override was captured against (userLayout.widthBase)
      // with the current author width — a mismatch means the author re-pinned.
      const authorWidth = Number(columnWidths?.[col]);
      const userWidthRaw = userLayout?.widths?.[col];
      const userBase = userLayout?.widthBase?.[col];
      const authorChangedSinceDrag =
        (Number.isFinite(authorWidth) && authorWidth > 0) &&
        Number(userBase || 0) !== authorWidth;
      const userWidth = authorChangedSinceDrag ? undefined : userWidthRaw;
      // AG Grid's field prop treats dots as nested-path navigation
      // (data['cpu']['pct']), which silently empties columns whose names
      // literally contain dots (e.g. ts-store flat keys like 'cpu.pct').
      // Use a closure-captured valueGetter keyed on the literal name + an
      // explicit colId so reorder / resize state still persists by name.
      const colKey = col;
      // Resolved explicit width: viewer drag-resize wins, else author config.
      const resolvedWidth = (userWidth && userWidth > 0)
        ? userWidth
        : (Number.isFinite(authorWidth) && authorWidth > 0 ? authorWidth : 0);
      // Default content floor for unsized columns. When a column IS explicitly
      // sized, honor a small value by dropping the floor to it (AG Grid still
      // enforces its own hard ~10px minimum), so "20" doesn't silently snap to
      // the 120 text-column default.
      const defaultFloor = isNumCol ? 100 : (isTimeCol ? 170 : 120);
      const def = {
        colId: colKey,
        headerName: columnAliases[col] || col,
        valueGetter: (params) => params.data?.[colKey],
        sortable: true,
        resizable: true,
        filter: isNumCol ? 'agNumberColumnFilter' : (isTimeCol ? 'agDateColumnFilter' : 'agTextColumnFilter'),
        floatingFilter: false,
        valueFormatter: (params) => {
          const v = params.value;
          if (v == null) return '';
          // Author-set per-column format (compact SI / duration / plain)
          // wins over the default cell formatter. Same vocabulary as the
          // number tile — formatNumberValue handles the non-numeric
          // fallback itself.
          const colFmt = columnFormats[col];
          if (colFmt && colFmt !== 'auto') {
            const f = formatNumberValue(v, col, { numberFormat: colFmt, numberDecimals: 'auto' }, formatCellValue);
            return f == null ? '' : String(f);
          }
          const f = formatCellValue(v, col, { timestampFormat: xAxisFormat, strictTimestampNames: true });
          return f == null ? '' : String(f);
        },
        minWidth: resolvedWidth > 0 ? Math.min(defaultFloor, resolvedWidth) : defaultFloor,
      };
      // Conditional formatting (#214). Only attach cellStyle when the column
      // actually has rules — AG Grid calls cellStyle for every rendered cell,
      // so an unruled table shouldn't pay for a function call per cell.
      //
      // A whole-row rule is painted by getRowStyle instead (one style for the
      // row, rather than each cell fighting over the same background), so the
      // cell hands the row case back. Returning null lets the theme's own
      // cell styling stand.
      // Editor mode: swap in the control-surface header, and mark hidden
      // columns (present only while "Show hidden" is on) so they render
      // greyed with a show action instead of the layout controls.
      if (editable) {
        const isHidden = hiddenSet.has(colKey);
        def.headerComponent = EditorColumnHeader;
        def.headerComponentParams = {
          hidden: isHidden,
          // Whether this column currently has an AUTHOR-set width. The
          // auto-size control only renders when it does — on an already
          // auto-sizing column it would be a no-op, and offering it implies
          // a state change that can't happen. Its presence is also the only
          // indicator that a column is pinned to a width at all.
          hasWidth: Number.isFinite(authorWidth) && authorWidth > 0,
          onEditColumn,
          onHideColumn,
          onShowColumn,
          onAutoSizeColumn,
        };
        def.sortable = false;
        def.filter = false;
        // A hidden column is a placeholder for un-hiding, not part of the
        // layout being tuned: it can't be dragged or resized, and it stays
        // narrow so it doesn't crowd the columns that matter.
        if (isHidden) {
          def.suppressMovable = true;
          def.resizable = false;
          def.cellClass = 'dvg-cell--hidden-col';
          def.width = 140;
          def.minWidth = 80;
          def.flex = 0;
          def.suppressSizeToFit = true;
        }
      }
      const rules = columnRules?.[colKey];
      if (Array.isArray(rules) && rules.length > 0) {
        def.cellStyle = (params) => {
          const hit = resolveColumnRule(params.value, rules);
          if (!hit || hit.wholeRow) return null;
          return hit.target === 'both'
            ? { backgroundColor: hit.color, color: contrastPartnerFor(hit.color) || undefined }
            : { color: hit.color };
        };
      }
      if (resolvedWidth > 0) {
        def.width = resolvedWidth;
        def.flex = 0;
        def.suppressSizeToFit = true;
      }
      return def;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, userLayout, columnWidthsKey, columnFormatsKey, columnAliasesKey, columnRulesKey, editable, hiddenSet]);

  // Columns WITHOUT an explicit width — the only ones fitCellContents should
  // auto-size. A column with an author/user width must keep its def.width, but
  // autoSizeStrategy=fitCellContents runs on data render and, unrestricted,
  // re-sizes every column to its content — so after the grid mounts the width
  // field looked like it stopped working (the wide `msg` cell won). Restricting
  // the strategy's colIds to unsized columns lets the explicit widths stick.
  const autoSizeColIds = useMemo(() => {
    return orderedColumns.filter((col) => {
      // Editor: a "Show hidden" placeholder is fixed-width by design.
      if (hiddenSet.has(col)) return false;
      const uw = userLayout?.widths?.[col];
      const aw = Number(columnWidths?.[col]);
      const hasWidth = (uw && uw > 0) || (Number.isFinite(aw) && aw > 0);
      return !hasWidth;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, userLayout, columnWidthsKey, hiddenSet]);

  // Re-measure the unsized columns against the FORMATTED cell text.
  //
  // autoSizeStrategy (below) is a MOUNT-TIME option: it runs when the grid
  // first renders data, which on the seeding path is while rowData is still
  // [] — the backfill hasn't landed yet. So it measures headers, not
  // content, and the rows that do arrive come in via applyTransaction,
  // which never re-autosizes. Columns end up sized for the raw magnitude
  // instead of the "7.8T" the valueFormatter actually paints.
  //
  // autoSizeColumns measures RENDERED cells, so running it once the grid is
  // up gets the formatted width. Explicitly-sized columns are excluded
  // (autoSizeColIds already filters them), so author/user widths still win.
  //
  // Deliberately NOT tied to a ResizeObserver or to the displayed row count:
  // this writes column widths, and anything that re-measures in response to
  // its own write loops. The format/alias keys are deps because they change
  // the rendered text width; gridReady is the mount edge.
  // hasRows (not latestRowObjs) is the trigger: it flips false→true ONCE,
  // when content first exists to measure. Depending on latestRowObjs would
  // re-autosize on every streaming batch and fight a viewer's column drag.
  const hasRows = latestRowObjs.length > 0;
  useEffect(() => {
    if (!gridReady || !hasRows) return;
    const api = gridRef.current?.api;
    if (!api || autoSizeColIds.length === 0) return;
    const live = autoSizeColIds.filter((c) => api.getColumn?.(c));
    if (live.length > 0) api.autoSizeColumns(live);
  }, [gridReady, hasRows, autoSizeColIds, columnFormatsKey, columnAliasesKey]);

  // No default flex — columns size to their content via the grid's
  // autoSizeStrategy=fitCellContents. A default flex=1 would cause AG Grid
  // to redistribute leftover row space evenly across columns, overriding
  // the autosize.
  const defaultColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    filter: true,
  }), []);

  // Whole-row conditional formatting (#214). Scans the ruled columns in
  // display order and takes the first whole-row match — the leftmost column
  // wins, which is arbitrary but stable and explainable (see resolveRowRule).
  //
  // undefined (not null) when nothing matches: AG Grid treats undefined as
  // "no opinion" and leaves its own row striping alone.
  const getRowStyle = useMemo(() => {
    if (!hasRowRules) return undefined;
    return (params) => {
      const hit = resolveRowRule(params.data, orderedColumns, columnRules);
      if (!hit) return undefined;
      return hit.target === 'both'
        ? { backgroundColor: hit.color, color: contrastPartnerFor(hit.color) || undefined }
        : { color: hit.color };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRowRules, columnsKey, columnRulesKey]);

  // Persist user layout changes (resize + reorder) to app_config.
  // Debounced via the saver itself in useDataviewLayout.
  //
  // ONLY persist a genuine user drag (source 'uiColumnResized'). AG Grid also
  // fires columnResized for programmatic width changes — applying our author
  // `def.width` from columnDefs comes through as source 'api'/'flex'/'autosize'.
  // Without this guard, the author width gets written into the per-user widths
  // store, which is a columnDefs dep, so the grid re-derives → re-applies →
  // fires again: a width-jitter feedback loop in view mode.
  const handleColumnResized = (event) => {
    if (!event.column) return;
    if (event.source !== 'uiColumnResized') return;
    // Mid-drag: surface the width the author is currently dragging to.
    // AG Grid fires this continuously with finished=false, which is
    // exactly the signal the old blind "type a number" flow lacked.
    if (!event.finished) {
      if (editable) {
        setLiveResize({ colId: event.column.getColId(), width: Math.round(event.column.getActualWidth()) });
      }
      return;
    }
    if (editable) setLiveResize(null);
    const colId = event.column.getColId();
    // EDITOR MODE (#214): the author is setting the chart's default width, so
    // the drag writes column_widths and must NOT touch the per-user layout.
    //
    // This split is load-bearing. useDataviewLayout's precedence is
    // "viewer drag > author width", with widthBase recording which author
    // width a drag was made against so a later author re-pin invalidates the
    // override. If an EDITOR drag were captured as a user override it would
    // be its own widthBase — the author's own change would look like a stale
    // viewer drag and get discarded. That is the v0.37.1 clobbering bug.
    if (editable) {
      onAuthorWidthChange?.(colId, Math.round(event.column.getActualWidth()));
      return;
    }
    if (!chartId) return;
    saveLayout((prev) => {
      const widths = { ...(prev?.widths || {}) };
      widths[colId] = event.column.getActualWidth();
      // Record the author width this drag was made against, so a LATER author
      // change to that column's config width invalidates this override (the
      // author's re-pin wins). 0 = no author width at drag time.
      const widthBase = { ...(prev?.widthBase || {}) };
      widthBase[colId] = Number(columnWidths?.[colId]) || 0;
      return { ...prev, widths, widthBase };
    });
  };
  const handleColumnMoved = (event) => {
    const api = gridRef.current?.api;
    if (!api) return;
    // colId is the canonical column identifier (field is used as a path
    // lookup, not a literal name).
    const ids = api.getColumnDefs().map((c) => c.colId || c.field);
    // Editor mode: reorder writes the AUTHOR's visible_columns order. Same
    // reasoning as the resize split above.
    if (editable) {
      // Only a completed USER drag is a real reorder. AG Grid fires
      // columnMoved continuously while dragging (finished: false), and also
      // for programmatic column changes during setup/remount — where
      // `source` is 'api'/'gridInitializing' and `finished` may be undefined.
      // Writing on those would let a remount echo the grid's own column order
      // back into visible_columns as if the author had dragged it.
      if (!event?.finished) return;
      if (event.source !== 'uiColumnMoved') return;
      onAuthorOrderChange?.(ids);
      return;
    }
    if (!chartId) return;
    saveLayout((prev) => ({ ...prev, order: ids }));
  };

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>Loading...</div>;
  }
  if (error) {
    return <div style={{ color: '#da1e28', padding: '1rem' }}>Error: {error.message || String(error)}</div>;
  }
  if (!data?.rows?.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6f6f6f' }}>
        {isStreaming ? 'Waiting for data...' : 'No data'}
      </div>
    );
  }

  // Title suppressible per-component via options.showTitle (default on)
  // — same uniform guard as ChartShell / ValueView. Off → the grid gets
  // the full panel height.
  const showTitle = config?.options?.showTitle !== false;
  const title = showTitle ? (config?.title || config?.name || '') : '';
  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', backgroundColor: 'transparent', overflow: 'hidden' }}>
      {title ? (
        // Title band — scales by --title-scale (font + height), shared
        // 2.5rem base with ChartShell / ValueView.
        <div style={{
          display: 'block', height: 'calc(2.5rem * var(--title-scale, 1))', lineHeight: 'calc(2.5rem * var(--title-scale, 1))', flexShrink: 0,
          padding: '0 0.75rem', fontSize: 'calc(0.875rem * var(--title-scale, 1))', fontWeight: 600, color: 'var(--cds-text-primary)',
          textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {title}
        </div>
      ) : null}
      <div className="ag-theme-quartz-dark" style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact
          ref={gridRef}
          theme="legacy"
          rowData={initialRowDataRef.current || []}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          // Only auto-size columns that have NO explicit width, so author/user
          // widths aren't clobbered by fitCellContents on data render. When
          // every column is explicitly sized, omit the strategy entirely.
          autoSizeStrategy={autoSizeColIds.length > 0
            ? { type: 'fitCellContents', colIds: autoSizeColIds }
            : undefined}
          animateRows={false}
          suppressCellFocus
          // Editor-only: carries the in-flight drag width to the headers
          // without re-deriving columnDefs on every mousemove.
          context={editable ? { liveResize } : undefined}
          getRowStyle={getRowStyle}
          getRowId={(params) => String(params.data.__id)}
          // Editor headers carry the column name PLUS three action buttons,
          // which don't fit on one line in a narrow column — so the header
          // wraps (see .dvg-editor-header) and the row needs room for the
          // second line. AG Grid sizes the header row from this option, not
          // from its content, so without it a wrapped header is clipped.
          // View mode keeps the default height.
          headerHeight={editable ? 56 : undefined}
          maintainColumnOrder
          // Lets the seeding effect above re-run once the api exists, so a
          // backfill that resolved before mount still paints.
          onGridReady={() => setGridReady(true)}
          onColumnResized={handleColumnResized}
          onColumnMoved={handleColumnMoved}
        />
      </div>
    </div>
  );
}
