// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * tagValueByPrefix — read a value out of a connection's prefixed tags.
 *
 * Prefixed tags act as a lightweight key-value store on a connection: a tag
 * `host:trv-srv-001` with prefix `host` yields `trv-srv-001`. Used to give the
 * dashboard-variable connection-swap dropdown a short, readable label instead
 * of the long connection name (and, later, the same for variable text panels).
 *
 * Matching is case-insensitive on the prefix and splits on the FIRST colon, so
 * a value may itself contain colons. Returns the value of the FIRST matching
 * tag (convention: one `<prefix>:` tag per connection). Returns null when no
 * tag matches or the inputs are unusable — callers fall back to the connection
 * name.
 *
 * @param {string[]} tags    the connection's tag set
 * @param {string}   prefix  the prefix to match (without the trailing colon)
 * @returns {string|null} the matched tag value, or null
 */
export function tagValueByPrefix(tags, prefix) {
  if (!Array.isArray(tags) || !prefix) return null;
  const want = String(prefix).trim().toLowerCase();
  if (!want) return null;
  const needle = `${want}:`;
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const idx = tag.indexOf(':');
    if (idx < 0) continue;
    if (tag.slice(0, idx).toLowerCase() === want) {
      const value = tag.slice(idx + 1).trim();
      if (value) return value;
    }
    // Defensive: also accept a leading-prefix form even if indexOf landed
    // elsewhere (keeps behavior stable if a value contains a colon).
    if (tag.toLowerCase().startsWith(needle)) {
      const value = tag.slice(needle.length).trim();
      if (value) return value;
    }
  }
  return null;
}

/**
 * candidateLabel — the dropdown label for a connection-swap candidate, applying
 * the configured label-tag-prefix and falling back to the connection name (then
 * its id). Centralizes the precedence so the dropdown and itemToString agree.
 *
 * @param {object} candidate  a VariableCandidate ({ name, id, tags })
 * @param {string} prefix     the configured label tag prefix (may be empty)
 * @returns {string}
 */
export function candidateLabel(candidate, prefix) {
  if (!candidate) return '';
  if (prefix) {
    const v = tagValueByPrefix(candidate.tags, prefix);
    if (v) return v;
  }
  return candidate.name || candidate.id || '';
}

/**
 * tagValues — the VALUE part of every prefixed tag on a connection, used by
 * component-swap rules whose subject is "tag" (e.g. a rule `tag CONTAINS "PI"`
 * tests these values). For a `prefix:value` tag the value is the part after the
 * first colon; a tag with no colon contributes its whole string (so a bare
 * `PI` tag still matches). Returns a de-duplicated array of non-empty strings.
 *
 * @param {string[]} tags  the connection's tag set
 * @returns {string[]}
 */
export function tagValues(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const idx = tag.indexOf(':');
    const value = (idx >= 0 ? tag.slice(idx + 1) : tag).trim();
    if (value && !seen.has(value)) { seen.add(value); out.push(value); }
  }
  return out;
}

export default tagValueByPrefix;
