// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"reflect"
	"strings"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Schema-parity backstop (issue #54). The Chat assistant advertises an
// explicit JSON schema per nested model object. Unlike MCP (which now decodes
// field-complete via decodeInto), the Chat schema is hand-written, so a field
// added to the model is invisible to the agent until someone updates the
// schema — a silent capability gap. These tests reflect over the model's json
// tags and fail when a field is neither advertised in the schema nor listed in
// an explicit, documented allowlist. A new model field then forces a conscious
// choice: expose it to the agent, or allowlist it with a reason.

// schemaPropertyKeys pulls the top-level "properties" map keys out of an inline
// JSON-schema produced by the *Schema() helpers.
func schemaPropertyKeys(t *testing.T, schema map[string]interface{}) map[string]bool {
	t.Helper()
	props, ok := schema["properties"].(map[string]interface{})
	if !ok {
		t.Fatalf("schema has no properties map: %#v", schema)
	}
	keys := make(map[string]bool, len(props))
	for k := range props {
		keys[k] = true
	}
	return keys
}

// modelJSONTags returns the json tag names of every exported field on a struct
// type (skipping "-" and empty tags), bare name without options like ",omitempty".
func modelJSONTags(t *testing.T, v interface{}) []string {
	t.Helper()
	rt := reflect.TypeOf(v)
	if rt.Kind() == reflect.Ptr {
		rt = rt.Elem()
	}
	if rt.Kind() != reflect.Struct {
		t.Fatalf("modelJSONTags: %T is not a struct", v)
	}
	var tags []string
	for i := 0; i < rt.NumField(); i++ {
		tag := rt.Field(i).Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			continue
		}
		tags = append(tags, name)
	}
	return tags
}

// assertParity fails for any model json tag missing from BOTH the schema and
// the allowlist. The allowlist documents fields deliberately not exposed to the
// chat agent (legacy, dataview-internal, or covered by a different mechanism).
func assertParity(t *testing.T, structVal interface{}, schema map[string]interface{}, allow map[string]string) {
	t.Helper()
	keys := schemaPropertyKeys(t, schema)
	for _, tag := range modelJSONTags(t, structVal) {
		if keys[tag] {
			continue
		}
		if _, ok := allow[tag]; ok {
			continue
		}
		t.Errorf("model field %q is on %T but not in the chat schema or the allowlist — "+
			"expose it in the *Schema() helper, or add it to the allowlist with a reason (issue #54)",
			tag, structVal)
	}
}

func TestChartDataMappingSchemaParity(t *testing.T) {
	// Fields intentionally not surfaced on the chat data_mapping schema.
	allow := map[string]string{
		"reference_levels": "legacy scalar band markers — read-only/back-compat; banded_bar uses band_columns",
		"column_aliases":   "dataview-only display renaming; not part of chart authoring",
		"visible_columns":  "dataview-only column selection",
		"column_widths":    "dataview-only per-column pixel widths (UI/per-user layout)",
		"parser":           "per-component streaming extraction config; not yet a chat authoring surface",
	}
	assertParity(t, models.ChartDataMapping{}, chartDataMappingSchema(), allow)
}

func TestDashboardSettingsSchemaParity(t *testing.T) {
	allow := map[string]string{
		"default_view": "viewer default-view mode; not part of dashboard authoring via chat",
	}
	assertParity(t, models.DashboardSettings{}, dashboardSettingsSchema(), allow)
}

func TestChartQueryConfigSchemaParity(t *testing.T) {
	assertParity(t, models.ChartQueryConfig{}, chartQueryConfigSchema(), nil)
}
