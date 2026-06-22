// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

import "testing"

func deref(b *bool) (bool, bool) {
	if b == nil {
		return false, false
	}
	return *b, true
}

// TestAnnotationsForTool locks in the per-verb behavior hints. The update_*
// case is the reason this exists (issue #111): an update must advertise
// destructiveHint=false + idempotentHint=true so a host's auto-approval logic
// treats a rename as the safe operation it is.
func TestAnnotationsForTool(t *testing.T) {
	cases := []struct {
		name        string
		readOnly    *bool
		destructive *bool
		idempotent  *bool
		openWorld   *bool
	}{
		{"get_component", boolPtr(true), nil, nil, nil},
		{"list_dashboards", boolPtr(true), nil, nil, nil},
		{"create_component", boolPtr(false), boolPtr(false), boolPtr(false), nil},
		{"update_component", boolPtr(false), boolPtr(false), boolPtr(true), nil},
		{"update_connection", boolPtr(false), boolPtr(false), boolPtr(true), nil},
		{"update_dashboard", boolPtr(false), boolPtr(false), boolPtr(true), nil},
		{"delete_component", boolPtr(false), boolPtr(true), boolPtr(true), nil},
		// External-reaching reads stay read-only but flag the open world.
		{"query_connection", boolPtr(true), nil, nil, boolPtr(true)},
		{"test_connection", boolPtr(true), nil, nil, boolPtr(true)},
		{"sample_mqtt_topic", boolPtr(true), nil, nil, boolPtr(true)},
		{"list_mqtt_topics", boolPtr(true), nil, nil, boolPtr(true)},
		{"get_connection_schema", boolPtr(true), nil, nil, boolPtr(true)},
		// Local catalog reads are read-only and closed-world.
		{"list_chart_types", boolPtr(true), nil, nil, nil},
		{"get_type_catalog", boolPtr(true), nil, nil, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := annotationsForTool(tc.name)
			if a == nil {
				t.Fatalf("annotationsForTool(%q) = nil", tc.name)
			}
			checkHint(t, "readOnlyHint", a.ReadOnlyHint, tc.readOnly)
			checkHint(t, "destructiveHint", a.DestructiveHint, tc.destructive)
			checkHint(t, "idempotentHint", a.IdempotentHint, tc.idempotent)
			checkHint(t, "openWorldHint", a.OpenWorldHint, tc.openWorld)
		})
	}
}

func checkHint(t *testing.T, label string, got, want *bool) {
	t.Helper()
	gv, gok := deref(got)
	wv, wok := deref(want)
	if gok != wok || gv != wv {
		t.Errorf("%s = %v (set=%v), want %v (set=%v)", label, gv, gok, wv, wok)
	}
}

// TestEveryRegisteredToolIsAnnotated guards against a future tool whose name
// doesn't match a known verb prefix slipping in unannotated — that would put it
// back on the host's name/value heuristic, the exact failure mode of #111.
func TestEveryRegisteredToolIsAnnotated(t *testing.T) {
	// Services are unused during registration (handlers only run on call), so
	// nils are fine for enumerating the registered tool set.
	r := NewToolRegistry(nil, nil, nil, nil, nil, nil, nil)
	for _, tool := range r.GetTools() {
		if tool.Annotations == nil {
			t.Errorf("tool %q has no annotations — add its verb to annotationsForTool", tool.Name)
			continue
		}
		if tool.Annotations.ReadOnlyHint == nil {
			t.Errorf("tool %q has no readOnlyHint", tool.Name)
		}
	}
}
