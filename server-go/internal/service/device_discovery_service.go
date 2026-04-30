// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// DeviceDiscoveryService handles device discovery from MQTT bridges
type DeviceDiscoveryService struct {
	connectionRepo *repository.ConnectionRepository
	deviceTypeRepo *repository.DeviceTypeRepository
	deviceRepo     *repository.DeviceRepository
}

// NewDeviceDiscoveryService creates a new device discovery service
func NewDeviceDiscoveryService(
	connectionRepo *repository.ConnectionRepository,
	deviceTypeRepo *repository.DeviceTypeRepository,
	deviceRepo *repository.DeviceRepository,
) *DeviceDiscoveryService {
	return &DeviceDiscoveryService{
		connectionRepo: connectionRepo,
		deviceTypeRepo: deviceTypeRepo,
		deviceRepo:     deviceRepo,
	}
}

// DiscoverDevices discovers devices on an MQTT connection
func (s *DeviceDiscoveryService) DiscoverDevices(ctx context.Context, connectionID string) (*models.DiscoverDevicesResponse, error) {
	// Validate connection
	ds, err := s.connectionRepo.FindByID(ctx, connectionID)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
	}
	if ds.Type != models.ConnectionTypeMQTT || ds.Config.MQTT == nil {
		return nil, fmt.Errorf("connection is not MQTT type")
	}

	// Create MQTT adapter
	adapter, err := registry.CreateAdapter("stream.mqtt", ds.GetEffectiveConfig())
	if err != nil {
		return nil, fmt.Errorf("failed to create MQTT adapter: %w", err)
	}

	// Subscribe to zigbee2mqtt/bridge/devices (retained message)
	collectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	recordChan, err := adapter.Stream(collectCtx, registry.Query{Raw: "zigbee2mqtt/bridge/devices"})
	if err != nil {
		return nil, fmt.Errorf("failed to subscribe to bridge/devices: %w", err)
	}

	// Collect the bridge/devices message
	var bridgePayload []byte
	for {
		select {
		case record, ok := <-recordChan:
			if !ok {
				goto parseBridge
			}
			// The record should contain the raw payload or parsed JSON
			if payload, ok := record["payload"].(string); ok {
				bridgePayload = []byte(payload)
				goto parseBridge
			}
			// If the JSON was parsed into individual fields, try to reconstruct
			// The bridge/devices message is a JSON array, so it might come as payload
			payloadJSON, err := json.Marshal(record)
			if err == nil {
				bridgePayload = payloadJSON
			}
		case <-collectCtx.Done():
			goto parseBridge
		}
	}

parseBridge:
	if len(bridgePayload) == 0 {
		// No bridge/devices message received — return empty result
		return &models.DiscoverDevicesResponse{
			Devices: []models.DiscoveredDevice{},
			Source:  "zigbee2mqtt",
		}, nil
	}

	// Parse the z2m bridge/devices JSON array
	z2mDevices, err := parseZ2MBridgeDevices(bridgePayload)
	if err != nil {
		log.Printf("[DeviceDiscovery] Failed to parse bridge/devices: %v", err)
		return &models.DiscoverDevicesResponse{
			Devices: []models.DiscoveredDevice{},
			Source:  "zigbee2mqtt",
		}, nil
	}

	// Get existing devices for this connection to check imports
	existingDevices, _ := s.deviceRepo.FindByConnectionID(ctx, connectionID)
	existingTargets := make(map[string]bool)
	for _, d := range existingDevices {
		existingTargets[d.StateTopic] = true
	}

	// Get device types for matching
	allTypes, _, _ := s.deviceTypeRepo.List(ctx, &models.DeviceTypeQueryParams{PageSize: 100})

	// Convert to DiscoveredDevice list
	var discovered []models.DiscoveredDevice
	for _, z2mDev := range z2mDevices {
		// Skip coordinator
		if z2mDev.Type == "Coordinator" {
			continue
		}

		caps := mapZ2MCapabilities(z2mDev.Definition.Exposes)
		suggestedType := matchDeviceType(caps, allTypes)
		stateTopic := "zigbee2mqtt/" + z2mDev.FriendlyName

		discovered = append(discovered, models.DiscoveredDevice{
			FriendlyName:    z2mDev.FriendlyName,
			IEEEAddress:     z2mDev.IEEEAddress,
			Model:           z2mDev.Definition.Model,
			Vendor:          z2mDev.Definition.Vendor,
			Description:     z2mDev.Definition.Description,
			Capabilities:    caps,
			SuggestedTypeID: suggestedType,
			AlreadyImported: existingTargets[stateTopic],
		})
	}

	return &models.DiscoverDevicesResponse{
		Devices: discovered,
		Source:  "zigbee2mqtt",
	}, nil
}

// z2m bridge/devices JSON structures

type z2mDevice struct {
	FriendlyName string        `json:"friendly_name"`
	IEEEAddress  string        `json:"ieee_address"`
	Type         string        `json:"type"`
	Definition   z2mDefinition `json:"definition"`
}

type z2mDefinition struct {
	Model       string       `json:"model"`
	Vendor      string       `json:"vendor"`
	Description string       `json:"description"`
	Exposes     []z2mExpose  `json:"exposes"`
}

type z2mExpose struct {
	Type     string       `json:"type"`
	Name     string       `json:"name,omitempty"`
	Property string       `json:"property,omitempty"`
	Access   int          `json:"access,omitempty"`
	ValueMin *float64     `json:"value_min,omitempty"`
	ValueMax *float64     `json:"value_max,omitempty"`
	ValueStep *float64    `json:"value_step,omitempty"`
	Values   []string     `json:"values,omitempty"`
	Unit     string       `json:"unit,omitempty"`
	Features []z2mExpose  `json:"features,omitempty"` // For composite types like "switch", "light"
}

func parseZ2MBridgeDevices(data []byte) ([]z2mDevice, error) {
	var devices []z2mDevice
	if err := json.Unmarshal(data, &devices); err != nil {
		return nil, fmt.Errorf("invalid bridge/devices JSON: %w", err)
	}
	return devices, nil
}

// mapZ2MCapabilities converts z2m exposes to DeviceCapability list
func mapZ2MCapabilities(exposes []z2mExpose) []models.DeviceCapability {
	var caps []models.DeviceCapability

	for _, expose := range exposes {
		// Composite types (switch, light, etc.) have features
		if len(expose.Features) > 0 {
			for _, feature := range expose.Features {
				cap := z2mExposeToCap(feature)
				if cap != nil {
					caps = append(caps, *cap)
				}
			}
			continue
		}

		cap := z2mExposeToCap(expose)
		if cap != nil {
			caps = append(caps, *cap)
		}
	}

	return caps
}

func z2mExposeToCap(expose z2mExpose) *models.DeviceCapability {
	name := expose.Property
	if name == "" {
		name = expose.Name
	}
	if name == "" {
		return nil
	}

	capType := expose.Type
	switch capType {
	case "binary", "numeric", "enum", "text":
		// valid
	default:
		capType = "text"
	}

	return &models.DeviceCapability{
		Name:      name,
		Type:      capType,
		ValueMin:  expose.ValueMin,
		ValueMax:  expose.ValueMax,
		ValueStep: expose.ValueStep,
		Values:    expose.Values,
		Unit:      expose.Unit,
		StatePath: "$." + name,
	}
}

// matchDeviceType finds the best matching built-in device type for a set of capabilities
func matchDeviceType(caps []models.DeviceCapability, types []models.DeviceType) string {
	// Simple heuristic: match by capability names
	hasState := false
	hasBrightness := false

	for _, cap := range caps {
		switch cap.Name {
		case "state":
			hasState = true
		case "brightness":
			hasBrightness = true
		}
	}

	if hasState && hasBrightness {
		return "zigbee-dimmer"
	}
	if hasState {
		return "zigbee-switch"
	}

	return ""
}
