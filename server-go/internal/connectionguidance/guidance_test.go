// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connectionguidance

import "testing"

func TestGet_ExactKey(t *testing.T) {
	g, ok := Get("api.prometheus")
	if !ok {
		t.Fatal("expected dedicated guidance for api.prometheus")
	}
	if g == "" {
		t.Fatal("expected non-empty guidance text")
	}
}

func TestGet_SuffixAlias(t *testing.T) {
	// Agents (esp. external MCP clients) pass the bare last segment.
	cases := map[string]string{
		"prometheus": "api.prometheus",
		"tsstore":    "store.tsstore",
		"mqtt":       "stream.mqtt",
		"edgelake":   "api.edgelake",
		"rest":       "api.rest",
		"csv":        "file.csv",
	}
	for alias, full := range cases {
		aliasText, aliasOK := Get(alias)
		if !aliasOK {
			t.Errorf("alias %q: expected guidance, got fallback", alias)
			continue
		}
		fullText, _ := Get(full)
		if aliasText != fullText {
			t.Errorf("alias %q resolved to different text than %q", alias, full)
		}
	}
}

func TestGet_UnknownType(t *testing.T) {
	_, ok := Get("does-not-exist")
	if ok {
		t.Fatal("expected has_entry=false for unknown type")
	}
}

func TestSuffixAlias_NoAmbiguousEntries(t *testing.T) {
	// Defensive: if two keyed types ever share a suffix, the alias
	// table must omit it rather than silently pick one. This proves
	// the dedup logic and flags the day a new collision is added.
	counts := map[string]int{}
	for k := range guidance {
		counts[suffixOf(k)]++
	}
	for alias := range suffixAlias {
		if counts[alias] != 1 {
			t.Errorf("ambiguous suffix %q leaked into alias table (count=%d)", alias, counts[alias])
		}
	}
}
