package handlers

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// A color light sends a composite object rather than a scalar, which a
// key/value template cannot express -- see CommandDef.PassthroughValue.
func TestPassthroughPayload(t *testing.T) {
	composite := map[string]interface{}{
		"state":      "ON",
		"brightness": 120,
		"color":      map[string]interface{}{"hex": "#ffd300"},
	}

	t.Run("publishes the object verbatim when asked", func(t *testing.T) {
		got, ok := passthroughPayload(models.CommandDef{PassthroughValue: true}, composite)
		if !ok {
			t.Fatal("expected passthrough to apply")
		}
		if got["state"] != "ON" {
			t.Errorf("state = %v, want ON", got["state"])
		}
		color, isMap := got["color"].(map[string]interface{})
		if !isMap || color["hex"] != "#ffd300" {
			t.Errorf("nested color lost: %#v", got["color"])
		}
	})

	t.Run("is inert unless the flag is set", func(t *testing.T) {
		if _, ok := passthroughPayload(models.CommandDef{}, composite); ok {
			t.Error("passthrough applied without the flag")
		}
	})

	t.Run("falls back for scalars, which cannot be an object payload", func(t *testing.T) {
		for _, v := range []interface{}{"ON", 42, true, nil} {
			if _, ok := passthroughPayload(models.CommandDef{PassthroughValue: true}, v); ok {
				t.Errorf("passthrough applied to scalar %#v", v)
			}
		}
	})

	t.Run("falls back for an empty object", func(t *testing.T) {
		if _, ok := passthroughPayload(models.CommandDef{PassthroughValue: true}, map[string]interface{}{}); ok {
			t.Error("passthrough applied to an empty object")
		}
	})
}

// Guards the pre-existing template path against regression from the
// passthrough change: a scalar command must still interpolate as before.
func TestInterpolateSchemaTemplateStillHandlesScalars(t *testing.T) {
	tmpl := map[string]interface{}{"brightness": "{{value}}"}
	got := interpolateSchemaTemplate(tmpl, 120, "zigbee2mqtt/lamp/set")
	if got["brightness"] != 120 {
		t.Errorf("brightness = %#v, want 120", got["brightness"])
	}
}
