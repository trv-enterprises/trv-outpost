// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Token form embedded in text-panel content: {{variable:NAME}} resolves to the
// display value of the dashboard variable named NAME at view time (the
// connection-swap label, or a filter variable's chosen value). Whitespace
// around NAME is tolerated. NAME may contain letters, digits, dashes, and
// underscores (matching DashboardVariable.name slugs).
export const TEXT_VARIABLE_TOKEN_RE = /\{\{\s*variable:\s*([A-Za-z0-9_-]+)\s*\}\}/g;

/**
 * variableTokenFor — the canonical token string for a variable name, used by
 * the insert-pill so the editor and resolver agree on the exact form.
 * @param {string} name
 * @returns {string} e.g. "{{variable:host}}"
 */
export function variableTokenFor(name) {
  return `{{variable:${name}}}`;
}

/**
 * resolveTextTemplate — substitute every {{variable:NAME}} token in a template
 * with its resolved display value. Unknown variables (no entry in `values`, or
 * an empty value) resolve to an empty string so a missing selection collapses
 * cleanly rather than leaving a literal token on screen.
 *
 * @param {string} template  the raw text-panel content
 * @param {Object<string,string>} values  name → display value
 * @returns {string}
 */
export function resolveTextTemplate(template, values) {
  if (!template) return '';
  if (!values || typeof template !== 'string') return template || '';
  return template.replace(TEXT_VARIABLE_TOKEN_RE, (_match, name) => {
    const v = values[name];
    return v == null ? '' : String(v);
  });
}

/**
 * templateUsesVariables — true when the template embeds at least one
 * {{variable:NAME}} token. Used to decide whether a text panel depends on the
 * live variable values (e.g. to re-render on selection change).
 * @param {string} template
 * @returns {boolean}
 */
export function templateUsesVariables(template) {
  if (!template || typeof template !== 'string') return false;
  TEXT_VARIABLE_TOKEN_RE.lastIndex = 0;
  return TEXT_VARIABLE_TOKEN_RE.test(template);
}

export default resolveTextTemplate;
