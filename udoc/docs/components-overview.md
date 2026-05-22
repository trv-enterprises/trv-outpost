---
sidebar_position: 9
---

# Components Overview

Components are the visual elements placed inside dashboard panels. There are three categories:

## Charts

Data visualization components that render using ECharts. They query a data connection and display results as interactive charts.

Types: Bar, Line, Area, Banded Bar, Pie, Scatter, Gauge, Data Table, Number, Custom

See [Chart Types](chart-types.md) for details.

## Controls

Interactive UI elements that send commands to devices via MQTT or WebSocket connections. Controls can read device state and send commands.

Types: Button, Toggle, Slider, Text Input, MQTT Publish, Switch, Dimmer, Garage Door, Tile Switch, Tile Dimmer, Tile Garage Door

Executing a control requires the **Control** capability. See
[Control Types](control-types.md) for details and for the legacy
type names (Plug → Switch, Tile Plug → Tile Switch, Text Label →
native Text panel).

## Displays

Specialized visual components for specific integrations that don't use the standard chart rendering.

Types: Frigate Camera, Frigate Alerts, Weather

See [Display Types](display-types.md) for details.

## Component Library

All components are stored in a shared library. The same component can be used across multiple dashboards and panels. When you edit a component, the changes appear everywhere it's used.

Access the full component library from Design Mode > Components.

### List Features

- **Search** by name, description, type, or connection
- **Filter** by component type hierarchy (Charts > Bar, Line, etc.)
- **Filter** by connection
- **Sort** by name, type, connection, dashboard count, status, or date
- **View toggle** between list and tile layouts
- **Dashboard count** shows how many dashboards use each component

### Component Status

| Status | Meaning |
|--------|---------|
| **Final** | Published version, used in dashboards |
| **Draft** | Work in progress, typically from AI builder sessions |

---
