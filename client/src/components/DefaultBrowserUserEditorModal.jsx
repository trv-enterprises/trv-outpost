// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { Modal, Select, SelectItem, TextInput, InlineNotification } from '@carbon/react';
import apiClient from '../api/client';

/**
 * Admin setting — the user GUID assigned to a browser-mode visitor
 * who hasn't been given an identity by any other means (no
 * `?user_id=` URL, no localStorage value).
 *
 * This is identity assertion, NOT authentication: anyone hitting
 * the bare deployment URL becomes this user. Use only for
 * single-user deployments or when there's a separate access-control
 * layer (VPN, reverse-proxy auth) in front of the dashboard.
 *
 * Empty string means "no default" — the app shows a "Sign-in not
 * configured" stub instead of loading.
 */
function DefaultBrowserUserEditorModal({ open, onClose, currentValue, onSave }) {
  const [selected, setSelected] = useState('');
  const [users, setUsers] = useState([]);
  const [usersLoaded, setUsersLoaded] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(currentValue || '');
    apiClient.getUsers()
      .then((data) => {
        setUsers(data?.users || []);
        setUsersLoaded(true);
      })
      .catch(() => setUsersLoaded(true));
  }, [open, currentValue]);

  const matchedUser = users.find((u) => u.guid === selected);
  // The picker offers known users by name. If selected is a GUID
  // that doesn't match any known user, the text fallback below
  // accepts free-form values.
  const showCustomInput = selected && !matchedUser;

  const handlePickerChange = (e) => {
    const v = e.target.value;
    if (v === '__custom__') {
      // Switching to custom — don't clobber any existing GUID
      setSelected(selected || '');
    } else {
      setSelected(v);
    }
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Default browser user"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={() => onSave(selected.trim())}
      size="sm"
    >
      <div style={{ padding: '0 0 1rem' }}>
        <p style={{ color: 'var(--cds-text-secondary)', marginBottom: '1rem' }}>
          User GUID assumed for browser-mode visitors who haven't been
          assigned an identity by URL parameter or prior session.
          Empty means no default — visitors see a "Sign-in not
          configured" stub.
        </p>

        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Identity assertion, not authentication"
          subtitle="Anyone hitting the bare deployment URL becomes this user. Use only for single-user deployments or when there's a separate access control layer (VPN, reverse proxy) in front of the dashboard."
          style={{ marginBottom: '1rem', maxWidth: '100%' }}
        />

        <Select
          id="default-browser-user-picker"
          labelText="Pick from existing users"
          value={matchedUser ? selected : (selected ? '__custom__' : '')}
          onChange={handlePickerChange}
          disabled={!usersLoaded}
          helperText={usersLoaded ? '' : 'Loading users...'}
        >
          <SelectItem value="" text="(none — show sign-in stub)" />
          {users.map((u) => (
            <SelectItem
              key={u.guid}
              value={u.guid}
              text={`${u.name} (${(u.capabilities || []).join(', ') || 'no capabilities'})`}
            />
          ))}
          <SelectItem value="__custom__" text="Other — enter a GUID below" />
        </Select>

        {showCustomInput && (
          <TextInput
            id="default-browser-user-custom"
            labelText="Custom user GUID"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            placeholder="e.g. admin-00000000-0000-0000-0000-000000000001"
            helperText="GUID of a user that exists on the server. Will fail validation if the user doesn't exist."
            style={{ marginTop: '1rem' }}
          />
        )}
      </div>
    </Modal>
  );
}

export default DefaultBrowserUserEditorModal;
