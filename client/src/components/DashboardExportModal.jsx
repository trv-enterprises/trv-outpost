// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Modal, Loading, InlineNotification } from '@carbon/react';
import apiClient from '../api/client';
import { triggerDownload, filenameSlug } from '../utils/downloadFile';

/**
 * DashboardExportModal
 *
 * Single modal used for both the bulk-export flow (Dashboards list) and
 * the single-dashboard flow (Dashboard viewer header). Takes a flat
 * list of dashboard IDs to export and handles the full flow:
 *
 *   1. On open, call /api/dashboards/export/preview to fetch counts +
 *      any warnings (e.g., missing chart versions) so the user knows
 *      what's about to download.
 *   2. If multiple namespaces are in play, block via an inline warning
 *      — the plan requires exports to be scoped to a single namespace
 *      so there's no ambiguity on import. User cancels and narrows
 *      their selection.
 *   3. On confirm, call /api/dashboards/export to get the full bundle
 *      and trigger a file download named after the source namespace
 *      and timestamp.
 *
 * Props:
 *   open            — boolean, open state.
 *   onClose         — callback.
 *   dashboardIds    — array of string IDs to export.
 *   dashboards      — optional array of dashboard records (used to
 *                     detect within-selection name collisions before
 *                     we even hit the server).
 */
export default function DashboardExportModal({ open, onClose, dashboardIds, dashboards = [] }) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);

  // Name-collision guard inside the selected set. If two selected
  // dashboards share a name (probably in different namespaces), import
  // can only land them in one namespace and would fail the second
  // insert on the compound unique index. Warn at the source.
  const nameCollisions = useMemo(() => {
    if (!dashboards || dashboards.length === 0) return [];
    const selected = dashboards.filter((d) => dashboardIds.includes(d.id));
    const byName = {};
    selected.forEach((d) => {
      if (!byName[d.name]) byName[d.name] = [];
      byName[d.name].push(d);
    });
    return Object.entries(byName)
      .filter(([, group]) => group.length > 1)
      .map(([name, group]) => ({
        name,
        namespaces: group.map((d) => d.namespace || 'default'),
      }));
  }, [dashboards, dashboardIds]);

  useEffect(() => {
    if (!open || !dashboardIds || dashboardIds.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    apiClient
      .previewExportDashboards(dashboardIds)
      .then((data) => { if (!cancelled) setPreview(data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Preview failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, dashboardIds]);

  const download = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const bundle = await apiClient.exportDashboards(dashboardIds);
      const slug = filenameSlug(bundle.source_namespace || 'dashboard_export');
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .slice(0, 15); // YYYYMMDDTHHMMSS
      triggerDownload(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
        `${slug}-${stamp}.json`
      );
      onClose();
    } catch (err) {
      setError(err.message || 'Export failed');
    } finally {
      setLoading(false);
    }
  }, [dashboardIds, onClose]);

  // Preflight errors or in-selection collisions block the download.
  const blocked = !!error || nameCollisions.length > 0;

  return (
    <Modal
      open={open}
      modalHeading="Export dashboards"
      primaryButtonText="Download"
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={download}
      primaryButtonDisabled={loading || blocked || !preview}
      size="sm"
    >
      {loading && <Loading description="Checking…" small withOverlay={false} />}
      {error && (
        <InlineNotification kind="error" title="Export failed" subtitle={error} lowContrast hideCloseButton />
      )}
      {nameCollisions.length > 0 && (
        <InlineNotification
          kind="warning"
          title="Name collisions in selection"
          subtitle={
            `Selected dashboards share the name "${nameCollisions[0].name}" across namespaces `
            + `(${nameCollisions[0].namespaces.join(', ')}). `
            + 'Rename one before exporting — a bundle can only be imported into a single namespace.'
          }
          lowContrast
          hideCloseButton
        />
      )}
      {preview && !blocked && (
        <div>
          <p style={{ marginBottom: '0.75rem' }}>
            Exporting <strong>{preview.dashboard_count}</strong> dashboard{preview.dashboard_count === 1 ? '' : 's'}
            {' '}with <strong>{preview.component_count}</strong> component{preview.component_count === 1 ? '' : 's'}
            {' '}and <strong>{preview.connection_count}</strong> connection{preview.connection_count === 1 ? '' : 's'}.
          </p>
          {preview.source_namespace && (
            <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)' }}>
              Source namespace: <code>{preview.source_namespace}</code>
            </p>
          )}
          {Array.isArray(preview.warnings) && preview.warnings.length > 0 && (
            <InlineNotification
              kind="info"
              title="Warnings"
              subtitle={preview.warnings.join(' · ')}
              lowContrast
              hideCloseButton
              style={{ marginTop: '0.75rem' }}
            />
          )}
        </div>
      )}
    </Modal>
  );
}
