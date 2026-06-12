// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// TestEscapeEdgeLakeValue is the safety-critical test: EdgeLake has no bind
// params, so escapeEdgeLakeValue is the SOLE injection guard. Verify that no
// input can break out of the surrounding double-quoted AnyLog string literal.
func TestEscapeEdgeLakeValue(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		want  string
	}{
		{"plain", "trv-srv-001", "trv-srv-001"},
		{"empty", "", ""},
		{"double_quote", `a"b`, `a\"b`},
		{"backslash", `a\b`, `a\\b`},
		{"backslash_then_quote", `a\"b`, `a\\\"b`},
		{"leading_quote_breakout_attempt", `" OR 1=1 --`, `\" OR 1=1 --`},
		{"trailing_backslash", `c:\`, `c:\\`},
		{"only_quotes", `""`, `\"\"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := escapeEdgeLakeValue(tc.in)
			if got != tc.want {
				t.Fatalf("escapeEdgeLakeValue(%q) = %q, want %q", tc.in, got, tc.want)
			}
			// Stronger invariant: when the escaped value is dropped into a
			// double-quoted literal, every quote in it must be backslash-escaped
			// (no unescaped " that could terminate the literal early).
			assertNoUnescapedQuote(t, got)
		})
	}
}

// assertNoUnescapedQuote fails if s contains a double-quote that is not preceded
// by an odd number of backslashes (i.e. an unescaped quote that would close the
// surrounding AnyLog string literal).
func assertNoUnescapedQuote(t *testing.T, s string) {
	t.Helper()
	for i := 0; i < len(s); i++ {
		if s[i] != '"' {
			continue
		}
		backslashes := 0
		for j := i - 1; j >= 0 && s[j] == '\\'; j-- {
			backslashes++
		}
		if backslashes%2 == 0 {
			t.Fatalf("unescaped double-quote at index %d in %q — could break out of the AnyLog string literal", i, s)
		}
	}
}

func TestSubstituteEdgeLakeToken(t *testing.T) {
	t.Run("no_token_passthrough", func(t *testing.T) {
		raw := "select * from t where host = 'x'"
		got, err := substituteEdgeLakeToken(raw, "anything", true)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != raw {
			t.Fatalf("expected passthrough, got %q", got)
		}
	})

	t.Run("substitutes_escaped", func(t *testing.T) {
		raw := `select * from t where host = "` + DashboardVariableToken + `"`
		got, err := substituteEdgeLakeToken(raw, `a"b`, true)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if strings.Contains(got, DashboardVariableToken) {
			t.Fatalf("token not substituted: %q", got)
		}
		if !strings.Contains(got, `a\"b`) {
			t.Fatalf("value not escaped in output: %q", got)
		}
	})

	t.Run("unset_value_errors", func(t *testing.T) {
		raw := "select * from t where host = " + DashboardVariableToken
		_, err := substituteEdgeLakeToken(raw, "", false)
		if !errors.Is(err, ErrDashboardVariableNotSet) {
			t.Fatalf("expected ErrDashboardVariableNotSet, got %v", err)
		}
	})
}

// TestSubstituteSQLToken_OrderedBinding guards the deterministic occurrence-order
// binding that replaced the old random-map-order args build. With two or more
// token occurrences, placeholders must be numbered in occurrence order and the
// args slice must carry the value once per occurrence.
func TestSubstituteSQLToken_OrderedBinding(t *testing.T) {
	raw := "select * from t where a = " + DashboardVariableToken + " or b = " + DashboardVariableToken

	// Run repeatedly: a random-map-order regression would surface as flakiness.
	for i := 0; i < 50; i++ {
		gotSQL, args, err := substituteSQLToken("postgres", raw, "v", true)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := "select * from t where a = $1 or b = $2"
		if gotSQL != want {
			t.Fatalf("postgres placeholders = %q, want %q", gotSQL, want)
		}
		if len(args) != 2 || args[0] != "v" || args[1] != "v" {
			t.Fatalf("args = %#v, want two \"v\" values", args)
		}
	}
}

func TestSubstituteSQLToken_Dialects(t *testing.T) {
	raw := "x = " + DashboardVariableToken + " and y = " + DashboardVariableToken
	cases := map[string]string{
		"postgres": "x = $1 and y = $2",
		"mssql":    "x = @p1 and y = @p2",
		"oracle":   "x = :1 and y = :2",
		"mysql":    "x = ? and y = ?",
		"sqlite":   "x = ? and y = ?",
	}
	for driver, want := range cases {
		t.Run(driver, func(t *testing.T) {
			got, args, err := substituteSQLToken(driver, raw, "v", true)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != want {
				t.Fatalf("%s = %q, want %q", driver, got, want)
			}
			if len(args) != 2 {
				t.Fatalf("%s args len = %d, want 2", driver, len(args))
			}
		})
	}
}

func TestSubstituteSQLToken_NoToken(t *testing.T) {
	raw := "select 1"
	got, args, err := substituteSQLToken("postgres", raw, "", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != raw {
		t.Fatalf("expected passthrough, got %q", got)
	}
	if len(args) != 0 {
		t.Fatalf("expected no args, got %#v", args)
	}
}

func TestSubstituteSQLToken_UnsetValueErrors(t *testing.T) {
	raw := "select * from t where a = " + DashboardVariableToken
	_, _, err := substituteSQLToken("postgres", raw, "", false)
	if !errors.Is(err, ErrDashboardVariableNotSet) {
		t.Fatalf("expected ErrDashboardVariableNotSet, got %v", err)
	}
}

// absoluteRange builds a params map carrying an absolute range intent.
func absoluteRange(from, to string) map[string]interface{} {
	return map[string]interface{}{
		RangeParam: map[string]interface{}{"type": "absolute", "from": from, "to": to},
	}
}

// relativeRange builds a params map carrying a relative range intent.
func relativeRange(token string) map[string]interface{} {
	return map[string]interface{}{
		RangeParam: map[string]interface{}{"type": "relative", "token": token},
	}
}

func TestResolveRelativeToAbsolute(t *testing.T) {
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		token    string
		wantFrom string
	}{
		{"1h", "2026-06-11T11:00:00Z"},
		{"24h", "2026-06-10T12:00:00Z"},
		{"7d", "2026-06-04T12:00:00Z"},
		{"30m", "2026-06-11T11:30:00Z"},
		{"2w", "2026-05-28T12:00:00Z"},
	}
	for _, tc := range cases {
		t.Run(tc.token, func(t *testing.T) {
			from, to, err := resolveRelativeToAbsolute(tc.token, now)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if from != tc.wantFrom {
				t.Fatalf("from = %q, want %q", from, tc.wantFrom)
			}
			if to != "2026-06-11T12:00:00Z" {
				t.Fatalf("to = %q, want now", to)
			}
		})
	}
	t.Run("bad_token", func(t *testing.T) {
		if _, _, err := resolveRelativeToAbsolute("nonsense", now); !errors.Is(err, ErrRangeNotSet) {
			t.Fatalf("expected ErrRangeNotSet, got %v", err)
		}
	})
}

func TestResolveRange(t *testing.T) {
	t.Run("absolute", func(t *testing.T) {
		spec, ok := resolveRange(absoluteRange("2026-06-11T00:00:00Z", "2026-06-11T06:00:00Z"))
		if !ok || spec.Type != "absolute" || spec.From == "" || spec.To == "" {
			t.Fatalf("got %+v ok=%v", spec, ok)
		}
	})
	t.Run("relative", func(t *testing.T) {
		spec, ok := resolveRange(relativeRange("1h"))
		if !ok || spec.Type != "relative" || spec.Token != "1h" {
			t.Fatalf("got %+v ok=%v", spec, ok)
		}
	})
	t.Run("missing", func(t *testing.T) {
		if _, ok := resolveRange(map[string]interface{}{}); ok {
			t.Fatal("expected ok=false")
		}
	})
	t.Run("absolute_missing_to", func(t *testing.T) {
		p := map[string]interface{}{RangeParam: map[string]interface{}{"type": "absolute", "from": "x"}}
		if _, ok := resolveRange(p); ok {
			t.Fatal("expected ok=false")
		}
	})
}

// TestSubstituteAllSQLTokens_RangeExpand verifies the column-aware expansion:
// `<col> {{range-variable}}` → `col BETWEEN $1 AND $2` with from/to bound args.
func TestSubstituteAllSQLTokens_RangeExpand(t *testing.T) {
	raw := "SELECT * FROM t WHERE ts " + RangeVariableToken + " ORDER BY ts"
	got, args, err := substituteAllSQLTokens("postgres", raw, absoluteRange("2026-06-11T00:00:00Z", "2026-06-11T06:00:00Z"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "SELECT * FROM t WHERE ts BETWEEN $1 AND $2 ORDER BY ts"
	if got != want {
		t.Fatalf("sql = %q, want %q", got, want)
	}
	if len(args) != 2 || args[0] != "2026-06-11T00:00:00Z" || args[1] != "2026-06-11T06:00:00Z" {
		t.Fatalf("args = %#v, want [from, to]", args)
	}
}

// TestSubstituteAllSQLTokens_Interleaved is the load-bearing test: a range
// condition before a dashboard-variable token must number $1/$2 (range) then $3
// (variable) in true left-to-right occurrence order.
func TestSubstituteAllSQLTokens_Interleaved(t *testing.T) {
	raw := "WHERE ts " + RangeVariableToken + " AND host = " + DashboardVariableToken
	params := absoluteRange("2026-06-11T00:00:00Z", "2026-06-11T06:00:00Z")
	params[DashboardVariableParam] = "trv-srv-001"

	got, args, err := substituteAllSQLTokens("postgres", raw, params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "WHERE ts BETWEEN $1 AND $2 AND host = $3"
	if got != want {
		t.Fatalf("sql = %q, want %q", got, want)
	}
	if len(args) != 3 ||
		args[0] != "2026-06-11T00:00:00Z" ||
		args[1] != "2026-06-11T06:00:00Z" ||
		args[2] != "trv-srv-001" {
		t.Fatalf("args = %#v, want [from, to, host]", args)
	}
}

func TestSubstituteAllSQLTokens_RangeRelativeResolves(t *testing.T) {
	raw := "WHERE ts " + RangeVariableToken
	_, args, err := substituteAllSQLTokens("postgres", raw, relativeRange("1h"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Relative resolves to absolute instants; just confirm two RFC3339 args bound.
	if len(args) != 2 {
		t.Fatalf("args = %#v, want 2", args)
	}
	for _, a := range args {
		if _, perr := time.Parse(time.RFC3339, a.(string)); perr != nil {
			t.Fatalf("arg %q not RFC3339", a)
		}
	}
}

func TestSubstituteAllSQLTokens_RangeUnset(t *testing.T) {
	raw := "WHERE ts " + RangeVariableToken
	_, _, err := substituteAllSQLTokens("postgres", raw, map[string]interface{}{})
	if !errors.Is(err, ErrRangeNotSet) {
		t.Fatalf("expected ErrRangeNotSet, got %v", err)
	}
}

func TestSubstituteAllSQLTokens_RangeMalformed(t *testing.T) {
	// No safe identifier to the left of the token.
	raw := "WHERE (1=1) " + RangeVariableToken
	_, _, err := substituteAllSQLTokens("postgres", raw, absoluteRange("2026-06-11T00:00:00Z", "2026-06-11T06:00:00Z"))
	if !errors.Is(err, ErrRangeMalformed) {
		t.Fatalf("expected ErrRangeMalformed, got %v", err)
	}
}

func TestSubstituteEdgeLakeRange(t *testing.T) {
	t.Run("no_token_passthrough", func(t *testing.T) {
		raw := "select * from t where x = 1"
		got, err := substituteEdgeLakeRange(raw, map[string]interface{}{})
		if err != nil || got != raw {
			t.Fatalf("got (%q, %v), want passthrough", got, err)
		}
	})
	t.Run("expands_predicate", func(t *testing.T) {
		raw := "select * from t where ts " + RangeVariableToken + " limit 10"
		got, err := substituteEdgeLakeRange(raw, absoluteRange("2026-06-11T00:00:00Z", "2026-06-11T06:00:00Z"))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if strings.Contains(got, RangeVariableToken) {
			t.Fatalf("token not substituted: %q", got)
		}
		want := "select * from t where ts >= '2026-06-11T00:00:00Z' AND ts <= '2026-06-11T06:00:00Z' limit 10"
		if got != want {
			t.Fatalf("got %q\nwant %q", got, want)
		}
	})
	t.Run("unset_errors", func(t *testing.T) {
		raw := "where ts " + RangeVariableToken
		if _, err := substituteEdgeLakeRange(raw, map[string]interface{}{}); !errors.Is(err, ErrRangeNotSet) {
			t.Fatalf("expected ErrRangeNotSet, got %v", err)
		}
	})
	t.Run("malformed_errors", func(t *testing.T) {
		raw := "where (x) " + RangeVariableToken
		if _, err := substituteEdgeLakeRange(raw, absoluteRange("2026-06-11T00:00:00Z", "2026-06-11T06:00:00Z")); !errors.Is(err, ErrRangeMalformed) {
			t.Fatalf("expected ErrRangeMalformed, got %v", err)
		}
	})
}

func TestTsstoreRangeFromSpec(t *testing.T) {
	t.Run("relative", func(t *testing.T) {
		tr, ok := tsstoreRangeFromSpec(RangeSpec{Type: "relative", Token: "1h"})
		if !ok || !tr.Relative || tr.Since != "1h" {
			t.Fatalf("got %+v ok=%v", tr, ok)
		}
	})
	t.Run("absolute_epoch", func(t *testing.T) {
		tr, ok := tsstoreRangeFromSpec(RangeSpec{Type: "absolute", From: "2026-06-11T00:00:00Z", To: "2026-06-11T06:00:00Z"})
		if !ok || tr.Relative || tr.FromEpoch != 1781136000 || tr.ToEpoch != 1781157600 {
			t.Fatalf("got %+v ok=%v", tr, ok)
		}
	})
}

func TestPromRangeFromSpec(t *testing.T) {
	// Relative intents resolve to ABSOLUTE RFC3339 start/end (Prometheus rejects
	// d/w in the now-<dur> form), with the step. Verify the window math + step.
	t.Run("relative_1h_with_default_step", func(t *testing.T) {
		start, end, step, ok := promRangeFromSpec(RangeSpec{Type: "relative", Token: "1h"}, "1m")
		if !ok || step != "1m" {
			t.Fatalf("ok=%v step=%q", ok, step)
		}
		s, e := mustRFC3339(t, start), mustRFC3339(t, end)
		if d := e.Sub(s); d != time.Hour {
			t.Fatalf("window = %v, want 1h", d)
		}
	})
	// 7d must NOT fail (the bug was time.ParseDuration rejecting d/w → no data).
	t.Run("relative_7d_resolves", func(t *testing.T) {
		start, end, _, ok := promRangeFromSpec(RangeSpec{Type: "relative", Token: "7d"}, "1h")
		if !ok {
			t.Fatal("7d should resolve to an absolute window")
		}
		s, e := mustRFC3339(t, start), mustRFC3339(t, end)
		if d := e.Sub(s); d != 7*24*time.Hour {
			t.Fatalf("window = %v, want 168h", d)
		}
	})
	t.Run("absolute_with_spec_step", func(t *testing.T) {
		start, end, step, ok := promRangeFromSpec(RangeSpec{Type: "absolute", From: "a", To: "b", Step: "30s"}, "1m")
		if !ok || start != "a" || end != "b" || step != "30s" {
			t.Fatalf("got (%q,%q,%q) ok=%v", start, end, step, ok)
		}
	})
}

func mustRFC3339(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("not RFC3339: %q (%v)", s, err)
	}
	return v
}

func TestDashboardVariableValue(t *testing.T) {
	cases := []struct {
		name      string
		params    map[string]interface{}
		wantValue string
		wantOK    bool
	}{
		{"nil_params", nil, "", false},
		{"missing_key", map[string]interface{}{"other": "x"}, "", false},
		{"nil_value", map[string]interface{}{DashboardVariableParam: nil}, "", false},
		{"empty_string", map[string]interface{}{DashboardVariableParam: ""}, "", false},
		{"string_value", map[string]interface{}{DashboardVariableParam: "trv-srv-001"}, "trv-srv-001", true},
		{"int_value", map[string]interface{}{DashboardVariableParam: 42}, "42", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, ok := dashboardVariableValue(tc.params)
			if v != tc.wantValue || ok != tc.wantOK {
				t.Fatalf("dashboardVariableValue = (%q, %v), want (%q, %v)", v, ok, tc.wantValue, tc.wantOK)
			}
		})
	}
}

func TestResolveFilterParam(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]interface{}
		want   string
	}{
		{"no_filter", map[string]interface{}{}, ""},
		{"empty_filter", map[string]interface{}{"filter": ""}, ""},
		{"literal_filter", map[string]interface{}{"filter": "Warehouse"}, "Warehouse"},
		{
			"token_with_value",
			map[string]interface{}{"filter": DashboardVariableToken, DashboardVariableParam: "Warehouse"},
			"Warehouse",
		},
		{
			// Token but no value supplied → unfiltered, NOT the literal token
			// (which would match nothing in ts-store's substring filter).
			"token_without_value",
			map[string]interface{}{"filter": DashboardVariableToken},
			"",
		},
		{
			"token_with_empty_value",
			map[string]interface{}{"filter": DashboardVariableToken, DashboardVariableParam: ""},
			"",
		},
		{
			// A literal that merely contains the token text is passed through
			// verbatim (only an EXACT token binds to the variable).
			"partial_token_literal",
			map[string]interface{}{"filter": "pre{{dashboard-variable}}", DashboardVariableParam: "X"},
			"pre{{dashboard-variable}}",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveFilterParam(tc.params); got != tc.want {
				t.Fatalf("resolveFilterParam = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDeriveVariableColumn(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		wantOK     bool
		wantColumn string
		wantTable  string
	}{
		{
			name:       "simple_equality_single_table",
			raw:        "SELECT * FROM lab_control_daily WHERE control_id = {{dashboard-variable}} LIMIT 100",
			wantOK:     true,
			wantColumn: "control_id",
			wantTable:  "lab_control_daily",
		},
		{
			name:       "qualified_column",
			raw:        "SELECT * FROM t WHERE t.host = {{dashboard-variable}}",
			wantOK:     true,
			wantColumn: "t.host",
			wantTable:  "t",
		},
		{
			name:       "whitespace_tolerant",
			raw:        "select * from metrics where  site   =   {{dashboard-variable}}",
			wantOK:     true,
			wantColumn: "site",
			wantTable:  "metrics",
		},
		{
			name:   "no_token",
			raw:    "SELECT * FROM t WHERE control_id = 'x'",
			wantOK: false,
		},
		{
			name:       "join_table_ambiguous_table_only",
			raw:        "SELECT * FROM a JOIN b ON a.id=b.id WHERE a.host = {{dashboard-variable}}",
			wantOK:     true,
			wantColumn: "a.host",
			wantTable:  "", // join → don't guess the table
		},
		{
			name:       "comma_multitable_no_table",
			raw:        "SELECT * FROM a, b WHERE a.host = {{dashboard-variable}}",
			wantOK:     true,
			wantColumn: "a.host",
			wantTable:  "",
		},
		{
			name:   "two_different_columns_ambiguous",
			raw:    "SELECT * FROM t WHERE a = {{dashboard-variable}} OR b = {{dashboard-variable}}",
			wantOK: false,
		},
		{
			name:       "two_same_column_ok",
			raw:        "SELECT * FROM t WHERE a = {{dashboard-variable}} OR a = {{dashboard-variable}}",
			wantOK:     true,
			wantColumn: "a",
			wantTable:  "t",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DeriveVariableColumn(tc.raw)
			if got.OK != tc.wantOK {
				t.Fatalf("OK = %v, want %v (got %+v)", got.OK, tc.wantOK, got)
			}
			if !tc.wantOK {
				return
			}
			if got.Column != tc.wantColumn {
				t.Fatalf("Column = %q, want %q", got.Column, tc.wantColumn)
			}
			if got.Table != tc.wantTable {
				t.Fatalf("Table = %q, want %q", got.Table, tc.wantTable)
			}
		})
	}
}

func TestIsSafeIdentifier(t *testing.T) {
	safe := []string{"control_id", "t.host", "schema.tbl.col", "_x", "Col123"}
	unsafe := []string{"", "1col", "a;b", "col)", "a-b", "drop table", `a"b`, "a.b.", ".a"}
	for _, s := range safe {
		if !IsSafeIdentifier(s) {
			t.Errorf("IsSafeIdentifier(%q) = false, want true", s)
		}
	}
	for _, s := range unsafe {
		if IsSafeIdentifier(s) {
			t.Errorf("IsSafeIdentifier(%q) = true, want false", s)
		}
	}
}

func TestBuildDistinctQuery(t *testing.T) {
	cases := []struct {
		driver string
		want   string
	}{
		{"postgres", `SELECT "control_id" FROM "lab_control_daily" GROUP BY "control_id" ORDER BY "control_id" LIMIT 1000`},
		{"sqlite", `SELECT "control_id" FROM "lab_control_daily" GROUP BY "control_id" ORDER BY "control_id" LIMIT 1000`},
		{"mysql", "SELECT `control_id` FROM `lab_control_daily` GROUP BY `control_id` ORDER BY `control_id` LIMIT 1000"},
		{"mssql", `SELECT [control_id] FROM [lab_control_daily] GROUP BY [control_id] ORDER BY [control_id] LIMIT 1000`},
		// EdgeLake: GROUP BY, NO DISTINCT, NO ORDER BY.
		{"edgelake", `SELECT "control_id" FROM "lab_control_daily" GROUP BY "control_id" LIMIT 1000`},
	}
	for _, tc := range cases {
		t.Run(tc.driver, func(t *testing.T) {
			got, err := BuildDistinctQuery(tc.driver, "control_id", "lab_control_daily", 0)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q\nwant %q", got, tc.want)
			}
			if tc.driver == "edgelake" && strings.Contains(got, "ORDER BY") {
				t.Fatalf("edgelake query must not contain ORDER BY: %q", got)
			}
			if strings.Contains(got, "DISTINCT") {
				t.Fatalf("query must use GROUP BY, not DISTINCT: %q", got)
			}
		})
	}
}

func TestBuildDistinctQuery_RejectsUnsafe(t *testing.T) {
	if _, err := BuildDistinctQuery("postgres", "a;drop", "t", 10); err == nil {
		t.Fatal("expected error for unsafe column")
	}
	if _, err := BuildDistinctQuery("postgres", "col", "t;x", 10); err == nil {
		t.Fatal("expected error for unsafe table")
	}
}
