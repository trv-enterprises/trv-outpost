# Multi-connection swap: tag-value selection + panel connection tags

**Status: design agreed 2026-08-06 (Tom + session review). Not yet implemented.**
Tracked on issue #186, whose original proposal (per-variable
`source_connection_id` scoping) this design supersedes for the primary
use case — see "Relation to #186's original design" at the end.

## The problem

A dashboard's panels may span **two or more related connections for the
same host** — e.g. a Synology-stats connection and a docker-stats
connection, both for `trv-srv-001`. The connection-swap variable today
repoints **every** panel to the single selected connection
(`resolveConnectionId`, `client/src/hooks/useDashboardVariable.js:351`),
so on a multi-connection dashboard the panels bound to the second
connection are force-swapped onto a connection that lacks their schema
and break.

What's wanted: one selection ("show me trv-srv-002") swaps the whole
*family* of related connections, each panel following the member of the
family it needs.

## Core design: the picker selects a tag value, not a connection

A new mode on the swap variable changes **what the picker selects**:

- **`selection: "connection"`** (default, today's behavior) — the picker
  lists candidate connections; selecting one repoints every panel.
- **`selection: "tag_value"`** (new) — the picker lists **distinct
  values of the key tag** (deduped on the label-tag-prefix value, each
  host once), and every related connection follows the selected value.

Stored as a string discriminator, not a boolean, so a third mode never
needs a schema change.

### Resolution

The variable's `label_tag_prefix` (e.g. `host`) becomes the **join
key** in tag-value mode. Prefixed tags already act as a lightweight
key-value store on connections (`host:trv-srv-001`).

- Panel **without** panel-connection tags → the connection matching
  `variable.tags ∪ {host:<selected value>}` (the *primary family*).
- Panel **with** panel-connection tags → the connection matching
  `panel.connection_tags ∪ {host:<selected value>}`.

The panel tag set **extends** the variable's tags (UNION) — the
variable's tags are the entry gate ("connections must meet the tag to
be considered at all for this dashboard") and the panel's tags narrow
within it, so a panel family's effective tags are
`variable.tags ∪ panel.connection_tags`. Removing the gate tag from a
connection removes it from every family at once.

> Owner-decided 2026-08-07, superseding the replace semantics this note
> originally specified. Replace was inferred from "the docker connection
> does not carry the synology tags", but the real tagging convention
> gives every connection the umbrella tag PLUS its specific tag, so
> union both works everywhere and provides the gating behaviour the
> owner intended. Consequence worth knowing: the primary family (gate
> tag alone) is inherently AMBIGUOUS under this convention wherever a
> host has multiple sub-family connections — untagged data panels get a
> flagged first-by-name pick, so authors should tag every data panel.

The panel tags are **static**: they carry no reference to the variable
or any of its values; the join to the selection happens entirely
through the key tag. Changing the selected host re-resolves every
family with zero panel-side changes.

The stored selection (and the URL param) becomes the **tag value
string** (`trv-srv-002`), not a connection id.

`ComponentOverride` rules with subject `"variable"` already compare
against the prefix-tag value (falling back to name), so existing
component-swap rules work unchanged in the new mode.

### No-match behavior

When no connection matches a panel's tags + the selected value, the
panel renders an **empty-state message naming the gap** — e.g. "No
connection for *trv-srv-003* matches this panel's tags" — NOT the
baseline connection's data. With host B selected, silently showing host
A's data is a lie; the empty state is honest. (Decided over the earlier
fall-back-to-baseline-plus-badge proposal.) The message is deliberately
specific rather than generic: it only ever appears on a misconfigured
or sparse family, where the detail is exactly what the author needs.

### Validation

Two failure shapes the mode creates, designed rather than discovered:

1. **Ambiguity within a family** — two connections matching the same
   family tags AND the same key value. Warn at authoring time, badge at
   view time, resolve deterministically (first by name) rather than
   erroring.
2. **Sparse families** — a key value present in the primary family but
   absent from an override family. Handled by the empty state at view
   time; the picker may additionally annotate partially-resolving
   values ("trv-srv-003 — 2 of 3 families") so a partial swap is an
   informed one.

## Storage: a panel field, not an adornments-style overlay

`connection_tags []string` goes **on `DashboardPanel`** (alongside
`component_overrides`), not in a dashboard-level side map keyed by
panel id. Panels are embedded in the dashboard document, so a panel
field already satisfies "data owned by the dashboard object" — it never
touches the (cross-dashboard) component record, survives panel-id
regeneration on duplicate for free, and exports with the panel. The
adornments overlay exists because free-drawn borders are *not*
panel-bound; this data is, and `panel_border` adornments demonstrate
the remapping cost of storing panel-bound data outside the panel.

## Variables form: order and names

Current order buries `label_tag_prefix` last, marked "(optional)" —
right when it was cosmetic, wrong when it is the selection key. New
order for the connection-swap branch (shared fields stay ahead of
mode-specific ones):

1. Variable type (`mode`) — unchanged
2. Variable label (`label`) — unchanged position; shared with filter mode
3. **Swap by** (`selection`: Connection / Tag value) — new, first in
   the block because it changes what everything below means
4. **Label tag prefix** (`label_tag_prefix`) — moved from last;
   "(optional)" ⇄ "(required)" dynamically by mode
5. Connection tags (`tags`)
6. Compatibility check (`schema_strict`) ∥ Same namespace only
   (`same_namespace`) — unchanged

The 3→4→5 sequence is the authoring thought order in tag-value mode:
what kind of thing am I picking → which tag identifies it → which
connections are candidates.

**Names stay anchored to stored fields.** `label_tag_prefix` keeps the
UI label "Label tag prefix" (the role expansion is carried by
mode-aware helper text: in tag-value mode, "The tag that identifies
each selectable value — 'host' makes the dropdown list each host once,
and every related connection follows the selected host"). Renaming to
"Key tag prefix" would describe the new role better but drifts from the
stored name and a stored-field rename buys a migration for cosmetics.
"Compatibility check" (↔ `schema_strict`) stays as established.

Requiring the prefix **only in tag-value mode** means zero change and
no migration for every existing dashboard.

## Panel menu item: "Panel connection tags…"

Sits directly under **"Connection-based components…"** in
`PanelEditMenu`, same group.

**Name rationale**: it names ownership (**panel** — dashboard-owned,
addressing the concern that "component-based connection" implies
component-record data with cross-dashboard effect), the subject
(**connection**), and the mechanism (**tags**), and it matches the
stored field `panel.connection_tags`. Rejected: "Tag-based
connection…" (best parallelism with the sibling item, but drops the
ownership signal), "Panel/component-based connection" (slash reads as
either/or; "component-based" is exactly the phrase to avoid).

**Gating**: `selection === 'tag_value'` (read from the EDITABLE state,
see below) `&& hasChart`. Visible even when no tags are set — that's
how they get set the first time. Carries a set-state indicator (like
`hasSwapRules`) so scanning panels in edit mode shows which deviate
from the primary family.

**Modal** (heading "Panel connection tags"):

1. Explainer paragraph settling the replace-not-union semantics: "This
   panel's connection follows the dashboard variable, but matches
   these tags instead of the variable's connection tags. The connection
   carrying all of these tags plus `host:<selected value>` is used."
2. TagInput (same control as the variables modal).
3. **Resolution preview** — load-bearing, not decoration: for each
   value in the picker, show what these tags resolve to *right now*
   (`trv-srv-001 → syn-docker-001`, `trv-srv-003 → (no match)`).
   Without it tag entry is blind and the first feedback is a broken
   panel in view mode; with it the sparse-family case is visible at
   authoring time, when it is fixable.
4. Clear — removes the tags; the panel rejoins the primary family.

## Menu timing, disable semantics, dependencies

**Show the menu immediately** — gate on the *editable* variable state,
not the saved dashboard (today's gate reads the saved record via
`useDashboardVariable`, which is why the item only appears after
saving). Verified safe: rules/tags authored before save live in
`editablePanels`, which cancel discards *together with* the variable
enable — they cannot outlive it. And overrides with the variable off
are **dormant, not active** (`resolveComponent` only applies them when
a candidate is selected) — hidden-and-inert, not the
hidden-and-active failure mode.

**Disable + dependency counting are one decision.** Chosen:
**keep-and-count** — on variable disable, per-panel data
(`component_overrides`, `connection_tags`) is retained dormant, and
dependency surfaces (orphan preview, export bundling,
`/api/components/:id/usage` — all via `panelComponentIDs()`,
`server-go/internal/service/dashboard_service.go:550`) continue to
count override refs, **labeled as inactive** ("via swap rule
(inactive)") so they don't read as live dependencies. The rejected
quadrant — keep the data but exclude it from dependency checks — is
the dangerous one: orphan-preview would call a component unused, it
gets deleted, the variable is re-enabled, the rule silently breaks.
Export/import round-trips depend on counting retained refs.

## Relation to #186's original design

#186 proposed per-variable `source_connection_id` scoping with one
picker per variable. That solves genuinely *independent* families, but
for the actual reported case — related connections that travel
together — it means changing N pickers to move a dashboard to another
host, and has no concept that the families are related. The tag-value
mode expresses that intent with one selection. The two are not
mutually exclusive; scoped variables can be added later if independent
families show demand.

**#186's phase-1 remains worth doing regardless** as the safety floor
in plain connection mode: only swap panels whose baseline connection
matches the reference; leave other-connection panels untouched.

## Implementation surfaces (for planning, not exhaustive)

- `server-go/internal/models/dashboard.go` — `selection` on
  `ConnectionSwapConfig`; `connection_tags` on `DashboardPanel`;
  validation (prefix required in tag-value mode)
- `GetVariableCandidates` (server) — tag-value mode returns distinct
  key values + per-family resolution (and powers the modal's
  resolution preview); compatibility checking per family with a
  per-family reference connection
- `useDashboardVariable.js` — selection becomes a value string in
  tag-value mode; `resolveConnectionId` resolves per panel
- `DashboardViewerPage.jsx` — variables modal reorder + "Swap by";
  picker dedupes on key value; empty-state render for no-match panels;
  menu gating from editable state
- `PanelEditMenu.jsx` + new `PanelConnectionTagsModal`
- Usage/orphan/export surfaces — "inactive" labeling
