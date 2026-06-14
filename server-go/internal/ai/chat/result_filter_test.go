// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"strings"
	"testing"
)

const listJSON = `{"connections":[` +
	`{"id":"a","name":"Proxmox","type":"api"},` +
	`{"id":"b","name":"Lab DB","type":"sql"},` +
	`{"id":"c","name":"Sensors","type":"mqtt"}],"count":3}`

const queryJSON = `{"columns":["ts","temp"],"rows":[["t0",21.5],["t1",22.0]]}`

func TestFilterResult_ExtractField(t *testing.T) {
	out, err := FilterResult(listJSON, "count")
	if err != nil {
		t.Fatal(err)
	}
	if out != "3" {
		t.Errorf("count = %q, want 3", out)
	}
}

func TestFilterResult_ProjectArray(t *testing.T) {
	out, err := FilterResult(listJSON, "connections.#.name")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Proxmox") || !strings.Contains(out, "Sensors") {
		t.Errorf("project names = %q", out)
	}
}

func TestFilterResult_SelectByField(t *testing.T) {
	out, err := FilterResult(listJSON, `connections.#(type=="sql").name`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Lab DB") || strings.Contains(out, "Proxmox") {
		t.Errorf("select-by-field = %q, want only Lab DB", out)
	}
}

func TestFilterResult_Index(t *testing.T) {
	out, err := FilterResult(queryJSON, "rows.0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "21.5") || strings.Contains(out, "22.0") {
		t.Errorf("rows.0 = %q, want first row only", out)
	}
}

// jq-habit tolerance: leading dot and [N] index still work (the model knows
// jq, not gjson — normalizeGjsonPath bridges the common surface differences).
func TestFilterResult_JqHabitsTolerated(t *testing.T) {
	if out, err := FilterResult(listJSON, ".count"); err != nil || out != "3" {
		t.Errorf("leading-dot .count = %q err=%v", out, err)
	}
	if out, err := FilterResult(queryJSON, "rows[0]"); err != nil || !strings.Contains(out, "21.5") {
		t.Errorf("jq-index rows[0] = %q err=%v", out, err)
	}
	if out, err := FilterResult(queryJSON, ".rows[0].1"); err != nil || !strings.Contains(out, "21.5") {
		t.Errorf("mixed jq habits .rows[0].1 = %q err=%v", out, err)
	}
}

func TestFilterResult_BadPathInstructiveError(t *testing.T) {
	_, err := FilterResult(listJSON, "nope.bad.path")
	if err == nil {
		t.Fatal("expected error for non-matching path")
	}
	// Error must name the valid top-level keys so the model can correct.
	if !strings.Contains(err.Error(), "connections") || !strings.Contains(err.Error(), "count") {
		t.Errorf("error should list top-level keys, got: %v", err)
	}
	if !strings.Contains(err.Error(), "gjson") {
		t.Errorf("error should clarify gjson (not jq) syntax, got: %v", err)
	}
	if !strings.Contains(err.Error(), "OBJECT") {
		t.Errorf("object-root error should say the root is an OBJECT, got: %v", err)
	}
}

// When the result ROOT is a JSON array, a bad object-key filter must get
// array-appropriate guidance — not the old unhelpful "(result root is not an
// object)" (issue #43 follow-up; the layout_dimensions case from the screenshot).
func TestFilterResult_ArrayRootInstructiveError(t *testing.T) {
	arrayJSON := `[{"name":"2K","cols":71},{"name":"HD","cols":53}]`
	_, err := FilterResult(arrayJSON, "layout_dimensions")
	if err == nil {
		t.Fatal("expected error for object-key path against an array root")
	}
	msg := err.Error()
	if !strings.Contains(msg, "ARRAY") {
		t.Errorf("array-root error should say the root is an ARRAY, got: %v", msg)
	}
	if strings.Contains(msg, "not an object") {
		t.Errorf("array-root error must NOT use the old unhelpful wording, got: %v", msg)
	}
	// And a correct array path should work.
	out, err := FilterResult(arrayJSON, "#.name")
	if err != nil || !strings.Contains(out, "2K") {
		t.Errorf("array path '#.name' = %q err=%v", out, err)
	}
}

func TestFilterResult_StillLargeWarns(t *testing.T) {
	// Build a result whose filtered slice exceeds the inline threshold.
	var b strings.Builder
	b.WriteString(`{"rows":[`)
	for i := 0; i < 4000; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`["row-value-padding-xxxxxxxx"]`)
	}
	b.WriteString(`]}`)
	out, err := FilterResult(b.String(), "rows")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) <= LargeResultThresholdBytes {
		t.Skip("test data not large enough to exceed threshold")
	}
	if !strings.HasPrefix(out, "// NOTE:") {
		t.Errorf("oversized filtered result should be prefixed with a size warning, got prefix: %.40q", out)
	}
}
