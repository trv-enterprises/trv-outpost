// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * usePaginatedList — shared server-side filter + sort + pagination driver
 * for the entity list pages (connections, users, components, dashboards),
 * issue #21. Replaces the old per-page "fetch everything, filter/sort in a
 * useMemo" pattern that silently truncated large datasets.
 *
 * The page owns its filter VALUES (namespace, tags, type, search, etc.) and
 * passes them in via `filters`; this hook debounces, builds the query, and
 * re-fetches whenever filters / sort / page / pageSize change. ANY change to
 * filters or sort resets to page 1 (so a sort/filter always applies over the
 * whole dataset from the top). `page` itself does not reset on refetch.
 *
 * @param {object}   opts
 * @param {Function} opts.fetcher   async (queryParams) => response. Receives
 *                                  the merged { ...filters, sort, direction,
 *                                  page, page_size } and returns the raw API
 *                                  response.
 * @param {Function} opts.extract   (response) => { rows, total, hasMore }.
 *                                  Pulls the list + paging meta out of the
 *                                  entity-specific response shape.
 * @param {object}   opts.filters   current filter values (page resets when
 *                                  this changes by value).
 * @param {string}   opts.sortKey
 * @param {string}   opts.sortDir   'asc' | 'desc'
 * @param {number}   [opts.initialPageSize=25]
 * @param {string}   [opts.searchKey='name'] query key the debounced search
 *                                  term maps to (server filter field).
 * @param {string}   [opts.search='']  raw (un-debounced) search term.
 * @param {number}   [opts.debounceMs=300]
 * @param {number}   [opts.reloadTick] bump to force a refetch (e.g. after a
 *                                  delete) without changing filters.
 *
 * @returns {{ rows, total, hasMore, loading, error, page, setPage,
 *            pageSize, setPageSize, refetch }}
 */
export function usePaginatedList({
  fetcher,
  extract,
  filters,
  sortKey,
  sortDir,
  initialPageSize = 25,
  searchKey = 'name',
  search = '',
  debounceMs = 300,
  reloadTick = 0,
}) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  // Debounce the search term so typing doesn't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), debounceMs);
    return () => clearTimeout(t);
  }, [search, debounceMs]);

  // A stable signature of everything that should RESET to page 1 when it
  // changes (filters, sort, search). Page-size changes also reset to page 1
  // (Carbon Pagination convention). Only `page` itself advances without a
  // reset.
  const resetSig = JSON.stringify({ filters, sortKey, sortDir, debouncedSearch, pageSize });
  const prevResetSig = useRef(resetSig);
  useEffect(() => {
    if (prevResetSig.current !== resetSig) {
      prevResetSig.current = resetSig;
      setPage(1);
    }
  }, [resetSig]);

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = {
        ...filters,
        sort: sortKey,
        direction: sortDir,
        page,
        page_size: pageSize,
      };
      if (debouncedSearch) query[searchKey] = debouncedSearch;
      const resp = await fetcher(query);
      const { rows: r, total: t, hasMore: h } = extract(resp);
      setRows(r || []);
      setTotal(t || 0);
      setHasMore(!!h);
    } catch (err) {
      setError(err.message || 'Failed to load');
      setRows([]);
      setTotal(0);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSig, page, reloadTick]);

  useEffect(() => {
    doFetch();
  }, [doFetch]);

  return {
    rows,
    total,
    hasMore,
    loading,
    error,
    page,
    setPage,
    pageSize,
    setPageSize,
    refetch: doFetch,
  };
}

export default usePaginatedList;
