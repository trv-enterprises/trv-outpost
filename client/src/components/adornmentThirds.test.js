// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { adornmentRect } from './AdornmentLayer';

/**
 * Border edges can land on the 1/3 and 2/3 marks inside a cell, not just on
 * cell boundaries (#309).
 *
 * The motivating layout: two independent borders sharing one cell — a box
 * around a left group of panels ending at the 1/3 mark, and a box around a
 * right group starting at the 2/3 mark. Each border must sit the SAME
 * distance from its own panels, or one group looks more tightly boxed than
 * the other. That is the property these tests protect.
 *
 * Three rules make it work, each arrived at by rejecting something that
 * seemed reasonable first:
 *
 *  1. A fraction is a fraction of the CELL BODY (32px), not of the stride
 *     (36px). The 4px gutter is dead space between cells, so a third of the
 *     stride lands a third of the way through "cell plus gutter".
 *
 *  2. The line straddles a whole-pixel anchor at floor(fraction * CELL) —
 *     pixel 10 for 1/3, 21 for 2/3 — rather than centring on the true
 *     sub-pixel third (10.67 / 21.33).
 *
 *  3. An even-width line can't be centred on one pixel, so the tie is broken
 *     AWAY from the box's own interior: a thickening border grows back toward
 *     the panels it surrounds, never further across the gap into its
 *     neighbour. This makes the leading and trailing rules deliberately
 *     asymmetric.
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

describe('adornmentRect — two borders sharing a cell sit equally off their panels', () => {
  // THE case this feature exists for. A box around a left group of panels
  // ends its RIGHT edge at the 1/3 mark; a box around a right group starts
  // its LEFT edge at the 2/3 mark. They share one 32px cell.
  //
  // What must look identical is each border's distance from ITS OWN panels —
  // the left border's gap back to the cell start, and the right border's gap
  // on to the cell end. If those differ, one group looks more tightly boxed
  // than the other.
  [1, 2, 3, 4].forEach((line) => {
    it(`${line}px: each border sits the same distance from its own panels`, () => {
      // Left group's box: runs up to the 1/3 mark.
      const leftBorder = lineColumns({ x: 0, y: 0, w: THIRD, h: 1, width: line });
      // Right group's box: starts at the 2/3 mark.
      const rightBorder = lineColumns({ x: 2 * THIRD, y: 0, w: 1 - 2 * THIRD, h: 1, width: line });

      const leftGap = leftBorder.rightStart;          // cell start -> its line
      const rightGap = (CELL - 1) - rightBorder.leftEnd; // its line -> cell end
      expect(leftGap).toBe(rightGap);
    });
  });

  it('grows a thickening border toward its own panels, not across the gap', () => {
    // The tie-break direction. As the line thickens, the centre gap between
    // the two borders must not be eaten into faster on one side.
    const centreGaps = [1, 2, 3, 4].map((line) => {
      const l = lineColumns({ x: 0, y: 0, w: THIRD, h: 1, width: line });
      const r = lineColumns({ x: 2 * THIRD, y: 0, w: 1 - 2 * THIRD, h: 1, width: line });
      return r.leftStart - l.rightEnd - 1;
    });
    // Monotonically non-increasing: thicker lines never widen the gap.
    centreGaps.forEach((g, i) => {
      if (i > 0) expect(g).toBeLessThanOrEqual(centreGaps[i - 1]);
    });
  });
});

describe('adornmentRect — a single 1/3..2/3 box lands on the agreed pixels', () => {
  //   width   left line   right line   outerL | inner | outerR
  //     1px     10..10      21..21         10 |  10   |  10
  //     2px      9..10      21..22          9 |  10   |   9
  //     3px      9..11      20..22          9 |   8   |   9
  //     4px      8..11      20..23          8 |   8   |   8
  const spec = [
    { line: 1, left: [10, 10], right: [21, 21], gaps: [10, 10, 10] },
    { line: 2, left: [9, 10], right: [21, 22], gaps: [9, 10, 9] },
    { line: 3, left: [9, 11], right: [20, 22], gaps: [9, 8, 9] },
    { line: 4, left: [8, 11], right: [20, 23], gaps: [8, 8, 8] },
  ];

  spec.forEach(({ line, left, right, gaps }) => {
    it(`${line}px lines occupy ${left.join('..')} and ${right.join('..')}`, () => {
      const c = lineColumns({ x: THIRD, y: 0, w: THIRD, h: 1, width: line });
      expect([c.leftStart, c.leftEnd]).toEqual(left);
      expect([c.rightStart, c.rightEnd]).toEqual(right);
    });

    it(`${line}px gives gaps ${gaps.join('/')} with the outer two equal`, () => {
      const c = lineColumns({ x: THIRD, y: 0, w: THIRD, h: 1, width: line });
      const outerLeft = c.leftStart;
      const inner = c.rightStart - c.leftEnd - 1;
      const outerRight = (CELL - 1) - c.rightEnd;
      expect([outerLeft, inner, outerRight]).toEqual(gaps);
      // The outer gaps separate the border from the panels it surrounds, so
      // they are the pair that must match.
      expect(outerLeft).toBe(outerRight);
      expect(outerLeft + line + inner + line + outerRight).toBe(CELL);
    });
  });

  it('keeps the inner gap close to the outer ones', () => {
    // A 32px cell can't split into three equal parts; the centre is allowed
    // to differ, but only slightly.
    spec.forEach(({ gaps }) => {
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    });
  });
});

describe('adornmentRect — fractions are of the cell body, not the stride', () => {
  it('anchors 1/3 at floor(32/3), not floor(36/3)', () => {
    // Thirds of the 36px stride would put the anchor at pixel 12, which sits
    // left of centre inside the 0..31 cell the author is looking at.
    const c = lineColumns({ x: THIRD, y: 0, w: THIRD, h: 1, width: 1 });
    expect(c.leftStart).toBe(Math.floor(THIRD * CELL));
    expect(c.leftStart).not.toBe(Math.floor(THIRD * STRIDE));
  });

  it('offsets a fraction in a later cell by whole strides', () => {
    const c = lineColumns({ x: 2 + THIRD, y: 0, w: THIRD, h: 1, width: 1 });
    expect(c.leftStart).toBe(2 * STRIDE + Math.floor(THIRD * CELL));
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
