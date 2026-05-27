// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';
import { InlineNotification } from '@carbon/react';
import apiClient from '../../api/client';
import './ConnectionGuidanceHint.scss';

/**
 * ConnectionGuidanceHint — collapsible info card surfacing the
 * per-connection-type query-config conventions to a human user.
 *
 * The same `connectionguidance` strings the Dashboard Assistant
 * reads from toolops are exposed to humans here so users editing
 * a chart against an adapter with non-obvious behavior (ts-store's
 * DSL on `raw`, EdgeLake's narrow SQL subset, Prometheus's
 * query_type/start/step envelope) see the same warnings the agent
 * does.
 *
 * Props:
 *   - typeId: the connection adapter type id (e.g. "store.tsstore",
 *     "api.prometheus", "sql.postgres"). When unset, renders nothing.
 *   - defaultOpen: render expanded on mount (default false).
 *
 * Renders nothing when typeId is missing or the fetch fails — this
 * is a hint, not a critical control. Failure-silent by design.
 */
export default function ConnectionGuidanceHint({ typeId, defaultOpen = false }) {
  const [guidance, setGuidance] = useState(null);
  const [hasEntry, setHasEntry] = useState(false);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!typeId) {
      setGuidance(null);
      setHasEntry(false);
      return undefined;
    }
    let cancelled = false;
    apiClient.getConnectionTypeGuidance(typeId)
      .then((res) => {
        if (cancelled) return;
        setGuidance(res?.guidance || null);
        setHasEntry(!!res?.has_entry);
      })
      .catch(() => {
        if (cancelled) return;
        setGuidance(null);
        setHasEntry(false);
      });
    return () => { cancelled = true; };
  }, [typeId]);

  // Hide when no type or no guidance came back. We choose not to
  // surface the generic-fallback hint to humans — it adds noise to
  // the editor for types where we have nothing adapter-specific to
  // say.
  if (!typeId || !guidance || !hasEntry) return null;

  return (
    <InlineNotification
      kind="info"
      lowContrast
      hideCloseButton
      title={`Query conventions for ${typeId}`}
      className="connection-guidance-hint"
      subtitle={(
        <details
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
          className="connection-guidance-hint__details"
        >
          <summary className="connection-guidance-hint__summary">
            {open ? 'Hide details' : 'Show details'}
          </summary>
          <pre className="connection-guidance-hint__body">{guidance}</pre>
        </details>
      )}
    />
  );
}
