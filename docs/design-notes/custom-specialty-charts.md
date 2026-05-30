# Building custom & specialty chart types (Sankey, sunburst, treemap, graph…)

**Status:** notes / reference — distilled from a working session
**Raised:** 2026-05-29 (Tom)
**Related:** chart-spec-driven-editor, COMPONENT_SPEC_SUMMARY, mcp.md,
the `chart.custom` subtype / `use_custom_code` path

## Context

Notes from working through "what's the best way to get a *new chart
type* built." Two distinct cases came up and they have different
answers:

- **New instance of an existing type** (another scatter, another line).
  No special handling — describe the goal + point at a connection, the
  data shape is already understood.
- **A type with no first-class template** (Sankey, chord, sunburst,
  treemap, graph/network, parallel coordinates, themeRiver, boxplot,
  candlestick…). This note is about that case.

## The enabling fact

The `chart.custom` subtype renders **arbitrary ECharts** through
`ReactECharts` (`use_custom_code=true` + `component_code` = React
source). ECharts natively supports all of the specialty series above,
so **if ECharts can draw it, it can ship as a custom component** — no
new dependency, no viewer-runtime change. The canonical chart-type list
(line, bar, scatter, …) is just the set with first-class templates; it
is **not** the ceiling.

Implication: for a specialty chart the work is almost entirely two
things — (1) shaping the data into the form that series type demands,
and (2) confirming the visual matches intent. The ECharts config itself
is the easy part.

## The hard part is data shape, not the option

A scatter wants flat `[x, y]` rows — trivial. The specialty types want
*structured* input, and that transform is where the real work (and the
risk) lives:

- **Sankey** → a `nodes` list **and** a `links` list
  (`{source, target, value}`). SQL gives rows; you must derive distinct
  nodes and aggregate flows between them. **Sankey requires a DAG** —
  cycles throw. Feasibility-check for cycles before writing code.
- **Sunburst / treemap / tree** → a recursive `children` hierarchy
  built up from flat parent/child rows.
- **Graph / network** → nodes + edges, often with layout coords or a
  force layout.
- **Parallel coordinates** → one axis per dimension, each row a polyline.

The make-or-break question for any new type: **does the data actually
contain the relationship the chart visualizes?** A Sankey needs flows
between stages; a hierarchy chart needs parent/child levels. If the data
is flat and unrelated, no chart type rescues it. So the first step is
always a feasibility probe against the real connection, *before*
committing to the type.

## Recommended workflow for a new type

1. Name the **type** + the **relationship** to show
   (e.g. "Sankey of sensor readings flowing location → sensor_type →
   status"). The relationship is what determines feasibility.
2. **Feasibility-check against real data first** — confirm the
   source/target/value (or hierarchy levels) exist and aggregate
   cleanly; for Sankey verify no cycles. Be honest if the data can't
   support it.
3. Build the **transform + the chart**, matching the house style of
   existing custom components (Carbon dark theme, injected helpers
   `toObjects`/`getValue`/`formatTimestamp`/`formatCellValue`, the
   title-bar wrapper, `theme="carbon-dark"`).
4. Iterate **live** in the pane — tighter loop than a perfect up-front
   spec.

### Handing over a reference look

For exotic types the styling has many knobs (node alignment, link
curveness, orient, label placement), so a concrete reference beats
prose. In order of reliability:

1. **Paste the ECharts `option` snippet** — most reliable; adapt to data
   + theme.
2. **Paste a screenshot** — conveys visual intent; code gets written to
   match.
3. **Gallery URL** — `WebFetch` works on raw config/JSON/gist URLs, but
   the interactive gallery viewer is JS-rendered and a plain fetch may
   return page chrome without the `option = {…}` body. Falls back to
   "please paste."
4. **Just name it** — built from ECharts knowledge (frozen at the model
   cutoff; fine for standard looks, less precise for fiddly styling).

## The one real limit

If a request needs something **ECharts itself cannot render** — a
bespoke D3 viz, WebGL, a third-party React chart lib — that *is* an
architectural change (new viewer-runtime dependency) and must be
consulted before adding, not smuggled in. Rare; ECharts covers the vast
majority of "specialty" types out of the box.

## Reference repo: `apache/echarts-mcp` (local clone)

Located at `~/Documents/GitHub/echarts-mcp`. Assessed during this
session — **do not wire it into the dashboard**; it would be an
architectural step backward. What it is and why:

- Renders charts **server-side to a static PNG**, uploads to Baidu cloud
  storage, returns an image URL. Flat image: no interactivity, no live
  data, no tooltips/zoom/legend. Requires a Baidu cloud account to run.
- Supported types: `bar, line, pie, scatter, funnel, tree, treemap,
  sunburst` — **no Sankey/graph/parallel**.
- Deliberately uses its "Approach 3": minimal params, theme locked in
  the app, chosen for stability of a *generic* server — explicitly
  trading away arbitrary-chart capability.

Our `chart.custom` path is strictly more powerful (live React/ECharts,
any type, interactive, bound to connections, Carbon-themed, no external
dependency), so routing a specialty chart through that MCP would give a
*worse* result. Its own README's three-approaches discussion is
independent confirmation that the full-`option` approach is right for
*our* situation (one known data layer + live React runtime).

**Where it genuinely helps:** `src/chart.js` contains the
flat-rows → recursive-`children` normalization for `tree`/`treemap`/
`sunburst`. Worth reading as a vetted reference when we build a
hierarchy chart, to reuse a known-good shaping pattern. Keep the repo as
a local reference only.

## ECharts example pointers (don't vendor — fetch on demand)

We deliberately do **not** clone the ECharts examples repo into this
project: it's reference material humans/LLMs read, never code that runs,
so vendoring it just ships dead weight in every deployment image, adds
license/provenance noise, and rots out of date. The examples already
live somewhere reachable — the model's training knowledge (frozen at
cutoff) plus on-demand `WebFetch`. Key practical detail (verified
2026-05-29): **raw upstream URLs fetch cleanly**; it's only the
JS-rendered interactive gallery viewer (`echarts.apache.org/examples/
editor.html?c=…`) that returns page chrome without the `option = {…}`
body. So fetch the *raw* source/data file, not the gallery page.

Two raw URL families that work:

- **Option/source for a chart type** — the test HTML in the echarts repo
  carries full working option blocks:
  `https://raw.githubusercontent.com/apache/echarts/master/test/<type>.html`
  (e.g. `sankey.html`, `sunburst.html`, `treemap.html`, `graph.html`,
  `parallel.html`, `themeRiver.html`, `boxplot.html`, `candlestick.html`).
  Verified: `test/sankey.html` returns a real
  `type: 'sankey' … data: data.nodes, links: data.links` block.
- **Sample hierarchy / graph datasets** under the examples data dir:
  `https://echarts.apache.org/examples/data/asset/data/<file>.json`
  (e.g. `flare.json` — `{name, children}` hierarchy for sunburst/
  treemap/tree; `les-miserables.json` — graph nodes/links). Verified:
  `flare.json` returns a `name`/`children` tree.

Type → reference quick-map (request the raw URL above for the matching
`<type>`):

| Want to build | Series type | Data shape to produce |
|---|---|---|
| Flow between stages | `sankey` | `nodes[]` + `links[]` (`{source,target,value}`), **DAG only** |
| Radial hierarchy | `sunburst` | recursive `{name, children, value}` |
| Nested rectangles | `treemap` | recursive `{name, children, value}` |
| Node-link diagram | `graph` | `nodes[]` + `links[]`, optional coords/force layout |
| Multi-dim compare | `parallel` | one axis per dim, each row a polyline |
| Stacked time bands | `themeRiver` | `[time, value, category]` triples |
| Distribution spread | `boxplot` | per-category `[min,Q1,median,Q3,max]` |

When we build one of these: fetch the raw `test/<type>.html` for a
current, correct option block, reshape our connection's rows into the
"Data shape" column, and apply the house style (Carbon dark theme,
injected helpers, title-bar wrapper). Tom can paste a snippet/screenshot
if chasing a specific look.

## Security: custom code runs as real JS in the app origin

**Raised:** 2026-05-29 (Tom). This is the sharpest edge in the
custom-chart feature and worth being explicit about.

### What actually happens (verified, not assumed)

`chart.custom` (`use_custom_code=true`) is not a sandboxed config — it
is **arbitrary JavaScript that executes in the app's own origin.** The
render path, in `client/src/components/DynamicComponentLoader.jsx`:

1. The stored `component_code` (JSX source) is transformed at runtime by
   `@babel/standalone` (`Babel.transform`).
2. The result is executed via **`new Function(...)`** with React, hooks,
   the data-fetch layer, transforms, and the viz libs injected into
   scope. There is **no iframe, no sandbox** — it runs with the same
   privileges as the rest of the SPA (same DOM, same `fetch`, same
   `localStorage`, same auth context).

So "it's all frontend" is true but not reassuring: frontend code in the
app origin can read auth tokens / app state, call the backend API as the
logged-in user, exfiltrate over the network, or tamper with the DOM. A
malicious or buggy custom component is effectively stored XSS scoped to
whoever opens the dashboard.

### Persistence is the whole threat — so gate persistence

The data flow (per Tom, reconciled with the code): raw `component_code`
**is** stored in the DB (a string field on the component model,
`server-go/internal/models/component.go`) and **is** re-`eval`'d on
render — *but only if we let it persist.* The intended design is a
**save-time gate**: when `use_custom_code` / `component_code` is present,
run the code through a checker before accepting it. Reject → never
stored → never served → never re-run by anyone. The rejected code's only
execution was the author's own preview, which already happened in the
author's own session.

This gate is the **load-bearing control**, and the reason is the
author-vs-other-viewer distinction:

- **Author previewing / rendering their own code** — *no new threat.*
  The realtime eval (`DynamicComponentLoader` → `Babel.transform` →
  `new Function`, no sandbox) runs in the author's own browser with the
  author's own privileges. They could already run anything in their
  browser via DevTools; custom-code preview grants nothing extra. **Do
  not sandbox to protect an author from themselves** — pointless. This
  is why the realtime preview, though un-sandboxed, is *not* the problem.
- **A second user viewing a component someone else authored** — *this is
  the only real victim.* If raw code persists and is re-`eval`'d in their
  session, it runs with **their** auth/tokens/data, which they never
  consented to. That's stored XSS across a privilege boundary. The thing
  that creates this victim is **persistence + reach** — and that is
  exactly what the save-time gate denies. No persistence, no second
  victim.

So the control follows the threat precisely: the danger is *durable,
reaching* code; the gate removes durability before reach can happen.

### The AI is not a trust boundary (the concrete threat the gate catches)

The author here is often the AI builder (`AIComponentPreview.jsx`,
`AIBuilderPage.jsx`), and save is immediate. "The AI controls it" is not
a safeguard: the AI writes what it's *prompted* to write. Tom's own
example — *a user asks the AI to embed code that ships certain data to a
specific IP* — is **prompt injection turning the AI into the delivery
mechanism.** The save-time gate is what catches this regardless of
whether a human or the AI typed it, because it inspects the *artifact*,
not the author's intent. Because save fires right away on a known
artifact, the gate has a clean, immediate point to act: detect → refuse
the save → report back → the payload never acquires a lifetime.

### How the gate should land

- **Where to enforce.** **Backend-authoritative** — the gate must live
  server-side on create/update so it can't be bypassed by hitting the
  API directly; that's the boundary that actually decides whether code
  is stored and served. A **client-side** check mirrors it for fast
  feedback (and so the author sees the rejection inline), but is not the
  authority. (Note: the realtime *preview* evals in-memory and does not
  round-trip the backend, so a client check is also the only thing that
  could vet the preview — but per the distinction above, the preview
  only ever harms the author, so this is fast-feedback UX, not a
  security boundary.)
- **What kind of checker.** Static analysis with Babel (already a dep):
  - *AST denylist* — reject `fetch`/`XMLHttpRequest`, `import()`,
    `eval`/`new Function`, `localStorage`/`document.cookie`,
    `window.parent`/`top`, raw DOM escape hatches. Cheap, but a denylist
    is inherently leaky.
  - *Identifier allowlist* — permit only the injected scope (React/hooks,
    `data`, `config`, the helpers, `ReactECharts`) plus pure-JS builtins;
    reject everything else. Stronger; more false-positives to tune.

### Sandbox = deferred defense-in-depth, with a named trigger

Static checking of arbitrary JS is **leaky by nature** — a determined
payload can slip a gate. So an iframe/Worker sandbox (separate origin,
no ambient auth, `postMessage` data bridge) is the only thing that
actually *contains* what gets through. It is **not needed today** and is
deliberately deferred; it is an architectural change — consult before
building.

Its trigger condition, stated plainly so the decision is revisited at
the right moment: **the day a viewer can be served custom code authored
by someone they don't fully trust** — multi-tenant deployments, public
dashboard sharing, or untrusted import. Until then, a single trusted
operator is effectively their own only viewer, the "second victim" is
near-hypothetical, and the save-time gate carries the weight.

(CSP is only a partial lever here anyway: a `Content-Security-Policy`
exists today only on `electron/sidebar/index.html`, not the main viewer,
and `new Function`/eval requires `script-src 'unsafe-eval'` — the very
mechanism this feature depends on is what a strict CSP would block, so
CSP can't be the sole control without changing the execution model.)

**Bottom line / decision:** the feature trades safety for power
(arbitrary ECharts/React), and that trade is acceptable *because*
persistence is gated. **Required now:** a backend-authoritative
save-time checker (client mirror for UX) — it is load-bearing, since
persisted+served code is the only path to a non-consenting victim, and
the AI-authoring path makes prompt-injected payloads a real input.
**Deferred:** iframe/Worker isolation as defense-in-depth, triggered
only if custom code is ever served across a trust boundary.
