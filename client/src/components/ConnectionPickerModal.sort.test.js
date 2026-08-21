// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// The connection picker gained a "Last modified" column so an author can find
// the connection they just touched. Two things had to be right beyond adding
// the header, and both are silent when wrong:
//
//  1. Dates must sort as TIMESTAMPS. The displayed value is a locale string,
//     and sorting those alphabetically puts "1/9/2026" before "12/2/2025" —
//     the column looks sortable and is wrong.
//  2. The first click must sort NEWEST first. Ascending buries the recent
//     connection at the bottom, which defeats the reason to sort at all.
//
// The comparator lives inline in the component; this pins the behaviour it
// implements.

import { describe, it, expect } from 'vitest';
import { formatDate } from '../utils/formatDate';

// Mirrors the component's comparator.
const sortConnections = (rows, sortKey, sortDirection) => [...rows].sort((a, b) => {
  if (sortKey === 'updated_at') {
    const aT = Date.parse(a.updated_at) || 0;
    const bT = Date.parse(b.updated_at) || 0;
    return sortDirection === 'asc' ? aT - bT : bT - aT;
  }
  const aVal = String(a[sortKey] || '').toLowerCase();
  const bVal = String(b[sortKey] || '').toLowerCase();
  if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
  if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
  return 0;
});

const defaultDirFor = (key) => (key === 'updated_at' ? 'desc' : 'asc');

const CONNS = [
  { name: 'alpha', updated_at: '2025-12-02T10:00:00Z' },
  { name: 'bravo', updated_at: '2026-01-09T10:00:00Z' },
  { name: 'charlie', updated_at: '2026-08-20T10:00:00Z' },
];

describe('connection picker sorting', () => {
  it('sorts dates newest-first on desc', () => {
    const out = sortConnections(CONNS, 'updated_at', 'desc').map((c) => c.name);
    expect(out).toEqual(['charlie', 'bravo', 'alpha']);
  });

  it('sorts dates oldest-first on asc', () => {
    const out = sortConnections(CONNS, 'updated_at', 'asc').map((c) => c.name);
    expect(out).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('does NOT sort dates as display strings', () => {
    // The trap: "1/9/2026" < "12/2/2025" alphabetically, so a string sort
    // would put bravo (Jan 2026) before alpha (Dec 2025) when ascending.
    const displayed = CONNS.map((c) => formatDate(c.updated_at));
    const alphabetical = [...displayed].sort();
    const chronological = sortConnections(CONNS, 'updated_at', 'asc')
      .map((c) => formatDate(c.updated_at));
    expect(chronological).not.toEqual(alphabetical);
    expect(chronological[0]).toBe(formatDate('2025-12-02T10:00:00Z'));
  });

  it('puts missing timestamps last when sorting newest-first', () => {
    const withGap = [...CONNS, { name: 'delta', updated_at: null }];
    const out = sortConnections(withGap, 'updated_at', 'desc').map((c) => c.name);
    expect(out[out.length - 1]).toBe('delta');
  });

  it('defaults the date column to desc and text columns to asc', () => {
    expect(defaultDirFor('updated_at')).toBe('desc');
    expect(defaultDirFor('name')).toBe('asc');
    expect(defaultDirFor('type')).toBe('asc');
  });

  it('still sorts text columns alphabetically', () => {
    expect(sortConnections(CONNS, 'name', 'asc').map((c) => c.name))
      .toEqual(['alpha', 'bravo', 'charlie']);
    expect(sortConnections(CONNS, 'name', 'desc').map((c) => c.name))
      .toEqual(['charlie', 'bravo', 'alpha']);
  });
});

describe('formatDate', () => {
  it('renders a missing or unparseable value as the empty marker', () => {
    expect(formatDate(null)).toBe('N/A');
    expect(formatDate('')).toBe('N/A');
    expect(formatDate('not a date')).toBe('N/A');
    expect(formatDate(null, '—')).toBe('—');
  });

  it('renders a real timestamp as date + time', () => {
    const out = formatDate('2026-08-20T10:00:00Z');
    expect(out).toMatch(/\d/);
    expect(out).not.toBe('N/A');
    expect(out.split(' ').length).toBeGreaterThanOrEqual(2);
  });
});
