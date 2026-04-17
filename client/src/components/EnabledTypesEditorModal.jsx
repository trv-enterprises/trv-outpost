// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Checkbox,
  Loading,
  InlineNotification,
  Tag
} from '@carbon/react';
import apiClient from '../api/client';
import './EnabledTypesEditorModal.scss';

/**
 * EnabledTypesEditorModal
 *
 * Hierarchical editor for the `enabled_types` admin setting. Renders a
 * grouped checkbox tree:
 *
 *   Integrations
 *     - Frigate (controls all Frigate-tagged types as a bundle)
 *   Connections
 *     - mqtt, db.postgres, frigate, ...
 *   Charts
 *     - bar, line, pie, ...
 *   Controls
 *     - Carbon: button, toggle, slider, ...
 *     - Custom: switch, dimmer, garage_door
 *     - Tile: tile_switch, tile_dimmer, ...
 *   Displays
 *     - frigate_camera, frigate_alerts, weather, ...
 *
 * Semantics: when an integration is unchecked, its member checkboxes go
 * disabled (greyed) and are non-interactive. The disabled members keep
 * their previous checked state in local memory so re-enabling the
 * integration restores the admin's last selection.
 *
 * Default = everything checked. Storage on disk is an allowlist; admin
 * unchecks remove items from the per-category arrays.
 */
function EnabledTypesEditorModal({ open, onClose, onSaved }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [universe, setUniverse] = useState(null); // { integrations, connections, charts, controls, displays }
  const [enabled, setEnabled] = useState({
    integrations: new Set(),
    connections: new Set(),
    charts: new Set(),
    controls: new Set(),
    displays: new Set()
  });

  // Load the unfiltered registry plus the current admin selection.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiClient.getRegistryCatalog({ includeDisabled: true }),
      apiClient.getRegistryIntegrations({ includeDisabled: true }),
      apiClient.getSetting('enabled_types').catch(() => ({ value: {} }))
    ])
      .then(([catalog, integrations, settingResp]) => {
        if (cancelled) return;
        const fullCatalog = catalog || {};
        setUniverse({
          integrations: integrations?.integrations || fullCatalog.integrations || [],
          connections: fullCatalog.connection_types || [],
          charts: fullCatalog.chart_types || [],
          controls: fullCatalog.control_types || [],
          displays: fullCatalog.display_types || []
        });
        // The settings API decodes the Mongo BSON document shape, which Go's
        // mongo driver returns as primitive.D — that JSON-marshals to a list
        // of {Key, Value} pairs rather than a plain object. Normalize either
        // shape here so the checkboxes initialize correctly.
        const value = normalizeBsonValue(settingResp?.value);
        setEnabled({
          integrations: toSet(value.integrations),
          connections:  toSet(value.connections),
          charts:       toSet(value.charts),
          controls:     toSet(value.controls),
          displays:     toSet(value.displays)
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  // Group controls by their UI category so the tree shows Carbon / Custom /
  // Tile sub-sections. Hidden control types (legacy aliases) are dropped.
  const controlGroups = useMemo(() => {
    if (!universe) return [];
    const byCategory = new Map();
    universe.controls.forEach((c) => {
      if (c.hidden) return;
      const key = c.ui_category || 'other';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(c);
    });
    const labels = { carbon: 'Carbon Controls', custom: 'Custom Controls', tile: 'Tiles', decorative: 'Decorative', other: 'Other' };
    const order = ['carbon', 'custom', 'tile', 'decorative', 'other'];
    return order
      .filter((k) => byCategory.has(k))
      .map((k) => ({ id: k, label: labels[k] || k, items: byCategory.get(k) }));
  }, [universe]);

  const toggle = (category, id) => {
    setEnabled((prev) => {
      const next = { ...prev };
      const set = new Set(prev[category]);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      next[category] = set;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.updateSetting('enabled_types', {
        integrations: Array.from(enabled.integrations).sort(),
        connections:  Array.from(enabled.connections).sort(),
        charts:       Array.from(enabled.charts).sort(),
        controls:     Array.from(enabled.controls).sort(),
        displays:     Array.from(enabled.displays).sort()
      });
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const renderRow = (category, id, label, description, integration) => {
    const locked = integration && !enabled.integrations.has(integration);
    const checked = enabled[category].has(id);
    return (
      <div className={`enabled-types-row${locked ? ' is-locked' : ''}`} key={`${category}.${id}`}>
        <Checkbox
          id={`enabled-${category}-${id}`}
          labelText={
            <span className="enabled-types-row-label">
              <span className="enabled-types-row-name">{label}</span>
              <code className="enabled-types-row-id">{id}</code>
              {integration && (
                <Tag type="cool-gray" size="sm" className="enabled-types-integration-tag">
                  {integration}
                </Tag>
              )}
              {description && <span className="enabled-types-row-desc">{description}</span>}
            </span>
          }
          checked={!locked && checked}
          disabled={locked}
          onChange={() => toggle(category, id)}
        />
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      onRequestSubmit={handleSave}
      modalHeading="Type Availability"
      modalLabel="Settings"
      primaryButtonText={saving ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving || loading}
      size="lg"
    >
      <p className="enabled-types-intro">
        Choose which connections, displays, controls, charts, and integrations are available
        for new components and AI suggestions in this deployment. Existing dashboards keep
        rendering even when their type is unchecked here — disabling only hides items from
        creation pickers, the AI agent, and the MCP catalog.
      </p>

      {loading && <Loading description="Loading registry…" withOverlay={false} />}

      {error && (
        <InlineNotification kind="error" title="Failed to load type catalog" subtitle={error} hideCloseButton lowContrast />
      )}

      {!loading && universe && (
        <div className="enabled-types-tree">
          <section className="enabled-types-section">
            <h4>Integrations</h4>
            <p className="section-hint">
              Disabling an integration also disables its member types (greyed below).
              Enabling restores them with their previous checked state.
            </p>
            {universe.integrations.length === 0 && <em>No integrations registered.</em>}
            {universe.integrations.map((info) =>
              renderRow('integrations', info.id, info.display_name || info.id, info.description, null)
            )}
          </section>

          <section className="enabled-types-section">
            <h4>Connections</h4>
            {universe.connections.length === 0 && <em>No connection types registered.</em>}
            {universe.connections.map((t) =>
              renderRow('connections', t.type_id, t.display_name || t.type_id, '', t.integration)
            )}
          </section>

          <section className="enabled-types-section">
            <h4>Displays</h4>
            {universe.displays.length === 0 && <em>No display types registered.</em>}
            {universe.displays.filter((t) => !t.hidden).map((t) =>
              renderRow('displays', t.subtype, t.display_name, t.description, t.integration)
            )}
          </section>

          <section className="enabled-types-section">
            <h4>Controls</h4>
            {controlGroups.map((group) => (
              <div className="enabled-types-subgroup" key={group.id}>
                <h5>{group.label}</h5>
                {group.items.map((t) =>
                  renderRow('controls', t.subtype, t.display_name, t.description, t.integration)
                )}
              </div>
            ))}
          </section>

          <section className="enabled-types-section">
            <h4>Charts</h4>
            {universe.charts.filter((t) => !t.hidden).map((t) =>
              renderRow('charts', t.subtype, t.display_name, t.description, t.integration)
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function toSet(arr) {
  if (!Array.isArray(arr)) return new Set();
  return new Set(arr.filter((x) => typeof x === 'string'));
}

// normalizeBsonValue accepts either a plain object or the Mongo BSON
// "ordered document" shape — `[{Key, Value}, ...]` — that the Go driver
// produces when decoding into `interface{}`. Returns a plain object.
function normalizeBsonValue(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    const out = {};
    value.forEach((entry) => {
      if (entry && typeof entry === 'object' && 'Key' in entry) {
        out[entry.Key] = entry.Value;
      }
    });
    return out;
  }
  if (typeof value === 'object') return value;
  return {};
}

export default EnabledTypesEditorModal;
