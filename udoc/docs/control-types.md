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
| **Light** | Color bulb: power, brightness, and a color picker | Yes | Yes |
| **Garage Door** | Garage-door indicator + open/close action | Yes | Yes |

### Tiles (compact)

| Type | Description | Can Read | Can Write |
|------|-------------|----------|-----------|
| **Tile Switch** | Compact switch tile with popup for details | Yes | Yes |
| **Tile Dimmer** | Compact dimmer tile with popup for brightness | Yes | Yes |
| **Tile Light** | Compact color-bulb tile; live color shown on the tile face | Yes | Yes |
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

Tile Switch, Tile Dimmer, Tile Light, and Tile Garage Door are compact
versions designed for dense dashboards:

- Small footprint (minimum 2x3 grid cells)
- Show basic state (on/off, brightness level, door position)
- Click to open a popup with the full control interface
- Ideal for home-automation dashboards with many devices

---

## Light and Tile Light

**Light** and **Tile Light** drive a color-capable bulb over
Zigbee2MQTT. Both offer power, brightness, and color; the tile is the
compact form.

### Setting color

Color is a first-class action, not something buried in a settings
panel. On **Tile Light** the tile face shows the light's current color
as a small swatch, and a single tap anywhere on the tile opens its
control popup, where you pick from the light palette (warm whites
through to saturated accents) or open the custom picker for any hex the
palette doesn't cover.

The swatch on the tile is an indicator rather than a button: the palette
needs more room than a tile has, so it opens with the popup instead of
being clipped at the tile edge.

Behind the scenes the control publishes the hex directly — for example:

```json
{"state": "ON", "color": {"hex": "#ffd300"}}
```

Zigbee2MQTT accepts hex and converts it on the way in, so nothing is
converted on the command path. Setting a color also turns the light on.

### Why the swatch sometimes differs from what you picked

Zigbee bulbs report their color back as CIE `{x, y}` coordinates, never
as the hex that was written. The dashboard converts those coordinates
back to a color for display, and the bulb clamps any color to what its
LEDs can physically produce — so a very saturated pick may read back a
shade off.

To keep the swatch from visibly shifting the instant you set a color,
the control shows the hex you picked and only yields to the device's
reported color once that color changes materially. This matters when
an automation drives the same bulb: if a rule recolors the light, the
swatch follows the light rather than continuing to show your pick.

### Brightness and motion

Brightness is a 0–100% bar in the UI and is sent as Zigbee's native
0–254 range. On the tile, fill height is brightness and the fill takes
the bulb's live color.

If the device also reports `occupancy` — a motion nightlight, for
instance — a small motion dot appears in the tile corner. This is a
read-only indicator. Making motion actually *switch the light on* is an
automation concern handled outside the dashboard, not something the
control does.

### Configuration

| Setting | Applies to | Description |
|---------|-----------|-------------|
| `show_brightness` | Light | Show the brightness bar |
| `show_color` | Light | Show the color picker |
| `show_color_on_tile` | Tile Light | Show the live color swatch on the tile face (percentage shown instead when off) |
| `icon` | Tile Light | MDI icon (`lightbulb-on`, `floor-lamp`, `lamp`, …) |
| `state_field` | Both | State field to read (default `state`) |

Both require a device type whose command uses **passthrough** — the
built-in **Zigbee Color Light** device type does this. Passthrough
publishes the control's whole object as the payload, which a
placeholder-substitution template cannot express.

---
