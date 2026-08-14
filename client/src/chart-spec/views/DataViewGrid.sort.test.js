// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pins the dataview initial-sort column resolution: 'newest' (the default,
// including for records saved before the option existed) sorts the
// timestamp column descending — latest row at the top, the live-table
// reading order.

import { describe, it, expect } from 'vitest';
import { resolveInitialSortColumn } from './DataViewGrid';

describe('resolveInitialSortColumn', () => {
  it("prefers the literal 'timestamp' column", () => {
    expect(resolveInitialSortColumn(['container', 'uptime.sec', 'timestamp'])).toBe('timestamp');
  });

  it("falls back to 'ts', then the first time-named column in display order", () => {
    expect(resolveInitialSortColumn(['container', 'ts'])).toBe('ts');
    expect(resolveInitialSortColumn(['event_time', 'created_time', 'container'])).toBe('event_time');
  });

  it('returns null when nothing looks like a timestamp (sort has no target)', () => {
    expect(resolveInitialSortColumn(['container', 'cpu.pct', 'memory.pct'])).toBeNull();
    expect(resolveInitialSortColumn([])).toBeNull();
    expect(resolveInitialSortColumn(null)).toBeNull();
  });

  it("'uptime' style columns do count as time-named — the literal timestamp must outrank them", () => {
    // /time/i matches 'uptime.sec'; the preference order is what keeps the
    // sort on the actual timestamp when both are present.
    expect(resolveInitialSortColumn(['uptime.sec', 'timestamp'])).toBe('timestamp');
  });
});
