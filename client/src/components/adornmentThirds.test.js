// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { adornmentRect } from './AdornmentLayer';

/**
 * Border edges can land on the 1/3 and 2/3 marks inside a cell, not just on
 * cell boundaries (#309).
 *
 * The motivating layout is two independent borders meeting in one cell: a box
 * around a left group of panels ending at the 1/3 mark, and a box around a
 * right group starting at the 2/3 mark. Between the two neighbouring panels
 * there are three gaps, and they should look evenly spaced.
 *
 * The geometry that makes that work, each rule arrived at by rejecting
 * something that seemed reasonable first:
 *
 *  1. A fraction divides the GUTTER-INCLUSIVE span (GAP + CELL + GAP = 40px),
 *     starting one gutter before the cell. Dividing the 32px cell body was
 *     the original bug: the two outer gaps each swallow a 4px gutter that the
 *     centre never sees, so the centre came out ~6px tighter (measured
 *     14.3 / 8.2 on a real dashboard).
 *
 *  2. The line straddles a whole-pixel anchor rather than centring on the
 *     true sub-pixel third, which would round unpredictably.
 *
 *  3. Both edges straddle by the same floor(width/2), which balances the
 *     three gaps to within 1px at every width and exactly at 2px.
 *
 * KNOWN LIMITATION: at the first or last column there is no neighbouring
 * panel, so the span is not symmetric and an edge-adjacent border spaces
 * differently from an interior one. No cheap fix; deliberate.
 */

const CELL = 32;
const GAP = 4;
const STRIDE = CELL + GAP; // 36
const THIRD = 1 / 3;

/** Which physical pixel columns a rect's two vertical lines occupy. */
function lineColumns(a) {
  const line = a.width || 2;
  const r = adornmentRect(a);
  const leftStart = Math.round(r.left);
  const rightStart = Math.round(r.left + line + r.width);
  return {
    leftStart,
    leftEnd: leftStart + line - 1,
    rightStart,
    rightEnd: rightStart + line - 1,
  };
}

describe('adornmentRect — whole-cell boxes are unchanged', () => {
  // The regression that matters most: existing dashboards must not move by a
  // single pixel, and must not churn on the next save.
  const cases = [
    { a: { x: 0, y: 0, w: 1, h: 1, width: 2 }, left: -2, width: CELL },
    { a: { x: 2, y: 1, w: 3, h: 2, width: 2 }, left: 2 * STRIDE - 2, width: 3 * STRIDE - GAP },
    { a: { x: 5, y: 0, w: 1, h: 1, width: 4 }, left: 5 * STRIDE - 4, width: CELL },
  ];

  cases.forEach(({ a, left, width }) => {
    it(`x=${a.x} w=${a.w} line=${a.width} keeps its pre-#309 geometry`, () => {
      const r = adornmentRect(a);
      expect(r.left).toBe(left);
      expect(r.width).toBe(width);
    });
  });
});

describe('adornmentRect — two borders sharing a cell space evenly', () => {
  // THE case this feature exists for, and the one that set the geometry.
  //
  // A box around a left group of panels ends its RIGHT edge at the 1/3 mark;
  // a box around a right group starts its LEFT edge at the 2/3 mark. Between
  // the two neighbouring PANELS there are three visible gaps:
  //
  //   left panel | gutter + (0..1/3) | (1/3..2/3) | (2/3..1) + gutter | right panel
  //
  // The outer two each swallow a 4px gutter that the centre never sees, which
  // is why the fraction divides the 40px panel-edge-to-panel-edge span rather
  // than the 32px cell body. Dividing the body measured 14.3 / 8.2 on a real
  // dashboard — a ~6px discrepancy the author could see.
  //
  // Cell 0 is px 0..31. The panel left of it ends at px -5; the panel right
  // of it starts at px 36.
  const LEFT_PANEL_EDGE = -5;
  const RIGHT_PANEL_EDGE = 36;

  /** The three gaps, measured panel edge to panel edge. */
  function gaps(line) {
    // Left group's box: ends at the 1/3 mark of cell 0.
    const l = lineColumns({ x: -1, y: 0, w: 1 + THIRD, h: 1, width: line });
    // Right group's box: starts at the 2/3 mark of cell 0.
    const r = lineColumns({ x: 2 * THIRD, y: 0, w: 1, h: 1, width: line });
    return [
      l.rightStart - LEFT_PANEL_EDGE - 1,      // left panel -> left border
      r.leftStart - l.rightEnd - 1,            // between the two borders
      RIGHT_PANEL_EDGE - r.leftEnd - 1,        // right border -> right panel
    ];
  }

  const expected = {
    1: [13, 13, 12],
    2: [12, 12, 12],
    3: [12, 11, 11],
    4: [11, 10, 11],
  };

  Object.entries(expected).forEach(([line, want]) => {
    it(`${line}px gives gaps ${want.join('/')}`, () => {
      expect(gaps(Number(line))).toEqual(want);
    });
  });

  it('keeps all three gaps within 1px at every width', () => {
    [1, 2, 3, 4].forEach((line) => {
      const g = gaps(line);
      expect(Math.max(...g) - Math.min(...g)).toBeLessThanOrEqual(1);
    });
  });

  it('is exactly even at 2px', () => {
    // The width the author is most likely to use, so it is worth pinning
    // that it comes out perfectly balanced.
    expect(gaps(2)).toEqual([12, 12, 12]);
  });
});

describe('adornmentRect — fractions divide the gutter-inclusive span', () => {
  const SPAN = GAP + CELL + GAP; // 40

  it('starts the span one gutter BEFORE the cell', () => {
    // A 1/3 mark in cell 0 is measured from px -4, not px 0.
    const c = lineColumns({ x: THIRD, y: 0, w: THIRD, h: 1, width: 1 });
    expect(c.leftStart).toBe(-GAP + Math.round(THIRD * SPAN));
  });

  it('does not divide the 32px cell body', () => {
    // The original bug. Thirds of the body put the mark at px 10, which makes
    // the centre gap ~6px tighter than the outer ones.
    const c = lineColumns({ x: THIRD, y: 0, w: THIRD, h: 1, width: 1 });
    expect(c.leftStart).not.toBe(Math.floor(THIRD * CELL));
  });

  it('offsets a fraction in a later cell by whole strides', () => {
    const c = lineColumns({ x: 2 + THIRD, y: 0, w: THIRD, h: 1, width: 1 });
    expect(c.leftStart).toBe(2 * STRIDE - GAP + Math.round(THIRD * SPAN));
  });
});

describe('adornmentRect — mixed boxes stay closed', () => {
  it('handles a boundary start with a fractional end', () => {
    const line = 2;
    const r = adornmentRect({ x: 1, y: 0, w: THIRD, h: 1, width: line });
    // Starts like a boundary edge: fully outside the content box.
    expect(r.left).toBe(1 * STRIDE - line);
    expect(r.width).toBeGreaterThan(0);
  });

  it('handles a fractional start with a boundary end', () => {
    const r = adornmentRect({ x: 2 * THIRD, y: 0, w: 1 - 2 * THIRD, h: 1, width: 2 });
    expect(r.width).toBeGreaterThan(0);
  });

  it('never produces a negative width', () => {
    // A degenerate box should still render as something rather than
    // inverting — an inverted rect paints outside its own bounds.
    for (const w of [THIRD, 2 * THIRD, 1, 2]) {
      const r = adornmentRect({ x: 0, y: 0, w, h: 1, width: 2 });
      expect(r.width).toBeGreaterThan(0);
    }
  });
});
