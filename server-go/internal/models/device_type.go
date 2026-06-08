// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"time"
)

// Device category constants
const (
	DeviceCategorySwitch    = "switch"
	DeviceCategoryLight     = "light"
	DeviceCategorySensor    = "sensor"
	DeviceCategoryThermostat = "thermostat"
	DeviceCategoryCover     = "cover"
	DeviceCategoryOther     = "other"
)

// ValidDeviceCategories returns the list of valid device categories
func ValidDeviceCategories() []string {
	return []string{
		DeviceCategorySwitch,
		DeviceCategoryLight,
		DeviceCategorySensor,
		DeviceCategoryThermostat,
		DeviceCategoryCover,
		DeviceCategoryOther,
	}
}

// IsValidDeviceCategory checks if a category is valid
func IsValidDeviceCategory(category string) bool {
	for _, c := range ValidDeviceCategories() {
		if c == category {
			return true
		}
	}
	return false
}

// Control UI type constants (fixed set - how controls appear in UI)
const (
	ControlUITypeToggle         = "toggle"           // On/off switch, sends boolean
	ControlUITypeScalar         = "scalar"           // Slider/numeric input, sends number
	ControlUITypeButton         = "button"           // Action trigger, sends null
	ControlUITypeText           = "text"             // Text/command input, sends string
	ControlUITypeSwitch         = "switch"           // On/off switch, sends boolean
	ControlUITypePlug           = "plug"             // Alias for switch (backward compat)
	ControlUITypeDimmer         = "dimmer"           // Vertical slider with on/off, sends number (0=off)
	ControlUITypeGarageDoor     = "garage_door"      // Read-only full-size garage door contact sensor
	ControlUITypeTileSwitch     = "tile_switch"      // Compact tile switch
	ControlUITypeTilePlug       = "tile_plug"        // Alias for tile_switch (backward compat)
	ControlUITypeTileGarageDoor = "tile_garage_door" // Read-only garage door contact sensor tile
)

// ValidControlUITypes returns the list of valid control UI types
func ValidControlUITypes() []string {
	return []string{
		ControlUITypeToggle,
		ControlUITypeScalar,
		ControlUITypeButton,
		ControlUITypeText,
		ControlUITypeSwitch,
		ControlUITypePlug,
		ControlUITypeDimmer,
		ControlUITypeGarageDoor,
		ControlUITypeTileSwitch,
		ControlUITypeTilePlug,
		ControlUITypeTileGarageDoor,
	}
}

// IsValidControlUIType checks if a control type is valid
func IsValidControlUIType(controlType string) bool {
	for _, t := range ValidControlUITypes() {
		if t == controlType {
			return true
		}
	}
	return false
}

// CommandDef defines how to format a command message for a specific control type
// @Description Template for formatting control commands
type CommandDef struct {
	Template map[string]interface{} `json:"template" bson:"template"`               // Message template with {value}, {target} placeholders
	ValueMap map[string]interface{} `json:"value_map,omitempty" bson:"value_map"`   // Optional value mapping (e.g., true -> "ON", false -> "OFF")
}

// StateQueryDef defines how to request current state from a connection
// @Description Configuration for querying control state
type StateQueryDef struct {
	Template   map[string]interface{} `json:"template" bson:"template"`       // Query message template
	IntervalMs int                    `json:"interval_ms" bson:"interval_ms"` // Auto-poll interval in milliseconds (0 = manual only)
}

// ResponseDef defines how to parse responses from a connection
// @Description Configuration for parsing connection responses
type ResponseDef struct {
	SuccessPath string                 `json:"success_path" bson:"success_path"` // JSONPath to success flag (e.g., "$.success")
	StatePath   string                 `json:"state_path" bson:"state_path"`     // JSONPath to current state value (e.g., "$.state")
	ErrorPath   string                 `json:"error_path" bson:"error_path"`     // JSONPath to error message (e.g., "$.error")
	ValueMap    map[string]interface{} `json:"value_map,omitempty" bson:"value_map"` // Reverse mapping (e.g., "ON" -> true, "OFF" -> false)
}

// DeviceType is a reusable template defining a class of IoT device and how to control it
// @Description Template that defines a class of IoT device, its capabilities, and command protocol
type DeviceType struct {
	ID             string                 `json:"id" bson:"_id"`
	Name           string                 `json:"name" bson:"name" binding:"required"`
	Description    string                 `json:"description" bson:"description"`
	Category       string                 `json:"category" bson:"category"`
	Subtype        string                 `json:"subtype,omitempty" bson:"subtype"`
	Protocol       string                 `json:"protocol" bson:"protocol"`
	Capabilities   []DeviceCapability     `json:"capabilities" bson:"capabilities"`
	SupportedTypes []string               `json:"supported_types" bson:"supported_types"`
	Commands       map[string]CommandDef  `json:"commands" bson:"commands"`
	StateQuery     *StateQueryDef         `json:"state_query,omitempty" bson:"state_query,omitempty"`
	Response       *ResponseDef           `json:"response,omitempty" bson:"response,omitempty"`
	IsBuiltIn      bool                   `json:"is_built_in" bson:"is_built_in"`
	Metadata       map[string]interface{} `json:"metadata,omitempty" bson:"metadata,omitempty"`
	Created        time.Time              `json:"created" bson:"created"`
	Updated        time.Time              `json:"updated" bson:"updated"`
}

// DeviceCapability describes a single capability of a device type
// @Description A capability that a device type supports (e.g., state, brightness)
type DeviceCapability struct {
	Name        string   `json:"name" bson:"name"`
	Type        string   `json:"type" bson:"type"`                             // "binary", "numeric", "enum", "text"
	Description string   `json:"description,omitempty" bson:"description"`
	ValueMin    *float64 `json:"value_min,omitempty" bson:"value_min"`
	ValueMax    *float64 `json:"value_max,omitempty" bson:"value_max"`
	ValueStep   *float64 `json:"value_step,omitempty" bson:"value_step"`
	Values      []string `json:"values,omitempty" bson:"values"`               // For enum type
	Unit        string   `json:"unit,omitempty" bson:"unit"`
	StatePath   string   `json:"state_path,omitempty" bson:"state_path"`       // JSONPath in state message
}

// CreateDeviceTypeRequest represents a request to create a device type
// @Description Request body for creating a new device type
type CreateDeviceTypeRequest struct {
	ID             string                 `json:"id" binding:"required"`
	Name           string                 `json:"name" binding:"required"`
	Description    string                 `json:"description"`
	Category       string                 `json:"category" binding:"required"`
	Subtype        string                 `json:"subtype"`
	Protocol       string                 `json:"protocol" binding:"required"`
	Capabilities   []DeviceCapability     `json:"capabilities"`
	SupportedTypes []string               `json:"supported_types"`
	Commands       map[string]CommandDef  `json:"commands"`
	StateQuery     *StateQueryDef         `json:"state_query,omitempty"`
	Response       *ResponseDef           `json:"response,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
}

// UpdateDeviceTypeRequest represents a request to update a device type
// @Description Request body for updating an existing device type
type UpdateDeviceTypeRequest struct {
	Name           *string                 `json:"name,omitempty"`
	Description    *string                 `json:"description,omitempty"`
	Category       *string                 `json:"category,omitempty"`
	Subtype        *string                 `json:"subtype,omitempty"`
	Protocol       *string                 `json:"protocol,omitempty"`
	Capabilities   *[]DeviceCapability     `json:"capabilities,omitempty"`
	SupportedTypes *[]string               `json:"supported_types,omitempty"`
	Commands       *map[string]CommandDef  `json:"commands,omitempty"`
	StateQuery     *StateQueryDef          `json:"state_query,omitempty"`
	Response       *ResponseDef            `json:"response,omitempty"`
	Metadata       *map[string]interface{} `json:"metadata,omitempty"`
}

// DeviceTypeListResponse represents a paginated list of device types
// @Description Response containing a list of device types
type DeviceTypeListResponse struct {
	DeviceTypes []DeviceType `json:"device_types"`
	Total       int64        `json:"total"`
	Page        int          `json:"page"`
	PageSize    int          `json:"page_size"`
}

// DeviceTypeQueryParams defines query parameters for listing device types
// @Description Query parameters for filtering device types
type DeviceTypeQueryParams struct {
	Category      string `form:"category"`
	Protocol      string `form:"protocol"`
	SupportedType string `form:"supported_type"` // Filter by supported control UI type
	BuiltInOnly   bool   `form:"built_in_only"`
	Page          int    `form:"page"`
	PageSize      int    `form:"page_size"`
}

// DiscoveredDevice represents a device found during auto-discovery
// @Description A device discovered from a bridge (e.g., Zigbee2MQTT)
type DiscoveredDevice struct {
	FriendlyName    string             `json:"friendly_name"`
	IEEEAddress     string             `json:"ieee_address,omitempty"`
	Model           string             `json:"model,omitempty"`
	Vendor          string             `json:"vendor,omitempty"`
	Description     string             `json:"description,omitempty"`
	Capabilities    []DeviceCapability `json:"capabilities"`
	SuggestedTypeID string             `json:"suggested_type_id,omitempty"`
	AlreadyImported bool               `json:"already_imported"`
}

// DiscoverDevicesResponse is the API response for device discovery
// @Description Response from device discovery on a connection
type DiscoverDevicesResponse struct {
	Devices []DiscoveredDevice `json:"devices"`
	Source  string             `json:"source"`
}

// ImportDevicesRequest is the request to import discovered devices
// @Description Request to bulk import discovered devices
type ImportDevicesRequest struct {
	ConnectionID string              `json:"connection_id" binding:"required"`
	Devices      []ImportDeviceEntry `json:"devices" binding:"required"`
}

// ImportDeviceEntry represents a single device to import
type ImportDeviceEntry struct {
	FriendlyName string `json:"friendly_name" binding:"required"`
	DeviceTypeID string `json:"device_type_id" binding:"required"`
	Name         string `json:"name" binding:"required"`
	Room         string `json:"room,omitempty"`
}
