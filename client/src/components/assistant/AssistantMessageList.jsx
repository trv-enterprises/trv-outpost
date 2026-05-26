// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useRef } from 'react';
import { InlineLoading } from '@carbon/react';
import AssistantToolCallCard from './AssistantToolCallCard';

/**
 * AssistantMessageList — renders the persisted conversation. User
 * messages right-aligned, assistant messages left-aligned with
 * markdown-ish text rendering (plain text with paragraph breaks for
 * v1; full markdown is a fast follow-up).
 *
 * Tool calls render inline as collapsible cards in the assistant
 * message that produced them.
 *
 * `streamingContent` is the chat agent's in-progress assistant text
 * — rendered as a transient bottom-most assistant message until the
 * canonical `message` event arrives via WS and the hook clears the
 * streaming buffer.
 *
 * `thinking` shows the spinner; the chat agent toggles it true at
 * turn start and false at turn end, so it's a reliable "busy" flag.
 *
 * Auto-scrolls to the bottom whenever a new message arrives or new
 * streaming content lands.
 */
export default function AssistantMessageList({
  messages,
  sending,
  thinking,
  streamingContent,
}) {
  const scrollerRef = useRef(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, sending, thinking, streamingContent]);

  if ((!messages || messages.length === 0) && !streamingContent) {
    return (
      <div className="assistant-messagelist assistant-messagelist--empty">
        <p>Ask the assistant anything about your dashboard deployment.</p>
        <p className="assistant-messagelist__hint">
          Try: <em>&quot;list my connections&quot;</em>, <em>&quot;what dashboards do I have?&quot;</em>, or
          <em> &quot;create a chart from MQTT topic home/temp&quot;</em>.
        </p>
      </div>
    );
  }

  return (
    <div className="assistant-messagelist" ref={scrollerRef}>
      {messages.map((msg, idx) => (
        <AssistantMessage key={msg.id || `m-${idx}`} message={msg} />
      ))}
      {streamingContent && (
        <AssistantMessage
          message={{
            id: '__streaming__',
            role: 'assistant',
            content: streamingContent,
          }}
        />
      )}
      {(sending || thinking) && (
        <div className="assistant-messagelist__pending">
          <InlineLoading description="Assistant is thinking…" />
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ message }) {
  const isUser = message.role === 'user';
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return (
    <div className={`assistant-message assistant-message--${isUser ? 'user' : 'assistant'}`}>
      {!isUser && hasTools && (
        <div className="assistant-message__tool-calls">
          {message.tool_calls.map((tc) => (
            <AssistantToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
      {message.content && (
        <div className="assistant-message__content">
          {renderTextContent(message.content)}
        </div>
      )}
    </div>
  );
}

// renderTextContent is the v1 stand-in for proper markdown
// rendering. Splits on blank lines into paragraphs and renders
// each as a <p>. Code fences and inline backticks land in step 11
// when we add the markdown library.
function renderTextContent(text) {
  if (!text) return null;
  const paragraphs = String(text).split(/\n{2,}/);
  return paragraphs.map((p, i) => (
    <p key={i} className="assistant-message__paragraph">{p}</p>
  ));
}
