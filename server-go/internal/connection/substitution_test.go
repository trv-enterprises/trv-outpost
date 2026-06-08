// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"errors"
	"strings"
	"testing"
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
