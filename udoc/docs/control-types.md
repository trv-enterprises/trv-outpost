---
sidebar_position: 12
---

# Control Types

Controls are interactive UI elements that send commands to devices via bidirectional connections (MQTT, WebSocket). Most controls can both read device state and send commands.

Executing a control requires the **Control** capability (see
[User Management](user-management.md)). Without Control, controls
still render their current state in View mode but the interactive
affordance is disabled and the server rejects execute requests.

## Available Control Types

The control library is split into three categories that show up
grouped in the component-editor picker.

### Carbon Controls (full-size)

| Type | Description | Can Read | Can Write |
|------|-------------|----------|-----------|
| **Button** | Simple action button that sends a command on click | No | Yes |
| **Toggle** | Carbon on/off switch with current state | Yes | Yes |
| **Slider** | Numeric range slider for dimmers, volumes, etc. | Yes | Yes |
| **Text Input** | Text field for sending custom commands | Yes | Yes |
| **MQTT Publish** | Publish a literal payload to an MQTT topic on click | No | Yes |

### Custom Controls (full-size)

| Type | Description | Can Read | Can Write |
|------|-------------|----------|-----------|
| **Switch** | Pill-shaped on/off control (formerly "Plug") | Yes | Yes |
| **Dimmer** | Vertical light dimmer with brightness slider | Yes | Yes |
| **Garage Door** | Garage-door indicator + open/close action | Yes | Yes |

### Tiles (compact)

| Type | Description | Can Read | Can Write |
|------|-------------|----------|-----------|
| **Tile Switch** | Compact switch tile with popup for details | Yes | Yes |
| **Tile Dimmer** | Compact dimmer tile with popup for brightness | Yes | Yes |
| **Tile Garage Door** | Compact garage-door tile | Yes | Yes |

### Legacy / hidden

A few control types are kept for backward compatibility with existing
dashboards but no longer appear in the picker for new components:

- **Plug** → use **Switch** instead.
- **Tile Plug** → use **Tile Switch** instead.
- **Text Label** → use a native **Text** panel instead.

Existing components with these types continue to render.

## How Controls Work

### State Subscription
Controls that can read state subscribe to an MQTT topic (or the
output of a bidirectional WebSocket connection) to receive the
current device state. The state is extracted from the message using
a configurable field path.

### Command Execution
Controls that can write send commands when the user interacts with
them (click, toggle, slide). Commands are sent to the configured
connection with the appropriate payload. Requires the **Control**
capability.

### Connection Requirements
- Controls require a **bidirectional connection** (MQTT, or
  WebSocket marked Bidirectional on the connection).
- The connection must support both subscribing (for state) and
  publishing (for commands).
- MQTT Publish and Button controls are write-only and don't need
  subscribe support.

## Compact Tile Controls

Tile Switch, Tile Dimmer, and Tile Garage Door are compact versions
designed for dense dashboards:

- Small footprint (minimum 2x3 grid cells)
- Show basic state (on/off, brightness level, door position)
- Click to open a popup with the full control interface
- Ideal for home-automation dashboards with many devices

---
