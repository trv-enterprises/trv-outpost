# Snippets Panel — Design Note

**Status:** Design, not yet built.
**Author:** Tom + Claude
**Date:** 2026-05-26
**First surface:** EdgeLake Terminal (`/design/extensions/edgelake-terminal`)
**Future surfaces:** MQTT publisher, ad-hoc SQL query tool, kiosk command palette, anything terminal-shaped.

---

## Mission

A reusable iTerm2-style snippets panel: a saved library of commands the
user can recall into a text input with one or two clicks. Per-user
snippets by default; global snippets curated by Manage-capable admins;
the two are merged into one visible list at render time. Tags drive
flat folder grouping (one level deep). State persists across sessions.

The panel is built **generically** — not coupled to EdgeLake — so a
future MQTT publisher or SQL tool can mount the same component with a
different `context` key.

---

## Inspiration

iTerm2's Snippets pane is the reference shape:

- Vertical right-hand panel, collapsible.
- Search at the top.
- Untagged snippets flat, alpha-sorted, at the top.
- Tagged snippets grouped under collapsible folders, alpha-sorted by
  folder name, snippets alpha-sorted within each folder.
- Footer toolbar: `▷ Run`, `✏ Edit`, `🗑 Delete`, `+ Add`.
- A snippet with N tags appears under N folders.
- Single-click selects + pastes into terminal input. Double-click pastes + submits.
- Selection persists until another row is clicked (does not clear on
  input edits).

This doc captures how we adapt those mechanics to the dashboard's stack
(React + Carbon + Mongo + the existing auth/capabilities model).

---

## Data model

### `snippets` collection (new top-level Mongo collection)

One document per snippet. Both user and global snippets live in the
same collection, discriminated by `scope`.

```json
{
  "_id": "uuid",
  "scope": "user" | "global",
  "owner_user_id": "user-uuid",      // null when scope=global
  "context": "edgelake-terminal",    // freeform; future surfaces use their own key
  "title": "GET QUERY LOGS",
  "command": "mel logs query",
  "tags": ["INVESTIGATION"],
  "created_at": "...",
  "updated_at": "..."
}
```

**Why a new top-level collection** instead of stuffing into `app_config`
or `settings`?
- Per-user prefs are key-value (`app_config` scope=user); snippets are
  a list of small records that grow over time. Wrong shape.
- Settings are a small fixed schema seeded from YAML; snippets are
  user-generated content. Wrong shape.
- A real collection gets us indexes (`context`, `owner_user_id`,
  `scope`), proper queries, and a clean permission model.

**Indexes:**
- `(context, scope, owner_user_id)` — covers the GET list query.
- `tags` (multikey) — supports future tag-based filtering.

### Per-user UI state (existing `app_config` system)

The panel-open boolean is UI state, not snippet content. Stored in
existing user prefs:

| Key                                            | Type  | Default |
|------------------------------------------------|-------|---------|
| `edgelake_terminal.snippets_panel_open`        | bool  | true    |
| `<future-context>.snippets_panel_open`         | bool  | true    |

Generic per-surface key. Each surface that mounts the panel adds its
own key.

---

## API contract

Generic — surfaces don't get their own endpoints, they pass `context`.

### `GET /api/snippets?context=<ctx>`

Returns merged user-scoped + global-scoped snippets for the requesting
user, filtered to `context=<ctx>`. The merge is server-side so the
client makes one request.

Response shape:
```json
{
  "snippets": [
    {
      "id": "uuid",
      "scope": "global",
      "title": "GET STATUS",
      "command": "get status",
      "tags": ["Investigation"],
      "owner_user_id": null,
      "can_edit": false   // false for globals when caller lacks Manage
    },
    {
      "id": "uuid",
      "scope": "user",
      "title": "my custom probe",
      "command": "...",
      "tags": ["Debug"],
      "owner_user_id": "<caller>",
      "can_edit": true
    }
  ]
}
```

The `can_edit` field is computed server-side from the caller's
capabilities — saves the client from reimplementing the gate.

### `POST /api/snippets`

Create a snippet. Body:
```json
{
  "scope": "user" | "global",
  "context": "edgelake-terminal",
  "title": "...",
  "command": "...",
  "tags": ["..."]
}
```

- `scope=user` → owner_user_id set from auth context. Any authenticated
  user.
- `scope=global` → owner_user_id null. **Requires Manage capability.**

### `PUT /api/snippets/:id`

Update. Body same shape as POST (excluding `scope`, which is immutable —
to "promote" a user snippet to global you delete + recreate).

- User snippets: only the owner can update.
- Global snippets: **Manage capability required.**

### `DELETE /api/snippets/:id`

Delete. Same permission rules as PUT.

---

## UI behavior

### Host-page layout (EdgeLake terminal example)

The terminal page becomes a two-column flex layout when the panel is
open. The transcript box and command-input row share a column on the
left; the snippets panel takes the right column.

```
┌─────────────────────────────────────────────┬──────────────────────┐
│  ┌─ Transcript ───────[X clear][SidePanel] ┐ │ ┌─ Snippets ─────[×]┐ │
│  │                                          │ │ │ [🔍 Search]   [?]│ │
│  │ No commands yet. Type below…             │ │ ├─────────────────┤ │
│  │                                          │ │ │ (rows + folders)│ │
│  │                                          │ │ │                 │ │
│  └──────────────────────────────────────────┘ │ │                 │ │
│  ┌─ Input ─────────────────────────┬─ Send ─┐ │ │                 │ │
│  │ Type a command…                 │ Send ▷ │ │ │                 │ │
│  └─────────────────────────────────┴────────┘ │ ├─────────────────┤ │
│                                               │ │ [▷][✏]   [🗑][+]│ │
│                                               │ └─────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

**Vertical alignment:**
- Panel **top** lines up with the transcript-box top.
- Panel **bottom** lines up with the input-row bottom.
- Panel fills the full height of the terminal play area — no awkward
  gap above or below.

**Toggle button:**
- Lives in the transcript-box header, **immediately to the right of
  the existing `X` clear button**. Not in the terminal page's
  outer toolbar.
- Icon: Carbon `SidePanelClose` (panel currently open → click to
  close) or `SidePanelOpen` (currently closed → click to open). Pick
  the matching pair from `@carbon/icons-react` at build time.
- Tooltip: "Hide snippets" / "Show snippets".

**Collapsed state:**
- Panel collapses to zero width (not a narrow rail). The transcript +
  input row reflow to fill the full width.
- Re-opening restores the panel to its default width.

### Panel chrome

```
┌─ Snippets ─────────────────────── [×] ┐
│ [🔍 Search snippets...]          [?] │
├──────────────────────────────────────┤
│ (untagged snippets, flat, alpha)     │
│  💬 BUILD — mel build                │
│  💬 GET STATUS — get status          │
│  💬 SET DEBUG ON — set debug on      │
│                                      │
│ ▾ INVESTIGATION                       │
│    💬 GET CLUSTER — blockchain get … │
│    💬 GET OPERATOR LOGS — mel logs … │
│ ▸ NETWORK                             │
│ ▸ DEBUG                               │
├──────────────────────────────────────┤
│ [▷] [✏]              [🗑] [+]       │
└──────────────────────────────────────┘
```

**Width:** fixed at v1 (~300px). Resizable as a future enhancement.

The `[×]` button in the panel's own header is a second close
affordance (matches iTerm) — same effect as the SidePanelClose icon in
the transcript header.

**Open/close state** persists per-user via
`edgelake_terminal.snippets_panel_open`.

**Icon prefix on rows:** Carbon's `Chat` icon (the speech-bubble) as
the closest analog to iTerm's snippet glyph.

### Search

Search is **client-side** (the panel already has the full list in
memory). It supports a small query language modeled on iTerm's
snippets search.

**Plain terms** match as case-insensitive substring across `title`,
`command`, and `tags` (any field). Example: `linux` matches snippets
whose title, command, OR tags contain "linux".

**Field-qualified terms** restrict the search to one field:
- `title:foo` — match only the title.
- `text:foo` — match only the command body. (We use `text:` rather
  than `command:` to match iTerm's syntax verbatim — copy-paste from
  iTerm muscle memory should work.)
- `tag:foo` — match only tags.

**Negation** with `-`: `-linux` excludes snippets containing "linux";
`-tag:linux` excludes snippets tagged linux. Combines with terms above.

**OR with `|`**: `linux|bsd` matches snippets containing linux OR bsd.
`tag:linux|tag:bsd` matches snippets tagged linux OR tagged bsd. The
`|` binds tighter than the implicit AND between terms, so
`tag:linux|tag:bsd ssh` is parsed as `(tag:linux OR tag:bsd) AND ssh`.

**Multiple terms** are ANDed: `ssh tag:network -production` matches
snippets containing "ssh" AND tagged network AND not containing
"production".

**Clear button** (×) inside the search field when non-empty.

**Help affordance:** a `?` icon to the right of the search field opens
a small Carbon `Popover` describing the syntax above with examples.
Don't expose the syntax in the placeholder — the placeholder stays
`Search snippets…`. Power users discover the `?` and learn the syntax;
basic users never have to.

The query parser lives in `client/src/components/snippets/searchQuery.js`
as a pure function:
```
parseSnippetQuery(input) → (snippet) => boolean
```
It's exercised by unit tests covering each operator and combination.
Keep it small — the grammar is intentionally tiny.

### Sort / grouping

- Untagged snippets bucket renders **first**, flat, alpha by title.
- Tagged snippets render as folders below, sorted alpha by folder name.
- Snippets within a folder sorted alpha by title.
- A snippet with N tags appears under N folders. There is no
  deduplication — that's the point.
- Folders are collapsible. Per-user collapse state is NOT persisted in
  v1 (open-by-default each session). Persist if users complain.

### Selection model

- Single click on a row:
  1. Marks that row as selected (visual highlight).
  2. Pastes the snippet command into the terminal input field.
  3. Does **not** execute the command.
- Double click on a row:
  - Same as single-click + immediately submits the command.
- **Selection persists until another row is clicked.** Editing the
  terminal input does NOT deselect. This is the iTerm convention —
  Edit/Delete/Run footer buttons keep operating on whatever snippet was
  last clicked, even if the input has been modified since.

### Footer toolbar

| Button   | Carbon icon | Action                                                                       | Disabled when           |
|----------|-------------|------------------------------------------------------------------------------|-------------------------|
| `▷ Run`  | `Play`      | Paste selected snippet command into input AND submit. Same as double-click. | No selection.           |
| `✏ Edit` | `Edit`      | Open edit modal for selected snippet.                                       | No selection; or selected snippet is global and caller lacks Manage. |
| `🗑`     | `TrashCan`  | Delete selected snippet (confirmation prompt).                              | Same as Edit.           |
| `+`      | `Add`       | Open add modal.                                                             | Never.                  |

Buttons disabled (greyed out) when no row is selected, matching iTerm.

**Delete confirmation:** Carbon `Modal` with `danger` kind, "Delete
this snippet? This cannot be undone."

### Add / Edit modal

Same modal shape for both, with different title.

```
┌─ Add snippet ────────────────────────┐
│ Title:    [________________________] │
│           (auto-fills from command;  │
│           overridden when user types)│
│                                       │
│ Tags:     [ INVESTIGATION × ]         │
│           [ NETWORK × ]               │
│           [+ add tag…              ]  │
│                                       │
│ Command:  [_________________________] │
│           [_________________________] │
│           [_________________________] │
│                                       │
│ ☐ Global  (Manage capability required)│
│                                       │
│                  [ Cancel ]  [ Save ] │
└──────────────────────────────────────┘
```

**Title field:**
- Auto-fills with `command` truncated to 50 chars with `…` when
  truncated.
- Stays in sync with command edits **until** the user manually edits
  the title; after that, the title is sticky.
- Internally tracked via a `titleIsDerivative` boolean flag.

**Tags field:**
- Carbon `Tag` chips with `×` to remove.
- Inline input below the chips; press Enter or `,` to add a new tag.
- No "/ for nesting" footnote — we removed it. One level of folders,
  driven by raw tag strings.
- Tag strings are normalized (trimmed, no leading/trailing whitespace).
  Case is preserved as entered.

**Command field:**
- Multi-line textarea. ~6 rows tall by default, scrolls beyond.
- Pre-fill priority on add:
  1. Current terminal input field (if non-empty).
  2. Last successfully executed command (from the terminal session
     transcript).
  3. Empty.

**Global checkbox:**
- Default: unchecked.
- Disabled with tooltip "Requires Manage capability" when caller lacks
  Manage.
- Editing a global snippet leaves it checked + disabled even for Manage
  users (use delete + re-add to demote — same rule as the scope-is-
  immutable API contract).

**Validation:**
- Title required, max 100 chars.
- Command required.
- Tags optional, max ~20 per snippet (soft limit, prevents the folder
  list from going wild).

---

## Permissions

- **User snippets:** owner reads + writes their own. No sharing.
- **Global snippets:** all authenticated users read. Only Manage-
  capable users create / edit / delete.
- The GET endpoint merges both worlds server-side and stamps
  `can_edit` on each record. The client uses `can_edit` to disable
  Edit/Delete buttons when the selected row is a global the user can't
  touch.

The Manage gate uses the existing capability check the rest of the app
uses (same one that gates `/manage/*` routes and the Manage-mode
header).

---

## Starter-pack seeding

A migration runs once on first boot of a deployment that doesn't have
global snippets yet. It seeds a small EdgeLake-flavored set:

| Title                      | Tags              | Command                                       |
|----------------------------|-------------------|-----------------------------------------------|
| GET STATUS                 | Investigation     | `get status`                                  |
| GET CONNECTIONS            | Investigation     | `get connections`                             |
| GET SERVERS                | Investigation     | `get servers`                                 |
| TEST NETWORK               | Network           | `test network`                                |
| BLOCKCHAIN GET OPERATOR    | Network           | `blockchain get table where type=operator`    |
| SET DEBUG ON               | Debug             | `set debug on`                                |

**Migration name:** `seed_global_snippets_v1`.
**Mechanism:** the in-process framework
(`server-go/internal/database/migrations.go`). Tracks state in the
`migrations` collection, so re-running is a no-op.

**Re-seeding policy:** an admin who deletes a seeded global gets to
keep it deleted. The migration only writes when the migration record
is absent. Do not re-seed.

**Future surfaces:** they get their own `seed_global_snippets_<ctx>_v1`
migration. Don't pile MQTT/SQL seeds into the EdgeLake migration.

---

## Generic-primitive story

The `context` field on the snippet doc is the seam.

- EdgeLake terminal: `context=edgelake-terminal`.
- Future MQTT publisher: `context=mqtt-publisher`.
- Future ad-hoc SQL tool: `context=sql-adhoc`.

All hit the same `/api/snippets` endpoint. Each surface mounts the same
React `<SnippetsPanel context="..." onPick={...} onRun={...} />`
component. The component knows how to:
- Fetch + cache the merged list filtered by `context`.
- Render the panel chrome.
- Persist its own open/closed state via a per-surface user-prefs key.
- Call back into the host surface to paste / submit text.

The host surface owns:
- The actual text input (terminal, MQTT publish field, SQL editor).
- The "last successfully executed command" history that feeds the `+`
  pre-fill.
- The toggle button in its own toolbar.

This is the minimum coupling needed to keep the panel reusable. We
don't need to abstract the host surface — surfaces vary too much.

---

## What we are NOT building in v1

These were considered and explicitly dropped. Pulled out so we don't
re-litigate them mid-build.

- **Nested folders.** Tags are flat. The iTerm `/` convention does
  nothing.
- **Drag-to-reorder.** Sort is alpha within group.
- **Pinned snippets / "favorites" / "recently used."** Alpha sort
  only. If we want last-used tracking later, the schema can absorb a
  `last_used_at` field without breakage.
- **Resizable panel width.** Fixed ~300px.
- **Multi-select for bulk delete.** Single-select only.
- **Import / export.** Use the API directly if scripting is needed.
- **Per-snippet destination / method / timeout preset.** Snippets
  store the command only. The host surface owns its own toolbar state.
- **Tag pills on the snippet rows.** Folder placement is the only
  visual indicator that a snippet is tagged. (Open the edit modal to
  see the tag list.)
- **Snippet sharing between users.** User snippets are private. Global
  is the only shared mechanism, and it's admin-curated.
- **Persist folder collapse state.** Folders open on each render.
  Persist later if it bites.

---

## Future enhancements (not v1)

- Persist folder collapse state in user prefs.
- "Recently used" virtual folder at the top.
- Drag-to-reorder OR custom sort.
- Resizable panel.
- Multi-select.
- Promote/demote scope from the edit modal (delete + recreate works
  today).
- Snippet sharing (between specific users, not just global).

---

## Implementation roadmap

Rough sequence. Each item is a concrete commit.

1. **Server:** `models.Snippet` + `repository.SnippetRepository` +
   `service.SnippetService`. Indexes on `(context, scope,
   owner_user_id)` and `tags`. Capability check uses existing helper.
2. **Server:** `handlers.SnippetHandler` with the four endpoints.
   Wired into the router. Swagger comments. `make api-docs`.
3. **Server:** `seed_global_snippets_v1` migration with the EdgeLake
   starter pack.
4. **Client:** `apiClient.listSnippets(context)`,
   `createSnippet`, `updateSnippet`, `deleteSnippet`.
5. **Client:** `useSnippets(context)` hook — fetches list, exposes
   CRUD + local optimistic updates.
6. **Client:** `parseSnippetQuery()` pure parser in
   `client/src/components/snippets/searchQuery.js` with unit tests
   covering each operator (`title:`, `text:`, `tag:`, `-`, `|`) and
   their combinations.
7. **Client:** `<SnippetsPanel>` component — chrome, search (using
   the parser from step 6), list, folders, footer, `?` help popover.
   Lives in `client/src/components/snippets/`.
8. **Client:** `<SnippetEditModal>` component — add/edit modal.
9. **Client:** wire `<SnippetsPanel context="edgelake-terminal">` into
   the EdgeLake terminal page. Toggle button in the toolbar. Pre-fill
   wiring: panel asks the host for current input value + last
   successful command via props/callbacks.
10. **Verify** in browser: open/close persistence, single vs double
    click, search (all operators), folder collapse, add/edit/delete,
    Manage gate on global, starter-pack visible.
11. **Docs:** add a "Snippets" subsection to the EdgeLake terminal
    docs.
12. **Release** as a minor (new feature surface).

---

## Open questions left for build time

None as of this writing. All structural questions answered in the
spec above; any UI polish surfaces will be settled during step 6.
