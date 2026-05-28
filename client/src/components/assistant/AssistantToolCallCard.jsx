// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import { ChevronRight, ChevronDown, Tools } from '@carbon/icons-react';
import TerminalResponseBody from '../terminal/TerminalResponseBody';

/**
 * AssistantToolCallCard — collapsed by default, expand to inspect.
 * Renders one persisted ToolCall record from a chat-session message.
 *
 * Why we re-use TerminalResponseBody: it already handles JSON
 * pretty-print + collapse + expand/collapse-all controls from the
 * EdgeLake-terminal work. The chat agent's tool args and results
 * are JSON-stringified, so the same renderer applies.
 */
export default function AssistantToolCallCard({ toolCall, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!toolCall) return null;

  const argSummary = oneLineArgSummary(toolCall.input);
  const outputBytes = (toolCall.output || '').length;

  return (
    <div className={`assistant-toolcall${open ? ' assistant-toolcall--open' : ''}`}>
      <button
        type="button"
        className="assistant-toolcall__header"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="assistant-toolcall__chevron">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <Tools size={14} className="assistant-toolcall__icon" />
        <span className="assistant-toolcall__name">{toolCall.name}</span>
        <span className="assistant-toolcall__args">{argSummary}</span>
        <span className="assistant-toolcall__meta">{outputBytes} B</span>
      </button>
      {open && (
        <div className="assistant-toolcall__body">
          {toolCall.input && (
            <div className="assistant-toolcall__section">
              <div className="assistant-toolcall__section-label">Arguments</div>
              <TerminalResponseBody body={toolCall.input} />
            </div>
          )}
          {toolCall.output && (
            <div className="assistant-toolcall__section">
              <div className="assistant-toolcall__section-label">Result</div>
              <TerminalResponseBody body={toolCall.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// oneLineArgSummary picks 1-3 key=value pairs out of the args JSON
// so the collapsed header shows what the tool was called with
// without overwhelming the row. Empty input → empty summary.
function oneLineArgSummary(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed);
      if (entries.length === 0) return '';
      const pairs = entries.slice(0, 3).map(([k, v]) => {
        const valStr = typeof v === 'string' ? v : JSON.stringify(v);
        const truncated = valStr.length > 30 ? valStr.slice(0, 27) + '…' : valStr;
        return `${k}=${truncated}`;
      });
      return pairs.join(' ');
    }
  } catch {
    // not JSON; fall through
  }
  const s = String(raw);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
