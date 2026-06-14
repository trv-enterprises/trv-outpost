// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Shared client-side conversation exporters for BOTH AI surfaces (the
// Dashboard Assistant and the in-editor Component agent / "Edit with AI").
// Both formats run over the messages array already in the browser — no server
// round-trip — and trigger a download via Blob + URL.createObjectURL.
//
// Secrets are masked from the start (issue #40): tool-call args and results can
// echo connection configs the agent inspected (passwords, api keys, tokens), so
// every export runs through maskSecrets() before serialization. Masking is by
// key NAME (recursively), value-shape-agnostic — see SECRET_KEY_RE.

// SECRET_KEY_RE matches object keys whose values are credentials. Matched
// case-insensitively against each key anywhere in a tool-call payload. Kept in
// sync with the server's authHeaderNames / connection secret fields by intent,
// not by import (this is a defense-in-depth client mask, not the source of
// truth). Conservative: better to mask a non-secret than to leak one.
const SECRET_KEY_RE =
  /^(password|passwd|pwd|api[_-]?key|apikey|secret|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|auth[_-]?token|x[_-]?api[_-]?key|x[_-]?auth[_-]?token|x[_-]?access[_-]?token|cookie|set[_-]?cookie|private[_-]?key|credential|credentials|bearer)$/i;

const MASK = '«redacted»';

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

/**
 * maskSecrets walks a parsed value and replaces the value of any key whose
 * NAME matches SECRET_KEY_RE with the mask sentinel, recursively through
 * nested objects and arrays. Non-objects pass through unchanged. Pure — never
 * mutates the input (returns a redacted copy).
 */
export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? MASK : maskSecrets(v);
    }
    return out;
  }
  return value;
}

// maskToolField masks a JSON-stringified tool input/output. When the field
// parses as JSON we redact by key and re-stringify; when it's an opaque
// non-JSON string we leave it (no key structure to target) — tool args/results
// in this app are always JSON, so the opaque case is just defensive.
function maskToolField(raw) {
  const parsed = safeParseJSON(raw);
  if (parsed === null) return raw;
  return JSON.stringify(maskSecrets(parsed));
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
  // Revoke shortly after the click so the browser has actually grabbed the
  // blob. Immediate revoke can race in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Render the conversation as human-readable Markdown. Tool calls render inside
 * `<details>` blocks so GitHub / Obsidian / Bear render them collapsed by
 * default. Secret-bearing args/results are masked.
 */
function renderMarkdown({ title, messages, namespace, modelLabel, user }) {
  const lines = [];
  lines.push(`# ${title} — Conversation`);
  lines.push('');
  lines.push(`- Exported: ${new Date().toISOString()}`);
  if (user) lines.push(`- User: ${user}`);
  if (namespace) lines.push(`- Namespace: \`${namespace}\``);
  if (modelLabel) lines.push(`- Model: \`${modelLabel}\``);
  lines.push('- Secrets masked: yes');
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
          const masked = maskSecrets(safeParseJSON(tc.input) ?? {});
          lines.push(safeParseJSON(tc.input) ? JSON.stringify(masked, null, 2) : tc.input);
          lines.push('```');
          lines.push('');
        }
        if (tc.output) {
          lines.push('**Result:**');
          lines.push('');
          lines.push('```json');
          const parsedOut = safeParseJSON(tc.output);
          lines.push(parsedOut ? JSON.stringify(maskSecrets(parsedOut), null, 2) : tc.output);
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
 * Render the conversation as JSON with full structural fidelity. Tool-call
 * inputs/outputs are parsed back into native JSON (and masked) where possible
 * so consumers don't double-parse; raw strings are preserved (masked when
 * JSON) when not valid JSON.
 */
function renderJson({ title, messages, namespace, modelLabel, user }) {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      version: 1,
      surface: title,
      secrets_masked: true,
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
              input: safeParseJSON(tc.input)
                ? maskSecrets(safeParseJSON(tc.input))
                : maskToolField(tc.input),
              output: safeParseJSON(tc.output)
                ? maskSecrets(safeParseJSON(tc.output))
                : maskToolField(tc.output),
            }))
          : undefined,
      })),
    },
    null,
    2
  );
}

// defaultExportBaseName is the suggested filename stem (no extension) shown to
// the user when they choose to export. The user can rename it in the export
// dialog; this is just the prefilled default.
export function defaultExportBaseName(opts) {
  return `${opts?.filePrefix || 'ai-conversation'}_${formatTimestamp()}`;
}

// resolveFilename builds the final filename. When the caller passes an explicit
// `filename` (the user typed one in the export dialog), it's sanitized and used
// (the extension is appended if missing); otherwise it falls back to the
// timestamped default. This is what lets the user NAME the file on download.
function resolveFilename(opts, ext) {
  const typed = (opts.filename || '').trim();
  const base = typed || defaultExportBaseName(opts);
  // Strip a user-typed extension that matches, and any path separators.
  const cleaned = base.replace(/[/\\]+/g, '-').replace(new RegExp(`\\.${ext}$`, 'i'), '');
  return `${cleaned}.${ext}`;
}

/**
 * Trigger a Markdown download of the conversation. opts: { title, filePrefix,
 * messages, namespace, modelLabel, user, filename? }. When `filename` is set
 * (user named it in the export dialog) it's used; otherwise a timestamped
 * default. No-op when there are no messages.
 */
export function exportAsMarkdown(opts) {
  if (!opts?.messages || opts.messages.length === 0) return;
  const md = renderMarkdown(opts);
  downloadBlob(md, 'text/markdown;charset=utf-8', resolveFilename(opts, 'md'));
}

/**
 * Trigger a JSON download of the conversation. Same opts as exportAsMarkdown.
 */
export function exportAsJson(opts) {
  if (!opts?.messages || opts.messages.length === 0) return;
  const json = renderJson(opts);
  downloadBlob(json, 'application/json;charset=utf-8', resolveFilename(opts, 'json'));
}
