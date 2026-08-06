// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { Button, Modal } from '@carbon/react';
import TagInput from './shared/TagInput';
import apiClient from '../api/client';
import './PanelConnectionTagsModal.scss';

/**
 * PanelConnectionTagsModal — bind ONE panel to a different connection family
 * (tag-value swap mode, #186).
 *
 * The panel's connection follows the dashboard variable, but matches THESE
 * tags instead of the variable's connection tags: the connection carrying all
 * of these tags plus `<prefix>:<selected value>` is used. The tags REPLACE
 * the variable's tags for this panel (they do not union with them — a docker
 * connection doesn't carry the synology tags); "additive" in the design
 * conversation meant the feature adds on top of the variable mechanism.
 *
 * The RESOLUTION PREVIEW is load-bearing, not decoration: without it, tag
 * entry is blind and the first feedback is a broken panel in view mode. With
 * it, a sparse family (a host with no matching connection) is visible at
 * authoring time — exactly when it is fixable.
 *
 * Preview fidelity note: the preview matches tags client-side over the
 * visible connections list. The AUTHORITATIVE resolution at view time is the
 * server's (candidates endpoint, per-family payload); this mirrors its
 * semantics — AND tag match, case-insensitive, first-by-name on ties — and
 * is recomputed live as the draft tags change, which the server cannot do
 * for unsaved tags.
 */
function PanelConnectionTagsModal({
  open,
  onClose,
  panel,
  variableTags = [],
  keyPrefix = '',
  sameNamespace = false,
  dashboardNamespace = '',
  onSave,
}) {
  const [tags, setTags] = useState([]);
  const [connections, setConnections] = useState(null); // null = loading

  // Re-seed from the panel each time the modal opens.
  useEffect(() => {
    if (open) setTags(Array.isArray(panel?.connection_tags) ? panel.connection_tags : []);
  }, [open, panel]);

  // One connections fetch per open — the preview filters it client-side.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    apiClient
      .getConnections({ page_size: 500 })
      .then((res) => {
        if (cancelled) return;
        setConnections(Array.isArray(res) ? res : res?.connections || []);
      })
      .catch(() => {
        if (!cancelled) setConnections([]);
      });
    return () => { cancelled = true; };
  }, [open]);

  const norm = (t) => String(t || '').trim().toLowerCase();

  // Family resolution over the fetched pool: value → { name, ambiguous }.
  const resolveFamily = useMemo(() => {
    return (familyTags) => {
      if (!connections) return new Map();
      const want = familyTags.map(norm).filter(Boolean);
      if (want.length === 0) return new Map();
      const prefix = norm(keyPrefix);
      const byValue = new Map();
      for (const c of connections) {
        if (sameNamespace && dashboardNamespace && c.namespace !== dashboardNamespace) continue;
        const have = new Set((c.tags || []).map(norm));
        if (!want.every((t) => have.has(t))) continue;
        // Extract the key value (first prefix:value tag, value case preserved).
        let value = '';
        for (const t of c.tags || []) {
          const lt = norm(t);
          if (prefix && lt.startsWith(`${prefix}:`) && lt.length > prefix.length + 1) {
            value = String(t).trim().slice(prefix.length + 1).trim();
            break;
          }
        }
        if (!value) continue;
        const existing = byValue.get(value);
        if (!existing) {
          byValue.set(value, { name: c.name, ambiguous: false });
        } else {
          // Tie: deterministic first-by-name, flagged ambiguous (mirrors the
          // server's rule).
          existing.ambiguous = true;
          if (c.name < existing.name) existing.name = c.name;
        }
      }
      return byValue;
    };
  }, [connections, keyPrefix, sameNamespace, dashboardNamespace]);

  const preview = useMemo(() => {
    if (!connections) return null; // loading
    const draftTags = tags.map(norm).filter(Boolean);
    if (draftTags.length === 0) return { rows: [], empty: true };
    const primary = resolveFamily(variableTags);
    const draft = resolveFamily(tags);
    // Every value either family knows about, so a value the draft family
    // adds (present nowhere in the primary) still shows up.
    const values = [...new Set([...primary.keys(), ...draft.keys()])].sort();
    return {
      empty: false,
      rows: values.map((v) => ({ value: v, resolution: draft.get(v) || null })),
    };
  }, [connections, tags, variableTags, resolveFamily]);

  const handleSave = () => {
    const cleaned = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
    onSave?.(cleaned.length > 0 ? cleaned : null);
    onClose?.();
  };

  const handleClear = () => {
    onSave?.(null);
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Panel connection tags"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={handleSave}
      size="sm"
    >
      <div className="panel-conn-tags">
        <p className="pct-help">
          This panel&apos;s connection follows the dashboard variable, but matches
          <strong> these tags</strong> instead of the variable&apos;s connection tags.
          The connection carrying all of these tags plus{' '}
          <code>{keyPrefix || 'prefix'}:&lt;selected value&gt;</code> is used.
        </p>

        <TagInput
          id={`panel-conn-tags-${panel?.id || 'none'}`}
          label="Connection tags for this panel"
          value={tags}
          onChange={setTags}
        />

        {/* Resolution preview — what these tags resolve to right now. */}
        <div className="pct-preview">
          <div className="pct-preview__heading">Resolves to</div>
          {preview === null ? (
            <div className="pct-preview__note">Loading connections…</div>
          ) : preview.empty ? (
            <div className="pct-preview__note">
              No tags set — this panel follows the dashboard&apos;s connection tags.
            </div>
          ) : preview.rows.length === 0 ? (
            <div className="pct-preview__note">
              No connection carries all of these tags with a{' '}
              <code>{keyPrefix || 'prefix'}:</code> tag.
            </div>
          ) : (
            <table className="pct-preview__table">
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.value}>
                    <td className="pct-preview__value">{row.value}</td>
                    <td className={row.resolution ? 'pct-preview__conn' : 'pct-preview__nomatch'}>
                      {row.resolution
                        ? `${row.resolution.name}${row.resolution.ambiguous ? ' (ambiguous — first by name)' : ''}`
                        : 'no match — panel will show "no connection"'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {Array.isArray(panel?.connection_tags) && panel.connection_tags.length > 0 && (
          <Button kind="danger--ghost" size="sm" onClick={handleClear}>
            Clear — rejoin the dashboard&apos;s connection tags
          </Button>
        )}
      </div>
    </Modal>
  );
}

PanelConnectionTagsModal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func,
  panel: PropTypes.shape({
    id: PropTypes.string,
    connection_tags: PropTypes.arrayOf(PropTypes.string),
  }),
  variableTags: PropTypes.arrayOf(PropTypes.string),
  keyPrefix: PropTypes.string,
  sameNamespace: PropTypes.bool,
  dashboardNamespace: PropTypes.string,
  onSave: PropTypes.func,
};

export default PanelConnectionTagsModal;
