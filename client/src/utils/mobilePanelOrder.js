// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Mobile flow ordering: borders group the panels they enclose (#180).
 *
 * The mobile viewer discards the author's grid geometry and stacks panels in a
 * single column, so the only thing that survives from the layout is ORDER. A
 * plain reading-order sort loses the clustering the author expressed spatially:
 * two visual groups side by side interleave row-by-row down the phone, and a
 * visually-single row whose panels have staggered tops splits apart (a strict
 * `y` compare puts y=15 after y=14 even when they read as one row).
 *
 * A rect `border` adornment already means "these panels belong together" — it's
 * a box drawn around them. This module reads that intent: panels fully enclosed
 * by a border flow as a unit, emitted before anything outside it.
 *
 * ORDER ONLY. Nothing here renders; groups are invisible on mobile. Whether a
 * group should show a rule/heading/box is deliberately deferred (issue #232).
 *
 * Nesting is first-class — groups within groups nest arbitrarily deep, and a
 * nested group sorts against its loose siblings by position rather than always
 * leading or trailing them.
 */

/** Adornment/panel rects use omitempty on the wire: a border at the origin
 * arrives with NO x/y fields at all. Reading `a.x` directly yields undefined,
 * every comparison against it is false, and enclosure silently reports zero
 * members — which is exactly how a border that really encloses 4 panels was
 * first measured as enclosing none. Always coerce. */
const num = (v) => (Number.isFinite(v) ? v : 0);

const rectOf = (r) => ({
  x: num(r?.x), y: num(r?.y), w: num(r?.w), h: num(r?.h),
});

/**
 * Does `outer` fully contain `inner`? Full enclosure, not intersection — a
 * panel the border merely clips is not a member. Matches the marquee
 * selection predicate in the editor, so "what a box selects" and "what a box
 * groups" agree.
 */
export function encloses(outer, inner) {
  const o = rectOf(outer);
  const i = rectOf(inner);
  return i.x >= o.x && i.x + i.w <= o.x + o.w
      && i.y >= o.y && i.y + i.h <= o.y + o.h;
}

const areaOf = (r) => { const { w, h } = rectOf(r); return w * h; };

// Reading order: top-to-bottom, then left-to-right. Ties broken by id so the
// result is stable across runs regardless of input order.
const byPosition = (a, b) => (a.y - b.y) || (a.x - b.x) || String(a.id).localeCompare(String(b.id));

/**
 * Build the containment tree.
 *
 * A border's parent is the SMALLEST other border enclosing it; a panel's owner
 * is the SMALLEST border enclosing it (innermost wins). Because a parent is
 * always strictly smaller-area than nothing and strictly larger than its child,
 * the relation can't cycle — equal-area overlaps are broken by id so two
 * identical rects can't parent each other.
 */
function buildTree(panels, borders) {
  // Smallest first, so the first enclosing match found IS the innermost.
  const sorted = [...borders].sort(
    (a, b) => areaOf(a) - areaOf(b) || String(a.id).localeCompare(String(b.id))
  );

  const parentOf = new Map();
  sorted.forEach((b) => {
    const parent = sorted.find((o) => {
      if (o === b) return false;
      const ao = areaOf(o);
      const ab = areaOf(b);
      // Strictly larger area, or equal area broken deterministically by id —
      // never symmetric, so the tree stays acyclic.
      if (ao < ab) return false;
      if (ao === ab && String(o.id).localeCompare(String(b.id)) >= 0) return false;
      return encloses(o, b);
    });
    parentOf.set(b.id, parent ? parent.id : null);
  });

  const ownerOf = new Map();
  panels.forEach((p) => {
    const owner = sorted.find((o) => encloses(o, p));
    ownerOf.set(p.id, owner ? owner.id : null);
  });

  return { sorted, parentOf, ownerOf };
}

/**
 * Flatten one level: the parent's direct child groups and its direct loose
 * panels, interleaved by position, recursing into each group in place.
 *
 * Interleaving is the point — a nested group is just another item in its
 * parent's ordering, positioned at its border's top-left. A loose panel above a
 * nested group precedes it; one below follows it.
 */
function emitLevel(panels, ctx, parentId, depth, out) {
  const groups = ctx.sorted
    .filter((b) => ctx.parentOf.get(b.id) === parentId)
    .map((b) => ({ kind: 'group', id: b.id, ...rectOf(b), border: b }));

  const loose = panels
    .filter((p) => ctx.ownerOf.get(p.id) === parentId)
    .map((p) => ({ kind: 'panel', id: p.id, ...rectOf(p), panel: p }));

  [...groups, ...loose].sort(byPosition).forEach((item) => {
    if (item.kind === 'panel') {
      out.push({ panel: item.panel, depth, groupId: parentId });
    } else {
      emitLevel(panels, ctx, item.id, depth + 1, out);
    }
  });
  return out;
}

/**
 * Order panels for mobile flow, honoring border grouping.
 *
 * @param {Array} panels     dashboard.panels
 * @param {Array} adornments dashboard.adornments
 * @returns {Array<{panel: object, depth: number, groupId: string|null}>}
 *   Panels in flow order. `depth` is the nesting level (0 = ungrouped) and
 *   `groupId` the innermost enclosing border id (null = loose) — carried so a
 *   later presentation layer (#232) can render grouping without recomputing it.
 *   Callers that only need the panels can map to `.panel`.
 */
export function orderPanelsForMobile(panels, adornments) {
  const list = Array.isArray(panels) ? panels : [];
  if (list.length === 0) return [];

  // Only rect borders group. panel_border has no rect of its own (it decorates
  // a single panel), so it can't enclose anything.
  const borders = (Array.isArray(adornments) ? adornments : []).filter(
    (a) => a && a.kind === 'border' && a.id
  );

  // No borders → the original reading-order sort, exactly as before.
  if (borders.length === 0) {
    return [...list].sort(byPosition).map((panel) => ({ panel, depth: 0, groupId: null }));
  }

  const ctx = buildTree(list, borders);
  return emitLevel(list, ctx, null, 0, []);
}

export default orderPanelsForMobile;
