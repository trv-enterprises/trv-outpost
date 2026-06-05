---
sidebar_position: 7
---

# Panel Management

Panels are the building blocks of a dashboard layout. Each panel occupies a rectangular area on the grid and contains one component.

## Creating Panels

In edit mode, click and drag on empty grid space to draw a new panel:

1. Click on an unoccupied area of the grid (cursor shows as crosshair)
2. Drag to define the rectangle size
3. Release the mouse — the panel is created if at least 2x2 grid cells
4. A dashed blue preview shows the panel dimensions while dragging

## Moving Panels

### Standard Mode
Drag the panel by its header bar. The panel snaps to the grid as you move.

### Compact Mode
Drag anywhere on the panel. Click (without dragging) opens the component menu instead.

Panels cannot be moved beyond the layout dimension boundary (shown as red dashed lines).

## Resizing Panels

Drag the resize handle in the bottom-right corner of any panel. The handle appears as a small blue triangle.

- Panels enforce minimum sizes based on the assigned component type
- Panels cannot be resized beyond the layout boundary
- The size label in the header updates in real-time during resize

### Minimum Panel Sizes

| Component Type | Minimum Size |
|---------------|-------------|
| Default / Button / Number | 2 x 2 |
| Gauge | 2 x 3 |
| Bar / Line / Area / Pie / Scatter / Frigate Camera | 3 x 4 |
| Toggle / Slider | 3 x 3 |
| Text Input | 3 x 2 |
| Data Table | 4 x 3 |
| Plug / Dimmer | 2 x 7 |
| Tile Plug / Tile Dimmer | 2 x 3 |
| Text Label | 1 x 1 |
| Weather | 6 x 8 |

## Deleting Panels

In Standard edit mode, click the trash can icon in the panel header. The panel is removed immediately (undo is available by clicking Cancel before saving).

## Assigning Components

Click the edit icon (pencil for existing components, `+` for empty panels) in the panel header. A dropdown menu appears with options:

| Option | Description |
|--------|-------------|
| **Edit Component** | Open the component editor for the assigned component |
| **Edit with AI** | Open the AI builder to modify the component |
| **New Component** | Create a new component in the inline editor |
| **New with AI** | Launch the AI builder to create a component from scratch |
| **Select Existing** | Choose from the component library |

After assigning a component, the panel automatically expands to meet the component's minimum size if needed.

## Panels and Dashboard Variables

When a dashboard defines a [dashboard variable](dashboard-variables.md), panels interact with it in two ways:

- **Connection-swap pinning.** Every panel follows a connection-swap variable by default. To keep a panel on its own connection, **pin** it from the panel's edit menu — useful when one panel should always show a fixed reference while the rest of the board re-scopes.
- **Text panels with variable tokens.** A text panel can embed a `{{variable:NAME}}` token (inserted from a pill in the text editor) that resolves to the variable's current value — e.g. a header reading `Host: {{variable:host}}` updates as the viewer changes the selection.

---
