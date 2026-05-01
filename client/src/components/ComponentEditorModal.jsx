// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef } from 'react';
import { Modal } from '@carbon/react';
import ComponentEditor from './ComponentEditor';
import apiClient from '../api/client';
import { invalidateTagsCache } from './shared/tagsApi';
import './ComponentEditorModal.scss';

/**
 * ComponentEditorModal Component
 *
 * Modal wrapper for ComponentEditor component.
 * Used in dashboard editing to create/edit charts inline.
 */
function ComponentEditorModal({ open, onClose, onSave, chart, panelId }) {
  const [saving, setSaving] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [isValid, setIsValid] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const editorRef = useRef(null);

  // Reset state when modal opens — increment key to force ComponentEditor remount
  useEffect(() => {
    if (open) {
      setSaving(false);
      setShowCancelConfirm(false);
      setIsValid(!!chart?.name);
      setIsDirty(false);
      setEditorKey(k => k + 1);
    }
  }, [open, chart]);

  const handleSave = async (chartPayload) => {
    setSaving(true);
    try {
      let savedChart;
      if (chart?.id) {
        // Update existing chart
        savedChart = await apiClient.updateComponent(chart.id, chartPayload);
      } else {
        // Create new chart
        savedChart = await apiClient.createComponent(chartPayload);
      }

      // Drop the shared tag cache so the next TagInput/TagFilter mount
      // sees any newly-added tags.
      invalidateTagsCache();

      // Return the saved chart with panel_id for dashboard to link
      await onSave({
        ...savedChart,
        panel_id: panelId,
      });
      onClose();
    } catch (err) {
      alert(`Error saving chart: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  const handleSubmit = () => {
    if (editorRef.current) {
      editorRef.current.save();
    }
  };

  return (
    <>
      <Modal
        open={open}
        onRequestClose={handleClose}
        onRequestSubmit={handleSubmit}
        modalHeading={chart ? `Edit Chart: ${chart.name || 'Untitled'}` : 'Create New Chart'}
        modalLabel="Chart Editor"
        primaryButtonText={saving ? 'Saving...' : 'Save'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={saving || !isValid || !isDirty}
        size="lg"
        className="component-editor-modal"
        preventCloseOnClickOutside
        isFullWidth
      >
        <div className="component-editor-content">
          <ComponentEditor
            key={editorKey}
            ref={editorRef}
            chart={chart}
            onSave={handleSave}
            onCancel={handleClose}
            saving={saving}
            showActions={false}
            onValidityChange={setIsValid}
            onDirtyChange={setIsDirty}
          />
        </div>
      </Modal>

      {/* Cancel confirmation modal */}
      <Modal
        open={showCancelConfirm}
        onRequestClose={() => setShowCancelConfirm(false)}
        onRequestSubmit={() => {
          setShowCancelConfirm(false);
          onClose();
        }}
        modalHeading="Discard Changes?"
        modalLabel="Unsaved Changes"
        primaryButtonText="Discard"
        secondaryButtonText="Keep Editing"
        danger
        size="xs"
      >
        <p style={{ color: 'var(--cds-text-secondary)' }}>
          You have unsaved changes to this chart. Are you sure you want to discard them?
        </p>
      </Modal>
    </>
  );
}

export default ComponentEditorModal;
