# Dashboard Assistant — Design Note

**Status:** Design, not yet built.
**Author:** Tom + Claude
**Date:** 2026-05-26
**Working name in this doc:** *Dashboard Assistant.* Header tooltip
will read "Assistant." Internal package path: `server-go/internal/ai/chat/`.

---

## Mission

A persistent, app-shell-level chat assistant inside the dashboard
SPA. The user can open it from any page via a header icon, ask in
plain language for whatever they want built ("create a dashboard for
my Frigate camera," "wire this MQTT broker into a temperature
gauge," "make a status board for these EdgeLake nodes"), and watch
the assistant build it — talking to the same backend the human
uses, via in-process tool calls.

It is **not** a help bot. It is a builder, scoped to the deployment.

---

## What this is NOT

Three agent surfaces in or near the dashboard now. Roles must stay
crisp.

| Surface | Lives in | Scope | Tool surface |
|---|---|---|---|
| **Component AI agent** | Component editor (`/design/components/ai/:id`) | One specific chart/component | Narrow: structured-config, codegen, set-custom-code |
| **Electron sidebar** | Electron desktop shell only | Whole filesystem + dashboard via MCP | Claude Code's full toolset; runs as a subscription session in a separate `node-pty` process |
| **Dashboard Assistant** *(this doc)* | Dashboard app shell — web AND Electron | Whole deployment (connections, components, dashboards, namespaces) | Broad in-process tool registry; runs server-side, uses deployment Anthropic key |

The Dashboard Assistant does **not** go through MCP. Its architecture
is a sibling of the existing Component AI agent in the `internal/ai/`
package — see the Architecture section. (A standalone `dashboard-agent`
CLI was an earlier learning step — an external MCP client that built
dashboards end-to-end — now retired; the Assistant supersedes it.)

---

## Entry point

A new icon in the dashboard header, **left of the right-hand icon
cluster** (avatar menu, notifications, namespace picker).

- Click opens the assistant sidecard.
- Carbon icon: `AiLaunch` (sparkles + arrow). Tooltip: "Assistant."
- Renders only when the assistant is enabled (see Gating).

---

## Sidecard

Right-hand panel, slides in over page content. Persistent across
navigation — opening it on `/design/dashboards` and switching to
`/manage/users` does not kill the conversation.

**Width:** resizable via a drag handle on the left edge. Default
28rem. Min ~22rem. Max ~50% of viewport.

**State persistence** (per-user, in the existing user-prefs system):

| Key                              | Type   | Default |
|----------------------------------|--------|---------|
| `assistant.sidecard_open`        | bool   | false   |
| `assistant.sidecard_width_px`    | number | 448     |

Web AND Electron mount the same component. The Electron `BrowserView`
sidebar is **separate** — it doesn't change.

### Layout

```
┌─ Assistant ─────────────────── [⚙] [×] ┐
│ Namespace: <name>  • Model: sonnet-4-6 │
├────────────────────────────────────────┤
│                                        │
│ (message list — markdown rendered;     │
│  tool calls collapsed by default with  │
│  click-to-expand showing arguments +   │
│  result preview; long results truncate)│
│                                        │
├────────────────────────────────────────┤
│ [_________________________________]    │
│ [ ↑ stop ]  [ Send → ]                 │
└────────────────────────────────────────┘
```

- **Header line.** Shows current namespace and model. Informational
  only — namespace = the user's active namespace; switching
  namespaces in the header doesn't migrate the open conversation.
- **Cog (⚙) icon — popover menu:**
  - **Clear chat** — discard the current conversation
  - **Export as Markdown** — download as `.md`
  - **Export as JSON** — download as `.json`
  - **Show tool calls** (toggle — expand all / collapse all)
  - **Show token usage** (toggle — surface a small footer line)
- **Message list — friendlier rendering than the Component AI
  agent's transcript:**
  - User messages: right-aligned, layered background
  - Assistant messages: left-aligned, plain background, markdown rendered
  - **Tool calls render as collapsible cards inline in the
    assistant turn.** Default collapsed: shows tool name + a
    one-line summary of args ("`list_connections` — 12 items"). Click
    to expand: shows full args (JSON-rendered with the same
    `TerminalResponseBody` component we ship for EdgeLake responses)
    and a result preview.
  - Long results auto-truncate at ~20 lines with a "show full"
    affordance. Full results live in the server-side **tool-result
    store** (see Architecture); the UI fetches the full content on
    demand.
  - Code blocks use the existing AceEditor / syntax theme.
- **Input.** Multi-line textarea, autosizes to ~6 rows. Enter sends,
  Shift-Enter newline.
- **Stop button** appears while the assistant is generating; clicking
  cancels the in-flight context.

---

## Architecture

The Dashboard Assistant is built **alongside** the Component AI
agent, sharing the existing `internal/ai/` infrastructure where it
makes sense and forking where the two agents need different shapes.

### Shared `toolops` layer

The Dashboard Assistant and the existing MCP endpoint expose
largely the same set of dashboard operations — list connections,
create components, build dashboards, query connections, etc. —
just shaped differently for two different transports. Letting each
maintain its own implementation invites drift: a bug in MCP's
`create_component` doesn't get fixed in the Assistant's version, or
vice versa.

To avoid this, both consumers share a new package:

```
server-go/internal/ai/toolops/
├── connections.go    // ListConnections, GetConnection, CreateConnection, ...
├── components.go     // ListComponents, CreateComponent, UpdateComponent, ...
├── dashboards.go     // ListDashboards, CreateDashboard, ...
├── discovery.go      // ListEdgeLakeTables, SampleMQTTTopic, ...
├── guidance.go       // GetConnectionTypeGuidance, GetChartTypeSpec, ...
└── results.go        // result-size measurement, summarization helpers
```

Each function takes typed Go inputs and returns typed Go outputs.
They call into the existing service layer (`service.ConnectionService`,
`service.ComponentService`, etc.) — they don't reinvent business
logic. The Toolset struct is wired once at server startup and shared
across consumers.

```go
// internal/ai/toolops/connections.go
package toolops

type ListConnectionsInput struct {
    NamespaceID string
    TypeFilter  string  // "" = all
}

type ListConnectionsOutput struct {
    Connections []models.Connection
}

func (t *Toolset) ListConnections(ctx context.Context, in ListConnectionsInput) (*ListConnectionsOutput, error) {
    conns, err := t.connections.ListByNamespace(ctx, in.NamespaceID, in.TypeFilter)
    if err != nil {
        return nil, err
    }
    return &ListConnectionsOutput{Connections: conns}, nil
}
```

#### How the two consumers wrap toolops

**MCP wrapper** (`internal/mcp/tools.go`) keeps its current
JSON-RPC handler shape; each handler becomes a thin shim that
unmarshals JSON-RPC args, calls a `toolops` method, and returns
the result for MCP to marshal to JSON-RPC. MCP keeps owning:
JSON-RPC envelope, MCP `tools/list`/`prompts/list` discovery, the
MCP-shaped tool descriptions.

**Dashboard Assistant wrapper** (`internal/ai/chat/tools/registry.go`)
registers each `toolops` operation with Anthropic-tool-shaped
metadata, a capability predicate, and a tier flag (A vs B).

```go
// internal/ai/chat/tools/connections.go
var ListConnectionsTool = ChatTool{
    Name:        "list_connections",
    Description: "List all connections in the current namespace.",
    Tier:        TierA,
    Capability:  CapView,
    InputSchema: ..., // JSON schema for Anthropic
    Handler: func(ctx context.Context, args json.RawMessage, env *Env) (any, error) {
        var in struct{ TypeFilter string `json:"type_filter,omitempty"` }
        json.Unmarshal(args, &in)
        return env.Toolops.ListConnections(ctx, toolops.ListConnectionsInput{
            NamespaceID: env.CurrentNamespace,
            TypeFilter:  in.TypeFilter,
        })
    },
}
```

The chat wrapper owns: Anthropic tool-call shape, capability gate,
namespace injection from request context, Tier-A/B classification,
result-size measurement → tool-result store handoff.

#### Split of concerns

| Concern | Owner |
|---|---|
| What the tool *does* | `internal/ai/toolops` |
| JSON-RPC envelope, MCP `tools/list`, prompts capability | `internal/mcp` |
| Anthropic tool-call shape, capability gate, namespace injection, Tier-A/B classification, result store handoff | `internal/ai/chat/tools` |

Adding a new dashboard operation: write it in `toolops` once. Wire
it into both wrappers. ~10 lines per wrapper. No drift on the
underlying behavior; intentional drift on how it's exposed.

#### Component AI agent stays separate

The existing Component AI agent (`internal/ai/tools.go` and
`tool_executor.go`) is *not* migrated to `toolops`. Its toolset is
component-scoped (operate on one chart by ID); the broader
operations like `list_connections` aren't the right shape for it.
If a Component AI tool ever needs a shared op (e.g. query a
connection to validate a chart config), it can pull from `toolops`
à la carte at that point.

#### Three honest gotchas

1. **Namespace is a per-request concern.** `toolops` takes
   `NamespaceID` as an explicit parameter; the chat wrapper extracts
   from the caller's session and injects, the MCP wrapper accepts
   it from the JSON-RPC args.
2. **Authorization is a per-request concern.** `toolops` doesn't
   gate; both wrappers do, separately. The chat wrapper checks the
   per-tool capability predicate before dispatch; MCP relies on its
   existing auth middleware. Both must be audited together when a
   new mutation tool lands.
3. **Error shapes drift.** `toolops` returns Go errors. MCP wraps
   in JSON-RPC error objects with codes; the chat agent wraps as
   tool-result errors that go back to the model. We don't
   standardize — each wrapper translates as needed.

### What's reused from `internal/ai/`

- The `Agent` *type* and its message-loop driver (Anthropic SDK
  call shape, retry logic, streaming event types).
- The `AISession` model, `AISessionRepository`, `AISessionService`
  — extended with a `kind: "chat"` discriminator.
- The SSE handler in `AISessionHandler.SendMessage` and the cancel
  path in `CancelSession`. The wire format on the SSE channel is
  identical; the client just receives the assistant's responses and
  tool calls the same way it does for the Component AI agent.
- The token-counting and basic context-management code.

### What's new — sibling code in `internal/ai/chat/`

Separate files, same package family. The Component AI agent and the
Dashboard Assistant share a type (`*ai.Agent`) but are instantiated
as separate object graphs with different prompts and different tool
registries. No cross-talk risk because they don't share state.

Directory shape:

```
server-go/internal/ai/chat/
├── agent.go             // wraps the message loop; just orchestration
├── prompt.go            // assembles per-turn prompt from layers
├── layers/
│   ├── system.go        // immutable system prompt — small, stable
│   ├── caller.go        // caller context (caps, namespace, date) — 1-2 lines
│   ├── tools.go         // tool definitions for THIS turn
│   ├── history.go       // conversation history (full + summary mode)
│   └── workspace.go     // optional: pinned context the user marked relevant
├── tools/
│   ├── registry.go      // tool registry + per-tool capability predicate
│   ├── tier_a.go        // tier A: cheap, always-available read tools
│   ├── tier_b.go        // tier B: everything else, loaded on demand
│   ├── results_store.go // server-side cache of full tool results
│   └── executor.go      // tool dispatch into the existing service layer
└── budget.go            // token accounting + phase-switching
```

### Session lifecycle

Single endpoint family (`/api/ai/sessions/*`) handles both agents.
The new `kind: "chat"` discriminator on the session record selects:

- Which `Agent` instance handles the message loop
- Which system prompt + tool registry are wired in
- Which capability+namespace gate is enforced

Component AI agent sessions still get `kind: "component"` and a
`target_id` (the chart ID). Chat sessions get `kind: "chat"` and no
target. The repo + service learn the discriminator; everything
else stays the same.

### Session storage

Mongo collection: existing `ai_sessions`, with the new `kind`
field.

**No server-side saved-conversations feature.** Conversations are
ephemeral on the client. The session record persists server-side
during the conversation (we need it for SSE + tool dispatch) and is
TTL-cleaned after ~24h of inactivity. Users who want a permanent
record use **Export as Markdown / JSON** (see below).

### Capability + namespace gating

Hard rule: **the assistant can only do what the caller can do.** Not
a privilege bypass.

- **View-only user:** read tools only. Mutation tools return an
  error to the model: `"requires Design capability"`. The model
  reads that and adjusts its plan ("I can't create this for you,
  but you have Design access to do it manually — here's how").
- **Design-capable:** create/update/delete connections, components,
  dashboards in their current namespace.
- **Manage-capable:** also namespace CRUD, settings reads. Most
  Manage surface stays UI-only for v1 — the assistant doesn't get
  system-user creation, because failure modes are bad.
- **Control-only:** `execute_control` tool, no design/manage tools.

**Where the gate lives:** in `tools/executor.go`. Each tool
registration declares its capability predicate; the executor checks
caps before dispatching. Same code path used for every tool.

**Namespace context:** the assistant operates in the caller's
*currently-selected namespace*. Any `create_*` injects the
namespace from request context; `list_*` scopes to it. No in-chat
namespace switching for v1.

---

## Token budget + phased context architecture

Unscoped agent + Opus = expensive. The architecture is built to
move information that *can* be on-demand off the per-turn context.

### The principle

Every token in the model's context costs money on every turn. So:

- **Phase 1** (always loaded, every turn): only what's truly
  necessary — role, caller, the *names* of available tools, the
  recent conversation.
- **Phase 2** (loaded on demand, when the model asks): tool
  schemas, connection-type guidance, full tool results.
- **Phase 3** (compaction): older conversation turns summarized to
  free up budget.

The phased model is **baked into the architecture** from day 1.
Each phase is a layer in the prompt-assembly pipeline.

### Phase 1 — always loaded (cheap, stable, every turn)

What goes in:

- **System prompt** (~500 tokens) — role, instructions, behavior
  rules.
- **Caller context** (~50 tokens) — capabilities, namespace, date,
  user's display name.
- **Tier-A tool definitions** (~6-10 tools, ~1000 tokens) — the
  cheap, frequently-used reads that the model needs constantly:
  `list_connections`, `list_components`, `list_dashboards`,
  `list_chart_types`, `list_namespaces`, `list_integrations`,
  `get_current_user`, `describe_tool`, `get_full_result`.
- **Tier-B tool *names* with one-line descriptions** (~30 tools,
  ~1500 tokens) — so the model knows what's *possible* without
  loading every schema. Format: `tool_name: short description`.
- **Conversation history** — full transcript until compaction
  kicks in (Phase 3).

Phase 1 ceiling per turn: ~5-8k tokens regardless of how big the
toolset grows.

### Phase 2 — loaded on demand

Two meta-tools the model calls when it needs more info:

1. **`describe_tool(names: string[])`** — returns the full JSON
   schema for one or more Tier-B tools. Once returned, the schemas
   stay in conversation context (the model doesn't pay for them
   again).
2. **`get_full_result(result_id: string)`** — returns the full
   content of a tool result that was previously truncated. Tool
   results larger than ~2000 tokens are stored server-side (the
   **tool-result store**), inlined into the conversation as a
   one-line summary + ID. If the model needs the full content
   (rare), this tool fetches it.

This is the key win. A `query_connection` against a 47-row table
isn't going to pay; a `query_connection` against a 10,000-row
result is going to be stored server-side and represented inline as
"`query_connection`: 10000 rows returned (result_id `r_a3b9…`)" —
~50 tokens instead of millions.

Other Phase 2 candidates (call sites mark these for on-demand
loading):

- `get_connection_type_guidance(type)` — full markdown guidance
  for a connection type (e.g. EdgeLake SQL restrictions)
- `get_chart_type_spec(type)` — chart-type-specific configuration
  fields
- `get_component_template(type)` — codegen template for a chart
  type

### Phase 3 — context compaction (v1.1, not v1)

Architecture supports it; implementation deferred. When
conversation history exceeds a threshold (e.g. 40k tokens), older
turns are summarized into a "previous activity" block: "Earlier in
this conversation: user asked X, assistant created connection Y,
ran query Z which returned 47 rows." Verbatim turns are kept in
the export-to-file path but drop out of the model's context.

For v1 we just set a hard cap: hard error at 150k context tokens,
asking the user to clear the chat or export and restart.

### Trade-off — on-demand loading adds latency

Calling `describe_tool` before invoking a Tier-B tool costs one
extra round-trip. For a high-value action (`create_dashboard`),
that's a few seconds of wait.

Mitigations:

- **Pre-load schemas for "obvious" Tier-B tools** on first user
  message that contains hints — e.g. if the user says "create a
  dashboard," the prompt-assembly layer pre-loads
  `create_dashboard`'s schema before the model even runs.
- **`describe_tool` accepts a list** so the model can batch.
- **Cached for the rest of the conversation** — once loaded, the
  schema stays in context, no second round-trip.

Acceptable trade-off in exchange for the bounded per-turn cost. Will
revisit if telemetry shows the latency is hurting.

### Cost guardrails

Three layered controls on top of the architecture:

1. **Per-conversation context cap.** Soft warning at 50k context
   tokens with a banner ("start a new chat for performance"). Hard
   cut at 150k.
2. **Per-user daily token budget.** Tracked server-side; assistant
   refuses new turns when exceeded. Configurable via admin
   setting `assistant.daily_token_budget` — default 1,000,000
   input + 250,000 output. Resets at UTC midnight.
3. **Model selection.** Default Sonnet for v1 (cheaper, still
   capable). Opus opt-in via admin setting `assistant.model`. The
   Component AI agent runs Opus today; the broader scope here
   means the per-turn bar should be lower.

All three configurable via admin settings.

---

## Saving conversations

**No server-side history.** Two local-file exports instead.

### Export as Markdown

Renders the conversation as a human-readable `.md` file. Sketch:

```markdown
# Dashboard Assistant — Conversation
Date: 2026-05-26 11:24 CDT
Namespace: homelab
Model: claude-sonnet-4-6
User: Tom Viviano

## You — 11:24:03
Build me a dashboard for my Frigate cameras.

## Assistant — 11:24:05
I'll start by checking what Frigate connections you have, then…

<details>
<summary>Tool: list_connections — 3 results</summary>

**Arguments:**
```json
{ "type_filter": "api.frigate" }
```

**Result:**
```json
[
  { "id": "...", "name": "Front Door", ... },
  ...
]
```
</details>

## Assistant — 11:24:09
Looks like you have three cameras. I'll build a 3-tile dashboard…
```

Tool calls render as `<details>` blocks so they're collapsed by
default in markdown viewers (GitHub, Obsidian, Bear) and don't
crowd the readable content.

### Export as JSON

Full structured fidelity:

```json
{
  "exported_at": "2026-05-26T16:24:00Z",
  "namespace": "homelab",
  "model": "claude-sonnet-4-6",
  "user": { "name": "Tom Viviano", "guid": "..." },
  "messages": [
    {
      "role": "user",
      "ts": "2026-05-26T16:24:03Z",
      "content": "Build me a dashboard for my Frigate cameras."
    },
    {
      "role": "assistant",
      "ts": "2026-05-26T16:24:05Z",
      "content": "I'll start by checking…",
      "tool_calls": [
        {
          "name": "list_connections",
          "args": { ... },
          "result": { ... },
          "result_id": "r_a3b9...",
          "tokens_in": 234,
          "tokens_out": 1480
        }
      ]
    }
  ],
  "totals": { "tokens_in": 12480, "tokens_out": 3210 }
}
```

User reformats however they want later — feed it into a script,
load it into a tool, parse it for analytics.

### Implementation

Both renders are pure client-side functions over the conversation
state already held in browser memory. No new server endpoints.
Triggered from the cog popover; downloaded via `Blob` +
`URL.createObjectURL`, same plumbing the EdgeLake recording feature
uses.

---

## Gating and feature flag

The Dashboard Assistant must be disable-able by deployment
operators — same posture as the existing Component AI agent. Two
independent switches; both must pass.

### Switch 1: Anthropic credential present (hard env gate)

The assistant **cannot run without** `ANTHROPIC_API_KEY` in the
server environment. Same hard precondition the Component AI agent
already has. When the key is missing:

- The assistant constructor returns nil at boot.
- `/api/ai/availability` reports `chat_agent_enabled: false`.
- The header icon doesn't render.
- All assistant routes return 404 (router doesn't register them
  when the agent is nil).

No fallback model, no degraded mode. The feature simply doesn't
exist in that deployment.

### Switch 2: Admin enable flag (soft runtime kill-switch)

New admin setting, seeded from
`server-go/config/user-configurable.yaml`:

| Key                       | Default | Category | Description |
|---------------------------|---------|----------|-------------|
| `assistant.enabled`       | `true`  | ai       | Whether the Dashboard Assistant is available. Requires `ANTHROPIC_API_KEY` regardless. |

When `false`, the assistant is fully disabled even if the API key
is set:

- `/api/ai/availability` reports `chat_agent_enabled: false`.
- The header icon doesn't render.
- Routes return 404.
- The settings toggle itself still renders so an admin can turn
  it back on.

### Why two switches

- `ANTHROPIC_API_KEY` is a deployment-level credential decision —
  set once in env, often not editable post-deploy without redeploy.
- `assistant.enabled` is a runtime kill-switch — an admin can flip
  it instantly via the settings page if costs spike or behavior
  goes sideways, without redeploying or rotating the API key.

### Availability endpoint

Extend the existing `GET /api/ai/availability` response (currently
returns `{ enabled: bool }` for the Component AI agent) to return
both flags:

```json
{
  "component_agent_enabled": true,
  "chat_agent_enabled": true
}
```

`enabled` stays as an alias for `component_agent_enabled` so
existing consumers don't break. SPA bootstrap reads this once and
populates `AIAvailabilityContext` with both flags. Each consumer
reads the one it cares about.

### Restart vs hot-toggle

For v1, flipping `assistant.enabled` requires a server restart to
take effect. Matches the `enabled_types` ledger pattern (read once
at boot) and avoids "agent is half-running" states. Future
enhancement could make it hot-reloadable; not worth the complexity
in v1.

### Failure mode: fails closed

Every code path the user could reach must fail closed when
disabled. Header icon hidden (not just disabled). Sidecard not
mounted. Session-create endpoint returns 404. Only the settings
toggle survives.

---

## System prompt

Sketch (final wording lives in `server-go/internal/ai/chat/layers/system.go`):

> You are the TRV Outpost Assistant. The user is operating in
> namespace `<active>`. Today is `<date>`. Their capabilities are:
> `<caps>`.
>
> Your job is to help the user build and operate dashboards: create
> connections to data sources, build components (charts, controls,
> displays), and assemble them into dashboards. You have tools
> that let you do all of this directly — when the user asks for
> something buildable, build it. When they ask a question, answer
> it. Don't ask for confirmation before making small obvious moves;
> do confirm before destructive operations (delete, drop, replace).
>
> Tools are described in two tiers:
>
> - **Always available** (use directly): the read tools listed
>   above with full schemas.
> - **Available on request:** the names listed below, with
>   one-line descriptions. To use one, call `describe_tool` with
>   the name(s) to get the full schema, then invoke.
>
> Large tool results (rows of data, full connection lists) are
> stored and shown to you as a summary + a result ID. If you need
> the full content, call `get_full_result(result_id)`. Don't
> request the full content unless you actually need it — the
> summary usually has what you need.
>
> Capability constraints: if the user asks for something outside
> their capabilities, explain what's blocked and who they'd need
> to ask. Do not pretend you did something you didn't do.
>
> When you don't know enough about a connection to write a query,
> call `get_connection_type_guidance` first. When working with
> EdgeLake specifically, read the SQL dialect restrictions before
> writing SQL.

The system prompt gets the same incremental refinement the
Component AI agent's system prompt has had — start small, harden
based on observed failure modes.

### Hard rules the prompt must encode

Some lessons are already in hand from the earlier (now-retired)
`dashboard-agent` CLI work — bake them in from day 1 so we don't repeat:

- **Always prefer structured component config over `use_custom_code`.**
  When creating a chart, set `component_type`, `chart_type`,
  `connection_id`, `data_mapping`, `query_config` etc. and let
  server-side codegen produce `component_code`. Only fall back to
  custom code when the structured config genuinely cannot represent
  what the user asked for. The retired dashboard-agent CLI defaulted to
  custom code (likely because it wanted to set y-axis range / log
  scale / tooltip formatter fields that weren't in the structured
  config); the result was charts that wouldn't open cleanly in the
  visual editor. The Dashboard Assistant must not inherit that bias.
  Tom is extending the structured configs to close those gaps in
  parallel; the assistant should treat custom code as the
  last-resort path.

---

## Open questions

Defaults proposed; tell me to override.

1. **Header icon.** `AiLaunch` (sparkles + arrow) — **lock it.**
2. **Tool-call rendering.** Collapsed by default in the chat UI —
   **lock it.**
3. **Cross-namespace work.** Always-current — **lock it.**
4. **History persistence.** Local-only via Markdown / JSON export —
   **lock it.**
5. **Model default.** Sonnet — **lock it.** Opus opt-in via
   `assistant.model` admin setting.
6. **Cost cap.** 1M input + 250k output per user per day,
   admin-configurable — **default.** Adjust based on usage.
7. **Concurrent sessions.** Sidecard + Component AI agent can both
   run simultaneously — **lock it.**
8. **Anthropic key model.** Deployment-level only for v1 — **lock
   it.**
9. **Tier-A tool set.** Final list TBD during build, but the
   target is ~6-10 tools. Candidates so far:
   - `list_connections`
   - `list_components`
   - `list_dashboards`
   - `list_chart_types`
   - `list_namespaces`
   - `list_integrations`
   - `get_current_user`
   - `describe_tool` (meta)
   - `get_full_result` (meta)
10. **What counts as "large" for the tool-result store?** Initial
    cut: anything over 2000 tokens or 100 rows is stored
    server-side and replaced inline with a summary. Tune from
    telemetry.

---

## What we are NOT building in v1

Pulled out so we don't re-litigate them mid-build.

- **Server-side conversation history with restore.** Markdown /
  JSON export only. The session record is ephemeral (TTL-cleaned).
- **Cross-namespace operations.** Always-current-namespace.
- **System-user / settings / namespace CRUD via the assistant.**
  Manage surfaces stay UI-only.
- **Per-user Anthropic keys.** Deployment key only.
- **Voice input.** Text only.
- **Image / file uploads.** Text only.
- **Multi-agent orchestration / sub-agents.** One assistant, one
  conversation.
- **Phase-3 context compaction.** Architecture supports it; v1.1.

---

## Future enhancements (post-v1)

- Phase-3 context compaction on long conversations.
- Per-user Anthropic key opt-in.
- Cross-namespace switching ("switch to homelab and create…").
- Image input (paste a screenshot of a chart, assistant matches the
  layout).
- Sub-agent spawning for parallelizable work ("build 12
  dashboards from this list of nodes").
- Suggest-on-page-load (light, dismissable): "I see you're on
  Connections — want me to test all of them?"
- Server-side saved conversations with a picker (the original v1
  idea, deferred until users actually ask for it).

---

## Implementation roadmap

Rough sequence. Each item is one or more concrete commits.

0. **Server: availability gating + admin enable flag.** Add
   `assistant.enabled` to `server-go/config/user-configurable.yaml`
   (default true). Construct the assistant only when both
   `ANTHROPIC_API_KEY` and the setting are true; otherwise return
   nil and skip route registration. Extend the existing
   `/api/ai/availability` response with a `chat_agent_enabled`
   field. Update `AIAvailabilityContext` to expose both flags.
   The header icon (step 6) reads the chat flag and refuses to
   render when false. **This step lands FIRST** so every subsequent
   step has a real disable path.
1. **Server: `kind: "chat"` session discriminator.** Add to model
   + repo + service. Chat sessions get no `target_id`. Verify the
   Component AI agent path is unaffected.
2. **Server: skeleton of `internal/ai/chat/` package.** Empty
   layer files, empty registry. Wire one trivial Tier-A tool
   (`get_current_user`) end-to-end as a smoke test: model can be
   invoked, tool can be called, response streams to the SSE
   channel.
3. **Server: shared `toolops` layer + dual consumers.** Build
   `internal/ai/toolops/` with typed Go function signatures for
   every dashboard operation the Assistant needs (and MCP already
   has). Each function calls into the existing service layer.
   Then:
   - Refactor `internal/mcp/tools.go` handlers to call `toolops`
     methods (one shim per MCP tool). MCP's external behavior
     unchanged.
   - Build `internal/ai/chat/tools/` registry with per-tool
     capability predicates and Tier-A/B classification. Each
     ChatTool's `Handler` calls a `toolops` method.
   - Audit MCP's auth layer to confirm capability checks gate
     mutation handlers — toolops doesn't gate, both wrappers do.
   - Component AI agent's tools stay untouched (different shape).
   This step is the riskiest because MCP behavior must not
   regress. Verify with an MCP smoke test (Claude Desktop or
   `mcp-proxy` + curl) before moving on.
4. **Server: tool-result store.** New Mongo collection
   `chat_tool_results` (TTL-cleaned). `get_full_result` meta-tool.
   Large result summarization heuristic.
5. **Server: layered prompt assembly.** `chat/prompt.go` walks
   the layers; budget tracker; Phase 1 always-loaded, Phase 2 on
   demand. `describe_tool` meta-tool.
6. **Server: chat-agent system prompt** with namespace + caps +
   date templating.
7. **Server: cost guardrails.** Per-conversation context cap (soft
   + hard). Per-user daily token budget. Settings keys.
8. **Server: model selection.** `assistant.model` admin setting
   (sonnet | opus). Default sonnet.
9. **Client: `<AssistantSidecard>` component.** Header icon,
   slide-in panel, drag-to-resize, persistence of open + width.
   Reads `AIAvailabilityContext.chatAgentEnabled`.
10. **Client: message-list rendering.** Markdown + code blocks +
    collapsible tool-call cards. Reuse `<TerminalResponseBody>`
    for JSON args/results.
11. **Client: SSE stream consumption.** Reuse `useAISession` with a
    new "kind=chat" path. Cancel wiring.
12. **Client: cog popover.** Clear / Export Markdown / Export JSON
    / toggle tool-call expansion / toggle token usage.
13. **Client: export functions.** Pure functions over conversation
    state; download via `Blob`.
14. **Verify** end-to-end with three caller profiles:
    - Manage user: full surface; create connection → component →
      dashboard in one conversation
    - Design-only: same except no settings access
    - View-only: read tools only; mutation requests return
      capability errors and the assistant adjusts its plan
15. **Docs:** add a top-level user-facing "AI Assistant" section to
    `docs/architecture/frontend.md`; bump `CLAUDE.md` to mention
    the new agent; cross-reference this doc.
16. **Release** as a minor (new feature surface).

---

## Cross-references

- [`docs/design-notes/snippets-panel.md`](snippets-panel.md) — same
  "generic primitive with a context key" framing.
- [`server-go/internal/ai/`](../../server-go/internal/ai/) —
  Component AI agent; sibling code.
- [`server-go/internal/mcp/`](../../server-go/internal/mcp/) — MCP
  tool registry. After step 3 lands, MCP's tool handlers become
  thin shims over `internal/ai/toolops/`. The MCP transport itself
  is unchanged.
- `server-go/internal/ai/toolops/` (will exist after step 3) —
  shared lower-level tool implementations. Single source of truth
  for what each dashboard operation does. Both MCP and the
  Dashboard Assistant consume it.
- [`memory/dashboard-chat-agent-todo.md`](../../memory/dashboard-chat-agent-todo.md)
  — pointer to this doc.
