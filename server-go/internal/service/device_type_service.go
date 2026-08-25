// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// DeviceTypeService handles device type business logic
type DeviceTypeService struct {
	repo *repository.DeviceTypeRepository
}

// NewDeviceTypeService creates a new device type service
func NewDeviceTypeService(repo *repository.DeviceTypeRepository) *DeviceTypeService {
	return &DeviceTypeService{
		repo: repo,
	}
}

// CreateDeviceType creates a new device type with validation
func (s *DeviceTypeService) CreateDeviceType(ctx context.Context, req *models.CreateDeviceTypeRequest) (*models.DeviceType, error) {
	// Check ID uniqueness
	existing, err := s.repo.FindByID(ctx, req.ID)
	if err != nil {
		return nil, fmt.Errorf("error checking ID uniqueness: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("device type with ID '%s' already exists", req.ID)
	}

	// Validate category
	if !models.IsValidDeviceCategory(req.Category) {
		return nil, fmt.Errorf("invalid category '%s', must be one of: %v", req.Category, models.ValidDeviceCategories())
	}

	// Validate supported types
	for _, t := range req.SupportedTypes {
		if !models.IsValidControlUIType(t) {
			return nil, fmt.Errorf("invalid control type '%s', must be one of: %v", t, models.ValidControlUITypes())
		}
	}

	// Validate commands match supported types
	for controlType := range req.Commands {
		found := false
		for _, t := range req.SupportedTypes {
			if t == controlType {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("command defined for type '%s' but not in supported_types", controlType)
		}
	}

	dt := &models.DeviceType{
		ID:             req.ID,
		Name:           req.Name,
		Description:    req.Description,
		Category:       req.Category,
		Subtype:        req.Subtype,
		Protocol:       req.Protocol,
		Capabilities:   req.Capabilities,
		SupportedTypes: req.SupportedTypes,
		Commands:       req.Commands,
		StateQuery:     req.StateQuery,
		Response:       req.Response,
		IsBuiltIn:      false,
		Metadata:       req.Metadata,
	}

	if dt.Capabilities == nil {
		dt.Capabilities = []models.DeviceCapability{}
	}
	if dt.SupportedTypes == nil {
		dt.SupportedTypes = []string{}
	}
	if dt.Commands == nil {
		dt.Commands = map[string]models.CommandDef{}
	}

	if err := s.repo.Create(ctx, dt); err != nil {
		return nil, fmt.Errorf("error creating device type: %w", err)
	}

	return dt, nil
}

// GetDeviceType retrieves a device type by ID
func (s *DeviceTypeService) GetDeviceType(ctx context.Context, id string) (*models.DeviceType, error) {
	dt, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving device type: %w", err)
	}
	if dt == nil {
		return nil, fmt.Errorf("device type not found")
	}
	return dt, nil
}

// UpdateDeviceType updates an existing device type with validation
func (s *DeviceTypeService) UpdateDeviceType(ctx context.Context, id string, req *models.UpdateDeviceTypeRequest) (*models.DeviceType, error) {
	existing, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving device type: %w", err)
	}
	if existing == nil {
		return nil, fmt.Errorf("device type not found")
	}

	if existing.IsBuiltIn {
		return nil, fmt.Errorf("cannot modify built-in device type '%s'", id)
	}

	if req.Category != nil && !models.IsValidDeviceCategory(*req.Category) {
		return nil, fmt.Errorf("invalid category '%s', must be one of: %v", *req.Category, models.ValidDeviceCategories())
	}

	// Validate supported types if being updated
	if req.SupportedTypes != nil {
		for _, t := range *req.SupportedTypes {
			if !models.IsValidControlUIType(t) {
				return nil, fmt.Errorf("invalid control type '%s', must be one of: %v", t, models.ValidControlUITypes())
			}
		}
	}

	// Validate commands match supported types if commands being updated
	if req.Commands != nil {
		supportedTypes := existing.SupportedTypes
		if req.SupportedTypes != nil {
			supportedTypes = *req.SupportedTypes
		}
		for controlType := range *req.Commands {
			found := false
			for _, t := range supportedTypes {
				if t == controlType {
					found = true
					break
				}
			}
			if !found {
				return nil, fmt.Errorf("command defined for type '%s' but not in supported_types", controlType)
			}
		}
	}

	if err := s.repo.Update(ctx, id, req); err != nil {
		return nil, fmt.Errorf("error updating device type: %w", err)
	}

	return s.GetDeviceType(ctx, id)
}

// DeleteDeviceType deletes a device type by ID
func (s *DeviceTypeService) DeleteDeviceType(ctx context.Context, id string) error {
	existing, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return fmt.Errorf("error retrieving device type: %w", err)
	}
	if existing == nil {
		return fmt.Errorf("device type not found")
	}

	if existing.IsBuiltIn {
		return fmt.Errorf("cannot delete built-in device type '%s'", id)
	}

	if err := s.repo.Delete(ctx, id); err != nil {
		return fmt.Errorf("error deleting device type: %w", err)
	}

	return nil
}

// ListDeviceTypes retrieves device types with filtering and pagination
func (s *DeviceTypeService) ListDeviceTypes(ctx context.Context, params *models.DeviceTypeQueryParams) (*models.DeviceTypeListResponse, error) {
	deviceTypes, total, err := s.repo.List(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("error listing device types: %w", err)
	}
	if deviceTypes == nil {
		deviceTypes = []models.DeviceType{}
	}

	page := params.Page
	if page < 1 {
		page = 1
	}
	pageSize := params.PageSize
	if pageSize < 1 {
		pageSize = 50
	}

	return &models.DeviceTypeListResponse{
		DeviceTypes: deviceTypes,
		Total:       total,
		Page:        page,
		PageSize:    pageSize,
	}, nil
}

// SeedBuiltInDeviceTypes seeds the built-in device types into the database
func (s *DeviceTypeService) SeedBuiltInDeviceTypes(ctx context.Context) error {
	builtInTypes := getBuiltInDeviceTypes()

	for _, dt := range builtInTypes {
		if err := s.repo.UpsertBuiltIn(ctx, &dt); err != nil {
			return fmt.Errorf("error seeding built-in device type '%s': %w", dt.ID, err)
		}
	}

	return nil
}

func ptr(v float64) *float64 {
	return &v
}

// getBuiltInDeviceTypes returns the list of built-in device types with merged command schemas
func getBuiltInDeviceTypes() []models.DeviceType {
	return []models.DeviceType{
		{
			ID:          "zigbee-switch",
			Name:        "Zigbee Switch/Plug",
			Description: "On/off switch or smart plug controlled via Zigbee2MQTT",
			Category:    models.DeviceCategorySwitch,
			Subtype:     "plug",
			Protocol:    "mqtt",
			Capabilities: []models.DeviceCapability{
				{
					Name:      "state",
					Type:      "binary",
					StatePath: "$.state",
				},
			},

			SupportedTypes: []string{
				models.ControlUITypeToggle,
				models.ControlUITypePlug,
				models.ControlUITypeButton,
			},
			Commands: map[string]models.CommandDef{
				models.ControlUITypeToggle: {
					Template: map[string]interface{}{"state": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "ON", "false": "OFF"},
				},
				models.ControlUITypePlug: {
					Template: map[string]interface{}{"state": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "ON", "false": "OFF"},
				},
				models.ControlUITypeButton: {
					Template: map[string]interface{}{"state": "TOGGLE"},
				},
			},
			Response: &models.ResponseDef{
				StatePath: "$.state",
				ValueMap:  map[string]interface{}{"ON": true, "OFF": false},
			},
			IsBuiltIn: true,
		},
		{
			ID:          "zigbee-dimmer",
			Name:        "Zigbee Dimmer",
			Description: "Dimmable light controlled via Zigbee2MQTT",
			Category:    models.DeviceCategoryLight,
			Subtype:     "dimmer",
			Protocol:    "mqtt",
			Capabilities: []models.DeviceCapability{
				{
					Name:      "state",
					Type:      "binary",
					StatePath: "$.state",
				},
				{
					Name:      "brightness",
					Type:      "numeric",
					ValueMin:  ptr(0),
					ValueMax:  ptr(254),
					StatePath: "$.brightness",
				},
			},

			SupportedTypes: []string{
				models.ControlUITypeToggle,
				models.ControlUITypePlug,
				models.ControlUITypeButton,
				models.ControlUITypeScalar,
				models.ControlUITypeDimmer,
			},
			Commands: map[string]models.CommandDef{
				models.ControlUITypeToggle: {
					Template: map[string]interface{}{"state": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "ON", "false": "OFF"},
				},
				models.ControlUITypePlug: {
					Template: map[string]interface{}{"state": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "ON", "false": "OFF"},
				},
				models.ControlUITypeButton: {
					Template: map[string]interface{}{"state": "TOGGLE"},
				},
				models.ControlUITypeScalar: {
					Template: map[string]interface{}{"brightness": "{{value}}"},
				},
				models.ControlUITypeDimmer: {
					Template: map[string]interface{}{"brightness": "{{value}}"},
				},
			},
			Response: &models.ResponseDef{
				StatePath: "$.brightness",
			},
			IsBuiltIn: true,
		},
		{
			ID:          "zigbee-color-light",
			Name:        "Zigbee Colour Light",
			Description: "Colour-capable bulb controlled via Zigbee2MQTT (state, brightness, colour)",
			Category:    models.DeviceCategoryLight,
			Subtype:     "light",
			Protocol:    "mqtt",
			Capabilities: []models.DeviceCapability{
				{
					Name:      "state",
					Type:      "binary",
					StatePath: "$.state",
				},
				{
					Name:      "brightness",
					Type:      "numeric",
					ValueMin:  ptr(0),
					ValueMax:  ptr(254),
					StatePath: "$.brightness",
				},
				{
					Name: "color",
					Type: "object",
					// Z2M reports colour as {x, y} regardless of the format it
					// was written in; the client converts for display.
					StatePath: "$.color",
				},
			},
			SupportedTypes: []string{
				models.ControlUITypeToggle,
				models.ControlUITypePlug,
				models.ControlUITypeButton,
				models.ControlUITypeScalar,
				models.ControlUITypeDimmer,
				models.ControlUITypeLight,
				models.ControlUITypeTileLight,
			},
			Commands: map[string]models.CommandDef{
				models.ControlUITypeToggle: {
					Template: map[string]interface{}{"state": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "ON", "false": "OFF"},
				},
				models.ControlUITypePlug: {
					Template: map[string]interface{}{"state": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "ON", "false": "OFF"},
				},
				models.ControlUITypeButton: {
					Template: map[string]interface{}{"state": "TOGGLE"},
				},
				models.ControlUITypeScalar: {
					Template: map[string]interface{}{"brightness": "{{value}}"},
				},
				models.ControlUITypeDimmer: {
					Template: map[string]interface{}{"brightness": "{{value}}"},
				},
				// The light controls send a composite object rather than a
				// scalar -- {"state":"ON","brightness":120,"color":{"hex":"#ffd300"}}
				// -- so there is no template: a nil Template means the value
				// IS the payload and is published as-is (see
				// interpolateSchemaTemplate). Z2M accepts hex directly and
				// converts on the way in, so nothing is converted on the
				// command path.
				models.ControlUITypeLight:     {PassthroughValue: true},
				models.ControlUITypeTileLight: {PassthroughValue: true},
			},
			Response: &models.ResponseDef{
				StatePath: "$.state",
			},
			IsBuiltIn: true,
		},
		{
			ID:          "caseta-switch",
			Name:        "Caseta Switch",
			Description: "On/off light switch controlled via Lutron Caseta bridge over MQTT",
			Category:    models.DeviceCategorySwitch,
			Subtype:     "switch",
			Protocol:    "mqtt",
			Capabilities: []models.DeviceCapability{
				{
					Name:      "state",
					Type:      "binary",
					StatePath: "$.state",
				},
			},

			SupportedTypes: []string{
				models.ControlUITypeToggle,
				models.ControlUITypePlug,
				models.ControlUITypeButton,
			},
			Commands: map[string]models.CommandDef{
				models.ControlUITypeToggle: {
					Template: map[string]interface{}{"action": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "turn_on", "false": "turn_off"},
				},
				models.ControlUITypePlug: {
					Template: map[string]interface{}{"action": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "turn_on", "false": "turn_off"},
				},
				models.ControlUITypeButton: {
					Template: map[string]interface{}{"action": "turn_on"},
				},
			},
			Response: &models.ResponseDef{
				StatePath: "$.state",
				ValueMap:  map[string]interface{}{"on": true, "off": false},
			},
			IsBuiltIn: true,
		},
		{
			ID:          "caseta-dimmer",
			Name:        "Caseta Dimmer",
			Description: "Dimmable light controlled via Lutron Caseta bridge over MQTT",
			Category:    models.DeviceCategoryLight,
			Subtype:     "dimmer",
			Protocol:    "mqtt",
			Capabilities: []models.DeviceCapability{
				{
					Name:      "state",
					Type:      "binary",
					StatePath: "$.state",
				},
				{
					Name:      "level",
					Type:      "numeric",
					ValueMin:  ptr(0),
					ValueMax:  ptr(100),
					Unit:      "%",
					StatePath: "$.level",
				},
			},

			SupportedTypes: []string{
				models.ControlUITypeToggle,
				models.ControlUITypePlug,
				models.ControlUITypeButton,
				models.ControlUITypeScalar,
				models.ControlUITypeDimmer,
			},
			Commands: map[string]models.CommandDef{
				models.ControlUITypeToggle: {
					Template: map[string]interface{}{"action": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "turn_on", "false": "turn_off"},
				},
				models.ControlUITypePlug: {
					Template: map[string]interface{}{"action": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "turn_on", "false": "turn_off"},
				},
				models.ControlUITypeButton: {
					Template: map[string]interface{}{"action": "turn_on"},
				},
				models.ControlUITypeScalar: {
					Template: map[string]interface{}{"action": "set_level", "level": "{{value}}"},
				},
				models.ControlUITypeDimmer: {
					Template: map[string]interface{}{"action": "set_level", "level": "{{value}}"},
				},
			},
			Response: &models.ResponseDef{
				StatePath: "$.level",
			},
			IsBuiltIn: true,
		},
		{
			ID:          "caseta-shade",
			Name:        "Caseta Shade",
			Description: "Window shade/blind controlled via Lutron Caseta bridge over MQTT",
			Category:    models.DeviceCategoryCover,
			Subtype:     "shade",
			Protocol:    "mqtt",
			Capabilities: []models.DeviceCapability{
				{
					Name:      "state",
					Type:      "binary",
					StatePath: "$.state",
				},
				{
					Name:      "level",
					Type:      "numeric",
					ValueMin:  ptr(0),
					ValueMax:  ptr(100),
					Unit:      "%",
					StatePath: "$.level",
				},
			},

			SupportedTypes: []string{
				models.ControlUITypeToggle,
				models.ControlUITypePlug,
				models.ControlUITypeButton,
				models.ControlUITypeScalar,
				models.ControlUITypeDimmer,
			},
			Commands: map[string]models.CommandDef{
				models.ControlUITypeToggle: {
					Template: map[string]interface{}{"action": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "turn_on", "false": "turn_off"},
				},
				models.ControlUITypePlug: {
					Template: map[string]interface{}{"action": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "turn_on", "false": "turn_off"},
				},
				models.ControlUITypeButton: {
					Template: map[string]interface{}{"action": "turn_on"},
				},
				models.ControlUITypeScalar: {
					Template: map[string]interface{}{"action": "set_level", "level": "{{value}}"},
				},
				models.ControlUITypeDimmer: {
					Template: map[string]interface{}{"action": "set_level", "level": "{{value}}"},
				},
			},
			Response: &models.ResponseDef{
				StatePath: "$.level",
			},
			IsBuiltIn: true,
		},
		{
			ID:          "caseta-fan",
			Name:        "Caseta Fan",
			Description: "Fan speed control via Lutron Caseta bridge over MQTT",
			Category:    models.DeviceCategoryOther,
			Subtype:     "fan",
			Protocol:    "mqtt",
			Capabilities: []models.DeviceCapability{
				{
					Name:      "state",
					Type:      "binary",
					StatePath: "$.state",
				},
				{
					Name:      "level",
					Type:      "numeric",
					ValueMin:  ptr(0),
					ValueMax:  ptr(100),
					Unit:      "%",
					StatePath: "$.level",
				},
			},

			SupportedTypes: []string{
				models.ControlUITypeToggle,
				models.ControlUITypePlug,
				models.ControlUITypeButton,
				models.ControlUITypeScalar,
				models.ControlUITypeDimmer,
			},
			Commands: map[string]models.CommandDef{
				models.ControlUITypeToggle: {
					Template: map[string]interface{}{"action": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "turn_on", "false": "turn_off"},
				},
				models.ControlUITypePlug: {
					Template: map[string]interface{}{"action": "{{value}}"},
					ValueMap: map[string]interface{}{"true": "turn_on", "false": "turn_off"},
				},
				models.ControlUITypeButton: {
					Template: map[string]interface{}{"action": "turn_on"},
				},
				models.ControlUITypeScalar: {
					Template: map[string]interface{}{"action": "set_level", "level": "{{value}}"},
				},
				models.ControlUITypeDimmer: {
					Template: map[string]interface{}{"action": "set_level", "level": "{{value}}"},
				},
			},
			Response: &models.ResponseDef{
				StatePath: "$.level",
			},
			IsBuiltIn: true,
		},
	}
}
