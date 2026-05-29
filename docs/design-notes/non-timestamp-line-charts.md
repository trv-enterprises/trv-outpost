# Line/area charts: support non-timestamp x-axis without complicating time series

**Status:** todo / evaluation — not started
**Raised:** 2026-05-29 (Tom)
**Related:** chart-spec-driven-editor (Stage 2), line.js buildOption

## Problem

The line/area (and by extension bar, which shares line.js) charts assume
their x-axis is **timestamp-based**. Two concrete places this assumption
is baked in today:

1. **Automatic timestamp formatting.** Line charts apply a timestamp
   format (`x_axis_format`: chart / chart_time / chart_date / …) to the
   x-axis values by default. `line.js` runs every x value through
   `formatCellValue(v, xAxisCol, { timestampFormat })`. For a non-time
   column (e.g. `region`, `bucket_label`, an integer id), that formatter
   either mangles the value or is simply the wrong affordance.

2. **Sliding window assumed valid for all sources.** The editor exposes
   the Sliding Window section (a time-based "last N seconds" transform)
   for any connection, and we recently made it default-on-ish behavior.
   But a sliding window only makes sense when the data has a timestamp
   column. We **cannot infer this from the connection type** — a SQL
   connection can return timestamped OR non-timestamped result sets
   depending on the query (`SELECT ts, val …` vs `SELECT region, COUNT(*)
   …`). The per-connection assumption is wrong.

## Goal

Support **both** modes well:

- **Time-series x-axis** (today's behavior) — timestamp column, timestamp
  formatting, sliding window, time-bucket aggregation. Must stay as
  simple as it is now; this is the common case.
- **Category / non-timestamp x-axis** — a plain category or numeric x
  column with no timestamp formatting and no time-only transforms
  offered. Must not require the user to fight time-series defaults.

Without **significantly complicating the time-series path** — the
non-timestamp support should feel like a mode, not a forest of new knobs.

## Things to evaluate (the actual TODO)

This is an evaluation/design task, not a coded plan yet. Audit what it
would take:

1. **How is x treated as time today?**
   - `line.js`: `x_axis_format` → `formatCellValue(..., {timestampFormat})`.
     What happens when the column isn't a timestamp? (currently: still
     formats — wrong.)
   - `xAxis.type` is `'category'` for line/bar/area today. A true
     time axis (`xAxis.type: 'time'`) is a *separate* deferred item
     (see chart-feature-audit-stage2 Bucket B) — don't conflate.

2. **What signals "this x is a timestamp"?**
   - NOT the connection type (SQL can be either — Tom's key point).
   - Candidate signals: an explicit per-chart "x-axis is time" toggle;
     auto-detect from the sampled column values (looks like epoch /
     ISO / Date); the chosen `x_axis_format` being a real format vs a
     new "none/raw" option. Probably an explicit toggle is the honest
     answer, with auto-detect as a convenience default after Fetch Data.

3. **`x_axis_format` should gain a "none / raw" option** (or the whole
   format field should hide when x isn't time). Default for new line
   charts currently assumes a format — re-evaluate that default.

4. **Sliding window gating** should depend on "does this chart have a
   timestamp x (or a timestamp column at all)", not on connection type.
   Tie its availability to the same time-ness signal as #2. When the
   chart isn't time-based, hide/disable the Sliding Window section so it
   can't be enabled (this also kills the class of "phantom sliding
   window blocks save" bugs).

5. **Time-bucket aggregation** has the same connection-agnostic
   timestamp requirement — fold into the same gating signal.

6. **Spec capability flags.** line.json today has `has_x_axis_format`,
   `has_sliding_window`, `has_time_bucket` all true. Consider whether
   these become *conditional on the time-ness signal* rather than static
   per-chart-type — i.e. the spec declares "supports time mode" and the
   editor toggles the time-only sections on the per-chart signal.

## Design constraints / preferences (from Tom)

- Don't significantly complicate the timestamp charts to get this.
- Don't rely on the connection to decide timestamp-ness — a SQL
  connection can bring back either shape.
- Likely shape: one per-chart "time x-axis" signal that gates timestamp
  formatting + sliding window + time bucket together, defaulting sensibly
  (auto-detect from sampled data) so the common time-series case needs no
  extra clicks.

## Not yet decided

- Explicit toggle vs auto-detect vs both.
- Whether to introduce `xAxis.type: 'time'` here or keep category axis
  and just stop formatting (the latter is lower-risk; the former is the
  Bucket-B time-axis item and can stay separate).
- Migration: existing line charts assume time formatting; a default that
  flips them to non-time would regress them. The time-ness signal should
  default true / preserve current behavior for existing records.
