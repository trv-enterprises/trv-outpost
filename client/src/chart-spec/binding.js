// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Dot-path / bracket-path get/set helpers + visibleWhen evaluator.
// A `binds` path may include array indices: `data_mapping.y_axis[0]`.

const PATH_TOKEN_RE = /[^.[\]]+/g;

function tokenize(path) {
  return path.match(PATH_TOKEN_RE) || [];
}

function isIndex(token) {
  return /^\d+$/.test(token);
}

export function getByPath(obj, path) {
  const tokens = tokenize(path);
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[isIndex(t) ? Number(t) : t];
  }
  return cur;
}

/**
 * Immutable set by path. Returns a new object with the value updated.
 * Creates intermediate objects/arrays as needed (arrays when the next
 * token is numeric).
 */
export function setByPath(obj, path, value) {
  const tokens = tokenize(path);
  if (tokens.length === 0) return value;
  const root = Array.isArray(obj) ? [...(obj || [])] : { ...(obj || {}) };
  let cur = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const key = isIndex(t) ? Number(t) : t;
    const nextT = tokens[i + 1];
    const nextIsIndex = isIndex(nextT);
    let child = cur[key];
    if (child == null || typeof child !== 'object') {
      child = nextIsIndex ? [] : {};
    } else {
      child = Array.isArray(child) ? [...child] : { ...child };
    }
    cur[key] = child;
    cur = child;
  }
  const lastT = tokens[tokens.length - 1];
  cur[isIndex(lastT) ? Number(lastT) : lastT] = value;
  return root;
}

/**
 * Evaluate a visibleWhen clause against the current form state.
 * Returns true when the field should be shown.
 */
export function isVisible(visibleWhen, formState) {
  if (!visibleWhen) return true;
  const { field, operator, value } = visibleWhen;
  // `field` is the spec field id; we look up the matching field's
  // current value via the formState. Callers must pass formState as
  // a map { [fieldId]: value }.
  const current = formState[field];
  switch (operator) {
    case 'eq': return current === value;
    case 'neq': return current !== value;
    case 'in': return Array.isArray(value) && value.includes(current);
    case 'not_in': return Array.isArray(value) && !value.includes(current);
    case 'truthy': return Boolean(current);
    case 'falsy': return !current;
    case 'not_empty':
      if (current == null) return false;
      if (typeof current === 'string') return current.length > 0;
      if (Array.isArray(current)) return current.length > 0;
      return true;
    default:
      return true;
  }
}
