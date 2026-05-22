---
sidebar_position: 13
---

# Display Types

Displays are specialized visual components for specific integrations that don't use the standard chart rendering engine.

## Frigate Camera

Integrates with a Frigate NVR (Network Video Recorder) to show live camera snapshots.

### Configuration
- **Frigate Connection**: Select the API connection to your Frigate instance
- **Default Camera**: Choose which camera to display
- **MQTT Connection**: For real-time event notifications
- **Snapshot Interval**: How often to refresh the camera image (milliseconds)

### Features
- Live snapshot display with auto-refresh
- Camera selection from Frigate's camera list
- Event overlay from MQTT notifications

### Minimum Panel Size
3 columns x 4 rows

## Frigate Alerts

A grid of recent Frigate detection alerts. Renders thumbnails for
each event with timestamp, camera, and label (person / car / etc.),
and updates live as new alerts arrive.

### Configuration
- **Frigate Connection**: API connection to the Frigate instance.
- **MQTT Connection**: For real-time event notifications (the same
  broker Frigate publishes alerts to).
- **Default Camera**: Optional camera filter — limit the grid to
  alerts from one camera, or leave blank for all cameras.

### Features
- Live grid of recent detections with thumbnails
- Filter to a single camera or watch all cameras
- "Mark Reviewed" action per alert (requires the **Control**
  capability)

### Minimum Panel Size
4 columns x 4 rows

## Weather

Displays current weather information for a configured location.

### Configuration
- **Weather Location**: City/region name (e.g., "Spring, TX")
- **MQTT Connection**: For receiving weather data updates

### Features
- Current conditions display
- Temperature, humidity, and other weather metrics
- Automatic updates via MQTT subscription

### Minimum Panel Size
6 columns x 8 rows

---
