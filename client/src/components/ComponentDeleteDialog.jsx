// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import { Modal, RadioButton, RadioButtonGroup, Loading } from '@carbon/react';
import apiClient from '../api/client';
import './ComponentDeleteDialog.scss';

/**
 * ComponentDeleteDialog Component
 *
 * Version-aware delete dialog for charts with three variants:
 * 1. Draft: Simple discard confirmation
 * 2. Final with previous versions: Choice dialog (delete this version or all)
 * 3. Final single version: Simple permanent delete confirmation
 */
function ComponentDeleteDialog({ open, chart, onClose, onDelete }) {
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [versionInfo, setVersionInfo] = useState(null);
  const [deleteOption, setDeleteOption] = useState('version'); // 'version' or 'all'
  const [error, setError] = useState(null);

  const fetchVersionInfo = useCallback(async () => {
    if (!chart?.id) return;
    setLoading(true);
    setError(null);
    try {
      const info = await apiClient.getComponentVersionInfo(chart.id);
      setVersionInfo(info);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [chart?.id]);

  // Fetch version info when dialog opens
  useEffect(() => {
    if (open && chart?.id) {
      fetchVersionInfo();
    } else {
      // Reset state when closed
      setVersionInfo(null);
      setDeleteOption('version');
      setError(null);
    }
  }, [open, chart?.id, fetchVersionInfo]);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const isDraft = versionInfo?.status === 'draft';
      const hasMultipleVersions = versionInfo?.version_count > 1;

      if (isDraft) {
        // Delete draft
        await apiClient.deleteComponentDraft(chart.id);
      } else if (deleteOption === 'all' || !hasMultipleVersions) {
        // Delete all versions (or the only version)
        await apiClient.deleteComponent(chart.id);
      } else {
        // Delete specific version
        await apiClient.deleteComponentVersion(chart.id, versionInfo.version);
      }

      onDelete();
      onClose();
    } catch (err) {
      // 409 means dashboards still reference this component. Build a
      // useful message naming the dashboards so the user knows where
      // to remove the component before retrying.
      if (err.status === 409 && err.body?.usage?.dashboards?.length) {
        const dashes = err.body.usage.dashboards.map(d => d.name).filter(Boolean);
        const list = dashes.slice(0, 5).join(', ') + (dashes.length > 5 ? `, +${dashes.length - 5} more` : '');
        setError(`Cannot delete: still used by ${dashes.length} dashboard${dashes.length === 1 ? '' : 's'} (${list}). Remove the panel reference${dashes.length === 1 ? '' : 's'} first.`);
      } else {
        setError(err.message);
      }
    } finally {
      setDeleting(false);
    }
  };

  // Determine dialog type
  const isDraft = versionInfo?.status === 'draft';
  const hasMultipleVersions = versionInfo?.version_count > 1;
  // For drafts, previous version is version - 1 (if > 0)
  // For final versions, previous version is version - 1 (if > 1)
  const previousVersion = isDraft
    ? (versionInfo?.version > 0 ? versionInfo.version - 1 : 0)
    : (versionInfo?.version > 1 ? versionInfo.version - 1 : 0);
  const hasPreviousVersion = previousVersion > 0;

  // Dialog content based on type
  const getDialogContent = () => {
    if (loading) {
      return (
        <div className="delete-dialog-loading">
          <Loading description="Loading version info..." withOverlay={false} small />
        </div>
      );
    }

    if (error && !versionInfo) {
      return (
        <div className="delete-dialog-error">
          <p>Error loading chart info: {error}</p>
        </div>
      );
    }

    if (isDraft && hasPreviousVersion) {
      // Draft with previous version - discard dialog
      return (
        <div className="delete-dialog-content">
          <p>
            This will discard your draft changes to <strong>"{chart?.name}"</strong> and
            revert to the previous saved version (v{previousVersion}).
          </p>
        </div>
      );
    }

    if (isDraft && !hasPreviousVersion) {
      // Draft without previous version (new chart) - delete dialog
      return (
        <div className="delete-dialog-content">
          <p>
            This will permanently delete <strong>"{chart?.name}"</strong>.
            This action cannot be undone.
          </p>
        </div>
      );
    }

    if (!isDraft && hasMultipleVersions) {
      // Final with multiple versions - choice dialog
      return (
        <div className="delete-dialog-content">
          <RadioButtonGroup
            legendText=""
            name="delete-option"
            valueSelected={deleteOption}
            onChange={setDeleteOption}
            orientation="vertical"
          >
            <RadioButton
              id="delete-version"
              labelText={
                <span className="radio-label">
                  <strong>Delete this version only (v{versionInfo.version})</strong>
                  <span className="radio-description">
                    Reverts to previous version (v{previousVersion})
                  </span>
                </span>
              }
              value="version"
            />
            <RadioButton
              id="delete-all"
              labelText={
                <span className="radio-label">
                  <strong>Delete all versions</strong>
                  <span className="radio-description">
                    Permanently removes this chart ({versionInfo.version_count} versions)
                  </span>
                </span>
              }
              value="all"
            />
          </RadioButtonGroup>
        </div>
      );
    }

    // Final single version - simple delete
    return (
      <div className="delete-dialog-content">
        <p>
          This will permanently delete <strong>"{chart?.name}"</strong>.
          This action cannot be undone.
        </p>
      </div>
    );
  };

  const getHeading = () => {
    if (isDraft && hasPreviousVersion) {
      return `Discard draft and restore v${previousVersion}?`;
    }
    return `Delete "${chart?.name || 'Chart'}"`;
  };

  const getPrimaryButtonText = () => {
    if (deleting) return 'Deleting...';
    if (isDraft && hasPreviousVersion) return 'Discard';
    return 'Delete';
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      onRequestSubmit={handleDelete}
      modalHeading={getHeading()}
      primaryButtonText={getPrimaryButtonText()}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={loading || deleting}
      danger={!isDraft || !hasPreviousVersion}
      size="sm"
      className="component-delete-dialog"
    >
      {getDialogContent()}
      {error && versionInfo && (
        <div className="delete-dialog-error">
          <p>Error: {error}</p>
        </div>
      )}
    </Modal>
  );
}

export default ComponentDeleteDialog;
