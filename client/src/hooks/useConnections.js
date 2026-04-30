// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import apiClient from '../api/client';

/**
 * Hook to fetch systems
 */
export function useSystems() {
  const [systems, setSystems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSystems = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.getSystems();
      setSystems(response.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSystems();
  }, []);

  return {
    systems,
    loading,
    error,
    refresh: fetchSystems,
  };
}

/**
 * Hook to fetch sources for a system
 */
export function useSources(system) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSources = async () => {
    if (!system) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.getSources(system);
      setSources(response.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSources();
  }, [system]);

  return {
    sources,
    loading,
    error,
    refresh: fetchSources,
  };
}
