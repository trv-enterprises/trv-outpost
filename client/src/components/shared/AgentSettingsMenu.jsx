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
import './AgentSettingsMenu.scss';

/**
 * AgentSettingsMenu — the cog popover shared by both AI surfaces (the
 * Dashboard Assistant and the in-editor Component agent / "Edit with AI").
 * Hand-rolled rather than Carbon's OverflowMenu because OverflowMenu's
 * viewport-collision logic opened upward (clipped behind the app header) under
 * the sidecard's `position: fixed` parent.
 *
 * Every item is OPTIONAL — it renders only when its handler is supplied. So a
 * surface that has no "clear chat" (the component editor) simply omits
 * onClearChat and the item disappears; one with no expand-tool-calls pref omits
 * onToggleExpandToolCalls. Export items render disabled (not hidden) when their
 * handler is falsy so the affordance is visible on an empty conversation.
 *
 * NOTE: "Show token usage" was removed from this menu — the live per-session
 * usage display was never wired end-to-end (issue #55). Re-add a gated item
 * here when that lands; the per-user daily buckets already exist server-side.
 */
export default function AgentSettingsMenu({
  label = 'Settings',
  onClearChat,
  onExportMarkdown,
  onExportJson,
  expandToolCalls,
  onToggleExpandToolCalls,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (e) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) setOpen(false);
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

  const runAndClose = (fn) => () => {
    if (fn) fn();
    setOpen(false);
  };

  const hasExport = onExportMarkdown !== undefined || onExportJson !== undefined;

  return (
    <div className="agent-settings-menu__wrap" ref={wrapRef}>
      <IconButton
        kind="ghost"
        size="sm"
        label={label}
        align="bottom-right"
        onClick={() => setOpen((o) => !o)}
        isSelected={open}
      >
        <Settings />
      </IconButton>

      {open && (
        <div className="agent-settings-menu" role="menu" aria-label={`${label} menu`}>
          {onClearChat && (
            <>
              <button
                type="button"
                role="menuitem"
                className="agent-settings-menu__item"
                onClick={runAndClose(onClearChat)}
              >
                <TrashCan size={16} />
                <span>Clear chat</span>
              </button>
              {hasExport && <div className="agent-settings-menu__divider" />}
            </>
          )}

          {hasExport && (
            <>
              <button
                type="button"
                role="menuitem"
                className="agent-settings-menu__item"
                onClick={runAndClose(onExportMarkdown)}
                disabled={!onExportMarkdown}
              >
                <Download size={16} />
                <span>Export as Markdown</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="agent-settings-menu__item"
                onClick={runAndClose(onExportJson)}
                disabled={!onExportJson}
              >
                <DocumentExport size={16} />
                <span>Export as JSON</span>
              </button>
            </>
          )}

          {onToggleExpandToolCalls && (
            <>
              <div className="agent-settings-menu__divider" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={!!expandToolCalls}
                className="agent-settings-menu__item"
                onClick={() => onToggleExpandToolCalls?.()}
              >
                <span className="agent-settings-menu__check">
                  {expandToolCalls && <Checkmark size={16} />}
                </span>
                <span>Expand tool calls by default</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
