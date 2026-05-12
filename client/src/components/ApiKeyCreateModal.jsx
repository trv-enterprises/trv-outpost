// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import {
  Modal,
  TextInput,
  InlineNotification,
  Button,
  IconButton,
} from '@carbon/react';
import { Copy, CheckmarkFilled } from '@carbon/icons-react';
import apiClient from '../api/client';
import './ApiKeyCreateModal.scss';

/**
 * ApiKeyCreateModal
 *
 * Two-stage modal: first a name/expiration form, then a one-time
 * display of the plaintext token. The user MUST copy the token at
 * stage two — the server only persists the bcrypt hash and a short
 * plaintext prefix, so once this modal closes the plaintext can't be
 * recovered.
 *
 * Props:
 *   onClose, onCreated — modal lifecycle callbacks (required).
 *   createFn — async ({ name }) => createAPIKeyResponse. Defaults to
 *              apiClient.createAPIKey (the caller's own key). Pass
 *              apiClient.createSystemUserAPIKey.bind(apiClient, id)
 *              to mint a key for a specific system user; same response
 *              shape, same one-time-reveal UI.
 *   modalHeading — override the default "Create API key" label.
 */
function ApiKeyCreateModal({ onClose, onCreated, createFn, modalHeading }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [createdToken, setCreatedToken] = useState(null); // plaintext token + apiKey record
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const fn = createFn || ((args) => apiClient.createAPIKey(args));
      const resp = await fn({ name: trimmed });
      setCreatedToken(resp);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!createdToken?.token) return;
    try {
      await navigator.clipboard.writeText(createdToken.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError('Could not copy to clipboard: ' + err.message);
    }
  };

  const handleDone = () => {
    if (createdToken) {
      onCreated();
    } else {
      onClose();
    }
  };

  // Stage 2 — plaintext display
  if (createdToken) {
    return (
      <Modal
        open
        modalHeading="API key created"
        primaryButtonText="Done"
        onRequestSubmit={handleDone}
        onRequestClose={handleDone}
        passiveModal={false}
        primaryButtonDisabled={false}
        size="md"
      >
        <div className="api-key-create-modal__success">
          <InlineNotification
            kind="warning"
            title="Save this token now"
            subtitle={
              "This is the only time the plaintext token will be displayed. " +
              "If you lose it you'll need to revoke the key and create a new one."
            }
            hideCloseButton
            lowContrast
          />

          <div className="token-row">
            <code className="token-display">{createdToken.token}</code>
            <IconButton
              kind="ghost"
              label={copied ? 'Copied' : 'Copy to clipboard'}
              onClick={handleCopy}
              size="md"
            >
              {copied ? <CheckmarkFilled size={20} /> : <Copy size={20} />}
            </IconButton>
          </div>

          <dl className="key-meta">
            <dt>Name</dt>
            <dd>{createdToken.api_key?.name}</dd>
            <dt>Prefix</dt>
            <dd>
              <code>trve_{createdToken.api_key?.prefix}…</code>
            </dd>
          </dl>

          <p className="usage-hint">
            Use this token by passing it in the{' '}
            <code>Authorization</code> header:
          </p>
          <pre className="usage-example">
{`Authorization: Bearer ${createdToken.token}`}
          </pre>
        </div>
      </Modal>
    );
  }

  // Stage 1 — form
  return (
    <Modal
      open
      modalHeading={modalHeading || 'Create API key'}
      primaryButtonText={submitting ? 'Creating…' : 'Create'}
      secondaryButtonText="Cancel"
      onRequestSubmit={handleCreate}
      onRequestClose={onClose}
      primaryButtonDisabled={submitting || !name.trim()}
      size="sm"
    >
      <div className="api-key-create-modal__form">
        <p className="form-intro">
          Give this key a name so you can identify what it's for later
          (e.g. "homelab-agent", "claude-desktop"). The plaintext token
          is shown only once after creation.
        </p>

        <TextInput
          id="api-key-name"
          labelText="Name"
          placeholder="e.g. homelab-agent"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          autoFocus
        />

        {error && (
          <InlineNotification
            kind="error"
            title="Could not create key"
            subtitle={error}
            onCloseButtonClick={() => setError(null)}
            lowContrast
          />
        )}
      </div>
    </Modal>
  );
}

export default ApiKeyCreateModal;
