// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
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

// RangeVariableToken is the single sentinel a SQL/EdgeLake component author
// writes (via the WHERE-condition builder) immediately AFTER the column to
// time-bound: `… WHERE ts {{range-variable}} …`. At view time the server reads
// the column to the LEFT, resolves the active range to absolute instants, and
// rewrites `<col> {{range-variable}}` into a bounded predicate in the adapter's
// dialect (SQL `col BETWEEN $1 AND $2`, EdgeLake `col >= '…' AND col <= '…'`).
// ts-store/Prometheus have no WHERE clause — they auto-apply the window from
// RangeParam directly and never see this token.
const RangeVariableToken = "{{range-variable}}"

// RangeParam is the key under which the client passes the active range INTENT —
// a structured value, not pre-resolved instants:
//
//	{ "type": "relative", "token": "1h", "step": "1m" }   // last 1h/24h/1d (+step for Prometheus)
//	{ "type": "absolute", "from": "<RFC3339>", "to": "<RFC3339>", "step": "1m" }
//
// SQL/EdgeLake resolve a relative intent to absolute instants server-side;
// ts-store/Prometheus may consume the relative token natively.
const RangeParam = "range"

// reservedQueryParams are param keys consumed by token substitution / structured
// range handling — they must NOT be appended as stray positional bind args by
// the SQL adapters.
var reservedQueryParams = map[string]bool{
	DashboardVariableParam: true,
	RangeParam:             true,
}

// ErrDashboardVariableNotSet is returned when a query contains the
// DashboardVariableToken but no value was supplied in Query.Params. The adapter
// must NEVER send the literal token to the database; callers surface this as a
// friendly "select a value" empty-state on the panel.
var ErrDashboardVariableNotSet = errors.New("dashboard variable not set")

// ErrRangeNotSet is returned when a query carries the RangeVariableToken but no
// range window was supplied (or it can't be resolved). The adapter refuses the
// query; callers surface a friendly "select a range" empty-state.
var ErrRangeNotSet = errors.New("dashboard range not set")

// ErrRangeMalformed is returned when the RangeVariableToken has no safe column
// identifier to its left (it must be authored as `<column> {{range-variable}}`).
var ErrRangeMalformed = errors.New("range token must follow a column name")

// dashboardVariableValue extracts the active variable value from a params map,
// resolveFilterParam reads the "filter" param and, when it is exactly the
// DashboardVariableToken, replaces it with the active dashboard-variable value.
// ts-store's filter is a plain substring (not field-scoped), so an author who
// binds the filter to the dashboard variable stores the literal token; this
// swaps it for the chosen value at query time. Returns the resolved substring
// (empty string means "no filter"). When the token is present but no value was
// supplied, returns "" so the query runs unfiltered rather than matching the
// literal "{{dashboard-variable}}" text (which would match nothing).
func resolveFilterParam(params map[string]interface{}) string {
	filter, _ := params["filter"].(string)
	if filter == "" {
		return ""
	}
	if filter == DashboardVariableToken {
		if value, ok := dashboardVariableValue(params); ok {
			return value
		}
		return "" // token but no value → unfiltered
	}
	return filter
}

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

// paramString reads a string-ish param value ("" when absent/nil).
func paramString(params map[string]interface{}, key string) string {
	raw, ok := params[key]
	if !ok || raw == nil {
		return ""
	}
	return fmt.Sprintf("%v", raw)
}

// RangeSpec is the decoded range INTENT from params.range. Exactly one of
// (Token) / (From,To) is meaningful depending on Type. Step is Prometheus-only.
type RangeSpec struct {
	Type  string // "relative" | "absolute"
	Token string // relative duration token, e.g. "1h" (Type=="relative")
	From  string // RFC3339 (Type=="absolute")
	To    string // RFC3339 (Type=="absolute")
	Step  string // optional Prometheus step, e.g. "1m"
}

// resolveRange decodes params.range into a RangeSpec. ok is false when no range
// is present or the value is unusable. params.range is a map (JSON object) as
// delivered by the client through Query.Params.
func resolveRange(params map[string]interface{}) (RangeSpec, bool) {
	if params == nil {
		return RangeSpec{}, false
	}
	raw, ok := params[RangeParam]
	if !ok || raw == nil {
		return RangeSpec{}, false
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return RangeSpec{}, false
	}
	asStr := func(k string) string {
		if v, ok := m[k]; ok && v != nil {
			return fmt.Sprintf("%v", v)
		}
		return ""
	}
	spec := RangeSpec{
		Type:  asStr("type"),
		Token: asStr("token"),
		From:  asStr("from"),
		To:    asStr("to"),
		Step:  asStr("step"),
	}
	switch spec.Type {
	case "relative":
		if spec.Token == "" {
			return RangeSpec{}, false
		}
	case "absolute":
		if spec.From == "" || spec.To == "" {
			return RangeSpec{}, false
		}
	default:
		return RangeSpec{}, false
	}
	return spec, true
}

// relativeTokenPattern parses a relative duration token like "1h", "30m",
// "7d", "2w" into a count + unit.
var relativeTokenPattern = regexp.MustCompile(`^(\d+)\s*([mhdw])$`)

// resolveRelativeToAbsolute converts a relative token ("1h", "24h", "7d") into
// an absolute [from, to] window ending at `now`, both as UTC RFC3339. Returns an
// error for an unparseable token. Units: m=minute, h=hour, d=day, w=week.
func resolveRelativeToAbsolute(token string, now time.Time) (from, to string, err error) {
	mt := relativeTokenPattern.FindStringSubmatch(strings.TrimSpace(token))
	if mt == nil {
		return "", "", fmt.Errorf("%w: unparseable relative range token %q", ErrRangeNotSet, token)
	}
	n, _ := strconv.Atoi(mt[1])
	if n <= 0 {
		return "", "", fmt.Errorf("%w: non-positive relative range token %q", ErrRangeNotSet, token)
	}
	var unit time.Duration
	switch mt[2] {
	case "m":
		unit = time.Minute
	case "h":
		unit = time.Hour
	case "d":
		unit = 24 * time.Hour
	case "w":
		unit = 7 * 24 * time.Hour
	}
	dur := time.Duration(n) * unit
	end := now.UTC()
	return end.Add(-dur).Format(time.RFC3339), end.Format(time.RFC3339), nil
}

// tsstoreRange describes how a ts-store adapter should fetch a range window.
// Relative intents use ts-store's native `since:<token>` (newest-since); absolute
// intents use a [fromEpoch, toEpoch] range fetch.
type tsstoreRange struct {
	Relative  bool
	Since     string // relative token, e.g. "1h" (Relative)
	FromEpoch int64  // absolute lower bound, Unix seconds
	ToEpoch   int64  // absolute upper bound, Unix seconds
}

// tsstoreRangeFromSpec maps a RangeSpec to a tsstoreRange. ok is false when the
// spec can't be resolved (unparseable relative token / unparseable absolute
// instants).
func tsstoreRangeFromSpec(spec RangeSpec) (tsstoreRange, bool) {
	switch spec.Type {
	case "relative":
		if relativeTokenPattern.FindStringSubmatch(strings.TrimSpace(spec.Token)) == nil {
			return tsstoreRange{}, false
		}
		return tsstoreRange{Relative: true, Since: spec.Token}, true
	case "absolute":
		ft, ferr := time.Parse(time.RFC3339, spec.From)
		tt, terr := time.Parse(time.RFC3339, spec.To)
		if ferr != nil || terr != nil {
			return tsstoreRange{}, false
		}
		return tsstoreRange{FromEpoch: ft.Unix(), ToEpoch: tt.Unix()}, true
	default:
		return tsstoreRange{}, false
	}
}

// promRangeFromSpec maps a RangeSpec to Prometheus start/end/step strings.
// Relative intents use the native `now-<token>` / `now` form (parsePromTime
// accepts it); absolute intents use the two RFC3339 instants. step falls back
// to the supplied default (the component's configured step) when the spec
// carries none. Returns ok=false only when a relative token is unparseable.
//
// Relative intents resolve to ABSOLUTE RFC3339 start/end (via
// resolveRelativeToAbsolute) rather than the `now-<token>` string form —
// Prometheus's time parser is backed by Go's time.ParseDuration, which only
// supports up to hours and REJECTS `d`/`w` (so `now-7d`/`now-30d` would error
// and the query would return nothing, not even recent data). Resolving to
// concrete instants sidesteps that entirely.
func promRangeFromSpec(spec RangeSpec, defaultStep string) (start, end, step string, ok bool) {
	step = spec.Step
	if step == "" {
		step = defaultStep
	}
	switch spec.Type {
	case "relative":
		from, to, err := resolveRelativeToAbsolute(spec.Token, time.Now())
		if err != nil {
			return "", "", "", false
		}
		return from, to, step, true
	case "absolute":
		return spec.From, spec.To, step, true
	default:
		return "", "", "", false
	}
}

// rangeAbsolute resolves any RangeSpec to a concrete [from, to] UTC RFC3339
// window. Relative intents resolve against time.Now(); absolute intents are
// normalized to UTC RFC3339 (so adapters get a consistent literal).
func rangeAbsolute(spec RangeSpec) (from, to string, err error) {
	if spec.Type == "relative" {
		return resolveRelativeToAbsolute(spec.Token, time.Now())
	}
	// absolute: normalize to UTC RFC3339 (defensive — pass through on parse fail).
	norm := func(s string) string {
		if t, e := time.Parse(time.RFC3339, s); e == nil {
			return t.UTC().Format(time.RFC3339)
		}
		return s
	}
	return norm(spec.From), norm(spec.To), nil
}

// trailingIdentPattern captures a SQL identifier (optionally dotted/quoted) at
// the END of a string — the column immediately preceding {{range-variable}}.
// Allows surrounding double-quotes/backticks so a quoted column round-trips.
var trailingIdentPattern = regexp.MustCompile(
	"([A-Za-z_\"`][A-Za-z0-9_.\"`]*)\\s*$")

// substituteSQLToken is the single-token (dashboard-variable) entry, preserved
// for the value-discovery call path + tests. Replaces each token occurrence with
// a positional placeholder in occurrence order.
func substituteSQLToken(driver, raw string, value string, hasValue bool) (string, []interface{}, error) {
	if !strings.Contains(raw, DashboardVariableToken) {
		return raw, nil, nil
	}
	if !hasValue {
		return "", nil, ErrDashboardVariableNotSet
	}
	var args []interface{}
	var b strings.Builder
	idx := 1
	for {
		pos := strings.Index(raw, DashboardVariableToken)
		if pos < 0 {
			b.WriteString(raw)
			break
		}
		b.WriteString(raw[:pos])
		b.WriteString(sqlPlaceholder(driver, idx))
		args = append(args, value)
		idx++
		raw = raw[pos+len(DashboardVariableToken):]
	}
	return b.String(), args, nil
}

// substituteAllSQLTokens rewrites BOTH the dashboard-variable token and the
// range token in ONE left-to-right pass, so positional placeholders ($1/$2/$3…)
// number in true occurrence order regardless of interleaving (load-bearing for
// positional drivers — never split into per-token passes).
//
//   - {{dashboard-variable}}        → one placeholder, bound to the variable value.
//   - <col> {{range-variable}}      → `<col> BETWEEN <ph> AND <ph>`, two args
//     (from,to). The column is the identifier immediately to the LEFT of the
//     token, which is consumed from the already-emitted output. A missing/unsafe
//     left identifier → ErrRangeMalformed.
//
// Returns ErrDashboardVariableNotSet / ErrRangeNotSet when a token is present but
// its value/window is absent, so the adapter refuses rather than leaking a token.
func substituteAllSQLTokens(driver, raw string, params map[string]interface{}) (string, []interface{}, error) {
	dvValue, dvHas := dashboardVariableValue(params)
	rangeSpec, rangeOK := resolveRange(params)

	// Up-front presence-vs-value validation for clear errors.
	if strings.Contains(raw, DashboardVariableToken) && !dvHas {
		return "", nil, ErrDashboardVariableNotSet
	}
	if strings.Contains(raw, RangeVariableToken) && !rangeOK {
		return "", nil, ErrRangeNotSet
	}

	var rFrom, rTo string
	if rangeOK {
		f, t, err := rangeAbsolute(rangeSpec)
		if err != nil {
			return "", nil, err
		}
		rFrom, rTo = f, t
	}

	var args []interface{}
	var b strings.Builder
	idx := 1
	for len(raw) > 0 {
		dvPos := strings.Index(raw, DashboardVariableToken)
		rgPos := strings.Index(raw, RangeVariableToken)
		if dvPos < 0 && rgPos < 0 {
			b.WriteString(raw)
			break
		}
		// Pick the earliest token.
		rangeFirst := rgPos >= 0 && (dvPos < 0 || rgPos < dvPos)
		if rangeFirst {
			// Emit text up to the token; the column is the trailing identifier
			// of what we just emitted. Pull it back out of the buffer.
			emitted := b.String() + raw[:rgPos]
			m := trailingIdentPattern.FindStringSubmatchIndex(emitted)
			if m == nil {
				return "", nil, ErrRangeMalformed
			}
			col := emitted[m[2]:m[3]]
			if !IsSafeIdentifier(strings.Trim(col, "\"`")) {
				return "", nil, ErrRangeMalformed
			}
			// Rebuild the buffer without the trailing column, then append the
			// expanded predicate using the column.
			b.Reset()
			b.WriteString(emitted[:m[2]])
			ph1 := sqlPlaceholder(driver, idx)
			ph2 := sqlPlaceholder(driver, idx+1)
			b.WriteString(fmt.Sprintf("%s BETWEEN %s AND %s", col, ph1, ph2))
			args = append(args, rFrom, rTo)
			idx += 2
			raw = raw[rgPos+len(RangeVariableToken):]
		} else {
			b.WriteString(raw[:dvPos])
			b.WriteString(sqlPlaceholder(driver, idx))
			args = append(args, dvValue)
			idx++
			raw = raw[dvPos+len(DashboardVariableToken):]
		}
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

// edgeLakeRangePattern captures the column immediately before the range token:
// `<col> {{range-variable}}`. The column may be dotted/quoted; it's validated
// with IsSafeIdentifier before use.
var edgeLakeRangePattern = regexp.MustCompile(
	"([A-Za-z_\"`][A-Za-z0-9_.\"`]*)\\s*" + regexp.QuoteMeta(RangeVariableToken))

// substituteEdgeLakeRange rewrites `<col> {{range-variable}}` into the
// AnyLog-safe bounded predicate `col >= '<from>' AND col <= '<to>'`. EdgeLake
// has no bind params and rejects much standard date SQL (BETWEEN-with-params,
// EXTRACT, CAST, …) — see the edgelake-sql-restrictions notes — so we emit two
// escaped literal comparisons. Escaping is the sole injection defense (the
// from/to come from the dashboard, but defense-in-depth is cheap). Returns
// ErrRangeNotSet / ErrRangeMalformed mirroring the SQL path.
func substituteEdgeLakeRange(raw string, params map[string]interface{}) (string, error) {
	if !strings.Contains(raw, RangeVariableToken) {
		return raw, nil
	}
	spec, ok := resolveRange(params)
	if !ok {
		return "", ErrRangeNotSet
	}
	from, to, err := rangeAbsolute(spec)
	if err != nil {
		return "", err
	}

	var outErr error
	out := edgeLakeRangePattern.ReplaceAllStringFunc(raw, func(match string) string {
		m := edgeLakeRangePattern.FindStringSubmatch(match)
		col := m[1]
		if !IsSafeIdentifier(strings.Trim(col, "\"`")) {
			outErr = ErrRangeMalformed
			return match
		}
		return fmt.Sprintf("%s >= '%s' AND %s <= '%s'",
			col, escapeEdgeLakeValue(from), col, escapeEdgeLakeValue(to))
	})
	if outErr != nil {
		return "", outErr
	}
	// Any token left unconsumed means it had no valid column to its left.
	if strings.Contains(out, RangeVariableToken) {
		return "", ErrRangeMalformed
	}
	return out, nil
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
