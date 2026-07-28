---
sidebar_position: 15
---

# Connections Overview

Connections define how the dashboard fetches data and communicates with external systems. Manage connections from Design Mode > Connections.

## Connection List

The connections page shows all configured connections with:
- Name and description
- Connection type (SQL, API, WebSocket, etc.)
- Number of components using this connection
- Last modified date

Use the search bar to filter by name, description, or type. Switch between list and tile views.

## Creating a Connection

1. Click the **Create** button
2. Select the connection type
3. Fill in the type-specific configuration
4. Use **Test Connection** to verify the settings
5. Click **Save**

## Duplicating a Connection

The **Duplicate** icon on each row (list view) or card (tile view) copies a
connection immediately as `<name> (copy)` in the same namespace, carrying its
type, configuration, description, and tags. You stay on the list; the copy
appears there and can be edited like any other connection.

:::caution Secrets are not copied
Passwords, API keys, and tokens are never sent to the browser, so a duplicate is
created **without** them. Open the copy and re-enter its credentials before
testing or using it — a notification reminds you when the source had secrets.
:::

## Testing Connections

The connection editor includes a test feature:
1. Enter test parameters (query, message, etc.)
2. Click **Test**
3. View the response data to verify the connection works

## Connection Usage

The chart count column shows how many components reference each connection. Deleting a connection that's in use by components will cause those components to fail to load data.

## Tags and Dashboard Variables

Connection **tags** do double duty for [dashboard variables](dashboard-variables.md): a connection-swap variable discovers its candidate connections by tag, and a configurable **tag prefix** can drive the dropdown label. Tag a connection `host:trv-srv-001`, set the variable's label prefix to `host`, and the dropdown shows `trv-srv-001` instead of the full connection name. See [Tagging: real-time vs. query connections](dashboard-variables.md#tagging-matters-real-time-vs-query-connections) for why distinct tags matter when one source has both a streaming and a query connection.

---
