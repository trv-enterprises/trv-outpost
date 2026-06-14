// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useRef } from 'react';
import { InlineLoading } from '@carbon/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import AssistantToolCallCard from './AssistantToolCallCard';
import AgentWelcome from '../shared/AgentWelcome';
import AiIcon from '../icons/AiIcon';

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
  expandToolCalls = false,
  onSuggestion,
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
        <AgentWelcome
          icon={<AiIcon size={48} />}
          heading="Dashboard Assistant"
          description="Ask anything about your dashboard deployment — your connections, components, and dashboards — or have me build something."
          suggestions={[
            { label: 'Build a 2K system-stats dashboard', prompt: 'Build me a 2K dashboard for my system stats' },
            { label: 'List my connections', prompt: 'List my connections' },
            { label: 'What dashboards do I have?', prompt: 'What dashboards do I have?' },
            { label: 'Chart from an MQTT topic', prompt: 'Create a chart from MQTT topic home/temp' },
            { label: 'Summarize a dataset on a connection', prompt: 'Summarize a dataset on one of my connections' },
            { label: 'Summarize a dashboard', prompt: 'Summarize one of my dashboards' },
          ]}
          onSuggestion={onSuggestion}
        />
      </div>
    );
  }

  return (
    <div className="assistant-messagelist" ref={scrollerRef}>
      {messages.map((msg, idx) => (
        <AssistantMessage
          key={msg.id || `m-${idx}`}
          message={msg}
          expandToolCalls={expandToolCalls}
        />
      ))}
      {streamingContent && (
        <AssistantMessage
          message={{
            id: '__streaming__',
            role: 'assistant',
            content: streamingContent,
          }}
          expandToolCalls={expandToolCalls}
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

function AssistantMessage({ message, expandToolCalls }) {
  const isUser = message.role === 'user';
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return (
    <div className={`assistant-message assistant-message--${isUser ? 'user' : 'assistant'}`}>
      {!isUser && hasTools && (
        <div className="assistant-message__tool-calls">
          {message.tool_calls.map((tc) => (
            <AssistantToolCallCard
              key={tc.id}
              toolCall={tc}
              defaultOpen={expandToolCalls}
            />
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

// Markdown component overrides — map the elements react-markdown emits
// onto Carbon-token-styled DOM so the assistant's summaries
// (headings, lists, bold, inline code, code fences, tables, links)
// render properly instead of showing raw `**`/`##`/`-` syntax. Styling
// lives in AssistantSidecard.scss under .assistant-message__markdown.
// Links open in a new tab with noopener for safety; rehype-sanitize
// strips any HTML the model might emit so this is XSS-safe.
const MARKDOWN_COMPONENTS = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

// renderTextContent renders the assistant's message body as GitHub-
// flavored markdown. remark-gfm adds tables / strikethrough / autolinks;
// rehype-sanitize guards against injected HTML.
function renderTextContent(text) {
  if (!text) return null;
  return (
    <div className="assistant-message__markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={MARKDOWN_COMPONENTS}
      >
        {String(text)}
      </ReactMarkdown>
    </div>
  );
}
