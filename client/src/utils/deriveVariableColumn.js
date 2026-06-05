// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * deriveVariableColumn — best-effort client-side derivation of the column (and
 * single source table) that a dashboard-variable filters on, by scanning a raw
 * SQL query for the `<col> = {{dashboard-variable}}` predicate.
 *
 * Mirrors the server's conservative scan (connection/substitution.go
 * DeriveVariableColumn): a single `<col> = {{dashboard-variable}}` and a single
 * FROM table. ANY ambiguity — no token, the token bound against more than one
 * distinct column, a JOIN, or a comma-separated (multi-table) FROM — yields an
 * empty result rather than a wrong guess. Callers fall back to asking the user
 * (editor) or to the static option list (dashboard runtime).
 *
 * Used by BOTH the component editor's value picker and the dashboard runtime
 * value discovery, so the two stay consistent.
 *
 * @param {string} rawQuery - the component's raw SQL/EdgeLake query text
 * @returns {{ column: string, table: string }} - empty strings when not derivable
 */
export function deriveVariableColumn(rawQuery) {
  const raw = rawQuery || '';
  const colMatches = [...raw.matchAll(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*\{\{dashboard-variable\}\}/gi)];
  if (colMatches.length === 0) return { column: '', table: '' };
  const col = colMatches[0][1];
  // Ambiguous if the token binds against more than one distinct column.
  if (colMatches.slice(1).some((m) => m[1].toLowerCase() !== col.toLowerCase())) {
    return { column: '', table: '' };
  }
  let tbl = '';
  const fromMatch = raw.match(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/i);
  if (fromMatch) {
    const lower = raw.toLowerCase();
    const fromIdx = lower.indexOf(' from ');
    let region = fromIdx >= 0 ? lower.slice(fromIdx + 6) : '';
    for (const kw of [' where ', ' group by ', ' order by ', ' limit ', ' having ']) {
      const k = region.indexOf(kw);
      if (k >= 0) region = region.slice(0, k);
    }
    if (!lower.includes(' join ') && !region.includes(',')) tbl = fromMatch[1];
  }
  return { column: col, table: tbl };
}

export default deriveVariableColumn;
