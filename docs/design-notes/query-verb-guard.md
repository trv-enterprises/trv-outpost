# Connection `/query` Verb Guard — Design Note

**Status:** Shipped (unreleased). Branch `security-query-guard`, commit
`c07aab6`, build 1955. Not yet merged to `main`.
**Author:** Tom + Claude
**Date:** 2026-06-09
**Severity of the problem it fixes:** HIGH (logged 2026-06-03).

---

## Mission

`POST /api/connections/:id/query` executed client-supplied SQL **verbatim,
with no server-side validation**. Any authenticated user — including a pure
`view` user — could replay a rewritten request and run arbitrary SQL (read
*or* write) against any connection, limited only by the database account's
grants. This note documents the server-side **verb guard** that closes the
write/DDL path, the threat model that shaped it, and the two designs we
considered and rejected.

The guard is **defense-in-depth**. The *primary* real defense — least-
privilege read-only DB credentials — is deployment-side and remains open
(see [Remaining work](#remaining-work)).

---

## The hole

```
client → POST /api/connections/:id/query  { query: { raw, type, params } }
       → connection_handler.go QueryConnection
       → connection_service.go QueryConnection
       → dataSource.Query(ctx, req.Query)        ← runs req.Query.Raw as-is
```

`req.Query.Raw` reached the adapter unchecked. Two aggravating facts:

1. **The endpoint is intentionally no-capability.** `auth.go`
   `getRequiredCapability` returns `""` for any path ending in `/query`
   (and for `/stream`). It is treated as a read operation, so capability
   gating does not defend it.
2. **View Mode depends on it.** Every non-streaming chart fetches its data
   through this endpoint: `client/src/api/dataClient.js queryData()` → `POST
   /query`. A pure `view` user hits it constantly and legitimately.

**Confirmed live** (2026-06-03, lab Postgres connection): a `view`-only user
replayed `SELECT table_name FROM information_schema.tables` and got the
schema back. `DROP` / `DELETE` / `INSERT` / `UPDATE` would also have run if
the DB account had the grants.

### What was already safe (don't re-chase)

The `{{dashboard-variable}}` substitution is **not** the hole. For SQL the
variable value is bound as a placeholder parameter (`substituteSQLToken` in
`sql.go`); for EdgeLake it is escaped into the AnyLog string
(`edgelake.go`). A malicious *value* (`x'; DROP …`) is inert. The exposure
was always the **raw query**, not the variable. The variable work merely
surfaced it. This is why the guard classifies `query.Raw` **before**
substitution — the verb always lives in `Raw`; the token carries none.

---

## Threat model

The attacker is **not** anonymous and **not** privilege-escalating. They are
replaying or tampering with a **legitimate authenticated request** — swapping
the `raw` body of a request a real principal was entitled to make, changing a
`SELECT` into an `INSERT`/`DELETE`/`DROP`.

This framing is load-bearing, because it rules out the obvious identity-based
fixes:

- The attacker already holds a valid principal's token. Gating *who* may call
  the endpoint does nothing — they're replaying someone who's allowed.
- Therefore the defense must police **what runs**, not **who runs it**. The
  server has to refuse the dangerous *verb*, regardless of caller.

---

## Designs considered and rejected

### ✗ Capability split (require `design`, not `view`)

The original idea: arbitrary query execution is an authoring action, so gate
`/query` behind the `design` capability. **Rejected — it breaks View Mode.**
Viewers render every chart through `/query`; a pure `view` user must keep
calling it. There is no "author-only" framing of an endpoint that is the
core read path for viewers.

### ✗ Per-namespace / per-user write permission

A later idea: scope write-permission by namespace (a "lab" namespace allows
writes, "prod" stays read-only). **Rejected for two reasons (Tom):**

1. **It doesn't fit the threat.** The attacker is replaying a legitimate
   request; namespace doesn't constrain them. "Which namespace may write"
   is orthogonal to "stop the injected verb from running."
2. **Namespace isn't an identity boundary.** Namespace is not in the JWT, and
   a *user* has no namespace — it's a record-grouping/visibility concept
   (which namespaces a user is *authorized to interact with*, a future
   per-user authz feature), not a write-policy axis. Bolting SQL-write policy
   onto it conflates two unrelated things.

### ✓ Caller-agnostic verb guard (chosen)

Refuse dangerous verbs at the server, for everyone, with a global admin
opt-in to relax specific write verbs. This polices *what runs*, which is
exactly what the replay threat requires.

---

## The design

A pure, dependency-free classifier (`internal/connection/sqlguard.go`)
invoked from `QueryConnection` **before** the adapter is created (so a blocked
query never opens a DB connection). Applied to **`sql` and `edgelake` query
types only** — `api` / `mqtt` / `prometheus` / `tsstore` / `csv_filter` /
`stream_filter` pass through untouched.

### Policy

| Verb | Disposition |
|---|---|
| `SELECT`, `VALUES`, `SHOW`, `TABLE`, `WITH`(→read), `EXPLAIN`/`ANALYZE` of a read | **Always allowed** |
| `INSERT` / `UPDATE` / `DELETE` | Allowed **only** if the matching admin flag is on |
| DDL: `DROP`/`ALTER`/`TRUNCATE`/`CREATE`/`GRANT`/`REVOKE`/`MERGE`/… | **Always refused** — no flag, no opt-in |
| Unknown leading keyword | **Refused (fail closed)** |
| Multi-statement (`;`-chained) | **Refused** |
| Empty / comment-only | **Refused (unclassifiable)** |

Default posture — all three flags off — is **strict read-only**. DDL has no
flag by deliberate choice: a replayed `DROP TABLE` must never run, period.

### Configuration

Three global admin settings (`server-go/config/user-configurable.yaml`,
category `security`), default `false`:

- `query_guard.allow_insert`
- `query_guard.allow_update`
- `query_guard.allow_delete`

They are **read live per-query** via a closure wired in `main.go` after
`SettingsService` exists (`connectionService.SetQueryGuardPolicy(...)`), so a
toggle takes effect on the next query with **no restart**. A settings read
error falls back to `false` — a settings outage can never *permit* writes.
Because they're booleans, they render through the existing
`PrimitiveSettingEditorModal` Carbon `Toggle` — **no frontend code**.

### Error path

A blocked query returns **HTTP 200** with `success:false`,
`error_code:"write_not_allowed"` (`models.QueryErrorWriteNotAllowed`), and a
clear human message — matching the existing `dashboard_variable_not_set`
error style so the View Mode client handles it uniformly. (Not a 403: that
would diverge from how every other query failure surfaces, and the client
only inspects `success` / `error_code`.)

---

## The classifier (why hand-rolled)

A real SQL parser (vitess, pg_query_go) is dialect-locked (MySQL *or*
Postgres, not both, and definitely not AnyLog/EdgeLake), pulls a large
dependency tree, and still requires mapping its AST to our policy. We need
exactly three facts: *(a)* is there more than one statement? *(b)* what is the
leading verb? *(c)* for `WITH`, does the CTE resolve to a read or a write? A
focused, well-tested scanner answers all three, is dialect-agnostic, and
matches the maintainer's preference against unnecessary dependencies.

The scanner is the security-critical part, so its correctness is the real
deliverable. It is **comment- and literal-aware** — a single linear pass with
a small state machine (`NORMAL`/`SQUOTE`/`DQUOTE`/`LINECOMMENT`/`BLOCKCOMMENT`):

- Splits on **top-level** `;` only. A `;` inside a string literal or comment
  does **not** split.
- Collapses `--` and `/* */` comments to whitespace, so a keyword or a second
  statement **smuggled inside a comment** (`SELECT 1 -- ; DROP TABLE x`) is
  swallowed and never classified.
- Tracks `'…'` and `"…"` literals including `''`/`""` escape-doubling, so
  `SELECT 'O''Brien; DELETE FROM t'` stays a single SELECT.
- Skips read-only prefixes (`EXPLAIN`, `ANALYZE`, `DESCRIBE`) and a wrapping
  `(` before reading the verb, so `EXPLAIN ANALYZE DELETE …` classifies as a
  delete and `(SELECT 1)` as a read.
- Resolves `WITH` by skipping balanced-paren CTE bodies to find the operative
  verb: `WITH x AS (SELECT 1) DELETE …` is a **delete**, not a read.
- **Fails closed:** any unrecognized leading keyword classifies as DDL
  (refused), so a verb we didn't enumerate cannot slip through as allowed.

### Documented edge cases

- **`SELECT … INTO newtbl`** (table-creating in Postgres) classifies on its
  leading `SELECT` and is **allowed**. The replay threat is about swapping in
  an obvious `INSERT`/`DELETE`/`DROP`; this is a conscious, documented
  allowance, not an oversight. Revisit if a deployment needs it blocked.
- **`MERGE`/`REPLACE`/`UPSERT`** are writes with no opt-in flag, so they take
  the fail-closed DDL path (refused). Deliberate under "default = read-only."

---

## EdgeLake note

The EdgeLake adapter advertises `CanWrite:false` and its `Write()` hard-errors
— but its `Query()` does **not** itself refuse write SQL; it builds
`sql <db> format=json "<raw>"` and `ResolveHTTPMethod` would dispatch an
`INSERT` as a POST. So EdgeLake is **not** inherently read-only at the query
path and **is** guarded. AnyLog SQL is a Postgres subset using the same
leading-verb grammar, so the same classifier applies.

---

## Verification

Two layers:

1. **Unit** — `internal/connection/sqlguard_test.go`: a 41-case classification
   matrix plus read-only and policy-on authorization tests. Covers the nasty
   cases: semicolons/keywords inside string literals, `--` and `/* */` comment
   smuggling, doubled-quote escapes, CTEs resolving to DELETE/INSERT, stacked
   statements, `EXPLAIN` of a write, `MERGE`/unknown-verb fail-closed,
   unterminated block comments, empty/comment-only bodies.

2. **End-to-end** — against the lab Postgres connection as a **view-only**
   user (the exact original exploit):

   | Query | Result |
   |---|---|
   | `SELECT …` | ✅ runs (View Mode unaffected) |
   | `DROP TABLE …` | 🛡️ `write_not_allowed` (DDL message) |
   | `DELETE` / `INSERT` / `UPDATE` | 🛡️ `write_not_allowed` (read-only message) |
   | `SELECT 1; DROP TABLE …` | 🛡️ `write_not_allowed` (single-statement message) |
   | `SELECT 1 -- ; DROP TABLE x` | ✅ SELECT runs; smuggled DROP ignored |
   | `DELETE …` with `allow_delete=true` | ✅ reaches DB (guard permits; live toggle, no restart) |
   | `DROP` / `INSERT` with `allow_delete=true` | 🛡️ still blocked (DDL never; flags independent) |

---

## Breach testing — a real bypass found and fixed

After the first implementation, we ran active breach attempts through the live
API (not just unit tests). One **real bypass** surfaced:

**Type-confusion bypass (fixed).** The guard originally gated on the
*client-supplied* `query.Type` (`req.Query.Type == sql || edgelake`). But the
adapter is chosen by the **connection's** type, and the SQL adapter runs
`query.Raw` **regardless of `query.Type`** — it never reads that field for
dispatch. So an attacker could send `{"raw":"DROP TABLE …","type":"api"}` to a
SQL connection: the guard's condition was false (skip), but the SQL adapter ran
the DROP anyway. Confirmed live — the DROP reached Postgres (failed only on a
foreign-key dependency, `pq: cannot drop table`, not on the guard).

**Fix:** gate on `ds.Type` (the connection's own type, server-side and
trustworthy) via `connection.MustGuard(...)`, never on `query.Type`. The
gating decision now lives in one tested helper (`MustGuard` +
`TestMustGuard`), with the connection-type set as the single source of truth.
Verified: every `query.Type` value (`api`, `prometheus`, `tsstore`, omitted,
bogus) on a SQL connection is now blocked.

**Other vectors tested and found safe (no change needed):**

- **Encoding/evasion** — lowercase, leading whitespace/newlines, leading
  comments, CTE-hidden writes, stacked statements, `EXPLAIN ANALYZE DELETE`,
  `INSERT … RETURNING`, trailing comments — all correctly classified and
  blocked.
- **Write smuggled in `params`** — inert. `params` values are passed via the
  driver's parameterized API (bound data), never concatenated into SQL.
- **Sibling endpoints** — `/variable-values` (SQL + EdgeLake) builds its query
  via `BuildDistinctQuery`, which validates `column`/`table` against a strict
  `IsSafeIdentifier` allowlist and quotes them — no raw-SQL injection. The
  tsstore/API distinct paths and `"newest"` use hardcoded raw.
  `SaveDiscoveredValues` does a repo write, no SQL.
- **AI / MCP `query_connection` tool** — calls the same service
  `QueryConnection`, so it **inherits the guard** automatically (all three AI
  call sites). No separate adapter bypass for the agents.

## Files

| File | Change |
|---|---|
| `internal/connection/sqlguard.go` | **New.** `ClassifyAndAuthorize`, `WritePolicy`, the scanner, `GuardErrorMessage`. |
| `internal/connection/sqlguard_test.go` | **New.** 41-case matrix + authz tests. |
| `internal/service/connection_service.go` | Guard call in `QueryConnection` (before adapter creation); `SetQueryGuardPolicy` setter + field. |
| `cmd/server/main.go` | Policy closure wiring (reads the three settings live). |
| `internal/models/connection.go` | `QueryErrorWriteNotAllowed` error code. |
| `server-go/config/user-configurable.yaml` | Three `query_guard.allow_*` settings (category `security`, default false). |
| `CLAUDE.md` | Admin-settings table rows. |

No HTTP handler signature, route, or Swagger annotation changed — `make
api-docs-check` stays clean.

---

## Remaining work

1. **Least-privilege DB credentials (PRIMARY defense — open).** Connections
   should authenticate as a read-only DB role (`GRANT SELECT` only, ideally
   table-scoped); then a replayed write fails at the database no matter what
   the app allows. Deployment/connection-config side, not repo code. Audit
   whether the simulator and prod connections use read-only roles.
2. **Ship it.** The branch is unreleased and unmerged.

## Related

- `ai-query-tool-data-to-anthropic-todo` — same endpoint, different concern
  (AI tools returning row *values* to the model).
- The guard runs the same regardless of registry-vs-legacy adapter path,
  because it sits in `QueryConnection` above `CreateFromConfig`.
