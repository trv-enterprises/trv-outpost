// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"encoding/json"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Regression for #71: the chat schema advertised the filter config under the
// key "filter", but the model field is FilterValue (json:"filter_value"). The
// mismatch meant a chat-created filter variable's whole config (value_source,
// value_column, value_table, default) was silently DROPPED on unmarshal,
// falling back to static "from list". This asserts the key the schema now uses
// actually populates the model.
func TestFilterVariableUnmarshalsUnderFilterValueKey(t *testing.T) {
	// Shape the agent emits per the (fixed) chat dashboardVariablesSchema.
	args := []byte(`{
		"name": "dashboard-variable",
		"label": "Location",
		"mode": "filter",
		"filter_value": {
			"value_source": "connection",
			"value_table": "readings",
			"value_column": "location",
			"default_value": "Server-Room"
		}
	}`)

	var v models.DashboardVariable
	if err := json.Unmarshal(args, &v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if v.FilterValue == nil {
		t.Fatal("FilterValue is nil — the filter config was dropped (key mismatch regressed)")
	}
	if v.FilterValue.ValueSource != "connection" {
		t.Errorf("value_source = %q, want connection", v.FilterValue.ValueSource)
	}
	if v.FilterValue.ValueColumn != "location" || v.FilterValue.ValueTable != "readings" {
		t.Errorf("value_column/value_table dropped: %+v", v.FilterValue)
	}
}

// Guard the trap directly: the OLD wrong key "filter" must NOT populate the
// model (so if someone reintroduces it in the schema, this documents why it
// fails silently).
func TestFilterVariableWrongKeyIsDropped(t *testing.T) {
	args := []byte(`{"name":"dashboard-variable","mode":"filter","filter":{"value_source":"connection"}}`)
	var v models.DashboardVariable
	if err := json.Unmarshal(args, &v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if v.FilterValue != nil {
		t.Error("the bare 'filter' key should NOT populate FilterValue — model tag is filter_value")
	}
}
