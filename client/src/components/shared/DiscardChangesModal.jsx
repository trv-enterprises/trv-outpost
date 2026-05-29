// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Modal } from '@carbon/react';

/**
 * Shared "Discard Changes?" confirmation dialog.
 *
 * Before this existed, the same Carbon <Modal> was hand-rolled in 5+
 * places (DashboardViewerPage, ComponentEditorModal, AIBuilderPage,
 * ConnectionDetailPage, UserDetailPage, ComponentDetailPage) with
 * drifting headings, body copy, sizes, and close behavior. One source of
 * truth keeps the styling — Keep Editing (secondary) + Discard (danger),
 * close === keep editing — consistent everywhere, and lets width / copy
 * tweaks propagate in one edit.
 *
 * Width: size="sm" — the per-page copies that already used sm are kept;
 * the ones that sprawled (md/lg, or the default) are pulled down to sm so
 * the dialog doesn't stretch across a large monitor.
 *
 * @param {boolean}  open          Whether the modal is shown.
 * @param {Function} onKeepEditing Called for Keep Editing, the × close,
 *                                 and backdrop/Esc dismissal — i.e. any
 *                                 "don't discard" exit.
 * @param {Function} onDiscard     Called when the user confirms Discard.
 * @param {string}   [heading]     Modal heading. Defaults to "Discard Changes?".
 * @param {string}   [body]        Body copy. Defaults to a generic
 *                                 unsaved-changes prompt.
 */
export default function DiscardChangesModal({
  open,
  onKeepEditing,
  onDiscard,
  heading = 'Discard Changes?',
  body = 'You have unsaved changes. Are you sure you want to discard them?',
}) {
  if (!open) return null;
  return (
    <Modal
      open
      danger
      size="sm"
      modalHeading={heading}
      primaryButtonText="Discard"
      secondaryButtonText="Keep Editing"
      onRequestSubmit={onDiscard}
      onRequestClose={onKeepEditing}
      onSecondarySubmit={onKeepEditing}
    >
      <p>{body}</p>
    </Modal>
  );
}
