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
| **Duplicate** | Copy this panel *and* its component (see below) |

After assigning a component, the panel automatically expands to meet the component's minimum size if needed.

The **Select Existing** picker also offers a **Create a duplicate of the
selected component** checkbox: confirm with it checked and the panel gets a new
`<name> (copy)` component instead of the original, so you can edit it without
affecting other dashboards. See
[Create a duplicate instead](creating-components.md#create-a-duplicate-instead).

## Duplicating a Panel

**Duplicate** in the panel's edit menu copies the panel *and* the component on
it. The new panel is placed in the first free space to the right of (or below)
the original at the same size, holding a fresh `<name> (copy)` component.

This is the quickest way to build a row of similar tiles: duplicate, then edit
the copy's query or title. Because the copy is its own component, editing it
does **not** affect the panel you copied from.

The component copy is created as soon as you click — it appears in the
component library right away, so it's there even if you then cancel the
dashboard edit. (Cancelling still discards the *panel*.) If you want two panels
showing the *same* component instead, use **Select Existing** and pick it.

Empty panels have nothing to copy, so Duplicate isn't offered on them.

## Deleting a Panel

The trash icon removes the panel from the dashboard. The component itself is a
separate record and normally stays in the library — deleting a panel is not
meant to destroy the thing it was showing.

When removing the panel would leave its component **completely unused** — no
other panel on this dashboard, and no other dashboard, references it — a
confirmation appears offering to delete the component too. The checkbox is off
by default: the panel goes either way, and the component is only deleted if you
explicitly ask.

Unlike removing the panel, deleting the component is immediate and is **not**
undone by cancelling the dashboard edit.

If the component is still used somewhere else, the panel is removed with no
prompt — there is nothing to clean up.

## Shared Component Indicator

In edit mode, a panel whose component is also placed on **other** dashboards
shows a counter icon in its header. The number is how many dashboards use that
component in total, and the tooltip names how many others are affected.

It's a heads-up, not a problem: sharing a component is normal and often the
point. But it means editing that panel's component changes those dashboards
too. If you want a change that stays local, duplicate the component first —
either from the panel's **Select Existing** picker or from the components list.

Saving a shared component asks for confirmation and lists the dashboards it
will affect, so you get a second chance even if you miss the icon.

## Panels and Dashboard Variables

When a dashboard defines a [dashboard variable](dashboard-variables.md), panels interact with it in two ways:

- **Connection-swap pinning.** Every panel follows a connection-swap variable by default. To keep a panel on its own connection, **pin** it from the panel's edit menu — useful when one panel should always show a fixed reference while the rest of the board re-scopes.
- **Text panels with variable tokens.** A text panel can embed a `{{variable:NAME}}` token (inserted from a pill in the text editor) that resolves to the variable's current value — e.g. a header reading `Host: {{variable:host}}` updates as the viewer changes the selection.

---
