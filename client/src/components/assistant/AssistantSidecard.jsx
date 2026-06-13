// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconButton, Button, TextArea, InlineNotification } from '@carbon/react';
import { Close, Send } from '@carbon/icons-react';
import useAssistantSession from '../../hooks/useAssistantSession';
import useAssistantPreferences from '../../hooks/useAssistantPreferences';
import AssistantMessageList from './AssistantMessageList';
import AssistantSettingsMenu from './AssistantSettingsMenu';
import { exportAsMarkdown, exportAsJson } from './exportConversation';
import './AssistantSidecard.scss';

/**
 * AssistantSidecard — the Dashboard Assistant's persistent chat
 * panel. Slides in from the right edge of the viewport; resizable
 * via a drag handle on its left edge.
 *
 * Step 9 shipped the chrome. Step 10 (this commit) wires the
 * conversation: message list + input + send. Step 11 swaps the
 * polling refetch for SSE so deltas arrive token-by-token.
 *
 * Props:
 *   - open: boolean
 *   - width: number — current width in px
 *   - onResize(nextPx): called while dragging the left edge
 *   - onRequestClose(): called when the user clicks the X
 *   - namespace: string — shown in the header line, informational
 *   - modelLabel: string — e.g. "sonnet" / "opus", shown in header
 *
 * The cog popover is owned here (step 12) — settings are
 * browser-local prefs via useAssistantPreferences, so the sidecard
 * doesn't need a prop for the menu.
 */
export default function AssistantSidecard({
  open,
  width,
  minWidth = 360,
  onResize,
  onRequestClose,
  namespace = 'default',
  modelLabel = 'sonnet',
  userName = null,
}) {
  const draggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(width);

  const session = useAssistantSession();
  const prefs = useAssistantPreferences();
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  // Export handlers are passed to the cog menu. Only wire them when
  // the conversation has at least one message — the menu reads
  // undefined as "disable this item" so empty conversations
  // surface the items as future-features rather than no-ops.
  const hasMessages = session.messages && session.messages.length > 0;
  const handleExportMarkdown = useCallback(() => {
    exportAsMarkdown({
      messages: session.messages,
      namespace,
      modelLabel,
      user: userName,
    });
  }, [session.messages, namespace, modelLabel, userName]);
  const handleExportJson = useCallback(() => {
    exportAsJson({
      messages: session.messages,
      namespace,
      modelLabel,
      user: userName,
    });
  }, [session.messages, namespace, modelLabel, userName]);

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

  // Auto-focus the input when the sidecard opens so the user can
  // start typing immediately.
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus?.();
    }
  }, [open]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || session.sending) return;
    setDraft('');
    await session.sendMessage(text);
  }, [draft, session]);

  const handleKeyDown = useCallback((e) => {
    // Enter sends, Shift-Enter newline. Carbon's TextArea fires
    // onKeyDown on the native textarea so the keys work naturally.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  if (!open) return null;

  const canSend = draft.trim().length > 0 && !session.sending;

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
            <AssistantSettingsMenu
              onClearChat={session.clearChat}
              // Pass undefined when there are no messages so the
              // export items render as disabled rather than firing
              // on an empty conversation.
              onExportMarkdown={hasMessages ? handleExportMarkdown : undefined}
              onExportJson={hasMessages ? handleExportJson : undefined}
              expandToolCalls={prefs.expandToolCalls}
              onToggleExpandToolCalls={prefs.toggleExpandToolCalls}
              showTokenUsage={prefs.showTokenUsage}
              onToggleShowTokenUsage={prefs.toggleShowTokenUsage}
            />
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
        {session.warning && (
          <InlineNotification
            kind="warning"
            title="Heads up"
            subtitle={session.warning}
            hideCloseButton
            lowContrast
          />
        )}
        {session.error && (
          <InlineNotification
            kind="error"
            title="Assistant error"
            subtitle={session.error}
            hideCloseButton
            lowContrast
          />
        )}
        <AssistantMessageList
          messages={session.messages}
          sending={session.sending}
          thinking={session.thinking}
          streamingContent={session.streamingContent}
          expandToolCalls={prefs.expandToolCalls}
          onSuggestion={setDraft}
        />
      </div>

      <footer className="assistant-sidecard__footer">
        <div className="assistant-sidecard__input-row">
          <TextArea
            ref={inputRef}
            id="assistant-input"
            labelText=""
            hideLabel
            placeholder="Ask the assistant…"
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={session.sending}
          />
          <Button
            kind="primary"
            size="md"
            renderIcon={Send}
            iconDescription="Send"
            onClick={handleSend}
            disabled={!canSend}
          >
            Send
          </Button>
        </div>
        {prefs.showTokenUsage && (
          <div className="assistant-sidecard__token-usage">
            Token usage counters will appear here once per-turn
            usage events are broadcast over the session WebSocket
            (small follow-up commit; server already tracks the
            exact counts via response.Usage).
          </div>
        )}
      </footer>
    </aside>
  );
}
