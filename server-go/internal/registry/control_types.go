// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

// Control type registrations. This is the backend mirror of the frontend
// controlTypes.js CONTROL_TYPE_INFO map. When adding or editing a control
// type you must update both files — the frontend for rendering, this file
// for discovery (AI builder, MCP server, /api/meta/types).
//
// Eventually this will flip: control type metadata will come from the
// registry (optionally MongoDB-backed) and the frontend will fetch it at
// runtime. The frontend React component itself will always be code.
//
// Icons are stored as MDI constant names ("mdiGestureTap", not "gesture-tap").
// The frontend resolves them to SVG paths at render time via @mdi/js.

func init() {
	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.button",
		Category:    CategoryControl,
		Subtype:     "button",
		DisplayName: "Button",
		Description: "Simple action button that triggers a command when clicked.",
		Icon:        "mdiGestureTap",
		UICategory:  "carbon",
		Capabilities: ComponentCapabilities{
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
		},
		DefaultConfig: map[string]interface{}{
			"label": "Execute",
			"kind":  "primary",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.toggle",
		Category:    CategoryControl,
		Subtype:     "toggle",
		DisplayName: "Toggle",
		Description: "On/off switch that sends true or false and subscribes to live state.",
		Icon:        "mdiToggleSwitch",
		UICategory:  "carbon",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Enable",
			"offLabel":    "Disable",
			"state_field": "state",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.slider",
		Category:    CategoryControl,
		Subtype:     "slider",
		DisplayName: "Slider",
		Description: "Numeric slider for setting values within a range. Reads live state and writes command values.",
		Icon:        "mdiTuneVertical",
		UICategory:  "carbon",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Value",
			"min":         0,
			"max":         100,
			"step":        1,
			"state_field": "value",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.text_input",
		Category:    CategoryControl,
		Subtype:     "text_input",
		DisplayName: "Text Input",
		Description: "Text field for entering custom values or commands.",
		Icon:        "mdiFormTextbox",
		UICategory:  "carbon",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Command",
			"placeholder": "Enter value...",
			"submitLabel": "Send",
			"state_field": "value",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.switch",
		Category:    CategoryControl,
		Subtype:     "switch",
		DisplayName: "Switch",
		Description: "On/off switch with HomeKit-style pill design.",
		Icon:        "mdiPowerPlug",
		UICategory:  "custom",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Switch",
			"onLabel":     "On",
			"offLabel":    "Off",
			"state_field": "state",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.dimmer",
		Category:    CategoryControl,
		Subtype:     "dimmer",
		DisplayName: "Dimmer",
		Description: "Vertical slider for dimming lights — drag to set level.",
		Icon:        "mdiLightbulbOn",
		UICategory:  "custom",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Light",
			"min":         0,
			"max":         100,
			"step":        1,
			"state_field": "level",
			// Zigbee brightness is 0-254; without this the control sends 50
			// for "50%" (really 20%) and reads the echo back as a percent.
			"device_scale": 254,
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.garage_door",
		Category:    CategoryControl,
		Subtype:     "garage_door",
		DisplayName: "Garage Door",
		Description: "Full-size animated garage door showing open/closed state from a contact sensor. Read-only.",
		Icon:        "mdiGarage",
		UICategory:  "custom",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Garage",
			"state_field": "contact",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.light",
		Category:    CategoryControl,
		Subtype:     "light",
		DisplayName: "Light",
		Description: "Colour bulb control: power, brightness, and colour. Colour is written as hex and read back from the device as CIE xy.",
		Icon:        "mdiLightbulbOn",
		UICategory:  "carbon",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":           "Light",
			"state_field":     "state",
			"show_brightness": true,
			"show_color":      true,
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.tile_light",
		Category:    CategoryControl,
		Subtype:     "tile_light",
		DisplayName: "Tile Light",
		Description: "Compact tile for a colour bulb. Fill height is brightness and the fill takes the light's live colour; the colour swatch sits on the tile face. Shows a motion dot when the device reports occupancy.",
		Icon:        "mdiLightbulbNight",
		UICategory:  "tile",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":              "Light",
			"icon":               "lightbulb-on",
			"state_field":        "state",
			"show_color_on_tile": true,
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.tile_switch",
		Category:    CategoryControl,
		Subtype:     "tile_switch",
		DisplayName: "Tile Switch",
		Description: "Compact tile showing on/off state. Tap to open the full control.",
		Icon:        "mdiPowerPlug",
		UICategory:  "tile",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Switch",
			"onLabel":     "On",
			"offLabel":    "Off",
			"state_field": "state",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.tile_dimmer",
		Category:    CategoryControl,
		Subtype:     "tile_dimmer",
		DisplayName: "Tile Dimmer",
		Description: "Compact tile showing dimmer level with a vertical fill. Tap to open the full control.",
		Icon:        "mdiLightbulbOn",
		UICategory:  "tile",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Light",
			"min":         0,
			"max":         100,
			"step":        1,
			"state_field": "level",
			// Zigbee brightness is 0-254; without this the control sends 50
			// for "50%" (really 20%) and reads the echo back as a percent.
			"device_scale": 254,
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.tile_garage_door",
		Category:    CategoryControl,
		Subtype:     "tile_garage_door",
		DisplayName: "Tile Garage Door",
		Description: "Compact tile showing garage door open/closed state from a contact sensor. Read-only.",
		Icon:        "mdiGarage",
		UICategory:  "tile",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Garage",
			"state_field": "contact",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.mqtt_publish",
		Category:    CategoryControl,
		Subtype:     "mqtt_publish",
		DisplayName: "MQTT Publish",
		Description: "Fire-and-forget button that publishes a static JSON payload to an MQTT topic when pressed. No device type needed — topic and payload are configured directly on the control.",
		Icon:        "mdiSend",
		UICategory:  "carbon",
		Capabilities: ComponentCapabilities{
			CanWrite:           true,
			RequiresConnection: true,
		},
		DefaultConfig: map[string]interface{}{
			"label":   "Publish",
			"kind":    "primary",
			"payload": map[string]interface{}{},
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:       "control.text_label",
		Category:     CategoryControl,
		Subtype:      "text_label",
		DisplayName:  "Text Label",
		Description:  "Static text display for section headers, date/time, or dashboard titles. No connection needed. Replaced by native text panels — kept for backward compat.",
		Icon:         "mdiFormatText",
		UICategory:   "decorative",
		Hidden:       true,
		Capabilities: ComponentCapabilities{},
		DefaultConfig: map[string]interface{}{
			"display_content": "title",
			"align":           "center",
			"size":            "md",
		},
	})

	// --- Backward-compat aliases ---
	// Legacy records may still have these control types. Kept hidden so new
	// components can't be created with them, but the editor and MCP still
	// need metadata entries to load existing records cleanly.

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.plug",
		Category:    CategoryControl,
		Subtype:     "plug",
		DisplayName: "Plug (legacy)",
		Description: "Legacy name for Switch. Kept so existing components can still be edited.",
		Icon:        "mdiPowerPlug",
		UICategory:  "custom",
		Hidden:      true,
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Switch",
			"onLabel":     "On",
			"offLabel":    "Off",
			"state_field": "state",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "control.tile_plug",
		Category:    CategoryControl,
		Subtype:     "tile_plug",
		DisplayName: "Tile Plug (legacy)",
		Description: "Legacy name for Tile Switch. Kept so existing components can still be edited.",
		Icon:        "mdiPowerPlug",
		UICategory:  "tile",
		Hidden:      true,
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			CanWrite:           true,
			RequiresDeviceType: true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		DefaultConfig: map[string]interface{}{
			"label":       "Switch",
			"onLabel":     "On",
			"offLabel":    "Off",
			"state_field": "state",
		},
	})
}
