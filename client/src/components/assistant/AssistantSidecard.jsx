// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useRef } from 'react';
import { IconButton } from '@carbon/react';
import { Close, Settings } from '@carbon/icons-react';
import './AssistantSidecard.scss';

/**
 * AssistantSidecard — the Dashboard Assistant's persistent chat
 * panel. Slides in from the right edge of the viewport; resizable
 * via a drag handle on its left edge.
 *
 * Step 9 ships the chrome: header (title + namespace/model line +
 * cog + close), resizable body container, footer placeholder.
 * Step 10 mounts the message list. Step 11 wires SSE.
 *
 * Props:
 *   - open: boolean
 *   - width: number — current width in px
 *   - onResize(nextPx): called while dragging the left edge
 *   - onRequestClose(): called when the user clicks the X
 *   - namespace: string — shown in the header line, informational
 *   - modelLabel: string — e.g. "sonnet" / "opus", shown in header
 *   - onSettingsClick(): step 12 wires the cog popover; until then
 *     the cog can be passed undefined to hide.
 */
export default function AssistantSidecard({
  open,
  width,
  minWidth = 360,
  onResize,
  onRequestClose,
  namespace = 'default',
  modelLabel = 'sonnet',
  onSettingsClick,
}) {
  const draggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(width);

  const handleDragStart = useCallback((e) => {
    draggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = width;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, [width]);

  useEffect(() => {
    if (!open) return undefined;

    const handleMove = (e) => {
      if (!draggingRef.current) return;
      // Right edge is fixed at the viewport edge, left edge moves.
      // Dragging left grows the panel; dragging right shrinks it.
      const delta = dragStartXRef.current - e.clientX;
      const next = dragStartWidthRef.current + delta;
      onResize?.(next);
    };

    const handleEnd = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
    };
  }, [open, onResize]);

  if (!open) return null;

  return (
    <aside
      className="assistant-sidecard"
      style={{ width: `${Math.max(minWidth, width)}px` }}
      aria-label="Dashboard Assistant"
    >
      <div
        className="assistant-sidecard__drag-handle"
        onMouseDown={handleDragStart}
        aria-hidden="true"
      />

      <header className="assistant-sidecard__header">
        <div className="assistant-sidecard__title-row">
          <h2 className="assistant-sidecard__title">Assistant</h2>
          <div className="assistant-sidecard__header-actions">
            {onSettingsClick && (
              <IconButton
                kind="ghost"
                size="sm"
                label="Assistant settings"
                align="bottom-right"
                onClick={onSettingsClick}
              >
                <Settings />
              </IconButton>
            )}
            <IconButton
              kind="ghost"
              size="sm"
              label="Hide assistant"
              align="bottom-right"
              onClick={onRequestClose}
            >
              <Close />
            </IconButton>
          </div>
        </div>
        <div className="assistant-sidecard__subtitle">
          Namespace: <span className="assistant-sidecard__subtitle-value">{namespace}</span>
          {' • '}
          Model: <span className="assistant-sidecard__subtitle-value">{modelLabel}</span>
        </div>
      </header>

      <div className="assistant-sidecard__body">
        {/* Step 10 mounts the message list here. */}
        <div className="assistant-sidecard__empty">
          <p>The assistant is ready, but message rendering and the input box land in the next two commits.</p>
          <p className="assistant-sidecard__empty-hint">
            Once steps 10 and 11 land, this is where you&apos;ll see the conversation and type to the assistant.
          </p>
        </div>
      </div>

      <footer className="assistant-sidecard__footer">
        {/* Step 11 mounts the input + send button here. */}
      </footer>
    </aside>
  );
}
