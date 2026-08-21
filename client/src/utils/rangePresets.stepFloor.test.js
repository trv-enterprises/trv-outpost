// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pins the step GRANULARITY FLOOR (#277).
//
// The dropdown already filtered steps too fine for the WINDOW (a max-points
// budget). It had no floor for steps too fine for the DATA, so a 1-minute
// rollup dashboard still offered 15s and 30s — asking for a resolution the
// store cannot produce, which draws interpolated/empty buckets and reads as
// missing data rather than as an impossible request.
//
// The regression that matters most is the "no floor" case staying byte-for-byte
// identical to the old behavior: every existing dashboard must be unaffected.

import { describe, it, expect } from 'vitest';
import {
  stepsForWindow,
  rollupWindowMs,
  resolveMinStepMs,
  STEP_PRESETS,
  TSSTORE_MAX_POINTS,
} from './rangePresets';

const H = 3_600_000;
const M = 60_000;

describe('stepsForWindow — granularity floor', () => {
  it('hides steps finer than the floor', () => {
    // The motivating case: a 1m rollup must not offer 15s/30s.
    expect(stepsForWindow(H, TSSTORE_MAX_POINTS, M)).toEqual(['1m', '5m', '15m', '1h']);
  });

  it('is a no-op when the floor is absent, zero, or bogus', () => {
    // Every existing dashboard passes no floor — behavior must not change.
    const legacy = stepsForWindow(H, TSSTORE_MAX_POINTS);
    for (const floor of [undefined, 0, -1, null, NaN, 'nope']) {
      expect(stepsForWindow(H, TSSTORE_MAX_POINTS, floor)).toEqual(legacy);
    }
  });

  it('keeps the coarsest preset when the floor exceeds every option', () => {
    // A 2h rollup is coarser than the coarsest preset (1h). The dropdown must
    // not go empty — offer the closest legal choice instead.
    expect(stepsForWindow(24 * H, TSSTORE_MAX_POINTS, 2 * H)).toEqual(['1h']);
  });

  it('composes with the window budget rather than replacing it', () => {
    // Floor removes from the fine end, the point budget from the fine end too —
    // whichever binds harder wins, and the result is still non-empty.
    const wide = stepsForWindow(90 * 24 * H, TSSTORE_MAX_POINTS, M);
    expect(wide.length).toBeGreaterThan(0);
    expect(wide).not.toContain('15s');
    expect(wide).not.toContain('30s');
    expect(wide[wide.length - 1]).toBe('1h');
  });

  it('never returns an empty list', () => {
    for (const floor of [0, M, 2 * H]) {
      for (const win of [0, H, 24 * H, 365 * 24 * H]) {
        expect(stepsForWindow(win, TSSTORE_MAX_POINTS, floor).length).toBeGreaterThan(0);
      }
    }
  });

  it('preserves STEP_PRESETS order', () => {
    const out = stepsForWindow(H, TSSTORE_MAX_POINTS, M);
    const idx = out.map((s) => STEP_PRESETS.indexOf(s));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});

describe('rollupWindowMs — inference from ts-store metadata', () => {
  // Shape verified live against trv-pi-001 (ts-store v0.20.4).
  const rollup = { name: 'system-stats-1m', data_type: 'schema', role: 'rollup', rollup_of: 'system-stats', window: '1m' };
  const source = { name: 'system-stats', data_type: 'schema', role: 'source' };

  it('reads the window off a rollup store', () => {
    expect(rollupWindowMs(rollup)).toBe(M);
  });

  it('yields no floor for a raw/source store', () => {
    // A source store declares no cadence — its collection interval isn't
    // discoverable, so it must contribute nothing rather than a guess.
    expect(rollupWindowMs(source)).toBe(0);
  });

  it('yields no floor for junk, or a rollup with an unparseable window', () => {
    expect(rollupWindowMs(null)).toBe(0);
    expect(rollupWindowMs(undefined)).toBe(0);
    expect(rollupWindowMs({})).toBe(0);
    expect(rollupWindowMs({ role: 'rollup' })).toBe(0);
    expect(rollupWindowMs({ role: 'rollup', window: 'soon' })).toBe(0);
  });
});

describe('resolveMinStepMs — combining floors', () => {
  const r1m = { role: 'rollup', window: '1m' };
  const r5m = { role: 'rollup', window: '5m' };
  const raw = { role: 'source' };

  it('takes the MAX across stores, not the min', () => {
    // The dropdown is shared: floor at the COARSEST contributor, or a 1m series
    // draws real points beside a 5m series drawing interpolation.
    expect(resolveMinStepMs([r1m, r5m, raw])).toBe(5 * M);
  });

  it('lets a manual floor win over inference — in both directions', () => {
    // Coarser than inferred...
    expect(resolveMinStepMs([r1m], '15m')).toBe(15 * M);
    // ...and FINER. An author who types one knows something the metadata
    // doesn't, so manual is authoritative, not just a lower bound.
    expect(resolveMinStepMs([r5m], '1m')).toBe(M);
  });

  it('falls back to inference when the manual token is blank or unparseable', () => {
    expect(resolveMinStepMs([r1m], '')).toBe(M);
    expect(resolveMinStepMs([r1m], null)).toBe(M);
    expect(resolveMinStepMs([r1m], 'later')).toBe(M);
  });

  it('returns 0 when nothing applies', () => {
    expect(resolveMinStepMs([], null)).toBe(0);
    expect(resolveMinStepMs([raw], null)).toBe(0);
    expect(resolveMinStepMs(null, null)).toBe(0);
    expect(resolveMinStepMs(undefined, undefined)).toBe(0);
  });

  it('accepts a bare-seconds manual token', () => {
    // durationTokenToSeconds accepts "60" as seconds; the floor must too.
    expect(resolveMinStepMs([], '60')).toBe(M);
  });
});

describe('end-to-end: the PI STATS 1M case', () => {
  it('drops 15s and 30s for a 1m rollup on a 1h window', () => {
    const stores = [
      { name: 'system-stats', role: 'source' },
      { name: 'system-stats-1m', role: 'rollup', rollup_of: 'system-stats', window: '1m' },
    ];
    // The dashboard pins system-stats-1m; the floor comes from it.
    const floor = resolveMinStepMs([stores[1]], undefined);
    const items = stepsForWindow(H, TSSTORE_MAX_POINTS, floor);
    expect(items).not.toContain('15s');
    expect(items).not.toContain('30s');
    expect(items[0]).toBe('1m');
  });
});
