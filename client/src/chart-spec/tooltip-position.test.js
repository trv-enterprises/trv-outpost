// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pins tooltip placement. ECharts' built-in placement only FLIPS horizontally
// (right of cursor, else left) — it never falls back to above/below. So a
// tooltip wider than the space on either side of the cursor overflowed the
// panel and clipped the series names ("dashboard-caddy-1" → "hboard-caddy-1").
//
// The invariant that matters: the box is ALWAYS fully on-screen. Everything
// else is preference.

import { describe, it, expect } from 'vitest';
import { positionTooltip } from './tooltip-position';

const place = (cx, cy, vw, vh, tw, th) =>
  positionTooltip([cx, cy], null, null, null, { viewSize: [vw, vh], contentSize: [tw, th] });

const onScreen = ([x, y], vw, vh, tw, th) =>
  x >= 0 && y >= 0 && x + tw <= vw && y + th <= vh;

describe('positionTooltip', () => {
  it('places to the RIGHT of the cursor when it fits', () => {
    const [x] = place(200, 180, 700, 400, 180, 120);
    expect(x).toBeGreaterThan(200); // right of cursor
  });

  it('flips LEFT when the right would overflow', () => {
    const [x] = place(640, 180, 700, 400, 180, 120);
    expect(x + 180).toBeLessThanOrEqual(640); // entirely left of cursor
  });

  it('goes VERTICAL when neither side fits — the reported bug', () => {
    // 350-wide tooltip, cursor mid-plot on a 700-wide chart: 350+20 overflows
    // to the right, and 350+20 to the left runs past 0. ECharts picked the
    // left flip and clipped. We must not.
    const vw = 700; const vh = 400; const tw = 350; const th = 220;
    // cx=350 is the true middle: 350+20+350 > 700 AND 350-20-350 < 0, so
    // neither side fits. cy=300 leaves room above (300-20-220=60).
    const pos = place(350, 300, vw, vh, tw, th);
    expect(onScreen(pos, vw, vh, tw, th)).toBe(true);
    // Above the cursor, and centred on it horizontally rather than beside it.
    expect(pos[1] + th).toBeLessThanOrEqual(300);
    expect(Math.abs((pos[0] + tw / 2) - 350)).toBeLessThanOrEqual(1);
  });

  it('stays on-screen when the cursor is too central for EITHER side or above', () => {
    // The genuinely cramped case: no side fits and the box is taller than the
    // space above. It must still land fully on-screen (clamped), never
    // negative — that clamp is the backstop the old code lacked.
    const vw = 700; const vh = 400; const tw = 350; const th = 220;
    const pos = place(350, 180, vw, vh, tw, th);
    expect(onScreen(pos, vw, vh, tw, th)).toBe(true);
  });

  it('falls BELOW when there is no room above', () => {
    const vw = 700; const vh = 400; const tw = 350; const th = 120;
    const pos = place(300, 40, vw, vh, tw, th); // cursor near the top
    expect(onScreen(pos, vw, vh, tw, th)).toBe(true);
    expect(pos[1]).toBeGreaterThanOrEqual(40); // below the cursor
  });

  it('never goes off-screen across a sweep of cursor positions', () => {
    const vw = 700; const vh = 400; const tw = 350; const th = 220;
    for (let cx = 0; cx <= vw; cx += 25) {
      for (let cy = 0; cy <= vh; cy += 25) {
        const pos = place(cx, cy, vw, vh, tw, th);
        expect(onScreen(pos, vw, vh, tw, th), `cursor ${cx},${cy} → ${pos}`).toBe(true);
      }
    }
  });

  it('clamps rather than going negative when the tooltip exceeds the chart', () => {
    // Degenerate but real on a small panel: nothing can fully fit, so the
    // best available answer is flush to the origin, never negative.
    const pos = place(150, 100, 300, 200, 400, 300);
    expect(pos[0]).toBeGreaterThanOrEqual(0);
    expect(pos[1]).toBeGreaterThanOrEqual(0);
  });

  it('survives missing measurements without producing NaN', () => {
    // ECharts calls the placer before the content is measured on first show.
    for (const args of [[10, 10, 0, 0, 0, 0], [10, 10, 700, 400, 0, 0]]) {
      const pos = place(...args);
      expect(Number.isFinite(pos[0])).toBe(true);
      expect(Number.isFinite(pos[1])).toBe(true);
    }
  });

  it('tolerates a missing size argument entirely', () => {
    const pos = positionTooltip([10, 10], null, null, null, undefined);
    expect(Number.isFinite(pos[0])).toBe(true);
    expect(Number.isFinite(pos[1])).toBe(true);
  });
});
