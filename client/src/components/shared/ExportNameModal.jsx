// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { Modal, TextInput } from '@carbon/react';

/**
 * ExportNameModal — lets the user NAME the export file at download time.
 * Shared by both AI surfaces (Dashboard Assistant + Component agent). Prefilled
 * with a timestamped default; the user can rename before downloading. The
 * extension (.md / .json) is shown as a fixed suffix and appended by the
 * exporter, so the user types only the base name.
 *
 * Props:
 *   open        — whether the modal is shown
 *   format      — "md" | "json" (drives the heading + suffix label)
 *   defaultName — prefilled base name (no extension)
 *   onConfirm   — (baseName) => void; called with the (possibly edited) name
 *   onClose     — () => void
 */
export default function ExportNameModal({ open, format, defaultName, onConfirm, onClose }) {
  const [name, setName] = useState(defaultName || '');

  // Re-seed the field each time the modal opens (the default carries a fresh
  // timestamp, and the format may differ between opens).
  useEffect(() => {
    if (open) setName(defaultName || '');
  }, [open, defaultName]);

  const ext = format === 'json' ? '.json' : '.md';
  const submit = () => {
    onConfirm?.((name || defaultName || 'ai-conversation').trim());
    onClose?.();
  };

  return (
    <Modal
      open={open}
      modalHeading={`Export conversation (${ext.slice(1).toUpperCase()})`}
      primaryButtonText="Download"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!name.trim()}
      onRequestSubmit={submit}
      onRequestClose={onClose}
      size="sm"
    >
      <TextInput
        id="export-filename"
        labelText="File name"
        helperText={`Saved as “${(name || defaultName || 'ai-conversation').trim()}${ext}”`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) submit();
        }}
      />
    </Modal>
  );
}
