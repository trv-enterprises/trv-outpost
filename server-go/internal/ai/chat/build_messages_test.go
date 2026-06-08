// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"encoding/json"
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// blockText extracts the text of a text block, or "" if the block is
// not a text block. Used to assert no empty text blocks leak through.
func blockText(b anthropic.ContentBlockParamUnion) (string, bool) {
	if b.OfText != nil {
		return b.OfText.Text, true
	}
	return "", false
}

// assertNoEmptyTextBlocks walks every message and fails if any text
// block is empty — the exact condition the Anthropic API rejects with
// "messages: text content blocks must be non-empty".
func assertNoEmptyTextBlocks(t *testing.T, msgs []anthropic.MessageParam) {
	t.Helper()
	for i, m := range msgs {
		for j, b := range m.Content {
			if txt, isText := blockText(b); isText && txt == "" {
				t.Fatalf("empty text block at message[%d].content[%d] (role=%s) — the API would 400", i, j, m.Role)
			}
		}
	}
}

// TestBuildMessages_EmptyToolCallTurnReplaysWithoutEmptyBlock is the
// regression guard for the resumed-session 400. A tool-call assistant
// turn is persisted with Content="" + a non-empty ToolCalls slice;
// replaying it must NOT produce an empty text block.
func TestBuildMessages_EmptyToolCallTurnReplaysWithoutEmptyBlock(t *testing.T) {
	history := []models.AIMessage{
		{Role: models.AIMessageRoleUser, Content: "who am i?"},
		{
			Role:    models.AIMessageRoleAssistant,
			Content: "", // tool-only turn — the poisoned shape
			ToolCalls: []models.ToolCall{{
				ID:     "toolu_1",
				Name:   "get_current_user",
				Input:  `{}`,
				Output: `{"guid":"abc","name":"Tom"}`,
			}},
		},
		{Role: models.AIMessageRoleAssistant, Content: "You are Tom."},
	}

	msgs := buildMessages(history, "now list my connections")
	assertNoEmptyTextBlocks(t, msgs)

	// Expected replay shape:
	//   user(text) , assistant(tool_use) , user(tool_result) ,
	//   assistant(text) , user(text=new prompt)
	if len(msgs) != 5 {
		t.Fatalf("expected 5 messages, got %d", len(msgs))
	}

	// The tool-call turn must carry a tool_use block and no empty text.
	toolTurn := msgs[1]
	if toolTurn.Role != anthropic.MessageParamRoleAssistant {
		t.Fatalf("msg[1] role = %s, want assistant", toolTurn.Role)
	}
	foundToolUse := false
	for _, b := range toolTurn.Content {
		if b.OfToolUse != nil {
			foundToolUse = true
			if b.OfToolUse.ID != "toolu_1" {
				t.Errorf("tool_use ID = %s, want toolu_1", b.OfToolUse.ID)
			}
		}
	}
	if !foundToolUse {
		t.Error("tool-call turn produced no tool_use block")
	}

	// The paired user turn must carry the matching tool_result.
	resultTurn := msgs[2]
	foundResult := false
	for _, b := range resultTurn.Content {
		if b.OfToolResult != nil {
			foundResult = true
			if b.OfToolResult.ToolUseID != "toolu_1" {
				t.Errorf("tool_result ToolUseID = %s, want toolu_1", b.OfToolResult.ToolUseID)
			}
		}
	}
	if !foundResult {
		t.Error("tool-call turn produced no paired tool_result block")
	}
}

// TestBuildMessages_SkipsEmptyPlainTurns ensures a plain assistant or
// user turn with empty content and no tool calls is dropped rather
// than emitted as an illegal empty text block.
func TestBuildMessages_SkipsEmptyPlainTurns(t *testing.T) {
	history := []models.AIMessage{
		{Role: models.AIMessageRoleUser, Content: ""},      // dropped
		{Role: models.AIMessageRoleAssistant, Content: ""}, // dropped
		{Role: models.AIMessageRoleUser, Content: "hello"},
	}
	msgs := buildMessages(history, "")
	assertNoEmptyTextBlocks(t, msgs)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message (only the non-empty user turn), got %d", len(msgs))
	}
}

// TestBuildMessages_ToolInputRoundTrips confirms the persisted JSON
// string input is handed to the SDK as raw JSON (not re-quoted).
func TestBuildMessages_ToolInputRoundTrips(t *testing.T) {
	input := `{"namespace":"default","limit":10}`
	history := []models.AIMessage{
		{
			Role: models.AIMessageRoleAssistant,
			ToolCalls: []models.ToolCall{{
				ID: "toolu_x", Name: "list_connections", Input: input, Output: "[]",
			}},
		},
	}
	msgs := buildMessages(history, "")
	var found json.RawMessage
	for _, m := range msgs {
		for _, b := range m.Content {
			if b.OfToolUse != nil {
				raw, _ := json.Marshal(b.OfToolUse.Input)
				found = raw
			}
		}
	}
	if len(found) == 0 {
		t.Fatal("no tool_use input found")
	}
	// Re-marshal both sides to normalize key ordering before compare.
	var a, b map[string]any
	if err := json.Unmarshal([]byte(input), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(found, &b); err != nil {
		t.Fatalf("tool input did not round-trip as JSON object: %v (raw=%s)", err, string(found))
	}
	if len(a) != len(b) {
		t.Errorf("tool input keys differ: want %v got %v", a, b)
	}
}
