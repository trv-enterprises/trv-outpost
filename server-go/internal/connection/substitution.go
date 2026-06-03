// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// DashboardVariableToken is the fixed sentinel a component author writes into a
// query (or a client-side filter value) to mark where a dashboard variable's
// value should be substituted at view time. v1 supports a single fixed token;
// named tokens (`{{dashboard-variable:name}}`) are a future seam for multiple
// filter variables.
const DashboardVariableToken = "{{dashboard-variable}}"

// DashboardVariableParam is the key under which the client passes the active
// variable value in Query.Params. Substitution is entirely server-side: the
// client leaves the literal token in Query.Raw and supplies the value here.
const DashboardVariableParam = "dashboard_variable"

// ErrDashboardVariableNotSet is returned when a query contains the
// DashboardVariableToken but no value was supplied in Query.Params. The adapter
// must NEVER send the literal token to the database; callers surface this as a
// friendly "select a value" empty-state on the panel.
var ErrDashboardVariableNotSet = errors.New("dashboard variable not set")

// dashboardVariableValue extracts the active variable value from a params map,
// reporting whether the token should be substituted (present + non-empty).
func dashboardVariableValue(params map[string]interface{}) (string, bool) {
	if params == nil {
		return "", false
	}
	raw, ok := params[DashboardVariableParam]
	if !ok || raw == nil {
		return "", false
	}
	s := fmt.Sprintf("%v", raw)
	if s == "" {
		return "", false
	}
	return s, true
}

// substituteSQLToken replaces each DashboardVariableToken occurrence in raw with
// the driver-correct positional placeholder, returning the rewritten SQL plus
// the bound args in OCCURRENCE ORDER. Building args in occurrence order (rather
// than by ranging a map) is what makes positional binding deterministic — it
// simultaneously fixes the latent random-map-order bug in the old code path.
//
// If raw contains the token but no value was supplied, returns
// ErrDashboardVariableNotSet so the adapter can refuse the query rather than
// sending the literal token to the database.
func substituteSQLToken(driver, raw string, value string, hasValue bool) (string, []interface{}, error) {
	count := strings.Count(raw, DashboardVariableToken)
	if count == 0 {
		return raw, nil, nil
	}
	if !hasValue {
		return "", nil, ErrDashboardVariableNotSet
	}

	args := make([]interface{}, 0, count)
	var b strings.Builder
	rest := raw
	idx := 1
	for {
		pos := strings.Index(rest, DashboardVariableToken)
		if pos < 0 {
			b.WriteString(rest)
			break
		}
		b.WriteString(rest[:pos])
		b.WriteString(sqlPlaceholder(driver, idx))
		args = append(args, value)
		idx++
		rest = rest[pos+len(DashboardVariableToken):]
	}
	return b.String(), args, nil
}

// sqlPlaceholder returns the positional bind placeholder for a 1-based index in
// the given driver's dialect:
//   - postgres → $1, $2, …
//   - mssql    → @p1, @p2, …
//   - oracle   → :1, :2, …
//   - mysql / sqlite / default → ?
func sqlPlaceholder(driver string, idx int) string {
	switch driver {
	case "postgres":
		return fmt.Sprintf("$%d", idx)
	case "mssql":
		return fmt.Sprintf("@p%d", idx)
	case "oracle":
		return fmt.Sprintf(":%d", idx)
	default:
		// mysql, sqlite, and anything else use the positional "?" marker.
		return "?"
	}
}

// escapeEdgeLakeValue escapes a value for safe interpolation inside a
// double-quoted AnyLog/EdgeLake SQL string literal. EdgeLake has no bind-param
// mechanism — the command is `sql <db> format = json "<query>"` — so this is
// the SOLE injection vector for that adapter. Order matters: backslashes are
// doubled FIRST, then double-quotes are escaped, so an input backslash never
// combines with an injected quote's escape.
func escapeEdgeLakeValue(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return value
}

// substituteEdgeLakeToken replaces each DashboardVariableToken occurrence in raw
// with the escaped value. Returns ErrDashboardVariableNotSet when the token is
// present but no value was supplied.
func substituteEdgeLakeToken(raw string, value string, hasValue bool) (string, error) {
	if !strings.Contains(raw, DashboardVariableToken) {
		return raw, nil
	}
	if !hasValue {
		return "", ErrDashboardVariableNotSet
	}
	return strings.ReplaceAll(raw, DashboardVariableToken, escapeEdgeLakeValue(value)), nil
}

// ---- Variable value discovery (distinct values for the picker) ----------

// An identifier is a column or table name we'll splice into a generated
// distinct query. We accept only plain SQL identifiers (optionally
// schema/table-qualified) so the generated query can't be an injection vector.
// Anything outside this shape → derivation fails and the caller falls back to
// asking the author to pick a column explicitly.
var identifierPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)

// IsSafeIdentifier reports whether s is a plain (optionally dotted) SQL
// identifier — used to gate generated distinct queries.
func IsSafeIdentifier(s string) bool {
	return s != "" && identifierPattern.MatchString(s)
}

// equalsTokenPattern matches the common predicate shape `<col> = {{token}}`,
// capturing the column. Case-insensitive, tolerant of whitespace. The column
// may be schema-qualified (a.b). This is deliberately narrow — anything it
// doesn't match means "couldn't auto-detect", NOT a wrong guess.
var equalsTokenPattern = regexp.MustCompile(
	`(?i)([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*\{\{dashboard-variable\}\}`)

// fromTablePattern grabs the first table after FROM in a simple single-table
// query. Bails (no match used) when the FROM list is complex (joins/commas) —
// the caller treats absence as "couldn't auto-detect".
var fromTablePattern = regexp.MustCompile(
	`(?i)\bFROM\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)`)

// DerivedColumn is the best-effort result of scanning a query for the column
// the dashboard variable binds against.
type DerivedColumn struct {
	Column string // the column opposite the token (empty when not derivable)
	Table  string // single FROM table (empty when ambiguous/absent)
	OK     bool   // true only when a column was confidently derived
}

// DeriveVariableColumn scans a SQL/EdgeLake query for the `<col> = {{token}}`
// shape and a single FROM table. It is intentionally conservative: it returns
// OK=false on anything it can't unambiguously read (no token, multiple
// token occurrences against different columns, joins / multi-table FROM,
// non-identifier column). The caller then asks the author to pick a column
// rather than guessing. Never returns a column it isn't sure of.
func DeriveVariableColumn(raw string) DerivedColumn {
	matches := equalsTokenPattern.FindAllStringSubmatch(raw, -1)
	if len(matches) == 0 {
		return DerivedColumn{OK: false}
	}
	col := matches[0][1]
	// If the token binds against more than one distinct column, it's ambiguous.
	for _, m := range matches[1:] {
		if !strings.EqualFold(m[1], col) {
			return DerivedColumn{OK: false}
		}
	}
	if !IsSafeIdentifier(col) {
		return DerivedColumn{OK: false}
	}

	// Single-table FROM only. A comma or JOIN in the FROM region → ambiguous
	// table, so we leave Table empty (caller must supply it).
	table := ""
	if fm := fromTablePattern.FindStringSubmatch(raw); fm != nil {
		candidate := fm[1]
		// Reject when the query clearly has multiple tables (join/comma after FROM).
		lower := strings.ToLower(raw)
		if !strings.Contains(lower, " join ") && !strings.Contains(fromRegion(lower), ",") && IsSafeIdentifier(candidate) {
			table = candidate
		}
	}

	return DerivedColumn{Column: col, Table: table, OK: true}
}

// fromRegion returns the substring between FROM and the next major clause, used
// to detect a comma-separated (multi-table) FROM list.
func fromRegion(lowerQuery string) string {
	idx := strings.Index(lowerQuery, " from ")
	if idx < 0 {
		return ""
	}
	rest := lowerQuery[idx+6:]
	for _, kw := range []string{" where ", " group by ", " order by ", " limit ", " having "} {
		if k := strings.Index(rest, kw); k >= 0 {
			rest = rest[:k]
		}
	}
	return rest
}

// quoteIdentifier wraps a (possibly dotted) identifier in the driver's quoting
// so a generated distinct query is dialect-correct. Caller MUST have validated
// with IsSafeIdentifier first (we only quote known-safe identifiers).
func quoteIdentifier(driver, ident string) string {
	parts := strings.Split(ident, ".")
	var open, close string
	switch driver {
	case "mysql":
		open, close = "`", "`"
	case "mssql":
		open, close = "[", "]"
	default: // postgres, sqlite, oracle, edgelake → standard double quotes
		open, close = `"`, `"`
	}
	for i, p := range parts {
		parts[i] = open + p + close
	}
	return strings.Join(parts, ".")
}

// BuildDistinctQuery builds a distinct-values query for the given column/table.
// Uses GROUP BY (not SELECT DISTINCT) because it is universally supported and,
// critically, is the ONLY form EdgeLake's parser accepts (SELECT DISTINCT and
// ORDER-BY-on-non-aggregate both fail there — see the edgelake-sql-restrictions
// notes). For EdgeLake we therefore OMIT ORDER BY and sort server-side; SQL
// drivers get ORDER BY for stable output. Both honor LIMIT.
//
// Returns an error when column/table aren't safe identifiers (defense in depth;
// the caller should already have validated/derived them).
func BuildDistinctQuery(driver, column, table string, limit int) (string, error) {
	if !IsSafeIdentifier(column) {
		return "", fmt.Errorf("unsafe column identifier: %q", column)
	}
	if !IsSafeIdentifier(table) {
		return "", fmt.Errorf("unsafe table identifier: %q", table)
	}
	if limit <= 0 {
		limit = 1000
	}
	qc := quoteIdentifier(driver, column)
	qt := quoteIdentifier(driver, table)
	if driver == "edgelake" {
		// No ORDER BY (silently returns 0 rows on non-aggregated EdgeLake selects).
		return fmt.Sprintf("SELECT %s FROM %s GROUP BY %s LIMIT %d", qc, qt, qc, limit), nil
	}
	return fmt.Sprintf("SELECT %s FROM %s GROUP BY %s ORDER BY %s LIMIT %d", qc, qt, qc, qc, limit), nil
}
