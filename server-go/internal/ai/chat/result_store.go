// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

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

// buildSummary produces the one-line string that takes the place of
// the full result in the model's context. Best effort: it parses the
// raw JSON and looks for common envelope shapes that the toolops
// layer returns (e.g. {connections: [...], count: N}). For unknown
// shapes it falls back to a size-only summary.
//
// The format is consistent: a human-readable description plus the
// result_id at the end so the model knows what to pass to
// get_full_result.
func buildSummary(toolName, resultID, rawResult string) string {
	// Try to parse as JSON for a shape-aware summary.
	var parsed interface{}
	if err := json.Unmarshal([]byte(rawResult), &parsed); err == nil {
		if envelope, ok := parsed.(map[string]interface{}); ok {
			// Common toolops envelope shapes: {<plural-name>: [...], count: N}.
			// Surface the count and the first few item names if present.
			for _, listKey := range []string{"connections", "components", "dashboards", "namespaces"} {
				if items, ok := envelope[listKey].([]interface{}); ok {
					count := len(items)
					if c, ok := envelope["count"].(float64); ok {
						count = int(c)
					}
					sample := sampleNames(items, 5)
					sampleHint := ""
					if len(sample) > 0 {
						sampleHint = fmt.Sprintf(" — first %d: %v", len(sample), sample)
					}
					return fmt.Sprintf(
						"%s returned %d %s%s. Full result stored as %s — call get_full_result(%q) to retrieve everything (note: it's %d bytes, may consume significant context).",
						toolName, count, listKey, sampleHint, resultID, resultID, len(rawResult),
					)
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
			sample := sampleNames(items, 5)
			sampleHint := ""
			if len(sample) > 0 {
				sampleHint = fmt.Sprintf(" — first %d: %v", len(sample), sample)
			}
			return fmt.Sprintf(
				"%s returned a JSON array of %d items%s. Stored as %s (%d bytes) — call get_full_result(%q) for the full content.",
				toolName, len(items), sampleHint, resultID, len(rawResult), resultID,
			)
		}
	}
	// Not JSON or unparseable shape — fall back to size only.
	return fmt.Sprintf(
		"%s returned a large result (%d bytes, not JSON-structured). Stored as %s — call get_full_result(%q) to retrieve.",
		toolName, len(rawResult), resultID, resultID,
	)
}

// sampleNames returns up to `n` "name" strings from a list of items,
// best-effort. Used to give the model a sense of what's in a large
// list without including the full content.
func sampleNames(items []interface{}, n int) []string {
	out := make([]string, 0, n)
	for _, item := range items {
		if len(out) >= n {
			break
		}
		obj, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		for _, key := range []string{"name", "title", "id"} {
			if v, ok := obj[key].(string); ok && v != "" {
				out = append(out, v)
				break
			}
		}
	}
	return out
}
