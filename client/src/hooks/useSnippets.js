// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useState } from 'react';
import apiClient from '../api/client';

/**
 * Fetches the merged user + global snippet list for a host surface
 * (e.g. "edgelake-terminal") and exposes CRUD helpers. Mutations
 * refetch the list from the server rather than threading optimistic
 * state — the panel renders alpha-sorted and folder-grouped, so a
 * tiny refetch on save/delete is cleaner than reimplementing the sort
 * locally.
 *
 * Returns:
 *   - snippets: array of SnippetResponse (each with `can_edit`)
 *   - loading: true on initial load and during refetches
 *   - error: string or null
 *   - create({ scope, title, command, tags }) → SnippetResponse
 *   - update(id, { title, command, tags }) → SnippetResponse
 *   - remove(id) → void
 *   - refetch() → void
 */
export default function useSnippets(context) {
  const [snippets, setSnippets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchList = useCallback(async () => {
    if (!context) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.listSnippets(context);
      setSnippets(Array.isArray(res?.snippets) ? res.snippets : []);
    } catch (err) {
      setError(err?.message || 'Failed to load snippets');
    } finally {
      setLoading(false);
    }
  }, [context]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const create = useCallback(
    async ({ scope = 'user', title, command, tags = [] }) => {
      const created = await apiClient.createSnippet({
        scope,
        context,
        title,
        command,
        tags,
      });
      await fetchList();
      return created;
    },
    [context, fetchList]
  );

  const update = useCallback(
    async (id, { title, command, tags = [] }) => {
      const updated = await apiClient.updateSnippet(id, { title, command, tags });
      await fetchList();
      return updated;
    },
    [fetchList]
  );

  const remove = useCallback(
    async (id) => {
      await apiClient.deleteSnippet(id);
      await fetchList();
    },
    [fetchList]
  );

  return {
    snippets,
    loading,
    error,
    create,
    update,
    remove,
    refetch: fetchList,
  };
}
