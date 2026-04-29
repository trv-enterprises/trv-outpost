// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Dropdown,
  Select,
  SelectItem,
  TextInput,
  NumberInput,
  Button,
  Modal
} from '@carbon/react';
import { Camera, NotificationNew, PartlyCloudy } from '@carbon/icons-react';
import apiClient from '../api/client';
import { useEnabledTypes } from '../context/EnabledTypesContext';

// Available display types. The picker filters this list against the admin's
// enabled_types selection so deployments without Frigate (or any future
// integration) don't see those options. Existing components of disabled
// types still render — this is creation-only filtering.
const DISPLAY_TYPES = [
  { id: 'frigate_camera', label: 'Frigate Camera', description: 'Live camera feed from Frigate NVR', icon: Camera },
  { id: 'frigate_alerts', label: 'Frigate Alerts', description: 'Event alerts grid from Frigate NVR', icon: NotificationNew },
  { id: 'weather', label: 'Weather', description: 'Weather conditions from MQTT data', icon: PartlyCloudy }
];

/**
 * DisplayEditor Component
 *
 * Generic display config editor shown in ComponentEditor when componentType === 'display'.
 * Delegates to subtype-specific fields based on display_type.
 * Currently only supports Frigate Camera — future subtypes (datatable, iframe) will be added here.
 */
function DisplayEditor({ displayConfig, onDisplayConfigChange }) {
  const [connections, setConnections] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [loadingCameras, setLoadingCameras] = useState(false);
  const { isDisplayTypeEnabled, enabledDisplayTypes } = useEnabledTypes();

  // Pick a sensible fallback when no display_type was passed in: the first
  // enabled display type, or the first DISPLAY_TYPES entry as a last resort
  // (only relevant if the catalog hasn't loaded yet).
  const fallbackDisplayType =
    enabledDisplayTypes?.[0]?.subtype || DISPLAY_TYPES[0]?.id;

  // Filter the display-type list. Always include the type *currently saved
  // on this component* (even if now disabled) so editing existing components
  // works. Don't include the unconfigured-fallback default — otherwise a new
  // component opens to a disabled type.
  const savedDisplayType = displayConfig?.display_type;
  const displayType = savedDisplayType || fallbackDisplayType;
  const config = displayConfig || { display_type: displayType };
  const availableDisplayTypes = DISPLAY_TYPES.filter(
    t => isDisplayTypeEnabled(t.id) || t.id === savedDisplayType
  );

  // Fetch connections on mount
  useEffect(() => {
    const fetchConnections = async () => {
      try {
        const data = await apiClient.getConnections();
        setConnections(data.datasources || []);
      } catch (err) {
        console.error('Failed to load connections:', err);
      }
    };
    fetchConnections();
  }, []);

  // Fetch cameras when a Frigate-backed display type is selected.
  // Both frigate_camera and frigate_alerts use the camera list — the
  // camera picker is a "default camera" for the viewer and an optional
  // "camera filter" for the alerts grid.
  useEffect(() => {
    const usesCameras = displayType === 'frigate_camera' || displayType === 'frigate_alerts';
    if (!usesCameras || !config.frigate_connection_id) {
      setCameras([]);
      return;
    }

    const fetchCameras = async () => {
      setLoadingCameras(true);
      try {
        const data = await apiClient.getFrigateCameras(config.frigate_connection_id);
        setCameras(data.cameras || []);
      } catch (err) {
        console.error('Failed to load Frigate cameras:', err);
        setCameras([]);
      } finally {
        setLoadingCameras(false);
      }
    };

    fetchCameras();
  }, [displayType, config.frigate_connection_id]);

  const updateConfig = (updates) => {
    onDisplayConfigChange({ ...config, ...updates });
  };

  // Filter connections by type — prefer dedicated Frigate type, also support legacy API
  const frigateConnections = connections.filter(c => c.type === 'frigate' || c.type === 'api');
  const mqttConnections = connections.filter(c => c.type === 'mqtt');

  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const currentDisplayType = DISPLAY_TYPES.find(t => t.id === displayType) || availableDisplayTypes[0] || DISPLAY_TYPES[0];
  const CurrentIcon = currentDisplayType.icon;

  return (
    <div className="display-editor">
      {/* Display Type selector — card + modal */}
      <div className="type-card-section">
        <h4>Display Type</h4>
        <div className="type-card-current" onClick={() => setTypeModalOpen(true)}>
          <Button kind="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setTypeModalOpen(true); }}>
            Change
          </Button>
          {CurrentIcon && <CurrentIcon size={20} />}
          <div className="type-card-info">
            <span className="type-card-label">{currentDisplayType.label}</span>
            <span className="type-card-description">{currentDisplayType.description}</span>
          </div>
        </div>
      </div>

      {/* Display Type Selection Modal — portaled to body to escape parent modal */}
      {typeModalOpen && createPortal(
        <Modal
          open
          onRequestClose={() => setTypeModalOpen(false)}
          onRequestSubmit={() => setTypeModalOpen(false)}
          modalHeading="Select Display Type"
          primaryButtonText="Close"
          size="sm"
          className="type-selection-modal"
        >
          <div className="type-selection-grid">
            {availableDisplayTypes.map(type => {
              const TypeIcon = type.icon;
              return (
                <div
                  key={type.id}
                  className={`type-selection-item ${displayType === type.id ? 'selected' : ''}`}
                  onClick={() => {
                    setTypeModalOpen(false);
                    updateConfig({ display_type: type.id });
                  }}
                >
                  {TypeIcon && <TypeIcon size={24} />}
                  <div className="type-selection-info">
                    <span className="type-selection-label">{type.label}</span>
                    <span className="type-selection-description">{type.description}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Modal>,
        document.body
      )}

      {/* Weather fields */}
      {displayType === 'weather' && (
        <div className="display-editor__section">
          <h4>Weather Configuration</h4>
          <Dropdown
            id="weather-mqtt-connection"
            titleText="MQTT Connection"
            label="Select MQTT connection with weather topics"
            items={mqttConnections}
            itemToString={(item) => item?.name || ''}
            selectedItem={mqttConnections.find(c => c.id === config.mqtt_connection_id) || null}
            onChange={({ selectedItem }) => {
              updateConfig({ mqtt_connection_id: selectedItem?.id || '' });
            }}
          />

          <TextInput
            id="weather-location"
            labelText="Location"
            value={config.weather_location || ''}
            onChange={(e) => updateConfig({ weather_location: e.target.value })}
            placeholder="e.g., Spring, TX"
            helperText="Location label displayed at the top of the widget"
            size="md"
          />

          <TextInput
            id="weather-topic-prefix"
            labelText="Topic Prefix"
            value={config.weather_topic_prefix || 'weather'}
            onChange={(e) => updateConfig({ weather_topic_prefix: e.target.value })}
            helperText="MQTT topic prefix (subscribes to prefix/#). Default: weather"
            size="md"
          />
        </div>
      )}

      {/* Frigate Alerts fields */}
      {displayType === 'frigate_alerts' && (
        <div className="display-editor__section">
          <h4>Frigate Alerts Configuration</h4>
          <Dropdown
            id="frigate-alerts-connection"
            titleText="Frigate Connection"
            label="Select Frigate connection"
            items={frigateConnections}
            itemToString={(item) => item?.name || ''}
            selectedItem={frigateConnections.find(c => c.id === config.frigate_connection_id) || null}
            onChange={({ selectedItem }) => {
              updateConfig({
                frigate_connection_id: selectedItem?.id || '',
                default_camera: '' // Reset camera filter when connection changes
              });
            }}
          />

          {config.frigate_connection_id && (
            <Dropdown
              id="frigate-alerts-camera-filter"
              titleText="Camera Filter (optional)"
              label={loadingCameras ? 'Loading cameras...' : 'All cameras'}
              items={[null, ...cameras]}
              itemToString={(item) => item || 'All cameras'}
              selectedItem={config.default_camera || null}
              onChange={({ selectedItem }) => {
                updateConfig({ default_camera: selectedItem || '' });
              }}
              disabled={loadingCameras || cameras.length === 0}
              helperText="Leave unset to show alerts from all cameras"
            />
          )}

          <Select
            id="frigate-alerts-severity"
            labelText="Severity"
            value={config.alert_severity || 'alert'}
            onChange={(e) => updateConfig({ alert_severity: e.target.value })}
            helperText="alert = review-required events; detection = all detections"
          >
            <SelectItem value="alert" text="Alert" />
            <SelectItem value="detection" text="Detection" />
            <SelectItem value="" text="All" />
          </Select>

          <NumberInput
            id="frigate-alerts-max"
            label="Max thumbnails"
            value={config.max_thumbnails || 8}
            min={1}
            max={50}
            step={1}
            onChange={(e, { value }) => updateConfig({ max_thumbnails: value })}
            helperText="Maximum number of alert thumbnails to display (1–50)"
          />

          <NumberInput
            id="frigate-alerts-interval"
            label="Refresh Interval (ms)"
            value={config.snapshot_interval || 10000}
            min={2000}
            max={60000}
            step={1000}
            onChange={(e, { value }) => updateConfig({ snapshot_interval: value })}
            helperText="How often to poll Frigate for new alerts"
          />
        </div>
      )}

      {/* Frigate Camera fields */}
      {displayType === 'frigate_camera' && (
        <div className="display-editor__section">
          <h4>Frigate Camera Configuration</h4>
          <Dropdown
            id="frigate-connection"
            titleText="Frigate Connection"
            label="Select Frigate connection"
            items={frigateConnections}
            itemToString={(item) => item?.name || ''}
            selectedItem={frigateConnections.find(c => c.id === config.frigate_connection_id) || null}
            onChange={({ selectedItem }) => {
              updateConfig({
                frigate_connection_id: selectedItem?.id || '',
                default_camera: '' // Reset camera when connection changes
              });
            }}
          />

          {config.frigate_connection_id && (
            <Dropdown
              id="frigate-default-camera"
              titleText="Default Camera"
              label={loadingCameras ? 'Loading cameras...' : 'Select default camera'}
              items={cameras}
              itemToString={(item) => item || ''}
              selectedItem={config.default_camera || null}
              onChange={({ selectedItem }) => {
                updateConfig({ default_camera: selectedItem || '' });
              }}
              disabled={loadingCameras || cameras.length === 0}
            />
          )}

          <NumberInput
            id="snapshot-interval"
            label="Snapshot Interval (ms)"
            value={config.snapshot_interval || 10000}
            min={1000}
            max={60000}
            step={1000}
            onChange={(e, { value }) => updateConfig({ snapshot_interval: value })}
            helperText="How often to refresh the camera snapshot (idle mode)"
          />
        </div>
      )}
    </div>
  );
}

export default DisplayEditor;
