// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState, useCallback } from 'react';
import {
  Modal,
  StructuredListWrapper,
  StructuredListHead,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
  Button,
  InlineNotification,
} from '@carbon/react';
import { Copy } from '@carbon/icons-react';
import apiClient from '../api/client';
import { isElectron, getAppVersion, getElectronVersion, getPlatform } from '../utils/electron';
import buildInfo from '../../build.json';
import packageInfo from '../../package.json';

/**
 * AboutDialog — diagnostic information about the running dashboard
 * client and the server it's pointed at. Reached from the avatar
 * menu's "About" item. Built around the kind of thing a developer
 * or support engineer needs to know quickly:
 *
 *   - which server URL the client is talking to
 *   - what client + server versions are in play
 *   - who's signed in and through which auth path
 *   - whether the app is running in Electron (and which version)
 *
 * Includes a "Copy all" button that dumps the whole table as
 * plaintext, so a user reporting a bug can paste a complete
 * diagnostic snapshot into chat or a GitHub issue.
 *
 * Production users don't need to see this — it's not visually
 * promoted anywhere, the menu item just sits with the other
 * account actions. Support traffic discovers it; everyone else
 * ignores it.
 */
function AboutDialog({ open, onClose, currentUser, clerkActive }) {
  const [serverVersion, setServerVersion] = useState(null);
  const [serverFetchError, setServerFetchError] = useState(null);
  const [copied, setCopied] = useState(false);

  // Pull server /health once when the dialog opens so the version is
  // fresh per-open. The endpoint is unauthenticated and cheap, so
  // there's no concern about pre-fetching even when the user never
  // opens this dialog.
  useEffect(() => {
    if (!open) return;
    setServerVersion(null);
    setServerFetchError(null);
    setCopied(false);

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiClient.baseURL}/health`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setServerVersion(data.version || '(unknown)');
      } catch (err) {
        if (cancelled) return;
        setServerFetchError(err.message || String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const electronMode = isElectron();

  // Pull the relevant facts into a list of {label, value} pairs.
  // The list shape lets us render the table and the copy-all blob
  // from a single source — no duplication of "what's in the dialog."
  const rows = [
    { label: 'Server URL', value: apiClient.baseURL || '(not set)', mono: true },
    { label: 'Server version', value: serverVersion || (serverFetchError ? `error: ${serverFetchError}` : 'loading…') },
    { label: 'Client version', value: packageInfo.version },
    { label: 'Client build', value: String(buildInfo.buildNumber) },
    { label: 'Auth mode', value: clerkActive ? 'Clerk SSO' : (apiClient.apiKey ? 'API key' : 'unauthenticated') },
    { label: 'Signed-in user', value: currentUser?.name || '(none)' },
    { label: 'User GUID', value: currentUser?.guid || '(none)', mono: true },
    { label: 'Electron', value: electronMode
        ? `yes — app ${getAppVersion() || '?'}, runtime ${getElectronVersion() || '?'}, ${getPlatform() || '?'}`
        : 'no (browser)' },
  ];

  const copyAll = useCallback(() => {
    const blob = rows
      .map((r) => `${r.label}: ${r.value}`)
      .join('\n');
    navigator.clipboard.writeText(blob).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Clipboard write can fail in some contexts (insecure origin,
        // permission). Don't crash — just leave the copied flag off.
      }
    );
  }, [rows]);

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="About TRVE Dashboards"
      modalLabel="Diagnostic information"
      primaryButtonText="Close"
      onRequestSubmit={onClose}
      passiveModal={false}
      size="sm"
    >
      <StructuredListWrapper className="about-dialog__list">
        <StructuredListHead>
          <StructuredListRow head>
            <StructuredListCell head>Field</StructuredListCell>
            <StructuredListCell head>Value</StructuredListCell>
          </StructuredListRow>
        </StructuredListHead>
        <StructuredListBody>
          {rows.map((row) => (
            <StructuredListRow key={row.label}>
              <StructuredListCell>{row.label}</StructuredListCell>
              <StructuredListCell
                className={row.mono ? 'about-dialog__mono' : undefined}
                style={{ wordBreak: 'break-all' }}
              >
                {row.value}
              </StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>

      <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Button
          kind="tertiary"
          size="sm"
          renderIcon={Copy}
          onClick={copyAll}
        >
          Copy all
        </Button>
        {copied && (
          <span style={{ color: 'var(--cds-text-secondary)', fontSize: '0.8125rem' }}>
            Copied to clipboard
          </span>
        )}
      </div>

      {serverFetchError && (
        <InlineNotification
          kind="warning"
          title="Server version unavailable"
          subtitle={`Couldn't reach ${apiClient.baseURL}/health: ${serverFetchError}`}
          hideCloseButton
          lowContrast
          style={{ marginTop: '1rem' }}
        />
      )}
    </Modal>
  );
}

export default AboutDialog;
