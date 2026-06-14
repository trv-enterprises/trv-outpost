// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tidwall/gjson"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// gjsonIndexRe rewrites a jq-style array index "[N]" into the gjson ".N" form,
// so a model that types "rows[0]" out of jq habit still works. Used by
// normalizeGjsonPath.
var gjsonIndexRe = regexp.MustCompile(`\[(\d+)\]`)

// LargeResultThresholdBytes is the cut-off above which a tool result
// is stashed server-side instead of being inlined into the model's
// context. ~8KB ≈ ~2000 Anthropic tokens for typical JSON.
//
// Tuned conservatively. Telemetry from real usage should adjust this
// up or down — too low and we burn round-trips on get_full_result for
// results that would have been fine inline; too high and a single
// list_dashboards call blows the context window (which is exactly
// the problem this whole layer exists to solve).
const LargeResultThresholdBytes = 8 * 1024

// ResultStore handles the "is this result too big to inline, and if
// so, store it server-side and produce a one-line summary"
// pipeline. The chat agent calls Summarize() on every tool output
// before passing the result back to the model.
//
// May be nil — when not wired (tests, partial bootstrap), Summarize
// returns the raw result unchanged, so the chat agent behaves
// exactly like step 2 (no store, no truncation).
type ResultStore struct {
	repo *repository.ChatToolResultRepository
}

// NewResultStore constructs a store from a repository. Pass nil to
// disable the layer entirely.
func NewResultStore(repo *repository.ChatToolResultRepository) *ResultStore {
	if repo == nil {
		return nil
	}
	return &ResultStore{repo: repo}
}

// Summarize returns what the model should see in place of the full
// tool result. If the result is small, it's passed through verbatim.
// If it's large, it's persisted server-side and replaced with a
// one-line summary referencing the stored result by ID.
//
// The model can then call get_full_result(result_id) to retrieve the
// full content if it actually needs it — usually it doesn't, because
// the summary embeds the answer to the most common questions
// ("how many?", "what types?").
func (s *ResultStore) Summarize(ctx context.Context, sessionID, toolName, rawResult string) (string, error) {
	if s == nil || s.repo == nil {
		return rawResult, nil
	}
	if len(rawResult) <= LargeResultThresholdBytes {
		return rawResult, nil
	}

	resultID := "r_" + uuid.New().String()[:8]
	summary := buildSummary(toolName, resultID, rawResult)

	record := &models.ChatToolResult{
		ID:        resultID,
		SessionID: sessionID,
		ToolName:  toolName,
		Summary:   summary,
		FullJSON:  rawResult,
		Bytes:     len(rawResult),
		Created:   time.Now(),
	}
	if err := s.repo.Create(ctx, record); err != nil {
		// On store failure we degrade to "result was too large to
		// inline AND we couldn't persist it." Tell the model that —
		// it's better than silently feeding 200KB of JSON.
		return fmt.Sprintf(
			`{"truncated": true, "tool": %q, "bytes": %d, "error": "result-store write failed; full result not available — narrow your query and try again"}`,
			toolName, len(rawResult),
		), err
	}
	return summary, nil
}

// FetchFull returns the verbatim stored result for a given result ID,
// or an error message suitable for handing to the model when the
// result has expired or never existed.
func (s *ResultStore) FetchFull(ctx context.Context, resultID string) (string, error) {
	if s == nil || s.repo == nil {
		return "", fmt.Errorf("result store not wired")
	}
	rec, err := s.repo.FindByID(ctx, resultID)
	if err != nil {
		return "", err
	}
	if rec == nil {
		return "", fmt.Errorf("result %s not found — it may have expired (24h TTL) or never existed", resultID)
	}
	return rec.FullJSON, nil
}

// ClearSession removes every stored result for the given session.
// Called from the chat agent's Clear-chat path so storage doesn't
// outlive the conversation it belonged to.
func (s *ResultStore) ClearSession(ctx context.Context, sessionID string) error {
	if s == nil || s.repo == nil {
		return nil
	}
	return s.repo.DeleteBySession(ctx, sessionID)
}

// SummaryItemCap bounds how many entries we enumerate in a list
// summary before truncating to a tail count. 50 covers virtually all
// real deployments (typical user has ~10-30 connections / components,
// ~5-15 dashboards) so the model can resolve "find X by name" from
// the summary alone in nearly all cases. The full result is still
// available via get_full_result for pathological sizes.
//
// Token cost per entry is ~30-50 tokens (id + name + type + brief
// metadata). 50 entries ≈ 1500-2500 tokens — comfortably under the
// 8KB threshold that triggered summarization in the first place,
// which means the summary itself stays small even after enrichment.
const SummaryItemCap = 50

// buildSummary produces the string that takes the place of the full
// result in the model's context. Parses common toolops envelope
// shapes and emits a compact {id, name, type, hint} per entry so the
// model can usually answer "find X by name" without round-tripping
// through get_full_result.
//
// Why per-entry detail (vs the previous 5-name preview): when the
// model is looking up "the pi sensehat connection," a 5-name preview
// from a 14-entry list often misses the target and forces a
// get_full_result call. The full per-entry list is still tiny
// compared to inlining the raw 26KB result.
//
// The format always ends with the result_id and a get_full_result
// hint so the model knows the escape hatch is available.
func buildSummary(toolName, resultID, rawResult string) string {
	// Try to parse as JSON for a shape-aware summary.
	var parsed interface{}
	if err := json.Unmarshal([]byte(rawResult), &parsed); err == nil {
		if envelope, ok := parsed.(map[string]interface{}); ok {
			// Common toolops envelope shapes: {<plural-name>: [...], count: N}.
			for _, listKey := range []string{"connections", "components", "dashboards", "namespaces"} {
				if items, ok := envelope[listKey].([]interface{}); ok {
					count := len(items)
					if c, ok := envelope["count"].(float64); ok {
						count = int(c)
					}
					return buildListSummary(toolName, listKey, resultID, items, count, len(rawResult))
				}
			}
			// Other object — describe by top-level keys.
			keys := make([]string, 0, len(envelope))
			for k := range envelope {
				keys = append(keys, k)
				if len(keys) >= 8 {
					break
				}
			}
			return fmt.Sprintf(
				"%s returned a large JSON object with keys: %v. Stored as %s (%d bytes) — call get_full_result(%q) for the full payload.",
				toolName, keys, resultID, len(rawResult), resultID,
			)
		}
		if items, ok := parsed.([]interface{}); ok {
			return buildListSummary(toolName, "items", resultID, items, len(items), len(rawResult))
		}
	}
	// Not JSON or unparseable shape — fall back to size only.
	return fmt.Sprintf(
		"%s returned a large result (%d bytes, not JSON-structured). Stored as %s — call get_full_result(%q) to retrieve.",
		toolName, len(rawResult), resultID, resultID,
	)
}

// buildListSummary renders the {id, name, type, hint}-per-entry block
// used by every list-shaped tool result. Covers up to SummaryItemCap
// entries inline; anything beyond gets a "and N more — call
// get_full_result" tail.
func buildListSummary(toolName, listKey, resultID string, items []interface{}, count, rawBytes int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s returned %d %s.\n", toolName, count, listKey)

	end := len(items)
	if end > SummaryItemCap {
		end = SummaryItemCap
	}
	for i := 0; i < end; i++ {
		entry := summarizeListEntry(items[i])
		if entry == "" {
			continue
		}
		fmt.Fprintf(&b, "- %s\n", entry)
	}
	if len(items) > SummaryItemCap {
		fmt.Fprintf(&b, "- …and %d more entries — call get_full_result(%q) to see them.\n",
			len(items)-SummaryItemCap, resultID)
	}
	fmt.Fprintf(&b,
		"Full result stored as %s (%d bytes) — only call get_full_result(%q) if you need fields beyond what's shown above.",
		resultID, rawBytes, resultID)
	return b.String()
}

// summarizeListEntry renders one item from a list-shaped result. We
// pull the common identifiers (id, name, type) plus a short hint
// (description if short, tags, namespace) so the model can resolve
// "the pi sensehat one" or "the postgres connection" without
// fetching the full record.
//
// Returns "" for items we can't make sense of so the caller can skip.
func summarizeListEntry(item interface{}) string {
	obj, ok := item.(map[string]interface{})
	if !ok {
		return ""
	}

	id := stringField(obj, "id")
	name := stringField(obj, "name")
	if name == "" {
		name = stringField(obj, "title")
	}
	typ := stringField(obj, "type")
	if typ == "" {
		// Components use component_type; dashboards have no type.
		typ = stringField(obj, "component_type")
	}
	if typ == "" {
		typ = stringField(obj, "chart_type")
	}

	parts := []string{}
	if name != "" {
		parts = append(parts, fmt.Sprintf("%q", name))
	}
	if id != "" {
		parts = append(parts, fmt.Sprintf("id=%s", id))
	}
	if typ != "" {
		parts = append(parts, fmt.Sprintf("type=%s", typ))
	}

	// Hint: short description (if <=80 chars), else namespace, else tags.
	hint := ""
	if desc := stringField(obj, "description"); desc != "" && len(desc) <= 80 {
		hint = desc
	} else if ns := stringField(obj, "namespace"); ns != "" && ns != "default" {
		hint = "namespace=" + ns
	}
	if hint == "" {
		if tags := stringArrayField(obj, "tags"); len(tags) > 0 {
			cap := 4
			if len(tags) < cap {
				cap = len(tags)
			}
			hint = "tags=" + strings.Join(tags[:cap], ",")
		}
	}
	if hint != "" {
		parts = append(parts, hint)
	}

	return strings.Join(parts, " · ")
}

// stringField extracts a string value from a map, returning "" when
// missing or wrong-typed.
func stringField(obj map[string]interface{}, key string) string {
	if v, ok := obj[key].(string); ok {
		return v
	}
	return ""
}

// stringArrayField extracts a []string from a map, returning nil
// when missing or wrong-typed. Filters out non-string members.
func stringArrayField(obj map[string]interface{}, key string) []string {
	raw, ok := obj[key].([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, x := range raw {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// normalizeGjsonPath makes the model's filter input tolerant of jq habits.
// The model knows jq far better than gjson, so accept the most common jq-isms
// and translate to gjson path syntax: a leading "." is optional in gjson
// (".rows.0" → "rows.0"), and jq array-index "[0]" → ".0". We do NOT try to
// translate full jq (pipes, select(), map()) — only these surface tweaks; the
// tool description teaches gjson syntax directly.
func normalizeGjsonPath(filter string) string {
	p := strings.TrimSpace(filter)
	p = strings.TrimPrefix(p, ".")
	// "rows[0]" / "rows[0].name" → "rows.0" / "rows.0.name"
	p = gjsonIndexRe.ReplaceAllString(p, ".$1")
	// collapse any accidental double dots from the above
	p = strings.ReplaceAll(p, "..", ".")
	p = strings.TrimPrefix(p, ".")
	return p
}

// FilterResult applies a gjson PATH filter to a stored result's JSON and
// returns the extracted slice. On a non-matching/invalid path it returns an
// instructive error naming the result's top-level keys so the model can
// correct rather than fall back to a full fetch. When the filtered output is
// still over the inline threshold it is returned WITH a one-line size warning
// prepended (no re-store, no loop) — see issue #43.
func FilterResult(full, filter string) (string, error) {
	path := normalizeGjsonPath(filter)
	if path == "" {
		return full, nil // empty filter → whole result (defensive; handler guards too)
	}
	res := gjson.Get(full, path)
	if !res.Exists() {
		return "", fmt.Errorf(
			"filter %q matched nothing. The result uses gjson PATH syntax (not jq). %s",
			filter, shapeHint(full),
		)
	}
	out := res.Raw
	if len(out) > LargeResultThresholdBytes {
		return fmt.Sprintf(
			"// NOTE: filtered result is still ~%dKB — narrow the filter further (e.g. add an index like \".0\" or select a single field) to avoid re-blowing context.\n%s",
			len(out)/1024, out,
		), nil
	}
	return out, nil
}

// shapeHint describes the result's JSON ROOT so a failed filter gets
// shape-appropriate, actionable guidance — an object lists its keys, an ARRAY
// says to use index/wildcard paths (not object-key paths), and a scalar says no
// filter is needed. Earlier this only handled objects and emitted an unhelpful
// "(result root is not an object)" for array roots (issue #43 follow-up).
func shapeHint(full string) string {
	root := gjson.Parse(full)
	switch {
	case root.IsObject():
		var keys []string
		root.ForEach(func(k, _ gjson.Result) bool {
			keys = append(keys, k.String())
			return true
		})
		return fmt.Sprintf(
			"The root is an OBJECT with top-level keys [%s]. Path into one of those, e.g. %q, \"connections.#.name\", \"connections.#(type==\\\"sql\\\").name\". Retry with one of those keys.",
			strings.Join(keys, ", "), firstOr(keys, "somekey"),
		)
	case root.IsArray():
		n := len(root.Array())
		return fmt.Sprintf(
			"The root is an ARRAY of %d item(s) — there are NO top-level keys, so an object-key path won't match. Use index or wildcard paths: \"0\" (first item), \"#\" (count), \"#.<field>\" (a field across all items), \"#(<field>==\\\"x\\\")\" (filter). Retry with one of those.",
			n,
		)
	default:
		return "The root is a single scalar value — it has no sub-fields to filter; omit the filter to get it as-is."
	}
}

// firstOr returns the first element of s, or fallback when s is empty.
func firstOr(s []string, fallback string) string {
	if len(s) > 0 {
		return s[0]
	}
	return fallback
}
