// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { Modal, Checkbox, InlineLoading, InlineNotification } from '@carbon/react';
import apiClient from '../api/client';

/**
 * DashboardDeleteModal — danger-confirm for deleting a dashboard, with an
 * optional cascade for components that would be ORPHANED (referenced by no
 * other dashboard once this one is gone). On open it preflights
 * /delete-preview; if any components would be orphaned it offers a checkbox
 * list (default UNCHECKED, plus a select-all) so the user can also delete the
 * ones they don't want left behind. The server re-validates each chosen id as
 * actually orphaned before deleting, so the checkbox set is advisory, not
 * trusted blindly.
 *
 * Props:
 *   dashboard — { id, name } being deleted (null = closed)
 *   onClose   — () => void
 *   onDeleted — () => void  (called after a successful delete; refresh the list)
 */
export default function DashboardDeleteModal({ dashboard, onClose, onDeleted }) {
  const open = dashboard !== null;
  const [orphans, setOrphans] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  // Preflight the orphan list each time the modal opens for a dashboard.
  useEffect(() => {
    if (!dashboard) return;
    let cancelled = false;
    setOrphans([]);
    setSelected(new Set());
    setError(null);
    setLoadingPreview(true);
    apiClient
      .getDashboardDeletePreview(dashboard.id)
      .then((res) => {
        if (cancelled) return;
        setOrphans(res?.orphaned_components || []);
      })
      .catch((err) => {
        if (cancelled) return;
        // Preview failure shouldn't block deleting the dashboard itself —
        // surface it but still allow the plain delete.
        setError(`Couldn't check for orphaned components: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dashboard]);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = orphans.length > 0 && selected.size === orphans.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(orphans.map((o) => o.id)));
  };

  const handleDelete = async () => {
    if (!dashboard) return;
    setDeleting(true);
    setError(null);
    try {
      await apiClient.deleteDashboard(dashboard.id, Array.from(selected));
      onDeleted?.();
      onClose?.();
    } catch (err) {
      setError(`Failed to delete: ${err.message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={open}
      danger
      modalHeading="Delete dashboard"
      primaryButtonText={
        deleting
          ? 'Deleting…'
          : selected.size > 0
            ? `Delete dashboard + ${selected.size} component${selected.size === 1 ? '' : 's'}`
            : 'Delete dashboard'
      }
      secondaryButtonText="Cancel"
      primaryButtonDisabled={deleting || loadingPreview}
      onRequestSubmit={handleDelete}
      onRequestClose={onClose}
      size="sm"
    >
      <p>
        Are you sure you want to delete <strong>{dashboard?.name}</strong>? This cannot
        be undone.
      </p>

      {loadingPreview && (
        <InlineLoading description="Checking for orphaned components…" />
      )}

      {!loadingPreview && orphans.length > 0 && (
        <div className="dashboard-delete-orphans" style={{ marginTop: '1rem' }}>
          <p style={{ marginBottom: '0.5rem' }}>
            These component{orphans.length === 1 ? '' : 's'} are used only by this
            dashboard and would be left orphaned. Select any you also want to delete:
          </p>
          <Checkbox
            id="orphan-select-all"
            labelText={allSelected ? 'Deselect all' : 'Select all'}
            checked={allSelected}
            indeterminate={selected.size > 0 && !allSelected}
            onChange={toggleAll}
          />
          <div style={{ marginTop: '0.25rem', paddingLeft: '0.5rem' }}>
            {orphans.map((o) => (
              <Checkbox
                key={o.id}
                id={`orphan-${o.id}`}
                labelText={o.name}
                checked={selected.has(o.id)}
                onChange={() => toggle(o.id)}
              />
            ))}
          </div>
        </div>
      )}

      {error && (
        <InlineNotification
          kind="error"
          title="Error"
          subtitle={error}
          lowContrast
          hideCloseButton
          style={{ marginTop: '1rem' }}
        />
      )}
    </Modal>
  );
}
