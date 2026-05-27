// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';
import { Information, ChevronRight, ChevronDown } from '@carbon/icons-react';
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

  // We render our own bordered card rather than wrapping a Carbon
  // InlineNotification because the disclosure toggle is interactive
  // and Carbon's notification validator rejects interactive nodes
  // inside `subtitle` ("component should have no interactive child
  // nodes"). The visual treatment mimics InlineNotification kind=info
  // — left accent stripe, info icon, lowContrast layer background —
  // using Carbon tokens directly so theme switches still work.
  const ChevronIcon = open ? ChevronDown : ChevronRight;
  return (
    <div className="connection-guidance-hint" role="region" aria-label={`Query conventions for ${typeId}`}>
      <button
        type="button"
        className="connection-guidance-hint__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Information size={16} className="connection-guidance-hint__info-icon" />
        <span className="connection-guidance-hint__title">
          Query conventions for <code>{typeId}</code>
        </span>
        <ChevronIcon size={16} className="connection-guidance-hint__chevron" />
      </button>
      {open && (
        <pre className="connection-guidance-hint__body">{guidance}</pre>
      )}
    </div>
  );
}
