// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef } from 'react';
import { Modal } from '@carbon/react';
import ComponentEditor from './ComponentEditor';
import apiClient from '../api/client';
import { invalidateTagsCache } from './shared/tagsApi';
import { clearDataviewLayoutForCurrentUser } from '../hooks/useDataviewLayout';
import DiscardChangesModal from './shared/DiscardChangesModal';
import SharedComponentWarningModal from './shared/SharedComponentWarningModal';
import useSharedComponentWarning from '../hooks/useSharedComponentWarning';
import './ComponentEditorModal.scss';

/**
 * ComponentEditorModal Component
 *
 * Modal wrapper for ComponentEditor component.
 * Used in dashboard editing to create/edit charts inline.
 */
function ComponentEditorModal({ open, onClose, onSave, chart, panelId, dashboardId }) {
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

  // Editing from a dashboard is where the shared-component trap bites hardest:
  // the user is looking at ONE dashboard, so it's easy to miss that the save
  // lands on every other dashboard using this component. Gate the write behind
  // a confirmation naming them (the current dashboard is excluded from the
  // "others" test — see useSharedComponentWarning).
  const { guardSave, modalProps: sharedWarningProps } = useSharedComponentWarning({
    currentDashboardId: dashboardId,
  });

  const handleSave = (chartPayload) =>
    guardSave(chart?.id, chartPayload?.name || chart?.name, () => doSave(chartPayload));

  const doSave = async (chartPayload) => {
    setSaving(true);
    try {
      let savedChart;
      if (chart?.id) {
        // Update existing chart
        savedChart = await apiClient.updateComponent(chart.id, chartPayload);
        // Drop the author's OWN per-user column widths for this component:
        // they just re-specified the layout, so a width they dragged while
        // viewing it earlier must not sit on top of what they saved. Same
        // reasoning as ComponentDetailPage.confirmSave.
        await clearDataviewLayoutForCurrentUser(chart.id);
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
    if (isDirty) {
      setShowCancelConfirm(true);
      return;
    }
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
        // ComponentEditor portals several nested modals to <body> (connection
        // picker, chart-type picker, value pickers). Each is a Carbon Modal
        // (.cds--modal). This outer modal's focus trap (wrapFocus) treats any
        // node outside its own body as "outside" and yanks focus back — so the
        // nested modals' inputs (e.g. the connection picker search) couldn't
        // take keystrokes. Listing .cds--modal as a floating-menu selector
        // tells wrapFocus to leave focus alone when it lands in a nested modal.
        selectorsFloatingMenus={['.cds--modal']}
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
      <DiscardChangesModal
        open={showCancelConfirm}
        onKeepEditing={() => setShowCancelConfirm(false)}
        onDiscard={() => {
          setShowCancelConfirm(false);
          onClose();
        }}
        body="You have unsaved changes to this chart. Are you sure you want to discard them?"
      />

      {/* Shared-component save confirmation */}
      <SharedComponentWarningModal {...sharedWarningProps} />
    </>
  );
}

export default ComponentEditorModal;
