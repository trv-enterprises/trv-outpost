# Connection-health alerts (server-side watcher)

**Status:** `plans-maybe` — not on the near-term roadmap. Captured 2026-05-14 during the v0.16.9 bell-panel work to make sure the design decision survives.

## The question

Once the persistent-alert system landed (v0.16.4–v0.16.9), the obvious follow-up
is: *should connection failures pipe into it too?* They're already surfaced in
the bell as transient client-side notifications. Why not promote them?

## The answer: no, not as-is

**Don't pipe `apiClient._reportConnectionFailure` into the persistent alert
system.** Today's behavior — client-only, transient, in-memory, 30s debounce
per connection per tab — is load-shedding by design, and that's correct for
this failure shape. Persisting it would turn a transient mechanical signal
into a flood.

## The volume math

A connection-down event on a dashboard with N panels generates **N requests
per refresh cycle that all fail the same way**. The current debounce is
*per-tab*, not per-deployment:

- 1 connection, 12 dashboard tabs open, 30s debounce
  → 24 server-persisted alert writes per minute, all redundant.
- A 6-hour cable disconnect across one deployment
  → ~4,800 alert rows for a single ethernet cable that came unplugged.
- The bell hydrates from `/api/alerts` with `seen=false OR pinned=true`.
  Even at 30s debounce, an unattended deployment overnight produces a
  hydration response that pegs the bell badge and is useless to read.

By contrast, ts-store rules persist successfully because they're **rare,
semantic events**: a temperature crossed a threshold, a store stopped writing.
Connection failures are **frequent, mechanical events** with a different
shape — same underlying state being re-observed by every consumer.

## Two failure shapes — only one belongs in persistent storage

| Shape | Today | Belongs in persistent alerts? |
|---|---|---|
| "Connection X is unreachable *right now*" — per-request, reactive, transient | Client-only toast/bell, 30s debounce per tab | **No.** Keep as-is. |
| "Connection X has been down for 5 minutes" — semantic, time-windowed | Not surfaced | **Yes** (if/when we build it). One alert per outage. |
| "Connection X went down at 2:14, came back at 2:18" — incident-shaped | Not surfaced | **Yes** (if/when we build it). One alert per incident, with start/end. |

The first shape is just UI feedback for "something's wrong right now" — it
doesn't share an audit/notification model with "high-temp rule fired on
store X." Mixing them dilutes both.

The second and third shapes are real *events* and deserve the same treatment
as ts-store alerts: persistence, the bell, deep linking, audit trail.

## What today's client-only behavior gets right

- **Load-shedding by design.** Dropped notifications aren't a problem: if
  the connection is *still* failing, the next request fails too and re-fires
  the local notification. The "missed signal" risk is zero — you can always
  see the current state by trying to use the dashboard.
- **Per-tab debounce** is cheap and doesn't need a server backplane.
- **No DB writes** for the steady-state pathological case (broken connection
  + multiple open tabs).

The v0.16.9 connection-id fallback (`Connection abc12345 did not respond...`
when the name cache misses) closes the only real ergonomic gap — users can
now *identify* which connection is broken, which is what they need to act.

## If we ever build the server-side version

Sketch, not a commitment. Several days of work.

### Shape

A server-side health watcher, NOT a "promote every client failure to a DB
row" plumb-through.

- Server pings each enabled connection on a configurable interval (default
  ~60s). Cheap probe — e.g. TCP connect for SQL, GET / for HTTP, MQTT
  subscribe + immediate disconnect for MQTT.
- Per-connection state machine on the server: `healthy | unreachable |
  degraded`. State lives in memory; persisted only on transition.
- On state transition `healthy → unreachable`, emit ONE persistent alert
  with severity `warning` (or `error` after some grace), title
  `"Connection X unreachable"`, `external_ref` carrying
  `{"dashboard_id":"<best-guess>"}` so the bell deep-link works.
- On `unreachable → healthy`, emit ONE follow-up alert (or auto-mark the
  prior one seen — pick the convention that least surprises operators).
- One alert per outage, not one per request. Bounded volume.

### Settings

- `connection_health.enabled` (bool, default off — opt-in)
- `connection_health.probe_interval_seconds` (int, default 60)
- `connection_health.grace_period_seconds` (int, default 120 — don't alert
  on transient single-probe failures)
- Per-connection override: `health_check.enabled` on each `Connection`
  record, so noisy or "expected to flap" connections can be excluded.

### What this kills vs. what stays

- **Client-side `_reportConnectionFailure` stays.** It's the right thing
  for the "right now" shape. The server-side watcher is additive — a
  *separate* surface for the "been down for a while" shape.
- The two surfaces complement each other: client toast says "this request
  just failed," server alert says "this connection has been failing for
  long enough to care."

### What we'd need to design before starting

- Probe-failure semantics per connection type. TCP connect is fine for SQL;
  HTTP needs more care (GET / may 404 successfully — confirms reachability
  but not service health). MQTT needs subscribe-then-disconnect which holds
  state on the broker briefly.
- Where the watcher lives. Likely a goroutine in the existing
  `connection.Service`, separate from the per-request connection pool.
- Coexistence with the streaming connection manager — if SCM already has an
  open SSE/WS to a connection, it knows the health state for free. Don't
  double-probe.
- Alert dedup with the client-side surface. If both fire, only the
  server-side persists; the client-side toast still appears for the user
  who triggered the request.

## When to revisit

Trigger conditions for promoting this from `plans-maybe` to a real roadmap
item:

1. A multi-hour outage happens unobserved and matters retroactively.
2. We have multiple operators sharing one deployment and "is X currently
   down" becomes a coordination problem.
3. We integrate with paging (PagerDuty etc.) and need a structured
   "connection down" signal to forward.

Until one of those bites, the current client-only model is correct.

## Related

- `client/src/api/client.js::_reportConnectionFailure` — current
  client-side surface (kept).
- `server-go/internal/service/connection_service.go` — likely home for
  the future watcher.
- ts-store alerts (Phase 1 + 2) — the persistent-alert plumbing the
  server-side version would ride on.
- `docs/architecture/streaming.md` — describes today's streaming
  connection lifecycle; future watcher would slot in alongside.

## Tracking

GitHub Issue: [trv-enterprises/trv-outpost#7](https://github.com/trv-enterprises/trv-outpost/issues/7)
(`priority:maybe + area:streaming + effort:m + enhancement`)
