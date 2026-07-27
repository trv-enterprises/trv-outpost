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
- Alert banner when a weather advisory is active for the location

### Size variants

Set **Weather Size** to choose how much the widget shows:

| Variant | Shows | Give it at least |
|---------|-------|------------------|
| **Small** | Icon, temperature, conditions, location | 3 rows |
| **Medium** | Current conditions, detail metrics, sunrise/sunset bar | 6 rows |
| **Large** (default) | Everything above, plus hourly and 5-day forecasts | 10 rows |

All variants need at least 7 columns.

:::caution Size medium and large for the alert banner
The editor only enforces a 7 x 3 minimum — the floor for the *small*
variant — so it will happily let you make a medium or large panel too
short. Nothing warns you, and the panel looks fine most of the time.

The catch is the **alert banner**: it appears only while a weather
advisory is active for your location. A 4-row medium panel can look
correct for weeks and then clip the moment a heat advisory comes through.
Size for the alert case up front and the bad-weather day takes care of
itself.
:::

---
