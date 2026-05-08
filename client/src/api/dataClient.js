// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Data Client
 * API wrapper for data layer queries
 */

import apiClient from './client';

/**
 * Query data from a connection
 * @param {string} connectionId - ID of the connection
 * @param {object} query - Query parameters (raw, type, params)
 * @param {boolean} useCache - Whether to use cache (default: true). Currently informational only — the server doesn't implement a cache layer for /api/connections/:id/query.
 * @returns {Promise<object>} Query result with data and source
 */
export async function queryData(connectionId, query, useCache = true) {
  try {
    const response = await apiClient.request(`/api/connections/${connectionId}/query`, {
      method: 'POST',
      body: JSON.stringify({ query: query })
    });

    // The backend returns result_set with columns and rows
    return {
      data: response.result_set,
      source: useCache ? 'cache' : 'connection',
      cached: useCache
    };
  } catch (error) {
    console.error('Data query error:', error);
    throw new Error(error.message || 'Failed to query data');
  }
}
