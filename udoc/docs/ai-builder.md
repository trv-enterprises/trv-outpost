---
sidebar_position: 14
---

# AI Component Builder

The AI builder lets you create and modify components through natural language conversation with an AI assistant.

## Launching the AI Builder

### For New Components
1. Design Mode > Components > Create > **Create with AI**
2. Dashboard edit mode > Panel > Edit icon > **New with AI**

A **pre-flight dialog** appears first to gather context:
- Component type (Chart, Control, or Display)
- Sub-type (e.g., Bar chart, Toggle)
- Connection to use
- Component name

### For Existing Components
1. Design Mode > Components > select component > **Edit with AI**
2. Dashboard edit mode > Panel > Edit icon > **Edit with AI**

The AI builder opens with the existing component loaded.

## The AI Builder Interface

The screen splits into two panels:

### Chat Panel (left)
- **Message history**: Shows the full conversation with timestamps
- **Text input**: Type your requests at the bottom
- **Send**: Click Send or press Enter
- **Multiline**: Press Shift+Enter for line breaks
- **Thinking indicator**: Shows when the AI is processing
- **Tool calls**: The AI shows when it's using tools (updating code, querying data)

### Preview Panel (right)
- **Live preview**: Renders the component with real data
- **Component name**: Editable at the top of the preview
- **Real-time updates**: Preview refreshes as the AI modifies the component

## How to Use

### Describe What You Want
Be specific about the visualization or control you need:

- "Create a bar chart showing CPU usage over the last hour"
- "Make a toggle switch for the living room lights"
- "Build a gauge showing server memory usage with warning at 80%"

### Iterate
Ask the AI to refine the component:

- "Change the colors to blue and green"
- "Add a legend to the bottom"
- "Make the Y axis start at 0"
- "Switch to a line chart instead"

### The AI Can
- Write and update component code
- Query your data connections to understand the data structure
- Set chart types, axis labels, and visual options
- Configure control settings (MQTT topics, command payloads)
- Name and describe the component

## Saving

- Click **Save** to publish the component as a final version
- Click **Discard** to delete the draft and return
- If you navigate away with unsaved work, a confirmation dialog appears

When launched from a dashboard panel, the saved component is automatically assigned to that panel.

## Versions and drafts

The AI builder uses **versioning to checkpoint your work in progress**:

- The first time you ask the AI to change something on an existing
  component, the server creates a new row in the database with the
  same component ID, the next version number, and `status: draft`.
- Every subsequent edit during this session updates that draft
  in place — no new row per turn. The conversation tab shows a
  preview powered by the draft.
- The previous *final* version stays untouched. Dashboards using
  the component continue to render the final version, not the
  draft.
- Clicking **Save** flips the draft's `status` from `draft` to
  `final`. The previous final stays in history; the new final
  becomes what dashboards render.
- Clicking **Discard** deletes the draft row entirely, leaving the
  previous final as the latest version.

Old final versions are preserved indefinitely. The `/api/components/:id/versions`
endpoint and the version-history UI on the component detail page let you
inspect or roll back to any earlier version.

The **manual editor** does *not* create a draft on every save —
manual edits update the latest version in place. Versioning is an
AI-builder-specific safeguard so you can experiment freely without
breaking what's already on dashboards.

## Sessions

AI builder sessions are temporary (24-hour expiry). Each session maintains conversation history so you can return to a previous session if the browser tab stays open.

---
