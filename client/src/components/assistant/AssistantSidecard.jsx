// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconButton, Button, TextArea, InlineNotification } from '@carbon/react';
import { Close, Send, Launch } from '@carbon/icons-react';
import useAssistantSession from '../../hooks/useAssistantSession';
import useAssistantPreferences from '../../hooks/useAssistantPreferences';
import { useModeGuard } from '../../context/ModeGuardContext';
import { MODES } from '../../config/layoutConfig';
import AssistantMessageList from './AssistantMessageList';
import AssistantSettingsMenu from './AssistantSettingsMenu';
import { exportAsMarkdown, exportAsJson, defaultExportBaseName } from './exportConversation';
import { createdDashboardsFromMessages } from './createdDashboards';
import ExportNameModal from '../shared/ExportNameModal';
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
  const navigate = useNavigate();
  const { runModeGuard } = useModeGuard();
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  // Dashboards the Assistant created in this conversation, so we can offer
  // an "Open in viewer" affordance (#117). Derived from create_dashboard
  // tool-call outputs in the message history — so it stays correct after a
  // refresh rehydrates the conversation. The last entry is the most recent.
  const createdDashboards = useMemo(
    () => createdDashboardsFromMessages(session.messages),
    [session.messages]
  );
  const latestDashboard = createdDashboards.length
    ? createdDashboards[createdDashboards.length - 1]
    : null;

  // Open a created dashboard in the Design-mode previewer (read-only viewer
  // reached from the design context — same target the dashboards list uses).
  // If the user is mid-edit on ANOTHER dashboard, route through the mode guard
  // first so a dirty editor prompts "Unsaved changes" before we navigate away —
  // this in-app navigation would otherwise bypass that guard and silently
  // discard their edits (#117 follow-up).
  //
  // `refetchAt` forces the viewer to reload the dashboard record + its
  // components on arrival. The common case is the Assistant editing a component
  // on the dashboard the user is ALREADY viewing: navigating to that same
  // /view/dashboards/:id is a routing no-op (the :id is unchanged), so without
  // this signal the viewer keeps the stale component in chartsMap and the edit
  // doesn't mount until a manual browser refresh. A changing timestamp in
  // location.state makes the viewer refetch every time the button is pressed.
  const openDashboard = useCallback(
    async (id) => {
      if (!id) return;
      const { proceed } = await runModeGuard(MODES.VIEW);
      if (!proceed) return;
      navigate(`/view/dashboards/${id}`, {
        state: { fromDesign: true, refetchAt: Date.now() },
      });
    },
    [navigate, runModeGuard]
  );

  // Export handlers are passed to the cog menu. Only wire them when
  // the conversation has at least one message — the menu reads
  // undefined as "disable this item" so empty conversations
  // surface the items as future-features rather than no-ops.
  const hasMessages = session.messages && session.messages.length > 0;
  // Export name dialog: the cog items open it (set the format); the dialog's
  // onConfirm runs the export with the user-chosen filename (#61).
  const [exportFormat, setExportFormat] = useState(null); // 'md' | 'json' | null
  const handleExportConfirm = useCallback(
    (filename) => {
      const opts = { messages: session.messages, namespace, modelLabel, user: userName, filename };
      if (exportFormat === 'json') exportAsJson(opts);
      else exportAsMarkdown(opts);
    },
    [exportFormat, session.messages, namespace, modelLabel, userName]
  );

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
              // Pass undefined when there are no messages so the export items
              // render as disabled rather than opening the dialog on an empty
              // conversation. The items open the name dialog (#61).
              onExportMarkdown={hasMessages ? () => setExportFormat('md') : undefined}
              onExportJson={hasMessages ? () => setExportFormat('json') : undefined}
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
          onOpenDashboard={openDashboard}
        />
      </div>

      <footer className="assistant-sidecard__footer">
        {latestDashboard && (
          <Button
            className="assistant-sidecard__open-dashboard"
            kind="primary"
            size="sm"
            renderIcon={Launch}
            onClick={() => openDashboard(latestDashboard.id)}
          >
            {latestDashboard.name
              ? `Open “${latestDashboard.name}” in viewer`
              : 'Open new dashboard in viewer'}
          </Button>
        )}
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
        {prefs.showTokenUsage && session.tokenUsage && (
          <div className="assistant-sidecard__token-usage">
            Tokens this session: {session.tokenUsage.input.toLocaleString()} in
            {' · '}
            {session.tokenUsage.output.toLocaleString()} out
            {' · '}
            {(session.tokenUsage.input + session.tokenUsage.output).toLocaleString()} total
          </div>
        )}
        {/* Daily-budget grace band (#58): shown while the user is over the
            base cap — the server re-emits the notice on every send, so this
            reads as a standing reminder rather than a one-shot banner. */}
        {session.overBudgetNotice && (
          <div className="assistant-sidecard__over-budget" role="status">
            {session.overBudgetNotice}
          </div>
        )}
      </footer>

      <ExportNameModal
        open={exportFormat !== null}
        format={exportFormat || 'md'}
        defaultName={defaultExportBaseName()}
        onConfirm={handleExportConfirm}
        onClose={() => setExportFormat(null)}
      />
    </aside>
  );
}
