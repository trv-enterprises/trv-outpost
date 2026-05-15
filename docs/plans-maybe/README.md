# plans-maybe — ideas worth holding, not yet committed

This directory holds **design notes for features and ideas we might
build later**. It is the "future maybe" layer between fleeting thoughts
and real roadmap items.

## What lives here

- **Half-baked features** that need a writeup before they can be
  argued about or scheduled.
- **Architectural ideas** that would be too disruptive to start
  without a written-down design (e.g. auth refactors, multitenant
  rework).
- **Promotion candidates from memory notes** — a `~/.claude/.../memory/`
  TODO that has matured into a real proposal lives here.
- **Decisions captured as "we explicitly chose NOT to do X"** — like
  `connection-health-alerts.md`, which documents *why* something
  isn't built so the question doesn't have to be re-litigated every
  time it comes up.

## What does NOT live here

- **Active plans** — those live next to the code or in
  [`docs/architecture/`](../architecture/).
- **Completed work** — moves to [`docs/plans-archive/`](../plans-archive/)
  after shipping, with the date and the release tag in the doc body.
- **Hard commitments / current sprint** — those are GitHub Issues
  with `priority:now` or `priority:next` labels.

## Lifecycle

```
  idea
    ↓
  memory note  (one-line hook in MEMORY.md, link to a file)
    ↓
  plans-maybe/<name>.md  (when the idea matures into a proposal)
    ↓
  GitHub issue + priority:next  (when we commit to doing it)
    ↓
  shipped → plans-archive/<name>.md  (or deleted if it was a "no")
```

Not every idea passes through every stage. Small things skip straight
to "ship it." Big things sit in `plans-maybe/` for a while.

## Index

Keep this list short. One line per file, longest hook first if you
want to reorder by importance.

- [connection-health-alerts.md](connection-health-alerts.md) — server-
  side connection-uptime watcher emitting persistent alerts on `healthy
  ↔ unreachable` transitions. Captured 2026-05-14 with the explicit
  decision NOT to pipe transient client-side connection failures into
  persistent storage (volume math + two failure shapes argument).
- [DIRECT_CONNECTION_PLAN.md](DIRECT_CONNECTION_PLAN.md) — historical:
  original motivation for the `mask_secrets` flag on connections.
  **Superseded** — flag was removed, feature never built. Kept for
  context; can be moved to `plans-archive/` once we're sure nothing
  references it.

## Pairing with GitHub Issues

If an idea here is worth tracking publicly (or worth someone else
finding via search), open a GitHub Issue and link both ways:

- Issue body: `Design: docs/plans-maybe/<name>.md`
- Doc footer: `Tracked in GitHub Issue #N`

Labels: `priority:maybe` plus the relevant `area:*` and `effort:*`.
Issues without `priority:maybe` shouldn't link back to `plans-maybe/`
— they belong on the real roadmap.
