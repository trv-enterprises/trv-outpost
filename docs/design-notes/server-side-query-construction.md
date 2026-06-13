# Execute-by-reference: stop the client sending the query body at runtime (issue #23)

**Status:** Planned (design). Tracks GitHub issue
[#23](https://github.com/trv-enterprises/trv-outpost/issues/23).
**Author:** design note, 2026-06-13 (rewritten after scoping — see "Scoping correction").
**Scope:** close the arbitrary-SQL hole by having **view-mode runtime** queries
execute *by reference* to the stored component (server reads the stored query,
client sends only variable values). **No model change. No client-side SQL
restructuring. No migration.**

---

## Scoping correction (why this note was rewritten)

An earlier draft proposed a structured `QueryIntent` model + server-side
`BuildSQL` + a raw→intent migration. **That was over-scoped.** The component
already stores its query; we don't need to change *how* a query is modeled or
built. The real problem is narrower and purely a **runtime trust** issue:

> At view time the client sends the query body (`query.raw`) to
> `POST /api/connections/:id/query`, and the auth layer treats `/query` as a
> read open to *all* authenticated users. So a `view` user can tamper with the
> query string before it's sent and the server runs it verbatim.

The fix is to **not pass the query body from the client at runtime** — reference
the stored component instead. The model and the stored query stay exactly as
they are.

## Verified current state (2026-06-13)

| Path | Flow | Trust problem |
|---|---|---|
| **View mode (runtime)** | `useData` → `queryData(connId, query)` (`client/src/api/dataClient.js:19`) → `POST /api/connections/:id/query` with `{query:{raw,type,params}}`. The `query` originates from the stored component config but **travels client→server each poll**. | Client can rewrite `query.raw`; server runs it. |
| **Auth gate** | `middleware/auth.go:583-586`: `/query` → `return ""` (no capability required), commented "query endpoints are read operations". | A `view` user is allowed to call the raw-SQL endpoint at all. **This is the hole.** |
| **Design mode (preview)** | Component editor preview → same `/query` with the not-yet-saved query body. | Fine — the author can write any query anyway (they have design capability). |
| **Server execute** | `connection/sql.go:Query()` runs `query.Raw` after token substitution. | Runs whatever string it's handed. |
| **Streaming** | `/stream*` already capability-open and reads server-side; not the concern. | — |

The query *substitution* (dashboard-variable / range tokens → bound params) is
already safe and server-side (`substitution.go`). The hole is specifically the
**raw query body crossing the wire at view time + the open `/query` gate.**

## Design

### A. View-mode runtime = execute-by-reference

New runtime execution that references the stored component instead of carrying
the query body. Shape (final naming TBD at implementation):

```
POST /api/components/:id/data
body: { variables: { <name>: <value>, ... }, range: {…} }   // runtime values ONLY
```

Server:
1. Load the component by `:id`; read its stored `query_config` (unchanged
   model) and its `connection_id`.
2. Apply the **existing** token substitution with the client-supplied variable
   values / range intent (same `substitution.go` path as today — bound params /
   escaped literals).
3. Execute against the connection; return the ResultSet.

The client (`useData`/`queryData`) sends `{component_id, variables, range}` —
**never the SQL**. There is no client-controlled query body at view time, so
there is nothing to inject. The variable *values* are still bound/escaped
exactly as today, so supplying a value is not an injection vector.

### B. Gate the raw `/query` endpoint to authors

`POST /api/connections/:id/query` (raw body) stays — it's the **design-mode
preview** path (and AI authoring probes). But fix `auth.go:583-586` so it
requires **design or manage** capability instead of being open to all. A `view`
user can then no longer reach the raw path at all; authors sending arbitrary
queries is not an escalation (they can already author any query).

Net security model:
- **view** users: can only trigger a *stored* component's query by reference
  (A). Cannot send a query body.
- **design/manage** users: can send a raw query body for preview (B) — no new
  power, they already author queries.

This closes `query-endpoint-arbitrary-sql` with no model change.

### C. What does NOT change

- `ChartQueryConfig` / `models` — unchanged. No `QueryIntent`, no new fields.
- `SQLQueryBuilder.jsx` — unchanged. It still builds + stores the query the way
  it does today (raw string in `query_config.raw`). We are not moving SQL
  assembly off the client; we are not running the client's *runtime* string.
- AI surfaces — unchanged. They author components (which store a query); view
  execution of those components goes through (A) like any other.
- Token substitution (`substitution.go`) — unchanged; (A) feeds it the same
  params it gets today.
- **No migration** — nothing about stored data changes.

## Phasing

1. **Server: execute-by-reference endpoint** (A). Add `POST
   /api/components/:id/data` (or equivalent): load component → substitute
   runtime values → execute. Capability-open to view (it only runs the stored
   query). Tests: stored query runs; supplied variable values bind safely;
   unknown component / cross-namespace rejected.
2. **Client: view-mode uses it.** Point `useData`/`queryData` at the
   by-reference endpoint, sending `{component_id, variables, range}` instead of
   the query body. Design-mode preview keeps the raw `/query` call.
3. **Gate the raw `/query` endpoint** (B): require design/manage in
   `auth.go`. Verify view users get 403 on `/query`; design preview still works.

Each slice is independently releasable. After 1-3, view users cannot submit a
query body anywhere.

## Open questions to confirm at implementation

- **Endpoint shape/name** for (A): `POST /api/components/:id/data` vs a
  query-only variant on an existing component route. (Pairs with the
  dashboard-mount projection idea below.)
- **Streaming components**: the live-stream path (`/stream*`) is already
  server-side and capability-open; confirm it doesn't also carry a
  client-supplied query body that needs the same treatment (it appears to send
  a filter, not arbitrary SQL — verify).
- **Caching / N+1 on mount** (the issue's secondary ask): a view-mode
  `dashboard mount` could batch the by-reference executions or return query-only
  projections. **Independent of the security fix** — recommend splitting into
  its own issue; (A)+(B) stand alone.

## Why this is the right altitude

The component is already the source of truth for its query. The only defect is
*trusting a runtime copy of it from the client*. Execute-by-reference removes
that trust without touching the model, the builder, or stored data — the
smallest change that actually closes the hole.
