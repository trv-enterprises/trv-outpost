// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { describe, it, expect, vi } from 'vitest';
import { buildCopyName, fetchTakenCopyNames } from './duplicateEntity';

describe('buildCopyName', () => {
  it('appends "(copy)" when nothing collides', () => {
    expect(buildCopyName('Widget', [])).toBe('Widget (copy)');
  });

  it('walks the suffix past every taken name', () => {
    const taken = ['Widget (copy)', 'Widget (copy 2)', 'Widget (copy 3)'];
    expect(buildCopyName('Widget', taken)).toBe('Widget (copy 4)');
  });

  it('accepts a Set as well as an array', () => {
    expect(buildCopyName('Widget', new Set(['Widget (copy)']))).toBe('Widget (copy 2)');
  });

  it('falls back to Untitled for a nameless source', () => {
    expect(buildCopyName('', [])).toBe('Untitled (copy)');
  });
});

describe('fetchTakenCopyNames', () => {
  /**
   * The bug this exists for (#303): callers passed only the names they had
   * locally — the components on the open dashboard, or the current page of a
   * paginated list. A "(copy)" that existed in the namespace but not in that
   * subset was invisible, so buildCopyName returned a name that was already
   * taken and the create failed with a 409 the user could do nothing about.
   */
  const client = (components) => ({
    getComponents: vi.fn().mockResolvedValue({ components }),
  });

  it('picks up a name the caller could not see locally', async () => {
    // The orphaned "(copy)" is on no dashboard, so the editor's local set
    // misses it entirely — this is the exact reported scenario.
    const api = client([{ name: 'Widget' }, { name: 'Widget (copy)' }]);
    const taken = await fetchTakenCopyNames(api, 'Widget', 'default', ['Widget']);
    expect(taken.has('Widget (copy)')).toBe(true);
    expect(buildCopyName('Widget', taken)).toBe('Widget (copy 2)');
  });

  it('queries by name and namespace so the match is scoped', async () => {
    const api = client([]);
    await fetchTakenCopyNames(api, 'Widget', 'homelab', []);
    expect(api.getComponents).toHaveBeenCalledWith({ name: 'Widget', namespace: 'homelab' });
  });

  it('omits the namespace filter when there is none', async () => {
    const api = client([]);
    await fetchTakenCopyNames(api, 'Widget', '', []);
    expect(api.getComponents).toHaveBeenCalledWith({ name: 'Widget' });
  });

  it('keeps the local names as well as the fetched ones', async () => {
    const api = client([{ name: 'Widget (copy)' }]);
    const taken = await fetchTakenCopyNames(api, 'Widget', 'default', ['Widget (copy 2)']);
    // Local knew about (copy 2), server knew about (copy) — both must count.
    expect(buildCopyName('Widget', taken)).toBe('Widget (copy 3)');
  });

  it('falls back to the local set when the lookup fails', async () => {
    // A failed lookup must not block the duplicate — worst case is the old
    // behaviour, a 409 the caller surfaces.
    const api = { getComponents: vi.fn().mockRejectedValue(new Error('offline')) };
    const taken = await fetchTakenCopyNames(api, 'Widget', 'default', ['Widget (copy)']);
    expect(buildCopyName('Widget', taken)).toBe('Widget (copy 2)');
  });

  it('does not call the server without a base name', async () => {
    const api = client([]);
    await fetchTakenCopyNames(api, '', 'default', []);
    expect(api.getComponents).not.toHaveBeenCalled();
  });
});
