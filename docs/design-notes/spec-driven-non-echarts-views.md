# Spec-driven non-ECharts views (number, dataview, …)

**Status:** design — Stage 2 follow-on, branch `chart-spec-banded-bar`
(continuing the spec-driven migration). Supersedes the "force everything
through ECharts" assumption baked into the original `SpecDrivenChart` /
`ChartShell` contract.

## Problem

The spec-driven render contract today is ECharts-only:

```
buildOption(values, data) → ECharts option → ChartShell → <ReactECharts>
```

Two remaining chart types don't render via ECharts:

- **number** — a big DOM text value + optional unit. Plain `<div>`/`<span>`,
  CSS `tabular-nums`, ellipsis. Forcing it through ECharts `graphic`
  (text-on-canvas) would *degrade* it for no benefit.
- **dataview** — an AG Grid table. Virtualized rows, per-column
  filter/sort/resize/reorder, streaming `applyTransaction`, per-user
  layout persistence via `useDataviewLayout`. Nothing like an ECharts
  option.

Goal (Tom): the editor must be **config-driven for every type**, even if
that needs new spec field types for bespoke editors — so Stage 3 can
delete the legacy per-type JSX + string-codegen wholesale. The render
path should stay honest (don't fake ECharts) and stay **open-ended** so
future non-ECharts component types drop in without shell surgery.

## Contract change — tagged view descriptors + a view registry

A spec-driven type's render module returns EITHER shape:

```js
// ECharts types (line/area/bar/banded_bar/scatter/pie/gauge) — unchanged:
buildOption(values, data, helpers) → <ECharts option object>

// Non-ECharts types:
buildOption(values, data, helpers) → { render: 'number',   props: {…} }
                                    → { render: 'dataview', props: {…} }
```

`SpecDrivenChart` inspects the return value:

- A bare option object (no `render` tag) → today's path: `<ChartShell>` →
  `<ReactECharts>`. Zero change for the 7 ECharts types.
- A tagged descriptor `{ render, props }` → look `render` up in the
  **view registry** and render that React component with `props`, the
  saved `config`, and the `dataCtx`.

### View registry

`chart-spec/views/index.js` maps a tag → React component:

```js
const VIEWS = {
  number:   NumberView,
  dataview: DataViewGrid,
};
export function getView(tag) { return VIEWS[tag] || null; }
```

Adding a future non-ECharts type = write `specs/<type>.json` (editor) +
`specs/<type>.js` (returns `{render:'<type>', props}`) + register one
component in `views/index.js`. No dispatch edits in ComponentEditor, no
ChartShell branch.

### Who owns the shell treatment?

ECharts types lean on `ChartShell` for title + loading/error/no-data.
Non-ECharts views own *more* of that themselves, because their needs
differ:

- **number** wants its own absolute-positioned inline title + centered
  value (so titled/untitled doesn't reflow the number). It does NOT want
  ChartShell's `2.5rem` header.
- **dataview** manages its own loading / "Waiting for data…" / "No data"
  states with streaming awareness (`connected`), and its own centered
  title bar above the grid.

So the non-ECharts branch in `SpecDrivenChart` does **not** wrap the view
in `ChartShell`. It renders the registered view directly and passes
`config` + `dataCtx`; the view decides its own header + empty/loading
states. ChartShell stays the ECharts-only shell it is today. (If a future
view wants the standard header + placeholders, it can import and reuse
ChartShell's pieces — but it's opt-in, not imposed.)

This keeps each surface honest: ECharts charts share one shell; bespoke
views own their chrome because their chrome is bespoke.

## Editor — config-driven for both

Both get a `spec.json` driving the editor sections, like every other
type.

- **number.json** — reuses existing field types:
  - `value_column` → `column_select` (binds `data_mapping.y_axis[0]`,
    same as gauge)
  - `number_size` → `enum` (the 24–400 px list) binds `options.numberSize`
  - `number_unit` → `text` binds `options.numberUnit`
  - Capabilities mirror `CHART_TYPE_CONFIG.number` (single value: no x,
    no time-bucket, no sort/limit).
  - **No new field type needed.**

- **dataview.json** — needs ONE new spec field type:
  - `column_manager` — the visible-columns checklist + reorder (↕) +
    per-column alias rename. This is the only bespoke editor widget; it
    encapsulates the JSX currently inline in ComponentEditor
    (`visibleColumns` + `columnAliases` state). Binds a composite of
    `data_mapping.visible_columns` + `data_mapping.column_aliases`.
  - `has_sort_limit` is already a standard capability.
  - Field type registered in `chart-spec/field-types/index.js` like the
    others; reads/writes through the editor's formState + onFieldChange
    exactly like `ColumnSelect`.

## Why not force ECharts (`graphic` API)?

Rejected. number-as-canvas-text loses crisp DOM text, `tabular-nums`,
CSS-token theming, and ellipsis, and gains canvas reflow quirks — slick
for slick's sake, no real-work reduction. dataview-as-ECharts is a
non-starter (it's a data grid). The descriptor path is the honest model
and the one that generalizes.

## Stage-3 payoff

Once number + dataview render through the view registry and edit through
specs, the legacy `chartType === 'number'` / `=== 'dataview'` JSX blocks
and their `getDataDrivenChartCode` string-template branches have **zero
remaining callers** (the existing `hasBuildOption` codegen dispatch
already routes any type with a render module to `<SpecDrivenChart>`).
Stage 3 deletes them with the rest of the legacy paths — no special case.

## Naming

`buildOption` is now a slight misnomer for the non-ECharts modules (they
return a descriptor, not an ECharts option). Keep the export name
`buildOption` for consistency across all spec modules and the existing
`build-options.js` registry — renaming every module + the dispatch is
churn for no behavior change, and the design note + the `render` tag make
the dual return shape explicit. (Revisit at Stage 3 if a cleaner name like
`buildView` is worth the sweep.)
```
