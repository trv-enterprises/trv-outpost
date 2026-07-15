---
title: Namespaces
sidebar_position: 1
---

# Namespaces

Namespaces let you group connections, components, and dashboards
into separate **conflict domains** — two namespaces can each have a
dashboard called `Home` without colliding. They're useful for
keeping personal work, shared examples, and project-specific work
visually separated without losing the one-database simplicity.

Namespaces are also an **access boundary**: you can restrict a user
to specific namespaces, and they'll only see that content — see
[Namespace access](#namespace-access) below.

Tags are still around for *descriptive* groupings (`environment:prod`,
`owner:ops`); namespaces are for *structural* ownership.

## The active namespace

The header shows your current **active namespace** as a colored pill
next to the help and notification icons. The active namespace
determines:

- Which namespace newly-created connections, components, and
  dashboards land in by default. (The editors' Namespace Select
  starts here; you can pick a different namespace for any individual
  record.)
- The default target namespace when you open the import flow.

Click the pill to switch to a different namespace. Your choice
persists across sessions — the next time you log in, you'll be back
in the same namespace.

The active namespace does **not** filter list pages by itself. Use
the namespace filter (next section) for that — it's a separate
control on purpose, so you can peek at other namespaces without
changing where new records land.

## Filtering list pages

The Dashboards, Components, and Connections lists each have a
**Filter by namespace** multi-select in the toolbar. Empty selection
means "all namespaces." Pick one or more to narrow the view.

The same multi-select shows on every list page so the filter feels
familiar across the app, and the choice persists per page (the
Dashboards filter doesn't affect the Connections filter, etc.).

## Namespace properties

Each namespace has:

- **Slug** — a lowercase identifier like `default`, `my-homelab`,
  `public-examples`. Letters, numbers, hyphens; 3-32 characters.
- **Description** — a free-form note shown only on the management
  page.
- **Color** — picked from a palette of 12 Carbon-safe colors. The
  same color shows everywhere the namespace appears: header pill,
  list-row chip, picker swatches.

### The `default` namespace

Every system ships with a `default` namespace that can't be renamed
or deleted. Existing records (those that pre-date namespacing) live
here automatically; new records you create without picking a
namespace land here too.

The slug is locked because the server uses `default` as its fallback
target in several places (creation forms with no namespace, import
target when nothing else resolves, the startup seed). Description
and color are editable.

## Managing namespaces

Open **Manage → Namespaces** from the side nav. The page lists every
namespace with its color chip, description, and color hex. From
there you can:

- **Create** a new namespace via the toolbar button.
- **Edit** by clicking the row, which opens the namespace's own page:
  change description, color, or (for non-default namespaces) rename
  the slug — and manage who has access to it.
- **Delete** when no records reference it. If there are records,
  the delete button shows a 409 dialog with the per-type usage
  counts so you know what to move or remove first.

### Renaming a namespace

When you rename a namespace's slug, the server cascades the new
slug into every referring record's `namespace` field in the same
operation. There's no orphaning — connections, components, and
dashboards under the old slug all move to the new slug atomically.

The active namespace pill updates automatically if you rename your
own active namespace.

Renaming also updates the namespace inside every user's access list,
so nobody loses access to a namespace just because it was renamed.

## Namespace access

By default **every user can see every namespace** — that's the
behavior if you never touch any of this, and it's what all existing
users get.

You can instead restrict a user to specific namespaces. Open
**Manage → Users → _(the user)_ → Namespaces**, turn on *Restrict to
specific namespaces*, and tick the ones they should have. From then
on, that user:

- Sees only those namespaces in the header pill and in every
  namespace filter.
- Sees only connections, components, and dashboards in those
  namespaces.
- **Cannot read data through a connection they weren't granted** —
  this is enforced on the server, not just hidden in the UI.

### What a restricted user sees on shared work

A dashboard they *can* see might use a component or connection they
*can't*. Nothing is hidden dishonestly, and nothing leaks:

- The dashboard still opens. Only the affected panels show an
  **Unauthorized** message, and the rest of the dashboard renders
  normally.
- Lists show a warning badge on dashboards that depend on something
  the user can't reach, so they know before clicking.
- In the components/connections popovers, an out-of-reach item shows
  as **Unauthorized Component** / **Unauthorized Connection** — its
  name and namespace are never sent to the browser.

### Managing access from the namespace side

A namespace's page (**Manage → Namespaces → _(the namespace)_**) has a
**Users with access** list showing everyone who can see it:

| Access | Meaning |
| --- | --- |
| **Granted** | Restricted user who was given this namespace specifically. Revoke it here. |
| **All namespaces** | User who isn't restricted at all. Can't be revoked here — removing them would change their access to *every other* namespace too. Use **Edit user** to restrict them properly. |

### Capabilities vs. namespaces

These are two different questions and they don't override each other:

- **Capabilities** (View / Design / Manage / Control) decide *what
  you can do* — which modes you can use.
- **Namespaces** decide *what content you can do it to*.

One deliberate exception: the **Manage** capability's administrative
powers are not namespace-limited. Any manager can create namespaces
and grant any namespace to any user — including themselves. Otherwise
nobody could ever grant the first namespace. Restricting a manager
still limits the content *they* see; it just doesn't limit who they
can administer.

:::note
Namespace access is a **data** boundary, not a design/view split. A
restricted user with the Design capability can design in every
namespace they're granted. Per-namespace view-vs-design levels are
tracked as a future enhancement.
:::

## Where namespaces show up

| Surface | What it does |
| --- | --- |
| Header pill | Picks active namespace; default for new records |
| Header pill chevron | Same — opens the namespace picker dropdown |
| Edit forms (connection, component, dashboard) | Namespace Select pre-filled from active namespace |
| List pages (toolbar) | Multi-select filter |
| List pages (column) | Color chip on every row |
| Import modal | Target namespace select (with cascade default) |
| Export bundle JSON | `source_namespace` field |
| `/manage/namespaces` | CRUD for the namespaces themselves |
