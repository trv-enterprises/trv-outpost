---
title: Export & Import
sidebar_position: 2
---

# Exporting and importing dashboards

You can export one or more dashboards (along with the components and
connections they depend on) into a single JSON file, and re-import
that file later — into the same system to update in place, or into a
different namespace to make independent copies.

## What's in a bundle

When you export, the system follows the dashboard's dependency graph:

- The selected dashboards themselves
- Every component (chart / control / display) referenced by any
  panel
- Every connection (datasource) those components talk to, plus any
  Frigate or MQTT connections referenced by display configs

The bundle is a JSON file with this rough shape:

```json
{
  "format_version": 1,
  "exported_at": "2026-04-19T10:00:00Z",
  "exported_by": "tviviano",
  "source_namespace": "tviviano-homelab",
  "objects": {
    "connections": [ ... ],
    "components": [ ... ],
    "dashboards": [ ... ]
  }
}
```

Connections come out with secrets **masked** as `********`. The
import side handles those specially (see "Secrets" below).

## Exporting from the dashboard list

1. Open **Design → Dashboards**.
2. Click **Export** in the toolbar. The page switches into export
   mode — the Create button hides, every row shows a checkbox, and
   a bulk-action bar appears above the table.
3. Click rows (or check their boxes) to select the dashboards you
   want to export.
4. Click **Export (N)** in the bulk-action bar. A modal previews
   what's about to download:
   *"Exporting 3 dashboards with 12 components and 4 connections."*
5. Click **Download**. The file lands as
   `<source_namespace>-YYYYMMDDTHHMMSS.json`.

If two of your selected dashboards share a name (probably in
different namespaces), the modal blocks the Download button with a
clear explanation. A bundle can only be imported into a single
namespace, so name collisions inside the bundle would never round-trip
cleanly. Rename one of the dashboards and try again.

## Exporting a single dashboard from the viewer

While viewing any dashboard, click the **Download** icon in the
header (designer privilege required). The same export modal opens
with that dashboard pre-selected.

## Importing

1. From **Design → Dashboards**, click **Import** in the toolbar.
2. Drop the bundle file onto the upload area (or click to pick a
   file). The system parses it client-side and validates the
   `format_version`.
3. Pick a **target namespace**. The default is your active
   namespace; you can switch to any other namespace from the
   dropdown.
   - If the bundle's source namespace doesn't exist locally, an
     inline notice offers a one-click "Create '\<source\>'" button.
   - If the bundle's source namespace exists locally but isn't the
     active one, a notice offers "Use '\<source\>'" to swap the
     target.
4. The preflight runs automatically and shows colored count chips:
   - **New** — objects that don't exist locally yet
   - **Identical** — objects that match an existing record exactly
     (silently skipped)
   - **Conflicts** — objects with the same ID but different content
     (review individually)
   - **Blocked** — objects that can't be imported as-is
5. Click **Import**.
   - If there are conflicts, a diff modal opens. Review each
     conflict's unified diff, uncheck any you don't want to
     overwrite, and click Apply.
   - If everything is new or identical, the import runs
     immediately.
6. The result modal summarizes what happened: *"Import complete:
   8 created · 2 updated · 5 skipped."*

## Update vs. copy

Whether the import treats the bundle as an **update** or a **copy**
depends on the target namespace:

- **Target namespace == bundle's source namespace** → IDs are
  preserved. Re-importing the same bundle is idempotent (everything
  identical, nothing changes). Modified objects show up as
  conflicts you can review and overwrite. This is the path for
  cross-system updates ("I'm syncing my staging dashboards to my
  production namespace").

- **Target namespace != bundle's source namespace** → IDs are
  re-minted. Every connection, component, and dashboard becomes a
  fresh independent record in the new namespace. The dependency
  graph (chart → connection refs, dashboard → chart refs) is
  rewritten on the fly so the new records reference the new IDs.
  This is the path for templating ("clone my homelab dashboards
  into a new project namespace").

  If a dashboard's name already exists in the target namespace, the
  imported one lands as `<name>-copy` (or `-copy-2`, etc., until
  it's unique).

## Blocked imports

The "blocked" bucket exists for one specific case: an incoming object
has the same `(target_namespace, name)` as an existing local record
with a **different** ID. The importer can't decide whether they're
"the same logical thing" (delete the old one and replace it) or
"two different things" (rename one).

The fix is manual — pick a different target namespace, or rename
the existing local record before retrying. The blocked case is rare
because most imports either update by ID or copy with re-mint; only
old re-imports across very different histories tend to hit it.

## Secrets and masked values

Connection passwords and API keys ride in the bundle as `"********"`
placeholders, never plaintext. On import:

- **Update** path (preserved IDs): the existing record's real
  secret is preserved when the incoming value is `"********"`.
- **Create** path (new IDs): the placeholder is left literal. You
  have to open the new connection and fill in real credentials
  before it'll work.

This is intentional — bundles aren't safe secret vaults. If you
want to share a fully-functional dashboard, share both the bundle
and the credentials separately.

## What's *not* covered

- **Moving an existing record to a different namespace without
  re-creating it.** Covered today by editing the record's
  namespace field directly in the editor; no export/import involved.
- **Deleting an entire namespace's contents in one shot.** No
  current tooling — delete the records individually, or rename the
  namespace and recreate elsewhere.
- **Selective import** of only the dashboards from a bundle (skip
  the components / connections). The bundle is treated as an atomic
  graph; the only opt-out is per-conflict on the diff modal.
