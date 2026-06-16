// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import { ChevronRight, ChevronDown, Tools } from '@carbon/icons-react';
import TerminalResponseBody from '../terminal/TerminalResponseBody';
import './AgentToolCallCard.scss';

/**
 * AgentToolCallCard — a collapsed-by-default tool-call row shared by BOTH
 * AI surfaces (the Dashboard Assistant and the in-editor Component agent /
 * "Edit with AI"). Renders one persisted ToolCall record from an
 * ai-session message: collapsed it shows the tool name + a one-line arg
 * summary + output size; expanded it shows pretty-printed args and result.
 *
 * Why TerminalResponseBody: it already handles JSON pretty-print + collapse
 * from the EdgeLake-terminal work, and both agents' tool args/results are
 * JSON-stringified, so the same renderer applies.
 *
 * This is the single shared copy — see issue #40 (Component agent UX parity)
 * and the converge-on-shared-functions architecture direction. Do not fork.
 */
export default function AgentToolCallCard({ toolCall, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!toolCall) return null;

  const argSummary = oneLineArgSummary(toolCall.input);
  const outputBytes = (toolCall.output || '').length;

  return (
    <div className={`agent-toolcall${open ? ' agent-toolcall--open' : ''}`}>
      <button
        type="button"
        className="agent-toolcall__header"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agent-toolcall__chevron">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <Tools size={14} className="agent-toolcall__icon" />
        <span className="agent-toolcall__name">{toolCall.name}</span>
        <span className="agent-toolcall__args">{argSummary}</span>
        <span className="agent-toolcall__meta">{outputBytes} B</span>
      </button>
      {open && (
        <div className="agent-toolcall__body">
          {toolCall.input && (
            <div className="agent-toolcall__section">
              <div className="agent-toolcall__section-label">Arguments</div>
              <TerminalResponseBody body={toolCall.input} />
            </div>
          )}
          {toolCall.output && (
            <div className="agent-toolcall__section">
              <div className="agent-toolcall__section-label">Result</div>
              <TerminalResponseBody body={toolCall.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// oneLineArgSummary picks 1-3 key=value pairs out of the args JSON so the
// collapsed header shows what the tool was called with without overwhelming
// the row. Empty input → empty summary.
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
