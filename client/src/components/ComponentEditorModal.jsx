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

  // Pin the modal-body scroll position around focus events. Without
  // this, the browser's implicit focus-scroll re-centers the focused
  // element inside the scrollable .cds--modal-content, moving the
  // user's click target out from under their cursor — so the *first*
  // click only focuses and the *second* click is what actually fires
  // onClick. The pin captures scrollTop at focusin and then watches
  // for any scroll events for ~150ms; any movement during that window
  // is treated as the implicit focus-scroll and reverted. Explicit
  // scrollIntoView() callers (e.g. validation-error scroll) usually
  // run synchronously inside event handlers BEFORE focusin fires, so
  // they're captured as the new "before" value and respected.
  useEffect(() => {
    if (!open) return;
    const setup = () => {
      const sc = document.querySelector('.component-editor-modal .cds--modal-content');
      if (!sc) return null;
      let lockUntil = 0;
      let lockedTop = 0;
      const onFocusIn = () => {
        lockedTop = sc.scrollTop;
        lockUntil = performance.now() + 150;
      };
      const onScroll = () => {
        if (performance.now() < lockUntil && sc.scrollTop !== lockedTop) {
          sc.scrollTop = lockedTop;
        }
      };
      sc.addEventListener('focusin', onFocusIn);
      sc.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        sc.removeEventListener('focusin', onFocusIn);
        sc.removeEventListener('scroll', onScroll);
      };
    };
    let cleanup = setup();
    if (!cleanup) {
      const t = setTimeout(() => { cleanup = setup(); }, 50);
      return () => { clearTimeout(t); if (cleanup) cleanup(); };
    }
    return cleanup;
  }, [open]);

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
