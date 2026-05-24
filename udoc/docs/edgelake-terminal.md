---
title: EdgeLake Terminal
sidebar_position: 3
---

# EdgeLake Terminal

The EdgeLake Terminal is an interactive AnyLog/EdgeLake command
shell at `/design/extensions/edgelake-terminal`. It lets you send
raw commands to any EdgeLake connection in the deployment and see
the response verbatim — same surface you'd get over SSH to the node,
but rendered in the dashboard with command history, recording, and
the connection picker.

The terminal does **not** change how charts query EdgeLake — chart
queries continue to work whether the terminal is enabled or not.
Disabling the terminal hides the page and 403s the terminal's own
API; it doesn't disable EdgeLake support. To disable EdgeLake
entirely, use the **Type Availability** setting under Manage →
Settings.

## Sending a command

1. Pick an EdgeLake connection from the **Connection** dropdown.
   Only connections of type `EdgeLake` are listed.
2. Type a command in the prompt at the bottom — e.g.
   `get status`, `blockchain get table`, `sql my_db "SELECT * FROM
   readings LIMIT 10"`.
3. Press **Enter** (or click **Send**). The response prints in the
   transcript above.

Up-arrow / down-arrow in the prompt walks through your command
history for this session.

## Destination

The **Destination** field maps to AnyLog's `destination` REST
header. Four built-in choices:

| Destination | Effect |
|---|---|
| `(connection node)` | Run the command on the node the connection points at — the default. |
| `network (fan out)` | Fan the command out across the EdgeLake cluster. Asks every peer the node knows about. |
| `master (blockchain node)` | Route to the cluster's master/blockchain node. |
| `peer list… (edit to your nodes)` | Seed text — pick this to drop `<ip>:<port>, <ip>:<port>` into the field, then overwrite with real addresses. Single peer or comma-separated list both work. |

Peer addresses you've typed before are remembered in the browser
(localStorage) and surface as recent entries in the dropdown.

## Method (Auto / GET / POST)

AnyLog uses GET for read commands and POST for state-changing ones
(`run blockchain sync`, `set …`, `create table …`, etc.). The
**Method** picker decides which verb to send:

- **Auto** (default) — Detect from the command's leading verb.
  Recognizes `run`, `set`, `create`, `drop`, `delete`, `update`,
  `insert`, `reset`, `connect`, `disconnect`, `add`, `enable`,
  `disable`, `schedule`, `unschedule`, `deploy`, `exit`, `kill`, and
  `thread` as writes; also peeks inside `sql … "…"` for write
  statements. Everything else GETs.
- **GET** — Force GET.
- **POST** — Force POST. Use when Auto missed a write verb.

POST responses with empty bodies (common for writes) render as
`(POST 200 — no response body)` so success isn't silent.

The transcript row labels the resolved method when it's not GET, so
you can tell at a glance which calls were writes.

## Timeout

The **Timeout (s)** field caps how long any one command can take.
Default 30 seconds; range 1–300. The EdgeLake connection itself has
a chart-tuned timeout (usually 20s) — this overrides it for the
terminal only, so long-running diagnostics like `test network` or
distributed-fan-out SQL don't get cut off early.

If a command exceeds the timeout, the transcript shows a clear
"didn't respond within Ns" error rather than a generic 502.

## Cancel

While a command is in flight, the **Send** button becomes
**Cancel**. Clicking it aborts the in-flight request immediately —
no waiting for the timeout. Useful when a command is hanging on a
wedged node, or you realize you typed it wrong.

## Recording a session

The **Record session** button captures the transcript to a local
text file as you go. Click it, choose a file (or location), and
every command + response from that point onward streams to the
file. **Stop recording** when you're done.

How the file gets written depends on your browser:

- **Chrome, Edge, and other Chromium-based browsers** support the
  File System Access API. The terminal opens a save dialog and
  writes each entry live as you go. If you close the tab without
  stopping, the file is left intact at whatever was already
  written.
- **Firefox and Safari** don't support live file writes. Instead,
  the terminal accumulates the transcript in memory and triggers a
  download when you click **Stop recording**.

The recorded format is plain text, the same content you see in the
transcript — one block per command with timestamp, method (if not
GET), destination (if not the connection node), the command, the
response, and the duration. Easy to diff, easy to grep.

## Common commands

A few useful AnyLog commands to try:

- `get status` — node health and identity.
- `get connections` — peer list registered on this node.
- `blockchain get table` — all tables registered on the blockchain.
- `blockchain get *` — full blockchain entries (operators,
  publishers, tables, etc.).
- `test network` — diagnostic ping to every registered peer. Slow
  on large clusters; bump the Timeout before running.
- `get processes` — running threads on the node.
- `sql my_db format=json "SELECT … LIMIT 10"` — query a table.

For the authoritative command reference, see the
[AnyLog command docs](https://github.com/AnyLog-co/documentation/blob/master/README.md).

## When to use the terminal vs. chart queries

The terminal is a **debugging and exploration** surface — for one-off
investigations, diagnostics, and ad-hoc SQL. For repeatable
dashboards, build a chart on the EdgeLake connection instead: the
chart editor handles parameter binding, refresh intervals, error
display, and caching in ways the terminal deliberately does not.

## Disabling the extension

Admins can turn the terminal off in **Manage → Settings → Extensions
→ EdgeLake Terminal**. When off:

- The sidebar link under Design → Extensions disappears.
- Direct navigation to `/design/extensions/edgelake-terminal`
  redirects to `/design`.
- The `POST /api/edgelake-terminal/execute` endpoint returns
  `403 extension_disabled`.

Chart queries against EdgeLake connections continue to work
unaffected — only the terminal is gated.

See the [Extensions overview](./extensions-overview.md) for the
broader extension toggle model.
