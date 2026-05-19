// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';
import apiClient from '../api/client';
import { EXTENSIONS } from '../config/extensions';

/**
 * Resolves which Design-mode extensions are enabled. Reads each
 * extension's admin settings key once on mount; treats fetch failure
 * or missing key as "disabled" rather than "default on" so a server
 * that hasn't seeded the setting yet doesn't surface broken links.
 *
 * Returns:
 *   - enabled: array of EXTENSIONS entries that are turned on
 *   - byId: { [id]: boolean }
 *   - loading: true until the first read completes
 *   - isEnabled(id): convenience predicate
 */
export default function useExtensions() {
  const [byId, setById] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        EXTENSIONS.map(async (ext) => {
          try {
            const r = await apiClient.getSetting(ext.settingsKey);
            return [ext.id, r?.value === true];
          } catch {
            return [ext.id, false];
          }
        })
      );
      if (cancelled) return;
      setById(Object.fromEntries(results));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const enabled = EXTENSIONS.filter((ext) => byId[ext.id]);

  return {
    enabled,
    byId,
    loading,
    isEnabled: (id) => byId[id] === true,
  };
}
