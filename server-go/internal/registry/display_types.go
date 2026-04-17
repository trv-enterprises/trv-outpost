// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

// Display type registrations. Displays are non-chart visual components:
// Frigate camera viewers, alert grids, weather widgets, etc. They ship
// as purpose-built React components on the frontend rather than being
// rendered from ECharts config.
//
// This list is currently small and closely tied to frontend-bundled
// components. Each new display type requires a matching React component
// on the client.

func init() {
	// Register the Frigate integration so the connection type plus the two
	// Frigate display types can be enabled/disabled as a single bundle from
	// the admin settings UI. Frigate is unusual in that the connection type
	// itself isn't a registered adapter (it proxies through frigate_handler),
	// so the integration declares OwnedConnectionType: "frigate" to make it
	// addressable from the filter.
	RegisterIntegration(IntegrationInfo{
		ID:                  "frigate",
		DisplayName:         "Frigate NVR",
		Description:         "Frigate NVR camera proxy: connection type plus camera viewer and alerts grid displays.",
		OwnedConnectionType: "frigate",
		OwnedDisplayTypes:   []string{"frigate_camera", "frigate_alerts"},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "display.frigate_camera",
		Category:    CategoryDisplay,
		Subtype:     "frigate_camera",
		DisplayName: "Frigate Camera",
		Description: "Live Frigate NVR camera stream with periodic snapshot polling.",
		Integration: "frigate",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		ConfigSchema: []ConfigField{
			{Name: "frigate_connection_id", Type: "string", Required: true, Description: "Frigate API connection ID"},
			{Name: "default_camera", Type: "string", Required: false, Description: "Pre-selected camera name"},
			{Name: "snapshot_interval", Type: "int", Required: false, Default: 10000, Description: "Snapshot polling interval in ms"},
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "display.frigate_alerts",
		Category:    CategoryDisplay,
		Subtype:     "frigate_alerts",
		DisplayName: "Frigate Alerts",
		Description: "Grid of recent Frigate alert thumbnails filtered by camera and severity. Subscribes to an MQTT topic for real-time updates.",
		Integration: "frigate",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		ConfigSchema: []ConfigField{
			{Name: "frigate_connection_id", Type: "string", Required: true, Description: "Frigate API connection ID for snapshot fetching"},
			{Name: "mqtt_connection_id", Type: "string", Required: true, Description: "MQTT connection for the alerts topic"},
			{Name: "alert_topic", Type: "string", Required: false, Default: "frigate/reviews", Description: "MQTT topic to subscribe to"},
			{Name: "default_camera", Type: "string", Required: false, Description: "Optional camera filter"},
			{Name: "max_thumbnails", Type: "int", Required: false, Default: 8, Description: "Maximum thumbnails to display"},
			{Name: "alert_severity", Type: "select", Required: false, Default: "alert", Options: []string{"alert", "detection", ""}, Description: "Severity filter; empty means all"},
		},
	})

	// Weather is its own integration so deployments without weather telemetry
	// can disable it as a single bundle. Today there's only one weather
	// display type, but bundling it under an integration keeps the UI
	// symmetric with Frigate and makes room for future weather-specific
	// widgets (radar map, alerts banner) without changing the model.
	RegisterIntegration(IntegrationInfo{
		ID:                "weather",
		DisplayName:       "Weather",
		Description:       "Weather telemetry display fed by an MQTT topic prefix.",
		OwnedDisplayTypes: []string{"weather"},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "display.weather",
		Category:    CategoryDisplay,
		Subtype:     "weather",
		DisplayName: "Weather",
		Description: "Weather widget driven by an MQTT topic prefix. Displays current conditions for a labelled location.",
		Integration: "weather",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			RequiresConnection: true,
			SupportsStreaming:  true,
		},
		ConfigSchema: []ConfigField{
			{Name: "mqtt_connection_id", Type: "string", Required: true, Description: "MQTT connection for the weather feed"},
			{Name: "weather_topic_prefix", Type: "string", Required: false, Default: "weather", Description: "MQTT topic prefix"},
			{Name: "weather_location", Type: "string", Required: false, Description: "Display label (e.g. 'Spring, TX')"},
		},
	})
}
