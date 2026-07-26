# Plan: `number` chart type → `value` (string-or-numeric single-value tile)

**Status:** approved, ready to implement
**Date:** 2026-07-25
**Owner:** Tom / Claude

## Goal

Replace the `number` chart type with a `value` type that renders a single
**string OR numeric** value, carrying forward all of number's format options.
`value` fully supersedes `number` — it *replaces* it in the chart-type picker
(not a hide-alongside). The number type is retired: existing records migrate,
old bundles/callers keep working via accept-old/emit-new compatibility.

## Decisions (locked)

| Question | Decision |
|---|---|
| Type name | `value` |
| Rename stored option keys | **Yes** — `number*` → `value*` (no `value`-type-with-`numberFormat` mismatch) |
| Rename admin setting key | **Yes** — `default_numeric_chart_number_size` → `default_value_chart_size` |
| `NumberTile` custom-code export | **Keep as compat alias** for `ValueTile` (public API to user code) |
| `formatNumberValue()` param names | **Unchanged** — it's a shared cell-formatter, not the value chart. Only stored `options.*` keys rename. `value.js` maps `valueFormat`→the formatter's `numberFormat` param. Data-grid callers untouched. |
| Old export/import bundles | **Normalize on import** — remap `chart_type:number`→`value` and `options.number*`→`value*` before upsert |

### Key naming map

| Old (stored) | New (stored) |
|---|---|
| `chart_type: "number"` | `chart_type: "value"` |
| `options.numberFormat` | `options.valueFormat` |
| `options.numberDateFormat` | `options.valueDateFormat` |
| `options.numberDecimals` | `options.valueDecimals` |
| `options.numberUnit` | `options.valueUnit` |
| `options.numberSize` | `options.valueSize` |
| spec field id `number_format` | `value_format` (and `_date_format`,`_decimals`,`_unit`,`_size`) |
| setting `default_numeric_chart_number_size` | `default_value_chart_size` |

## The feature (string support)

`value.js` buildOption + `number-formats.js` (`formatNumberValue`): when the raw
value is **non-numeric**, render it as a string. `valueUnit` still applies
(suffix); numeric-only options (decimals/compact/duration/datetime) are no-ops
for strings. Numeric values behave exactly as today. This is the actual
capability being added; it rides along with the rename.

## Backward compatibility (accept-old, emit-new)

1. **chart_type alias** — buildOption dispatch, spec lookup, and AI
   `validChartTypes` (`tool_executor.go`) accept `"number"` and resolve to
   `value`. So an un-migrated doc / old AI call / old bundle still renders.
2. **Option-key read fallback** — `value.js`/`number-formats.js` read
   `opts.valueFormat ?? opts.numberFormat` (and siblings). Cheap insurance for
   any doc that escaped migration.
3. **Import normalization** — old bundles rewritten to new shape on ingest (see
   step 8). Result: no old-shape docs persist post-import.
4. **`NumberTile`** — kept as an alias export → `ValueTile` in the custom-code
   scope, so existing user custom-code components don't break.

## Implementation steps

### 1. Frontend spec files (rename + string support)
- Rename `client/src/chart-spec/specs/number.json` → `value.json`:
  set `chart_type: "value"`; field ids `number_*` → `value_*`; `binds`
  `options.number*` → `options.value*`.
- Rename `client/src/chart-spec/specs/number.js` → `value.js`:
  read `opts.valueSize ?? opts.numberSize` etc.; **add non-numeric branch**
  (render raw string, apply unit/prefix/suffix only). Keep the
  `value_column` / `y_axis[0]` data-mapping fallback as-is.
- `number-formats.js`: `formatNumberValue` gains a string path (return the raw
  string with unit when not numeric). Param names UNCHANGED (`numberFormat`,
  `numberDecimals`, …) — value.js maps `valueFormat`→`numberFormat` at the call
  site. DataViewGrid + ComponentDataGridModal callers untouched.
- `chart-spec/index.js`: import `value.json` (was `number.json`).
- `chart-spec/build-options.js`: register `value: buildValueOption`; **also
  register `number:` → same fn (alias)** so un-migrated docs resolve.

### 2. Frontend views
- Rename `chart-spec/views/NumberView.jsx` → `ValueView.jsx` (+ any
  `chartType === 'number'` internal branch → accept both).
- `chart-spec/views/index.js` VIEWS: `value: ValueView` **and** `number:
  ValueView` (alias).
- Rename `NumberTile.jsx` → `ValueTile.jsx`; **export `NumberTile` as an alias**
  of `ValueTile`.
- `DynamicComponentLoader.jsx`: expose BOTH `ValueTile` and `NumberTile`
  (alias) in the custom-code scope.

### 3. Frontend editor (`ComponentEditor.jsx`)
- `CHART_TYPES`: replace the `number` entry with `value` (label "Value", keep
  `StringInteger` icon or pick a better one). This is the "removed from
  suggestions" outcome — number is gone from the picker, replaced by value.
- `CHART_TYPE_CONFIG`: rename `number` key → `value` (same capabilities:
  aggregation/filters/sliding-window on; sort/limit/time-bucket off).
- `DEFAULT_CHART_OPTIONS` (369-376): keys `value*`.
- Admin-default lazy-seed (993-1009): `chartOptions.valueSize`, read setting
  `default_value_chart_size`.
- Spec-form READ (4064-4071) + WRITE cases (4238-4255): `value*` keys +
  `value_*` field ids.
- Any `chartType === 'number'` / `.includes('number')` gates (106, 944-945,
  3958): accept `value` (keep `number` in the set for safety during migration
  window, or map — decide inline; simplest: replace `number`→`value` and rely on
  migration+alias).

### 4. Frontend admin setting UI
- Rename `NumericChartNumberSizeEditorModal.jsx` → `ValueChartSizeEditorModal.jsx`
  (exports `VALUE_CHART_SIZES`, `DEFAULT_VALUE_CHART_SIZE`).
- `SettingsPage.jsx` (108, 404, 406): dispatch + key string → `default_value_chart_size`.

### 5. Go registry (`registry/chart_types.go`)
- `RegisterComponentType`: `TypeID: "chart.value"`, `Subtype: "value"`,
  `DisplayName: "Value"`; ConfigSchema field names `value*`.
- Keep a note in the sync-contract header.
- (Registry does not need a `number` alias — catalog drives the picker; the
  alias for old data lives in buildOption + AI validChartTypes.)

### 6. Go AI surface
- `tool_executor.go` `validChartTypes` (418-426): add `"value": true`, KEEP
  `"number": true` as accepted alias; error string (966) → value* keys.
- `tools.go`: `chartTypeEnum` fallback (453) → `value` (drop phantom
  heatmap/radar/funnel while here? — out of scope, leave unless trivial).
- `system_prompt.go`: prose/table (73, 90, 101, 151, 252, 284, 316, 346) →
  `value` + `value*` option keys; NumberTile→ValueTile mention (keep alias note).
- `toolops/chart_options.go` (93-137): option props + allow-list set → `value*`.
- `chat/prompt.go` (97, 109), `connectionguidance/guidance.go` (413),
  `mcp/dashboard_builder_prompt.go` (53, 58), `mcp/tools.go` (1193): `value` +
  `value*`.
- Chat schema parity: run `chat/schema_parity_test.go` — update if it asserts
  the key set.

### 7. DB migration (`database/migrations.go`) — two entries
Mirror `migrateRenameDatasourceIDField` (aggregation `$set` new-from-`$old` +
`$unset` old; `$exists` guard = idempotent).

- **`migrateNumberChartToValue`** on `components`:
  filter `chart_type: "number"`; pipeline `$set chart_type: "value"`,
  `$set options.valueFormat: "$options.numberFormat"` (× all 5, each guarded so
  a missing old key doesn't create a null — use `$rename`-equivalent via
  conditional `$set`+`$unset`, or set-then-unset only when old exists). Then
  `$unset` the 5 `options.number*`.
  *Note:* option keys may be absent on some docs (defaults). Set-from-`$path`
  on a missing field creates the field as missing (ok) — but verify no null
  pollution; prefer per-key `$exists`-scoped updates or an aggregation `$cond`.
- **`migrateValueChartSizeSetting`** on `settings`: rename the setting doc
  `key: default_numeric_chart_number_size` → `default_value_chart_size` (mirror
  `migrateAssistantEnabledToAIEnabled`).

Append both to the ordered `migrations` slice. Idempotent, runs on boot before
index creation.

### 8. Import normalization (`service/dashboard_import.go`)
Add a normalize step on the apply path: for each incoming `Component`, if
`chart_type == "number"` → `"value"`, and remap any `options.number*` →
`options.value*` before dedup-compare/upsert. Reuse the same key map as the
migration. Ensures old bundles land as current-shape docs (no persisted
old-shape). Export path unchanged (emits current shape naturally post-migration).

### 9. Tests
- `registry/spec_driven_test.go`, `spec_driven_test.go` (14): update `number`→`value`.
- Add/confirm buildOption still works; no `verify-number-buildoption.mjs` exists
  today — OUT OF SCOPE to add one (note it as a gap).
- `go test ./...` + `npm run` eslint (not full build while iterating, per
  HMR-circular-import gotcha).

### 10. Docs (four surfaces)
- `docs/architecture/*` (frontend/data-model chart-type list) + the design note
  `docs/design-notes/spec-driven-non-echarts-views.md` (101-102 option keys).
- udoc manual (chart types / number tile section) — `cd udoc && npm run build`
  to validate links.
- README if it enumerates chart types.
- `CHANGELOG.md` — feature entry (new `value` type, string support, `number`
  superseded+auto-migrated).

## Risks / watch-items

- **Migration null-pollution**: setting `options.valueX` from a missing
  `$options.numberX` — must not create spurious null keys. Use `$exists`-scoped
  or `$cond` per key. This is the single most error-prone part; test against a
  doc that has only *some* of the 5 keys.
- **`number_size` enum duplicated in 4 places** (value.json, size modal,
  chart_options.go prose, chart_types.go range) — keep in sync when renaming.
- **AI fallback lists drift** from catalog and still list phantom types — only
  touch the `number` entries; don't expand scope.
- **Custom-code components** referencing `NumberTile` — covered by the alias;
  verify the alias is actually in the eval scope, not just exported.

## Not doing (explicit scope cuts)

- Not renaming `formatNumberValue`'s param API (shared utility).
- Not adding a `verify-value-buildoption.mjs` (pre-existing gap, note only).
- Not touching the phantom heatmap/radar/funnel AI-list entries.
- Not renaming the `options` object BSON field (only its subkeys).
