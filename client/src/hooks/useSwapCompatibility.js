// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';
import apiClient from '../api/client';

// Debounce so rapid Host-picker changes don't fire a request per keystroke/
// selection frame. The check is a per-connection schema read server-side.
const DEBOUNCE_MS = 250;

/**
 * useSwapCompatibility
 *
 * For a connection_swap variable + a selected connection, asks the server which
 * variable-driven panels would be missing required columns on that connection
 * (a data table collapsing to whatever overlaps, etc.). Detection only — the
 * viewer still renders; this just drives per-panel warning badges.
 *
 *   const { issuesByPanel, schemaUnavailable } = useSwapCompatibility({
 *     dashboardId, variableName, selectedConnId, panelComponents,
 *   });
 *
 * @param {object}  args
 * @param {string}  args.dashboardId
 * @param {string}  args.variableName   the connection_swap variable name ('' → disabled)
 * @param {string}  args.selectedConnId currently selected swap connection ('' → no swap active)
 * @param {object}  args.panelComponents { panelId → effective componentId } post-override
 *
 * @returns {{ issuesByPanel: Record<string, {missing: string[], componentName: string}>,
 *             schemaUnavailable: boolean }}
 */
export function useSwapCompatibility({ dashboardId, variableName, selectedConnId, panelComponents }) {
  const [issuesByPanel, setIssuesByPanel] = useState({});
  const [schemaUnavailable, setSchemaUnavailable] = useState(false);

  // Stable signature of the panel→component map so we refetch when the
  // EFFECTIVE components change (an override kicked in) but not on every render.
  const pcKey = Object.entries(panelComponents || {})
    .map(([p, c]) => `${p}:${c}`)
    .sort()
    .join('|');

  useEffect(() => {
    // Nothing to check without an active swap selection.
    if (!dashboardId || !variableName || !selectedConnId) {
      setIssuesByPanel({});
      setSchemaUnavailable(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiClient
        .getDashboardSwapCompatibility(dashboardId, variableName, selectedConnId, panelComponents)
        .then((res) => {
          if (cancelled) return;
          const map = {};
          for (const issue of res?.issues || []) {
            if (!issue?.panel_id) continue;
            map[issue.panel_id] = {
              missing: issue.missing_columns || [],
              componentName: issue.component_name || '',
            };
          }
          setIssuesByPanel(map);
          setSchemaUnavailable(!!res?.schema_unavailable);
        })
        .catch(() => {
          if (cancelled) return;
          // On error, don't assert a false all-clear or a false warning — clear.
          setIssuesByPanel({});
          setSchemaUnavailable(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // pcKey captures panelComponents content; panelComponents itself is a new
    // object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId, variableName, selectedConnId, pcKey]);

  return { issuesByPanel, schemaUnavailable };
}

export default useSwapCompatibility;
