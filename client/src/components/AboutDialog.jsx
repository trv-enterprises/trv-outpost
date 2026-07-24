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
  Link,
  InlineNotification,
} from '@carbon/react';
import { Copy, ChevronDown, ChevronUp } from '@carbon/icons-react';
import apiClient from '../api/client';
import { isElectron, getAppVersion, getElectronVersion, getPlatform } from '../utils/electron';
import { copyTextToClipboard } from '../utils/clipboard';
import buildInfo from '../../build.json';
import packageInfo from '../../package.json';
import './AboutDialog.scss';

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
// Product attribution. Copyright is reproduced VERBATIM from the repo's
// LICENSE appendix — do not paraphrase it. License + repo links point at
// the canonical sources so a distributed copy carries provenance in-app.
const REPO_URL = 'https://github.com/trv-enterprises/trv-outpost';
const LICENSE_NAME = 'Apache License 2.0';
const LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';
const COPYRIGHT = 'Copyright 2026 TRV Enterprises LLC'; // verbatim from LICENSE

// Bundled third-party components — mirrors THIRD_PARTY_LICENSES.md. Kept
// here so the in-app About box carries the same attribution the repo does.
const THIRD_PARTY = [
  { name: 'Carbon Design System', author: 'IBM Corporation', license: 'Apache-2.0', url: 'https://github.com/carbon-design-system/carbon' },
  { name: 'AG Grid', author: 'AG Grid Ltd.', license: 'MIT', url: 'https://github.com/ag-grid/ag-grid' },
  { name: 'Meteocons (weather icons)', author: 'Bas Milius', license: 'MIT', url: 'https://github.com/basmilius/meteocons' },
];

function AboutDialog({ open, onClose, currentUser, clerkActive }) {
  const [serverVersion, setServerVersion] = useState(null);
  const [serverFetchError, setServerFetchError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // Pull server /health once when the dialog opens so the version is
  // fresh per-open. The endpoint is unauthenticated and cheap, so
  // there's no concern about pre-fetching even when the user never
  // opens this dialog.
  useEffect(() => {
    if (!open) return;
    setServerVersion(null);
    setServerFetchError(null);
    setCopied(false);
    setShowDetails(false);

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
    // Use the shared helper: navigator.clipboard is undefined on plain HTTP
    // (the homelab runs at http://192.168.x.x), so the direct call threw and
    // nothing copied. copyTextToClipboard falls back to execCommand there.
    copyTextToClipboard(blob).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Both paths failed (rare) — leave the copied flag off.
      }
    );
  }, [rows]);

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="About Outpost"
      modalLabel="Attribution & version"
      primaryButtonText="Close"
      onRequestSubmit={onClose}
      passiveModal={false}
      size="sm"
    >
      {/* --- Attribution (primary) --- */}
      <div className="about-dialog__attribution">
        <p className="about-dialog__tagline">
          Outpost — a dashboard for real-time data visualization and device control.
        </p>
        <dl className="about-dialog__meta">
          <div className="about-dialog__meta-row">
            <dt>Project</dt>
            <dd><Link href={REPO_URL} target="_blank" rel="noopener noreferrer">{REPO_URL.replace('https://', '')}</Link></dd>
          </div>
          <div className="about-dialog__meta-row">
            <dt>Version</dt>
            <dd className="about-dialog__mono">{packageInfo.version} · build {String(buildInfo.buildNumber)}</dd>
          </div>
          <div className="about-dialog__meta-row">
            <dt>Copyright</dt>
            <dd>{COPYRIGHT}</dd>
          </div>
          <div className="about-dialog__meta-row">
            <dt>License</dt>
            <dd><Link href={LICENSE_URL} target="_blank" rel="noopener noreferrer">{LICENSE_NAME}</Link></dd>
          </div>
        </dl>
      </div>

      {/* --- Third-party attribution --- */}
      <div className="about-dialog__thirdparty">
        <h3 className="about-dialog__subhead">Third-party components</h3>
        <ul className="about-dialog__tp-list">
          {THIRD_PARTY.map((tp) => (
            <li key={tp.name}>
              <Link href={tp.url} target="_blank" rel="noopener noreferrer">{tp.name}</Link>
              <span className="about-dialog__tp-meta"> — {tp.author} · {tp.license}</span>
            </li>
          ))}
        </ul>
        <p className="about-dialog__tp-note">
          Attribution &amp; license terms:{' '}
          <Link href={`${REPO_URL}/blob/main/NOTICE`} target="_blank" rel="noopener noreferrer">NOTICE</Link>
          {' · '}
          <Link href={`${REPO_URL}/blob/main/THIRD_PARTY_LICENSES.md`} target="_blank" rel="noopener noreferrer">THIRD_PARTY_LICENSES</Link>.
          Redistributions must reproduce the notices in <span className="about-dialog__mono">NOTICE</span>.
        </p>
      </div>

      {/* --- More info: diagnostics, collapsed by default --- */}
      <div className="about-dialog__more">
        <Button
          kind="ghost"
          size="sm"
          renderIcon={showDetails ? ChevronUp : ChevronDown}
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? 'Hide details' : 'More info'}
        </Button>
      </div>

      {showDetails && (
        <>
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
        </>
      )}
    </Modal>
  );
}

export default AboutDialog;
