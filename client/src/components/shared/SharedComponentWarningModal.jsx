// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Modal, UnorderedList, ListItem } from '@carbon/react';

/**
 * Shared "this component is on other dashboards" save confirmation.
 *
 * Components are shared entities: saving an edit updates the component
 * everywhere it is placed. That is usually what the author wants — but when
 * the edit is made from ONE dashboard's editor it is easy to forget the change
 * lands on the others too. This dialog is the last stop before the write,
 * naming the dashboards that will change.
 *
 * It is deliberately NOT `danger`: saving a shared component is a normal,
 * reversible action, not a destructive one. The dialog informs; it doesn't
 * scold. Primary is "Save Changes" so the common case stays one click.
 *
 * Only shown when the component is on MORE THAN the dashboard being edited —
 * see useSharedComponentWarning, which owns that decision so every save path
 * agrees on it.
 *
 * @param {boolean}  open          Whether the modal is shown.
 * @param {Function} onCancel      Called for Cancel, the × close, and Esc.
 * @param {Function} onConfirm     Called when the user confirms the save.
 * @param {string}   componentName Name of the component being saved.
 * @param {Array}    dashboards    [{id,name}] or [{unauthorized:true}] refs
 *                                 that reference this component.
 * @param {string}   [currentDashboardId] The dashboard being edited, if any —
 *                                 it is listed last as "(this dashboard)".
 */
export default function SharedComponentWarningModal({
  open,
  onCancel,
  onConfirm,
  componentName,
  dashboards = [],
  currentDashboardId,
}) {
  if (!open) return null;

  const others = dashboards.filter((d) => !d.unauthorized && d.id !== currentDashboardId);
  const hiddenCount = dashboards.filter((d) => d.unauthorized).length;
  const onCurrent = currentDashboardId
    ? dashboards.some((d) => d.id === currentDashboardId)
    : false;
  // The count the user cares about is "how many dashboards change", which
  // includes the one in front of them and any they can't see.
  const totalCount = others.length + hiddenCount + (onCurrent ? 1 : 0);

  return (
    <Modal
      open
      size="sm"
      modalHeading="Save shared component?"
      primaryButtonText="Save Changes"
      secondaryButtonText="Cancel"
      onRequestSubmit={onConfirm}
      onRequestClose={onCancel}
      onSecondarySubmit={onCancel}
    >
      <p>
        <strong>{componentName || 'This component'}</strong> is used on{' '}
        {totalCount} dashboard{totalCount === 1 ? '' : 's'}. Saving updates it
        everywhere — not just here.
      </p>
      <UnorderedList style={{ margin: '0.75rem 0 0 1rem' }}>
        {others.map((d) => (
          <ListItem key={d.id}>{d.name}</ListItem>
        ))}
        {hiddenCount > 0 && (
          <ListItem key="hidden">
            {hiddenCount} dashboard{hiddenCount === 1 ? '' : 's'} in a namespace you
            can&apos;t view
          </ListItem>
        )}
        {onCurrent && <ListItem key="current">This dashboard</ListItem>}
      </UnorderedList>
      <p style={{ marginTop: '0.75rem' }}>
        To change it here only, cancel and duplicate the component instead.
      </p>
    </Modal>
  );
}
