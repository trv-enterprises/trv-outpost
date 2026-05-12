// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import {
  Button,
  IconButton,
  Loading,
  InlineNotification,
  TextInput,
  Modal,
  Tag,
  Tile,
  Checkbox,
  FormGroup,
} from '@carbon/react';
import { TrashCan, Add, Password } from '@carbon/icons-react';
import apiClient from '../api/client';
import ApiKeyCreateModal from '../components/ApiKeyCreateModal';
import './SystemUsersPage.scss';

/**
 * SystemUsersPage
 *
 * Admin-only management of non-interactive service principals.
 * System users have no interactive sign-in path; their only purpose
 * is to own API keys that inbound integrations (ts-store webhook
 * receiver, MQTT bridge, etc.) authenticate with.
 *
 * UI surface (deliberately minimal):
 *   - List of system users with their API keys inline.
 *   - Create new system user (name only — capabilities default to "view").
 *   - Generate a new API key for any system user (one-time-reveal modal).
 *   - Revoke individual keys (existing per-key DELETE on /api/api-keys/:id).
 *   - Delete a system user entirely (cascades to its keys).
 *
 * Phase-2 work (deferred): editing capabilities, viewing
 * audit-trail of webhook calls per key. Today every system user
 * gets capabilities=["view"], which is enough to call inbound
 * webhook receivers.
 */
function SystemUsersPage() {
  const [users, setUsers] = useState([]);
  const [keysByUser, setKeysByUser] = useState({}); // user.id → APIKey[]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [createUserModal, setCreateUserModal] = useState(false);
  const [createKeyForUser, setCreateKeyForUser] = useState(null); // user object or null

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const resp = await apiClient.listSystemUsers();
      const list = resp?.users || [];
      setUsers(list);
      // Fetch keys for each user in parallel.
      const byUser = {};
      await Promise.all(
        list.map(async (u) => {
          try {
            byUser[u.id] = await apiClient.listSystemUserAPIKeys(u.id);
          } catch (e) {
            // Per-user fetch errors shouldn't break the whole page —
            // surface them next to that user's row instead.
            byUser[u.id] = { error: e.message };
          }
        }),
      );
      setKeysByUser(byUser);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleDeleteUser = async (user) => {
    const confirmMsg =
      `Delete system user "${user.name}"? This permanently revokes every API key it owns ` +
      `and any integration using those keys will immediately stop working.`;
    if (!window.confirm(confirmMsg)) return;
    try {
      await apiClient.deleteSystemUser(user.id);
      fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRevokeKey = async (key) => {
    const confirmMsg = `Revoke API key "${key.name}"? The integration using it will immediately stop working.`;
    if (!window.confirm(confirmMsg)) return;
    try {
      await apiClient.revokeAPIKey(key.id);
      fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="system-users-page">
      <div className="system-users-page__header">
        <div>
          <h1>System Users</h1>
          <p className="system-users-page__subtitle">
            Non-interactive service principals for inbound integrations (ts-store
            webhook receiver, etc.). System users cannot sign in — they only own
            API keys that external services use to authenticate calls to the
            dashboard.
          </p>
        </div>
        <Button
          renderIcon={Add}
          onClick={() => setCreateUserModal(true)}
        >
          New system user
        </Button>
      </div>

      {error && (
        <InlineNotification
          kind="error"
          title="Error"
          subtitle={error}
          onCloseButtonClick={() => setError(null)}
        />
      )}

      {users.length === 0 ? (
        <Tile className="system-users-page__empty">
          <p>No system users yet. Create one to issue an API key for an inbound integration.</p>
        </Tile>
      ) : (
        <div className="system-users-page__list">
          {users.map((user) => (
            <Tile key={user.id} className="system-user-card">
              <div className="system-user-card__header">
                <div>
                  <h3>{user.name}</h3>
                  <div className="system-user-card__meta">
                    <Tag type="cool-gray" size="sm">system</Tag>
                    {!user.active && <Tag type="red" size="sm">inactive</Tag>}
                    {(user.capabilities || []).map((cap) => (
                      <Tag key={cap} type={cap === 'webhook' ? 'blue' : 'gray'} size="sm">
                        {cap}
                      </Tag>
                    ))}
                    <span className="system-user-card__guid">{user.guid}</span>
                  </div>
                </div>
                <div className="system-user-card__actions">
                  <Button
                    kind="tertiary"
                    size="sm"
                    renderIcon={Password}
                    onClick={() => setCreateKeyForUser(user)}
                  >
                    Generate API key
                  </Button>
                  <IconButton
                    label="Delete system user"
                    kind="danger--ghost"
                    onClick={() => handleDeleteUser(user)}
                  >
                    <TrashCan />
                  </IconButton>
                </div>
              </div>

              <div className="system-user-card__keys">
                <h4>API keys</h4>
                {keysByUser[user.id]?.error ? (
                  <InlineNotification
                    kind="error"
                    title="Could not load keys"
                    subtitle={keysByUser[user.id].error}
                    lowContrast
                    hideCloseButton
                  />
                ) : (keysByUser[user.id] || []).length === 0 ? (
                  <p className="system-user-card__no-keys">
                    No keys yet. Generate one to authenticate inbound webhooks as this user.
                  </p>
                ) : (
                  <ul className="system-user-card__key-list">
                    {(keysByUser[user.id] || []).map((key) => (
                      <li key={key.id}>
                        <div className="key-row">
                          <code className="key-prefix">trve_{key.prefix}…</code>
                          <span className="key-name">{key.name}</span>
                          {key.revoked ? (
                            <Tag type="red" size="sm">revoked</Tag>
                          ) : (
                            <Tag type="green" size="sm">active</Tag>
                          )}
                          {!key.revoked && (
                            <IconButton
                              label="Revoke key"
                              kind="danger--ghost"
                              size="sm"
                              onClick={() => handleRevokeKey(key)}
                            >
                              <TrashCan />
                            </IconButton>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Tile>
          ))}
        </div>
      )}

      {createUserModal && (
        <CreateSystemUserModal
          onClose={() => setCreateUserModal(false)}
          onCreated={() => {
            setCreateUserModal(false);
            fetchUsers();
          }}
        />
      )}

      {createKeyForUser && (
        <ApiKeyCreateModal
          modalHeading={`Generate API key for ${createKeyForUser.name}`}
          createFn={({ name }) => apiClient.createSystemUserAPIKey(createKeyForUser.id, { name })}
          onClose={() => setCreateKeyForUser(null)}
          onCreated={() => {
            setCreateKeyForUser(null);
            fetchUsers();
          }}
        />
      )}
    </div>
  );
}

function CreateSystemUserModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  // Capability state. `view` is locked on — without it the system
  // user can't even call /auth/me, which makes the account useless;
  // the server enforces this too via normalizeCapabilities. `webhook`
  // is the canonical privilege for inbound integrations and defaults
  // to on. design / manage aren't surfaced here — broaden via the
  // regular users API if a future integration genuinely needs them.
  const [webhook, setWebhook] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr('Name is required.');
      return;
    }
    try {
      setSubmitting(true);
      setErr(null);
      const capabilities = ['view'];
      if (webhook) capabilities.push('webhook');
      await apiClient.createSystemUser({ name: trimmed, capabilities });
      onCreated();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      modalHeading="New system user"
      primaryButtonText={submitting ? 'Creating…' : 'Create'}
      secondaryButtonText="Cancel"
      onRequestSubmit={handleSubmit}
      onRequestClose={onClose}
      primaryButtonDisabled={submitting || !name.trim()}
    >
      <p style={{ marginBottom: 'var(--cds-spacing-05)' }}>
        Give the system user a memorable name that describes what integration will own it
        (e.g. <code>tsstore-webhook-recvr</code>).
      </p>
      <TextInput
        id="system-user-name"
        labelText="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="tsstore-webhook-recvr"
        invalid={!!err}
        invalidText={err}
      />

      <FormGroup
        legendText="Capabilities"
        style={{ marginTop: 'var(--cds-spacing-05)' }}
      >
        <Checkbox
          id="cap-view"
          labelText="View (read-only access — required)"
          checked
          disabled
          readOnly
        />
        <Checkbox
          id="cap-webhook"
          labelText="Webhook (POST to /api/webhooks/*)"
          checked={webhook}
          onChange={(_, { checked }) => setWebhook(checked)}
        />
        <div style={{ marginTop: 'var(--cds-spacing-03)', color: 'var(--cds-text-helper)', fontSize: '0.75rem' }}>
          Only the capabilities an integration actually needs — a leaked key
          can do everything the system user can.
        </div>
      </FormGroup>
    </Modal>
  );
}

export default SystemUsersPage;
