// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@carbon/react';
import {
  Settings,
  TrashCan,
  Download,
  DocumentExport,
  Checkmark,
} from '@carbon/icons-react';

/**
 * AssistantSettingsMenu — the cog popover inside the sidecard
 * header. Hand-rolled rather than using Carbon's OverflowMenu
 * because the OverflowMenu's positioning logic kept opening the
 * menu upward (clipped behind the app header) despite
 * `direction="bottom"` — its viewport-collision detection got
 * confused by the sidecard's `position: fixed` parent.
 *
 * Pattern: an IconButton trigger with a Carbon tooltip
 * (`align="bottom-right"`, same as the sidecard's Close button
 * which renders correctly). On click, toggle an absolutely-
 * positioned menu div that sits BELOW the trigger. Click outside
 * or Escape to close.
 *
 * Items match the design doc's spec:
 *   - Clear chat
 *   - Export as Markdown / JSON (disabled when no messages)
 *   - Expand tool calls by default (toggle)
 *   - Show token usage (toggle)
 */
export default function AssistantSettingsMenu({
  onClearChat,
  onExportMarkdown,
  onExportJson,
  expandToolCalls,
  onToggleExpandToolCalls,
  showTokenUsage,
  onToggleShowTokenUsage,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close on click outside, on Escape, and on any successful action.
  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (e) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // Action wrappers close the menu after running their handler.
  const runAndClose = (fn) => () => {
    if (fn) fn();
    setOpen(false);
  };

  return (
    <div className="assistant-settings-menu__wrap" ref={wrapRef}>
      <IconButton
        kind="ghost"
        size="sm"
        label="Assistant settings"
        align="bottom-right"
        onClick={() => setOpen((o) => !o)}
        isSelected={open}
      >
        <Settings />
      </IconButton>

      {open && (
        <div
          className="assistant-settings-menu"
          role="menu"
          aria-label="Assistant settings menu"
        >
          <button
            type="button"
            role="menuitem"
            className="assistant-settings-menu__item"
            onClick={runAndClose(onClearChat)}
          >
            <TrashCan size={16} />
            <span>Clear chat</span>
          </button>

          <div className="assistant-settings-menu__divider" />

          <button
            type="button"
            role="menuitem"
            className="assistant-settings-menu__item"
            onClick={runAndClose(onExportMarkdown)}
            disabled={!onExportMarkdown}
          >
            <Download size={16} />
            <span>Export as Markdown</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="assistant-settings-menu__item"
            onClick={runAndClose(onExportJson)}
            disabled={!onExportJson}
          >
            <DocumentExport size={16} />
            <span>Export as JSON</span>
          </button>

          <div className="assistant-settings-menu__divider" />

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={!!expandToolCalls}
            className="assistant-settings-menu__item"
            onClick={() => {
              onToggleExpandToolCalls?.();
              // Don't close — toggles read better as "stay open
              // until I'm done adjusting prefs".
            }}
          >
            <span className="assistant-settings-menu__check">
              {expandToolCalls && <Checkmark size={16} />}
            </span>
            <span>Expand tool calls by default</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={!!showTokenUsage}
            className="assistant-settings-menu__item"
            onClick={() => {
              onToggleShowTokenUsage?.();
            }}
          >
            <span className="assistant-settings-menu__check">
              {showTokenUsage && <Checkmark size={16} />}
            </span>
            <span>Show token usage</span>
          </button>
        </div>
      )}
    </div>
  );
}
