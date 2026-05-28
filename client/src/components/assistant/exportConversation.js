// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pure client-side exporters for the Dashboard Assistant
// conversation. Both formats run over the messages array already
// in the browser — no server round-trip — and trigger a download
// via Blob + URL.createObjectURL. Same plumbing the EdgeLake
// terminal's session-recording feature uses.

function formatTimestamp(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function safeParseJSON(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function downloadBlob(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke shortly after the click so the browser has actually
  // grabbed the blob. Immediate revoke can race in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Render the conversation as a human-readable Markdown file. Tool
 * calls render inside `<details>` blocks so GitHub / Obsidian /
 * Bear render them collapsed by default — readers see the flow of
 * conversation without being buried in tool args + result blobs,
 * but can expand any individual call when needed.
 */
function renderMarkdown({ messages, namespace, modelLabel, user }) {
  const lines = [];
  lines.push('# Dashboard Assistant — Conversation');
  lines.push('');
  lines.push(`- Exported: ${new Date().toISOString()}`);
  if (user) lines.push(`- User: ${user}`);
  if (namespace) lines.push(`- Namespace: \`${namespace}\``);
  if (modelLabel) lines.push(`- Model: \`${modelLabel}\``);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const m of messages) {
    if (!m || !m.role) continue;
    const heading = m.role === 'user' ? '## You' : '## Assistant';
    const stamp = m.timestamp ? ` — _${new Date(m.timestamp).toLocaleString()}_` : '';
    lines.push(`${heading}${stamp}`);
    lines.push('');

    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        lines.push(`<details>`);
        lines.push(`<summary>Tool: <code>${tc.name}</code></summary>`);
        lines.push('');
        if (tc.input) {
          lines.push('**Arguments:**');
          lines.push('');
          lines.push('```json');
          const parsed = safeParseJSON(tc.input);
          lines.push(parsed ? JSON.stringify(parsed, null, 2) : tc.input);
          lines.push('```');
          lines.push('');
        }
        if (tc.output) {
          lines.push('**Result:**');
          lines.push('');
          lines.push('```json');
          const parsed = safeParseJSON(tc.output);
          lines.push(parsed ? JSON.stringify(parsed, null, 2) : tc.output);
          lines.push('```');
          lines.push('');
        }
        lines.push(`</details>`);
        lines.push('');
      }
    }

    if (m.content) {
      lines.push(m.content);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Render the conversation as a JSON file with full structural
 * fidelity. Consumers (scripts, analytics, future "import a
 * conversation" tooling) can parse this directly.
 *
 * Tool-call inputs and outputs are parsed back into native JSON
 * objects where possible so the consumer doesn't have to
 * double-parse strings-of-strings; raw strings are preserved when
 * the content isn't valid JSON.
 */
function renderJson({ messages, namespace, modelLabel, user }) {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      version: 1,
      user: user || null,
      namespace: namespace || null,
      model: modelLabel || null,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        timestamp: m.timestamp,
        content: m.content,
        tool_calls: Array.isArray(m.tool_calls)
          ? m.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: safeParseJSON(tc.input) ?? tc.input,
              output: safeParseJSON(tc.output) ?? tc.output,
            }))
          : undefined,
      })),
    },
    null,
    2
  );
}

/**
 * Trigger a Markdown download of the conversation. No-op if there
 * are no messages — the cog menu should disable export items
 * before reaching this point, but defensive guard anyway.
 */
export function exportAsMarkdown(opts) {
  if (!opts?.messages || opts.messages.length === 0) return;
  const md = renderMarkdown(opts);
  const name = `dashboard-assistant_${formatTimestamp()}.md`;
  downloadBlob(md, 'text/markdown;charset=utf-8', name);
}

/**
 * Trigger a JSON download of the conversation.
 */
export function exportAsJson(opts) {
  if (!opts?.messages || opts.messages.length === 0) return;
  const json = renderJson(opts);
  const name = `dashboard-assistant_${formatTimestamp()}.json`;
  downloadBlob(json, 'application/json;charset=utf-8', name);
}
