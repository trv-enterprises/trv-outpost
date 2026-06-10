// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"errors"
	"testing"
)

// readOnly is the default policy (all writes denied).
var readOnly = WritePolicy{}

// allWrites opts into every write verb (DDL must STILL be denied).
var allWrites = WritePolicy{AllowInsert: true, AllowUpdate: true, AllowDelete: true}

func verbName(v Verb) string {
	switch v {
	case VerbSelect:
		return "SELECT"
	case VerbInsert:
		return "INSERT"
	case VerbUpdate:
		return "UPDATE"
	case VerbDelete:
		return "DELETE"
	case VerbDDL:
		return "DDL"
	default:
		return "UNKNOWN"
	}
}

// TestClassifyVerb covers the classification matrix from the implementation
// plan — including the nasty literal/comment/CTE/stacked cases.
func TestClassifyVerb(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    Verb
		wantErr error // ErrMultiStatement when expected; nil otherwise
	}{
		{"plain select", "SELECT * FROM t", VerbSelect, nil},
		{"lead ws lower", "   select 1", VerbSelect, nil},
		{"lead block comment", "/* hi */ SELECT 1", VerbSelect, nil},
		{"lead line comment", "-- note\nSELECT 1", VerbSelect, nil},
		{"mixed case", "SeLeCt 1", VerbSelect, nil},
		{"paren wrapped", "(SELECT 1)", VerbSelect, nil},
		{"cte select", "WITH x AS (SELECT 1) SELECT * FROM x", VerbSelect, nil},
		{"multi cte select", "WITH x AS (SELECT 1), y AS (SELECT 2) SELECT * FROM y", VerbSelect, nil},
		{"explain select", "EXPLAIN SELECT 1", VerbSelect, nil},
		{"explain analyze select", "EXPLAIN ANALYZE SELECT 1", VerbSelect, nil},
		{"values", "VALUES (1),(2)", VerbSelect, nil},
		{"show", "SHOW TABLES", VerbSelect, nil},
		{"semicolon in literal", "SELECT 'a; DROP TABLE x' AS c", VerbSelect, nil},
		{"doubled quote literal", "SELECT 'O''Brien; DELETE FROM t'", VerbSelect, nil},
		{"block comment in literal", "SELECT * FROM t WHERE c = '/* not a comment */'", VerbSelect, nil},
		{"line comment in literal", "SELECT * FROM t WHERE c = '-- not a comment'", VerbSelect, nil},
		{"select into", "SELECT * FROM src INTO newtbl", VerbSelect, nil}, // documented: allowed by leading-verb
		{"insert", "INSERT INTO t VALUES (1)", VerbInsert, nil},
		{"insert returning lower", "insert into t values (1) returning id", VerbInsert, nil},
		{"update", "UPDATE t SET c=1", VerbUpdate, nil},
		{"delete", "DELETE FROM t", VerbDelete, nil},
		{"cte delete", "WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT id FROM x)", VerbDelete, nil},
		{"cte insert", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", VerbInsert, nil},
		{"drop", "DROP TABLE t", VerbDDL, nil},
		{"truncate", "TRUNCATE t", VerbDDL, nil},
		{"alter", "ALTER TABLE t ADD COLUMN c int", VerbDDL, nil},
		{"create", "CREATE TABLE t (id int)", VerbDDL, nil},
		{"grant", "GRANT SELECT ON t TO u", VerbDDL, nil},
		{"stacked", "SELECT 1; DROP TABLE t", VerbUnknown, ErrMultiStatement},
		{"comment smuggled 2nd stmt", "SELECT 1 -- ; DROP TABLE t", VerbSelect, nil},
		{"block comment smuggled", "SELECT 1 /* ; DROP TABLE t */", VerbSelect, nil},
		{"trailing semicolon", "SELECT 1;", VerbSelect, nil},
		{"trailing semicolon ws", "SELECT 1 ;  ", VerbSelect, nil},
		{"empty", "", VerbUnknown, nil},
		{"only ws", "   ", VerbUnknown, nil},
		{"only comment", "-- only a comment", VerbUnknown, nil},
		{"explain delete", "EXPLAIN DELETE FROM t", VerbDelete, nil},
		{"merge fail closed", "MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET x=1", VerbDDL, nil},
		{"unknown verb fail closed", "FOOBAR baz", VerbDDL, nil},
		{"multiple lead comments", "/* a */ /* b */ SELECT 1", VerbSelect, nil},
		{"unterminated block comment", "SELECT 1 /* unterminated", VerbSelect, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := classifyVerb(tc.raw)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("classifyVerb(%q) err = %v, want %v", tc.raw, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("classifyVerb(%q) unexpected err = %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("classifyVerb(%q) = %s, want %s", tc.raw, verbName(got), verbName(tc.want))
			}
		})
	}
}

// TestClassifyAndAuthorizeReadOnly asserts the default (all-false) policy:
// reads allowed, every write/DDL/multi-statement denied with the right sentinel.
func TestClassifyAndAuthorizeReadOnly(t *testing.T) {
	cases := []struct {
		raw  string
		want error // nil = allowed
	}{
		{"SELECT * FROM t", nil},
		{"WITH x AS (SELECT 1) SELECT * FROM x", nil},
		{"EXPLAIN SELECT 1", nil},
		{"SELECT 'a; DROP TABLE x'", nil},
		{"INSERT INTO t VALUES (1)", ErrWriteNotAllowed},
		{"UPDATE t SET c=1", ErrWriteNotAllowed},
		{"DELETE FROM t", ErrWriteNotAllowed},
		{"WITH x AS (SELECT 1) DELETE FROM t", ErrWriteNotAllowed},
		{"DROP TABLE t", ErrDDLNotAllowed},
		{"TRUNCATE t", ErrDDLNotAllowed},
		{"GRANT SELECT ON t TO u", ErrDDLNotAllowed},
		{"MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET x=1", ErrDDLNotAllowed},
		{"SELECT 1; DROP TABLE t", ErrMultiStatement},
		{"", ErrUnclassifiable},
		{"-- comment only", ErrUnclassifiable},
	}
	for _, tc := range cases {
		err := ClassifyAndAuthorize(tc.raw, readOnly)
		if tc.want == nil {
			if err != nil {
				t.Errorf("ClassifyAndAuthorize(%q, readOnly) = %v, want allow", tc.raw, err)
			}
			continue
		}
		if !errors.Is(err, tc.want) {
			t.Errorf("ClassifyAndAuthorize(%q, readOnly) = %v, want %v", tc.raw, err, tc.want)
		}
	}
}

// TestClassifyAndAuthorizePolicyOn asserts the flags actually open the gate —
// and that DDL stays denied even with every write flag on.
func TestClassifyAndAuthorizePolicyOn(t *testing.T) {
	if err := ClassifyAndAuthorize("INSERT INTO t VALUES (1)", WritePolicy{AllowInsert: true}); err != nil {
		t.Errorf("INSERT with AllowInsert should be allowed, got %v", err)
	}
	if err := ClassifyAndAuthorize("UPDATE t SET c=1", WritePolicy{AllowUpdate: true}); err != nil {
		t.Errorf("UPDATE with AllowUpdate should be allowed, got %v", err)
	}
	if err := ClassifyAndAuthorize("DELETE FROM t", WritePolicy{AllowDelete: true}); err != nil {
		t.Errorf("DELETE with AllowDelete should be allowed, got %v", err)
	}
	// Insert denied if only update/delete are on.
	if err := ClassifyAndAuthorize("INSERT INTO t VALUES (1)", WritePolicy{AllowUpdate: true, AllowDelete: true}); !errors.Is(err, ErrWriteNotAllowed) {
		t.Errorf("INSERT without AllowInsert should be denied, got %v", err)
	}
	// DDL stays denied under the most permissive policy.
	for _, ddl := range []string{"DROP TABLE t", "ALTER TABLE t ADD c int", "TRUNCATE t", "CREATE TABLE t (id int)", "GRANT ALL ON t TO u"} {
		if err := ClassifyAndAuthorize(ddl, allWrites); !errors.Is(err, ErrDDLNotAllowed) {
			t.Errorf("DDL %q must be denied even with all write flags on, got %v", ddl, err)
		}
	}
}

// TestMustGuard locks in the type-confusion bypass fix: the guard gates on the
// CONNECTION type, and exactly the SQL-running types are guarded. A breach test
// (2026-06-09) found that gating on the client-supplied query.Type let a caller
// set query.Type:"api" on a SQL connection to skip the guard while the SQL
// adapter still ran the statement. These connection types must always guard;
// the rest must not (they can't run raw SQL, so guarding them would wrongly
// reject legitimate non-SQL queries).
func TestMustGuard(t *testing.T) {
	guarded := []string{"sql", "edgelake"}
	notGuarded := []string{"api", "mqtt", "prometheus", "tsstore", "csv", "socket", "frigate", "", "SQL", "sqlx", "EDGELAKE"}

	for _, ct := range guarded {
		if !MustGuard(ct) {
			t.Errorf("connection type %q must be guarded (runs raw SQL)", ct)
		}
	}
	for _, ct := range notGuarded {
		if MustGuard(ct) {
			t.Errorf("connection type %q must NOT be guarded (cannot run raw SQL, or is a non-canonical type string)", ct)
		}
	}
}
