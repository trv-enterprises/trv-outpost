// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { Modal, Checkbox, InlineLoading } from '@carbon/react';

/**
 * Panel delete confirmation, with an opt-in to also delete the panel's
 * component when removing the panel would orphan it.
 *
 * Deleting a panel is cheap and reversible (cancel the dashboard edit and it
 * comes back). Deleting a COMPONENT is a separate record disappearing from the
 * library, so the checkbox defaults to OFF: the user has to ask for the
 * destructive half deliberately.
 *
 * The component delete is DEFERRED to the dashboard save. It cannot run at
 * confirm time — the panel removal is local until then, so the server still
 * sees this dashboard referencing the component and refuses (#301). The upside
 * is that cancelling the edit now backs out both halves together.
 *
 * The dialog only appears when there is something to decide. A panel with no
 * component, or one whose component is still used elsewhere, deletes straight
 * away — see the caller in DashboardViewerPage.
 *
 * @param {boolean}  open
 * @param {Function} onCancel        Cancel / × / Esc — deletes nothing.
 * @param {Function} onConfirm       Called with `true` when the user also
 *                                   opted to delete the component.
 * @param {string}   componentName   Name of the would-be-orphaned component.
 * @param {boolean}  [checking]      Usage lookup still in flight.
 */
export default function PanelDeleteModal({
  open,
  onCancel,
  onConfirm,
  componentName,
  checking = false,
}) {
  const [alsoDelete, setAlsoDelete] = useState(false);

  // Reset the opt-in every time the dialog opens — a checkbox that remembers
  // "yes, delete it" across panels is exactly how someone loses a component
  // they meant to keep.
  useEffect(() => {
    if (open) setAlsoDelete(false);
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      open
      danger
      size="sm"
      modalHeading="Delete panel?"
      primaryButtonText={alsoDelete ? 'Delete panel and component' : 'Delete panel'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={checking}
      onRequestSubmit={() => onConfirm(alsoDelete)}
      onRequestClose={onCancel}
      onSecondarySubmit={onCancel}
    >
      {checking ? (
        <InlineLoading description="Checking where this component is used…" />
      ) : (
        <>
          <p>
            Removing this panel leaves <strong>{componentName}</strong> unused — no
            other panel or dashboard references it.
          </p>
          <Checkbox
            id="panel-delete-also-component"
            className="panel-delete-also-component"
            labelText={`Also delete the component "${componentName}"`}
            checked={alsoDelete}
            onChange={(_e, { checked }) => setAlsoDelete(checked)}
            style={{ marginTop: '1rem' }}
          />
          <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--cds-text-secondary)' }}>
            {alsoDelete
              ? 'The component is deleted from the library when you save the dashboard. Cancelling the edit keeps both the panel and the component.'
              : 'The component stays in the library and can be placed on a panel again later.'}
          </p>
        </>
      )}
    </Modal>
  );
}
