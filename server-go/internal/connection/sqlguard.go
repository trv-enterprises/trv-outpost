// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"errors"
	"strings"
)

// Server-side SQL verb guard for the /query endpoint.
//
// THREAT MODEL: POST /api/connections/:id/query executes client-supplied
// SQL. It is intentionally a no-capability read endpoint (View Mode renders
// every non-streaming chart through it), so it cannot be defended by
// identity/capability gating. The realistic attack is a REPLAY / body-tamper:
// an attacker intercepts a legitimate authenticated /query request and swaps
// `raw` with an INSERT/UPDATE/DELETE/DROP. The only defense is the server
// REFUSING to execute non-allowed verbs — which is what this guard does.
//
// POLICY: SELECT (and WITH/CTE resolving to a read) is always allowed.
// INSERT/UPDATE/DELETE are denied unless an admin has opted into that verb
// (see WritePolicy). DDL (DROP/ALTER/TRUNCATE/CREATE/GRANT/...) and any
// unrecognized leading keyword are ALWAYS denied — fail closed. Multi-
// statement bodies (`;`-chained) are rejected outright.
//
// This guard classifies `query.Raw` BEFORE dashboard-variable substitution,
// which is safe: for SQL the variable is bound as a placeholder param and for
// EdgeLake it is escaped, so the variable value can never introduce a verb.
// The verb always lives in Raw. The classifier is comment- and literal-aware
// so smuggled statements (`-- ; DROP`, `'a; DROP'`) cannot fool it.

// WritePolicy is the resolved admin posture for write verbs. The zero value
// (all false) is strict read-only — the safe default when the policy is
// unwired or a setting can't be read.
type WritePolicy struct {
	AllowInsert bool
	AllowUpdate bool
	AllowDelete bool
}

// Verb is the classified leading operation of a single SQL statement.
type Verb int

const (
	// VerbSelect is a read: SELECT, VALUES, SHOW, TABLE, a WITH/CTE that
	// resolves to a read, or an EXPLAIN/ANALYZE of any of those.
	VerbSelect Verb = iota
	VerbInsert
	VerbUpdate
	VerbDelete
	// VerbDDL is any schema/permission/other write statement that has no
	// opt-in flag (DROP/ALTER/TRUNCATE/CREATE/GRANT/... and, deliberately,
	// MERGE/REPLACE/UPSERT and every unrecognized keyword — fail closed).
	VerbDDL
	// VerbUnknown is an empty or unclassifiable body (e.g. only a comment).
	VerbUnknown
)

// Sentinel errors. QueryConnection collapses these to a single client-facing
// ErrorCode; they stay distinct so logs and tests can tell them apart.
var (
	ErrMultiStatement  = errors.New("multiple SQL statements are not allowed")
	ErrWriteNotAllowed = errors.New("write operations are not permitted on this connection")
	ErrDDLNotAllowed   = errors.New("schema-changing (DDL) statements are never permitted")
	ErrUnclassifiable  = errors.New("could not classify SQL statement")
)

// ClassifyAndAuthorize is the single entry point. It rejects multi-statement
// bodies, classifies the leading verb, and applies policy. Returns nil when
// the statement is allowed to run.
func ClassifyAndAuthorize(raw string, policy WritePolicy) error {
	verb, err := classifyVerb(raw)
	if err != nil {
		return err // ErrMultiStatement
	}
	switch verb {
	case VerbSelect:
		return nil
	case VerbInsert:
		if policy.AllowInsert {
			return nil
		}
		return ErrWriteNotAllowed
	case VerbUpdate:
		if policy.AllowUpdate {
			return nil
		}
		return ErrWriteNotAllowed
	case VerbDelete:
		if policy.AllowDelete {
			return nil
		}
		return ErrWriteNotAllowed
	case VerbDDL:
		return ErrDDLNotAllowed
	default: // VerbUnknown
		return ErrUnclassifiable
	}
}

// classifyVerb splits the body into statements (comment- and literal-aware),
// requires exactly one non-empty statement, and returns its leading verb.
// Returns ErrMultiStatement when more than one statement is present.
func classifyVerb(raw string) (Verb, error) {
	statements := splitStatements(raw)
	nonEmpty := statements[:0]
	for _, s := range statements {
		if strings.TrimSpace(s) != "" {
			nonEmpty = append(nonEmpty, s)
		}
	}
	if len(nonEmpty) == 0 {
		return VerbUnknown, nil
	}
	if len(nonEmpty) > 1 {
		return VerbUnknown, ErrMultiStatement
	}
	return leadingVerb(nonEmpty[0]), nil
}

// scanner states for splitStatements.
const (
	stNormal = iota
	stSQuote // inside a '...' string literal
	stDQuote // inside a "..." quoted identifier
	stLine   // inside a -- line comment
	stBlock  // inside a /* ... */ block comment
)

// splitStatements performs a single literal- and comment-aware linear scan,
// breaking the input on top-level `;`. Comments are collapsed to a single
// space (so a keyword smuggled inside a comment never reaches classification
// and never counts as a statement). String/identifier literals are tracked —
// including '' and "" escape-doubling — so a `;` or keyword inside a literal
// is preserved and does not split the body.
func splitStatements(raw string) []string {
	var statements []string
	var cur strings.Builder
	state := stNormal
	runes := []rune(raw)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		var next rune
		if i+1 < len(runes) {
			next = runes[i+1]
		}
		switch state {
		case stNormal:
			switch {
			case c == '\'':
				state = stSQuote
				cur.WriteRune(c)
			case c == '"':
				state = stDQuote
				cur.WriteRune(c)
			case c == '-' && next == '-':
				state = stLine
				i++ // consume the second '-'
			case c == '/' && next == '*':
				state = stBlock
				i++ // consume the '*'
			case c == ';':
				statements = append(statements, cur.String())
				cur.Reset()
			default:
				cur.WriteRune(c)
			}
		case stSQuote:
			cur.WriteRune(c)
			if c == '\'' {
				if next == '\'' { // '' escaped quote, stay in literal
					cur.WriteRune(next)
					i++
				} else {
					state = stNormal
				}
			}
		case stDQuote:
			cur.WriteRune(c)
			if c == '"' {
				if next == '"' { // "" escaped quote, stay in identifier
					cur.WriteRune(next)
					i++
				} else {
					state = stNormal
				}
			}
		case stLine:
			if c == '\n' {
				state = stNormal
				cur.WriteRune(' ') // comment becomes whitespace
			}
			// else swallow the comment character
		case stBlock:
			if c == '*' && next == '/' {
				state = stNormal
				i++ // consume the '/'
				cur.WriteRune(' ')
			}
			// else swallow the comment character
		}
	}
	statements = append(statements, cur.String())
	return statements
}

// readKeywords used to skip read-only statement prefixes that don't change
// the operative verb (EXPLAIN SELECT, EXPLAIN ANALYZE DELETE, etc.).
var prefixKeywords = map[string]bool{
	"EXPLAIN": true, "ANALYZE": true, "VERBOSE": true,
	"DESC": true, "DESCRIBE": true,
}

// leadingVerb classifies a single statement (comments already collapsed by
// splitStatements). It strips leading whitespace and a wrapping '(' and any
// EXPLAIN/ANALYZE/DESCRIBE prefix, then maps the first keyword to a Verb.
// Unknown leading keywords fall through to VerbDDL — fail closed.
func leadingVerb(stmt string) Verb {
	s := stmt
	// Skip read-only prefixes (possibly several: EXPLAIN ANALYZE VERBOSE ...).
	for {
		s = trimLeadingNoise(s)
		word, rest := firstWord(s)
		if word == "" {
			return VerbUnknown
		}
		if prefixKeywords[word] {
			s = rest
			continue
		}
		switch word {
		case "SELECT", "VALUES", "SHOW", "TABLE":
			return VerbSelect
		case "WITH":
			return resolveCTE(s)
		case "INSERT":
			return VerbInsert
		case "UPDATE":
			return VerbUpdate
		case "DELETE":
			return VerbDelete
		default:
			// DROP/ALTER/TRUNCATE/CREATE/GRANT/REVOKE/RENAME/COMMENT/MERGE/
			// REPLACE/UPSERT/COPY/CALL/SET/LOCK/VACUUM/... and anything we
			// don't recognize: hard-deny.
			return VerbDDL
		}
	}
}

// resolveCTE classifies a `WITH ...` statement by its operative verb. A WITH
// prelude is one or more "name [(cols)] AS ( ... )" blocks (the parenthesized
// subqueries may themselves contain SELECT/INSERT/etc., which we must NOT
// classify on), followed by the operative SELECT/INSERT/UPDATE/DELETE. We skip
// every balanced-paren group at depth 0 and the CTE-list commas, then take the
// first keyword that appears at paren depth 0 outside a CTE definition.
//
// `s` begins right after the WITH keyword. The scan is already safe from
// literals/comments because splitStatements ran first, but parentheses inside
// string literals would still mislead a naive depth counter — so we re-track
// single-quote literals here too.
func resolveCTE(s string) Verb {
	runes := []rune(s)
	depth := 0
	inSQuote := false
	i := 0
	for i < len(runes) {
		c := runes[i]
		switch {
		case inSQuote:
			if c == '\'' {
				if i+1 < len(runes) && runes[i+1] == '\'' {
					i += 2
					continue
				}
				inSQuote = false
			}
		case c == '\'':
			inSQuote = true
		case c == '(':
			depth++
		case c == ')':
			if depth > 0 {
				depth--
			}
		case depth == 0 && isWordStart(c):
			word, _ := firstWord(string(runes[i:]))
			switch word {
			case "SELECT", "VALUES":
				return VerbSelect
			case "INSERT":
				return VerbInsert
			case "UPDATE":
				return VerbUpdate
			case "DELETE":
				return VerbDelete
			case "AS", "RECURSIVE", "MATERIALIZED":
				// part of the CTE prelude — skip this word and continue
				i += len([]rune(word))
				continue
			default:
				// A CTE name (identifier) or comma — advance past the word
				// and keep scanning for the operative verb.
				i += len([]rune(word))
				continue
			}
		}
		i++
	}
	// WITH with no operative verb found at depth 0 — unclassifiable, fail closed.
	return VerbDDL
}

// trimLeadingNoise strips leading whitespace and a single wrapping '(' so
// "(SELECT 1)" classifies as SELECT.
func trimLeadingNoise(s string) string {
	s = strings.TrimLeftFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v'
	})
	for strings.HasPrefix(s, "(") {
		s = strings.TrimLeftFunc(s[1:], func(r rune) bool {
			return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v'
		})
	}
	return s
}

// firstWord returns the leading alphabetic keyword (upper-cased) and the rest
// of the string after it. Non-letters terminate the word.
func firstWord(s string) (word, rest string) {
	s = strings.TrimLeftFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v'
	})
	i := 0
	runes := []rune(s)
	for i < len(runes) && isWordChar(runes[i]) {
		i++
	}
	if i == 0 {
		return "", s
	}
	return strings.ToUpper(string(runes[:i])), string(runes[i:])
}

func isWordStart(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}

func isWordChar(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_'
}

// GuardErrorMessage maps a guard sentinel error to a clear, user-facing
// message for QueryResponse.Error. Non-guard errors pass through unchanged.
func GuardErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrDDLNotAllowed):
		return "Schema-changing statements (DROP, ALTER, CREATE, TRUNCATE, GRANT, …) are never permitted through the dashboard query endpoint."
	case errors.Is(err, ErrWriteNotAllowed):
		return "This connection is read-only. INSERT, UPDATE, and DELETE are disabled by the administrator."
	case errors.Is(err, ErrMultiStatement):
		return "Only a single SQL statement may be executed per query."
	case errors.Is(err, ErrUnclassifiable):
		return "The query could not be recognized as a valid read statement and was refused."
	default:
		return err.Error()
	}
}
