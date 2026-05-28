// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import "testing"

// Step 14.6 — verifies the in-cycle loop detector. Catches the
// (tool_name, args) duplicate pattern that burned turns in the
// 2026-05-26 get_full_result cycle and could bite again with any
// future tool.

func TestToolCallFingerprint_StableForSameInputs(t *testing.T) {
	a := toolCallFingerprint("list_connections", []byte(`{}`))
	b := toolCallFingerprint("list_connections", []byte(`{}`))
	if a != b {
		t.Errorf("same name+args should fingerprint identically; got %q vs %q", a, b)
	}
}

func TestToolCallFingerprint_DiffersByName(t *testing.T) {
	a := toolCallFingerprint("list_connections", []byte(`{}`))
	b := toolCallFingerprint("list_dashboards", []byte(`{}`))
	if a == b {
		t.Errorf("different tool names should fingerprint differently; both %q", a)
	}
}

func TestToolCallFingerprint_DiffersByArgs(t *testing.T) {
	a := toolCallFingerprint("query_connection", []byte(`{"id":"a"}`))
	b := toolCallFingerprint("query_connection", []byte(`{"id":"b"}`))
	if a == b {
		t.Errorf("different args should fingerprint differently; both %q", a)
	}
}

func TestIsDuplicateRecent(t *testing.T) {
	window := []string{"a", "b", "c"}
	if !isDuplicateRecent(window, "b") {
		t.Error("expected duplicate detected for fingerprint in window")
	}
	if isDuplicateRecent(window, "d") {
		t.Error("expected no duplicate for fingerprint not in window")
	}
	if isDuplicateRecent(nil, "anything") {
		t.Error("empty window should never report duplicates")
	}
}

func TestAppendBounded_GrowsThenSlides(t *testing.T) {
	cap := 3
	w := []string{}
	w = appendBounded(w, "a", cap)
	w = appendBounded(w, "b", cap)
	w = appendBounded(w, "c", cap)
	if len(w) != 3 || w[0] != "a" || w[2] != "c" {
		t.Fatalf("grow: expected [a b c], got %v", w)
	}
	// Fourth push should drop "a" and append "d".
	w = appendBounded(w, "d", cap)
	if len(w) != 3 || w[0] != "b" || w[2] != "d" {
		t.Fatalf("slide: expected [b c d], got %v", w)
	}
}

func TestAppendBounded_RespectsCap(t *testing.T) {
	w := []string{}
	for i := 0; i < 100; i++ {
		w = appendBounded(w, "x", loopDetectorWindow)
		if len(w) > loopDetectorWindow {
			t.Fatalf("window grew past cap (%d) — len=%d", loopDetectorWindow, len(w))
		}
	}
}
