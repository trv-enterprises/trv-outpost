// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Toggle } from '@carbon/react';

/**
 * Shared "Skip TLS certificate verification" toggle used by every
 * connection-editor form whose connection can speak TLS over TCP
 * (https://, wss://, mqtts://, etc.).
 *
 * Two-gate model — both the per-connection flag here AND the
 * server-level `api.allow_insecure_tls` setting must be true before
 * verification is actually skipped. The helper copy says so on both
 * states so users aren't confused when a deployment has the toggle
 * off at the server level.
 *
 * Props:
 *   id        — required, used by Carbon Toggle for ARIA + click target
 *   isTls     — whether the connection's current URL/protocol uses
 *               TLS. The component renders nothing when false so
 *               plain-http connections don't see an irrelevant
 *               security toggle.
 *   value     — current boolean value of the per-conn flag
 *   onChange  — (checked: boolean) => void
 */
function TLSSkipVerifyToggle({ id, isTls, value, onChange }) {
  if (!isTls) return null;

  return (
    <div
      style={{
        marginTop: '1rem',
        paddingTop: '1rem',
        borderTop: '1px solid var(--cds-border-subtle-01)',
      }}
    >
      <Toggle
        id={id}
        labelText="Skip TLS certificate verification"
        labelA="Off"
        labelB="On"
        toggled={!!value}
        onToggle={(checked) => onChange?.(checked)}
      />
      <div
        style={{
          marginTop: '0.5rem',
          color: 'var(--cds-text-helper)',
          fontSize: '0.75rem',
        }}
      >
        {value
          ? 'Verification disabled — MITM attacks against this endpoint will go undetected. Only use for self-signed certs on trusted local networks (e.g. a homelab Proxmox UI). The server must also have api.allow_insecure_tls enabled for this to take effect.'
          : 'For self-signed certs on trusted local networks only. Enable api.allow_insecure_tls in the server config first; otherwise this toggle has no effect.'}
      </div>
    </div>
  );
}

export default TLSSkipVerifyToggle;
