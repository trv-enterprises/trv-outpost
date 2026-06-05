---
sidebar_position: 10
---

# Creating Components

There are three ways to create components:

## 1. Manual Editor

Open the component editor from either:
- Design Mode > Components > **Create** button
- Dashboard edit mode > Panel header > Edit icon > **New Component**

The editor provides a form-based interface:

1. **Select component type** (Chart, Control, or Display)
2. **Select sub-type** (e.g., Bar chart, Toggle control)
3. **Enter name and description**
4. **Select a connection** (data source)
5. **Configure query** (SQL, API params, etc.)
6. **Set data mapping** (map query fields to chart axes)
7. **Adjust options** (colors, labels, thresholds)
8. **Preview** the component with live data

Click **Save** to create the component.

:::tip Make a component variable-driven
To let a [dashboard variable](dashboard-variables.md) drive this component, put
the `{{dashboard-variable}}` token where the value should go — in a SQL/EdgeLake
`WHERE` clause, or as a client-side filter value. At view time the dashboard's
selected value is substituted in (safely bound or escaped for queries). The
component is detected as variable-driven automatically once the token is
present.
:::

## 2. AI Builder

Create components through natural language conversation with an AI assistant:

1. Launch from Design Mode > Components > Create > **Create with AI**
2. Or from a dashboard panel > Edit icon > **New with AI**
3. A pre-flight dialog gathers context (component type, connection)
4. The AI builder opens with a split layout: chat (left) + preview (right)

See [AI Component Builder](ai-builder.md) for the full workflow.

## 3. Select Existing

Reuse a component from the library:

1. From a dashboard panel > Edit icon > **Select Existing**
2. Browse or search the component library
3. Filter by category (Charts, Controls, Displays)
4. Click a component to select it, then confirm

The selected component is assigned to the panel. The panel auto-expands to meet the component's minimum size.

## Editing Existing Components

From the component list or a dashboard panel:

- **Edit Component** opens the manual editor
- **Edit with AI** opens the AI builder with the existing component loaded

Changes to a component update it everywhere it's used.

## Versioning

Components are stored as a sequence of versions in the database (each
version is its own row sharing a component ID). Lists, dashboard
panels, and the component detail view always show the **latest
version**. Behavior depends on which editor you use:

- **Manual editor save** updates the latest version *in place* —
  the version number doesn't change. Dashboards see the new state
  immediately.
- **AI builder** creates a new draft version while you iterate
  (status: `draft`). Your previous saved component stays the
  rendered version everywhere it's used until you click **Save**,
  which promotes the draft to `final`. **Discard** deletes the
  draft and leaves the previous final as the latest. See
  [AI Component Builder](ai-builder.md#versions-and-drafts).

Older final versions stay in history; the version list on the
component detail page lets you inspect or roll back to any prior
state.

### Why versions exist (and their limits)

Versioning is primarily an **AI safety net**. When the AI builder makes
a change, *you* didn't make the edit by hand — so if the result isn't
what you wanted, there's nothing obvious for you to undo manually. The
version history is what lets you **revert to the prior state** in that
case: each AI save is a distinct version you can roll back to.

For **manual edits there is no per-save version snapshot** — a manual
save updates the component in place. The assumption is that since you
just made the change yourself, you can reverse it the same way (edit
again and put it back). Versioning isn't trying to be a general
undo/redo history; it exists mainly so an AI-driven change you can't
easily reproduce by hand can still be rolled back.

In short:

- **AI change didn't work out?** Roll back to the previous version from
  the component detail page.
- **Manual change you want to undo?** Just edit it again — there's no
  version to revert because you authored the change directly.

---
