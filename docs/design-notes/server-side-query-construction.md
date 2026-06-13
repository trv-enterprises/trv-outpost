# Server-side query construction (issue #23)

**Status:** Planned (design). Tracks GitHub issue
[#23](https://github.com/trv-enterprises/trv-outpost/issues/23).
**Author:** design note, 2026-06-13.
**Scope:** move SQL/EdgeLake query construction from the client to the
server. Architectural cleanup; **not** a data-model rewrite — components
keep storing their query config, what changes is *who turns config into
SQL*.

---

## 1. Problem

SQL (and EdgeLake) query text is built **on the client** in
`client/src/components/SQLQueryBuilder.jsx` and the server runs the raw
string verbatim. Three problems:

1. **Dialect logic is split.** The range feature (v0.30.0) already moved
   per-dialect expansion server-side (`substitution.go`: `BETWEEN $1 AND $2`
   for SQL, `col >= '…' AND col <= '…'` for EdgeLake, positional-placeholder
   mapping per driver). But the client *still* hand-builds SELECT / WHERE /
   GROUP BY / ORDER BY / LIMIT and the most-recent-N subquery wrap. Two
   places own SQL phrasing.
2. **Security: arbitrary client SQL.** `POST /api/connections/:id/query`
   runs client-supplied `query.raw` with no shape validation (only the two
   known tokens are bound). Any authenticated `view` user can replay a
   rewritten read/write query — the `query-endpoint-arbitrary-sql` HIGH
   item. If the client sends *structured intent* and the server builds the
   SQL, there is no arbitrary `raw` to guard.
3. **Client surface.** `SQLQueryBuilder.jsx` is ~909 lines, ~97 of which
   (`buildQuery`, lines 267–363) are pure SQL string assembly + a reverse
   parser (`parseSimpleQuery`, 36–109) that exists only to re-import the
   string the builder itself emitted.

## 2. Current state (verified 2026-06-13)

| Concern | Where | Today |
|---|---|---|
| Visual builder → SQL string | `SQLQueryBuilder.jsx:267-363` `buildQuery()` | client concatenates SELECT/WHERE/GROUP BY/ORDER BY/LIMIT + most-recent-N wrap (330-342) |
| Builder state | `SQLQueryBuilder.jsx:195-202` | `selectedTable`, `selectedColumns[{column,aggregate}]`, `whereConditions[{column,operator,value,logic,valueSource}]`, `groupByColumns[]`, `orderBy{column,direction}`, `limit`, `offset` |
| Token injection (client) | `SQLQueryBuilder.jsx:304-322` | emits `{{dashboard-variable}}` (unquoted) and `<col> {{range-variable}}` into the string |
| Reverse parser | `SQLQueryBuilder.jsx:36-109` `parseSimpleQuery()` | conservative raw→visual; bails on JOIN/CTE/HAVING/OR/subquery/BETWEEN/IN-expr |
| Stored query | `models/dashboard.go:67-71` `ChartQueryConfig{Raw,Type,Params}` | `Raw` = full baked SQL; `Params` = `dashboard_variable` value + `range` intent |
| Execute call | `client/src/api/client.js:858-864` `queryConnection()` | POST `{query:{raw,type}}` |
| Server execute | `connection/sql.go:198-269` `Query()` | takes `Raw` verbatim → `substituteAllSQLTokens()` → bound-arg exec |
| Dialect expansion (server) | `connection/substitution.go:331-487` | `substituteAllSQLTokens`, `sqlPlaceholder` ($N/?/@pN/:N), `resolveRange`, `substituteEdgeLake{Token,Range}` |
| Identifier safety | `substitution.go:~500` `IsSafeIdentifier()` | regex guard already exists |
| AI agents emit SQL | `toolops.go:311-350` `QueryConnectionInput.Raw`; AI tools write `query_config.raw` with tokens (#24) | all three AI surfaces emit **raw SQL strings** |

**Key split today:** `data_mapping` holds *client-side post-fetch transforms*
(filters, aggregation, sort, group_by, sliding_window, time_bucket). The
*server-fetched* WHERE/GROUP BY/ORDER BY/LIMIT are baked into `query_config.raw`.
So there are already two filtering layers; #23 is about the **fetch** layer
(the raw SQL), not the post-fetch transforms.

## 3. Design

### 3.1 New structured intent model

Add a structured representation alongside the existing `raw` on
`ChartQueryConfig` (server `models/dashboard.go`). `raw` is **not removed** —
it becomes the fallback/escape hatch (see Backward compatibility).

```
ChartQueryConfig {
  Raw    string         // KEPT — fallback + custom/advanced SQL escape hatch
  Type   string         // unchanged
  Params map[string]any // unchanged (dashboard_variable value, range intent)
  Intent *QueryIntent   // NEW — when set, the server builds SQL from this
}

QueryIntent {
  Table   string
  Columns []SelectColumn   // {Column, Aggregate ("", count, sum, avg, min, max), Alias}
  Where   []Condition      // {Column, Operator, Value, ValueSource (literal|variable|range), Logic (AND|OR)}
  GroupBy []string
  OrderBy *OrderClause     // {Column, Direction}
  Limit   int
  Offset  int
}
```

Mirrors `SQLQueryBuilder` state 1:1 so the client sends what it already holds,
minus the string assembly. `ValueSource=variable|range` replaces the client
emitting the literal tokens — the server knows to bind the dashboard variable /
expand the range for those conditions.

### 3.2 Server query builder

New package `internal/connection/querybuild` (or extend `substitution.go`):
`BuildSQL(driver, intent, params) (sql string, args []any, err error)`.

- Reuses `IsSafeIdentifier()` for every table/column/alias (reject unsafe →
  error, never interpolate).
- Operator → SQL from a server-side allowlist map (the client's 481-494 map
  moves here; unknown operator → error).
- Range condition (`ValueSource=range`) and dashboard-variable condition
  (`ValueSource=variable`) feed the **existing** `substituteAllSQLTokens` /
  range-resolution path — i.e. the builder produces the same token-or-bound
  shape the server already expands, so 90% of `substitution.go` is reused
  unchanged.
- Most-recent-N subquery wrap (client 330-342) moves here: when a range
  condition exists and no explicit ORDER BY, wrap `SELECT * FROM (<inner> ORDER
  BY <rangecol> DESC LIMIT n) ORDER BY <rangecol> ASC`.
- EdgeLake: same `QueryIntent` in, EdgeLake dialect out (no bind params, string
  escaping) — reuse `substituteEdgeLake*`.

### 3.3 Execution path

`POST /api/connections/:id/query` accepts EITHER:
- `query.intent` (preferred) → server `BuildSQL` → execute. No client SQL runs.
- `query.raw` (fallback) → today's path, behind the verb-guard.

The handler builds from `intent` when present; `raw` only runs when `intent` is
absent. This is also the **security fix**: a deployment can (later) refuse
`raw` entirely via a flag once everything emits intent, closing
`query-endpoint-arbitrary-sql` without a separate guard.

### 3.4 Client

`SQLQueryBuilder.jsx`: delete `buildQuery()` (string assembly) and
`parseSimpleQuery()` (reverse parser) — the builder's React state IS the intent;
serialize it directly to `query_config.intent`. Preview/execute send `intent`.
Net ~−250 lines, and the round-trip-through-a-string fragility (the reason
`parseSimpleQuery` bails on OR/BETWEEN/etc.) disappears.

### 3.5 AI surfaces (blast radius — important)

All three AI surfaces currently emit **raw SQL** (`toolops.QueryConnectionInput.Raw`,
and the agents write `query_config.raw` with tokens, shipped in #24). Options:
- **Phase 1:** leave AI on `raw` (it still works via the fallback path). No AI
  change needed to ship the client/server move.
- **Phase 2:** add structured-intent emission to the AI tools so agents produce
  `intent` too (and eventually a deployment can disable `raw`). This is the
  bigger lift and should be its own slice — it touches the shared toolops query
  tool + all three prompt surfaces.

## 4. Phasing (ship in slices, each independently releasable)

1. **Model + builder + tests.** Add `QueryIntent` + `BuildSQL` server-side
   with exhaustive unit tests (every operator, group/order/limit, range wrap,
   each driver's placeholders, EdgeLake dialect, identifier rejection). No
   wiring yet. Pure addition, zero behavior change.
2. **Execution path accepts `intent`.** Handler + `toolops`/adapter take
   `intent` and build; `raw` still works. Round-trip parity tests: for a corpus
   of current components, `BuildSQL(intent)` == the string the client builds
   today.
3. **Client emits `intent`.** `SQLQueryBuilder` serializes state to `intent`;
   delete `buildQuery`/`parseSimpleQuery`. Existing components keep working via
   `raw` until re-saved (or a one-time migration parses `raw`→`intent` where
   `parseSimpleQuery`'s rules allow; un-parseable stays on `raw`).
3.5. **`raw`→`intent` migration tool** (in-process). After slices 1-3 land
   (server builder + parity test proven), run a best-effort migration over
   stored components. See §5.1.
4. **(Later) AI emits `intent`** + deployment flag to refuse `raw` → closes the
   arbitrary-SQL hole fully.

### 5.1 raw→intent migration (slice 3.5)

Port the client's existing reverse parser `parseSimpleQuery()`
(`SQLQueryBuilder.jsx:36-109`, already shipped for the raw→visual toggle in
v0.30.1) to Go and run it as an **in-process migration** (`migrations.go` —
idempotent, runs on boot, no manual step; fits the framework per CLAUDE.md
since it's a per-document parse + conditional `$set`/`$unset` sweep).

Per component with a SQL/EdgeLake `query_config.raw`:
- Parse `raw`. **If it fits the simple subset** → write `query_config.intent`
  and **clear `raw`** (`$unset`/blank) — single source of truth; immediately
  shrinks the arbitrary-SQL surface for that component (decided 2026-06-13:
  clear, don't keep a backup copy).
- **If it does NOT parse** (JOIN/CTE/HAVING/OR/BETWEEN/subquery/IN-expr — the
  parser's documented bail cases) → leave `raw` untouched, no `intent`. These
  are the advanced queries `raw` exists to hold; the server keeps running them
  via the fallback path.

Properties:
- **Safety:** never destructive on un-parseable queries (they keep working).
  Clearing `raw` only happens *after* a successful parse whose `intent`
  round-trips back to equivalent SQL — the migration should re-`BuildSQL` the
  parsed intent and compare to the original (normalized) before committing the
  swap; mismatch → leave as `raw`. This makes the clear safe.
- **Gated on parity:** must NOT run before slice 2's parity test passes, or it
  could convert a query to an intent the server builds differently.
- **Idempotent:** a component already on `intent` (no `raw`) is skipped.
- **Reversible-in-aggregate:** because the clear is parity-checked, the built
  SQL equals the original; nothing is lost even though the literal string is
  gone.

Not a hard requirement for the feature (the `raw` fallback means old components
work un-migrated) — it's the cleanup that gets existing components onto the
structured path and lets a deployment eventually refuse `raw`.

## 5. Backward compatibility

- `raw` stays forever as the escape hatch for advanced SQL the visual builder
  can't express (JOINs, CTEs, window functions). The builder already only
  handles the simple subset; `raw` is how power users go beyond it.
- Existing stored components (all `raw`) keep running unchanged — the server
  prefers `intent` only when present.
- No migration is *required*; an optional best-effort `raw`→`intent` backfill
  (reusing `parseSimpleQuery`'s conservative rules) can convert the simple
  cases, leaving the rest on `raw`.

## 6. Dashboard-mount data path (related, separable)

The viewer does N+1 on mount: `getDashboard(id)` then one full
`getComponent(chartId)` per panel (`DashboardViewerPage.jsx:1165,1180,2449`),
each returning the whole component doc. This is **independent** of #23 (it's
about *fetching* component configs, not *building* SQL) and pairs with #21/#19.

Proposal (separate slice, can be its own issue): a query-only projection —
either extend `GET /api/components/summaries` to optionally include
`query_config`, or a new `GET /api/dashboards/:id/queries` returning per-panel
query info only. The "explicit dashboard-mount concept" the issue asks about is
**not needed** — a query-only projection endpoint is sufficient. Recommend
splitting this out of #23 so the query-construction move isn't blocked on the
load-path change.

## 7. Risks / decisions to confirm before coding

- **Parity is the gate.** Slice 2's round-trip parity test (server build ==
  current client build, for the existing component corpus) must pass before the
  client switch (slice 3) — otherwise charts silently change data.
- **Operator/feature coverage.** The builder's subset (no OR across groups, no
  BETWEEN literal, no IN-with-expr — see `parseSimpleQuery` exclusions) must be
  matched exactly by `QueryIntent`; anything beyond stays `raw`.
- **EdgeLake quirks** (`docs/...edgelake-sql-restrictions`): the builder must
  not emit EXTRACT/DATE_TRUNC/CAST/etc. for EdgeLake — the server builder is the
  right place to enforce per-dialect avoidance.
- **AI timing.** Decide whether AI intent-emission (phase 4) is in-scope for
  #23 or a follow-up. Recommend follow-up — keep #23 to client↔server move.
```
