// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"encoding/json"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// The observed failure (issue #56): the model sent `use_custom_code: "true"`
// and json.Unmarshal into UpdateComponentRequest.UseCustomCode (*bool) rejected
// the whole call. coerceModelScalars must fix it WITHOUT corrupting legitimate
// string values.

func TestCoerceModelScalars_FixesReportedFailure(t *testing.T) {
	// Exactly the shape from the user transcript.
	args := json.RawMessage(`{
		"id": "7e157f78-f16b-4ffe-a1fe-b1a3848d2eb7",
		"title": "Disk I/O (MB/s, last hour)",
		"use_custom_code": "true",
		"component_code": "const Component = () => null;"
	}`)

	var req models.UpdateComponentRequest
	if err := json.Unmarshal(coerceModelScalars(args), &req); err != nil {
		t.Fatalf("unmarshal after coercion failed: %v", err)
	}
	if req.UseCustomCode == nil || *req.UseCustomCode != true {
		t.Fatalf("use_custom_code not coerced to bool true: %+v", req.UseCustomCode)
	}
	if req.ComponentCode == nil || *req.ComponentCode == "" {
		t.Errorf("component_code should be preserved")
	}
}

func TestCoerceModelScalars_BoolVariants(t *testing.T) {
	for _, in := range []string{`"true"`, `"false"`, `true`, `false`} {
		args := json.RawMessage(`{"use_custom_code": ` + in + `}`)
		var req models.UpdateComponentRequest
		if err := json.Unmarshal(coerceModelScalars(args), &req); err != nil {
			t.Errorf("use_custom_code=%s rejected: %v", in, err)
		}
	}
}

func TestCoerceModelScalars_StringifiedInts(t *testing.T) {
	// data_mapping.limit is int; the model stringifying it would fail the same
	// way without coercion.
	args := json.RawMessage(`{"id":"x","data_mapping":{"x_axis":"ts","limit":"500"}}`)
	var req models.UpdateComponentRequest
	if err := json.Unmarshal(coerceModelScalars(args), &req); err != nil {
		t.Fatalf("stringified limit rejected: %v", err)
	}
	if req.DataMapping == nil || req.DataMapping.Limit != 500 {
		t.Fatalf("limit not coerced to int 500: %+v", req.DataMapping)
	}
}

// SAFETY: a legitimate string value that merely LOOKS numeric/boolean must not
// be altered. A filter value of "500" is a string; the x_axis column is a
// string; component_code is a string. None are coercible keys, so all stay
// strings.
func TestCoerceModelScalars_DoesNotCorruptLegitStrings(t *testing.T) {
	args := json.RawMessage(`{
		"id": "abc",
		"data_mapping": {
			"x_axis": "ts",
			"filters": [{"field": "port", "op": "eq", "value": "500"}],
			"y_axis": ["cpu"]
		},
		"component_code": "true"
	}`)
	out := coerceModelScalars(args)

	// Re-decode generically to assert the string-typed leaves stayed strings.
	var m map[string]interface{}
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("re-decode: %v", err)
	}
	dm := m["data_mapping"].(map[string]interface{})
	filters := dm["filters"].([]interface{})
	val := filters[0].(map[string]interface{})["value"]
	if _, ok := val.(string); !ok {
		t.Errorf("filter value '500' must stay a string, became %T (%v)", val, val)
	}
	if code, ok := m["component_code"].(string); !ok || code != "true" {
		t.Errorf("component_code 'true' must stay the string \"true\", got %T %v", m["component_code"], m["component_code"])
	}
}

func TestCoerceModelScalars_PassthroughOnGarbage(t *testing.T) {
	// Non-JSON / empty → returned unchanged so the handler surfaces the error.
	if got := coerceModelScalars(nil); got != nil {
		t.Errorf("nil should pass through, got %s", got)
	}
	bad := json.RawMessage(`{not json`)
	if got := string(coerceModelScalars(bad)); got != `{not json` {
		t.Errorf("invalid json should pass through unchanged, got %s", got)
	}
}
