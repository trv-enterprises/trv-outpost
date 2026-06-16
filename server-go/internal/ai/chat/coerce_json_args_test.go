// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"encoding/json"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Regression guard for issue #78 on the Dashboard Assistant tool path:
// the model sometimes sends typed-object args (data_mapping / query_config
// / options) as JSON strings, which made the typed Unmarshal fail and the
// create/update reject. coerceStringifiedJSONFields repairs that pre-decode.
func TestCoerceStringifiedJSONFields_Chat(t *testing.T) {
	args := json.RawMessage(`{
		"name":"CPU",
		"component_type":"chart",
		"chart_type":"line",
		"query_config":"{\"raw\":\"SELECT 1\",\"type\":\"sql\"}",
		"data_mapping":"{\"x_axis\":\"ts\",\"y_axis\":[\"v\"]}"
	}`)
	out := coerceStringifiedJSONFields(args)

	var req models.CreateComponentRequest
	if err := json.Unmarshal(out, &req); err != nil {
		t.Fatalf("unmarshal after coerce failed (the original bug): %v", err)
	}
	if req.QueryConfig == nil || req.QueryConfig.Raw != "SELECT 1" {
		t.Errorf("query_config not coerced: %+v", req.QueryConfig)
	}
	if req.DataMapping == nil || req.DataMapping.XAxis != "ts" {
		t.Errorf("data_mapping not coerced: %+v", req.DataMapping)
	}
	if req.ChartType != "line" {
		t.Errorf("chart_type mangled: %q", req.ChartType)
	}
}

func TestCoerceStringifiedJSONFields_LeavesPlainAndSQL(t *testing.T) {
	args := json.RawMessage(`{
		"raw":"SELECT * FROM t WHERE j->>'k'='1'",
		"data_mapping":{"x_axis":"ts"},
		"weird":"{not json"
	}`)
	out := coerceStringifiedJSONFields(args)
	var m map[string]json.RawMessage
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	var raw, weird string
	if err := json.Unmarshal(m["raw"], &raw); err != nil || raw == "" {
		t.Errorf("SQL raw was mangled: %s", m["raw"])
	}
	if err := json.Unmarshal(m["weird"], &weird); err != nil {
		t.Errorf("invalid-json string was mangled: %s", m["weird"])
	}
}
