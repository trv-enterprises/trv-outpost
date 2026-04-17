# Changelog

All notable changes to TRVE Dashboards. This file is started at v0.6.0;
prior releases are described in the git history (see `git tag`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.1] — 2026-04-17

### Fixed

- **SSE streams killed by 30s `WriteTimeout`**. The global HTTP
  `WriteTimeout` set on the Gin server was being enforced on
  long-lived `/api/connections/:id/stream` responses, terminating the
  stream after exactly 30 seconds. The browser auto-reconnected
  behind the scenes, but Firefox logged a "can't establish a
  connection" error on every reconnect cycle — visible as a flood of
  errors while viewing ts-store / WebSocket-backed charts. Fixed by
  calling `http.ResponseController.SetWriteDeadline(time.Time{})` at
  the top of both the standard and aggregated SSE handlers to
  disable the deadline for SSE responses only. Global `WriteTimeout`
  stays in place for every other handler.

## [0.6.0] — 2026-04-17

### Added

- **Type Availability gating**. Admins can enable or disable connection
  types, chart subtypes, control subtypes, display subtypes, and named
  integrations from a hierarchical Type Availability editor in
  Manage → Settings. Disabled items disappear from creation pickers,
  the AI agent's prompt and tool enums, and the MCP catalog. Existing
  dashboard components keep rendering regardless — gating is creation
  / suggestion only.
- **Integrations registry**. New `IntegrationInfo` metadata bundles
  related types under one toggle. Frigate (connection + camera viewer
  + alerts grid) and Weather (display) ship as integrations.
- **`enabled_types` / `known_types` settings** with seed-on-first-sight:
  new types added in a release auto-enable on first boot while
  admin-disabled items persist across upgrades.
- **WebSocket Bidirectional checkbox** in the connection editor. When
  set, the connection resolves to `stream.websocket-bidir` and gains
  write capability for control commands.
- **Connection-level parser** for WebSocket and TCP. Configure
  `data_path`, `timestamp_field`, and `timestamp_scale` once on the
  connection (point-to-point streams have one shape, so unwrap once
  on the server). Includes a ts-store preset that covers both MQTT
  and WebSocket push transports, plus a live test panel with side-by-
  side sample input and extracted output. MQTT keeps its existing
  per-component parser because broker multiplexing means each topic
  may carry a different shape.
- Dynamic AI agent prompt + tool enums — `BuildSystemPrompt(catalog)`
  and `GetAnthropicTools(catalog)` rebuild per message from the
  filtered catalog so admin toggles take effect on the next user turn.
- New MCP tool `list_integrations`.
- New REST endpoint `GET /api/registry/integrations` (with
  `?include_disabled=true` for the settings editor).
- Backend tests for WebSocket and TCP socket adapters
  (`internal/datasource/socket_streaming_test.go`), including the new
  TCP parser path.

### Changed

- Frigate connection type is now surfaced through the integrations
  registry's `OwnedConnectionType` rather than being a free-floating
  `DatasourceType` constant. The proxy handler is unchanged.
- ts-store parser preset renamed from `tsstore_mqtt` → `tsstore`. One
  preset covers both MQTT and WebSocket transports because both
  ts-store push paths use the same `{"timestamp": <ns int64>, "data":
  {...}}` envelope. Existing chart records that wrote `tsstore_mqtt`
  keep working.
- WebSocket / TCP `message_format` options reduced to `json` and
  `text`. Binary frames carrying JSON still parse transparently.
- `SocketParserConfig` gained a `TimestampScale` field (`ns` / `ms` /
  empty for auto-detect).

### Removed

- **UDP connection support**. The legacy `stream.udp` adapter,
  `udp.go`, the protocol option, and related model fields are gone.
  Realistic dashboard telemetry is overwhelmingly MQTT / WebSocket /
  REST, and the legacy connected-socket implementation couldn't
  receive unsolicited packets in any case.
- **Binary message_format** option for WebSocket and TCP. There was
  never a true binary mode for WebSocket, and TCP's binary mode had
  no consumers. Future binary protocols (MessagePack, protobuf)
  should be purpose-built typed adapters, not generic raw-bytes.

### Fixed

- Custom-mode parser preset on the connection editor briefly enabled
  inputs then re-derived the preset back to "none" before the user
  could type — fields are now sticky on explicit user selection.
- Component-type switcher (Chart / Display / Control) used to default
  new Display components to `frigate_camera` regardless of whether
  Frigate was enabled. Now picks the first enabled display type.
- Display tab in the component-type switcher now hides entirely when
  no display types are enabled (and same for the Control tab).
- Connection-type filter now correctly maps the bare legacy names
  (`sql`, `socket`, `mqtt`, ...) to the dotted registry families
  (`db.*`, `stream.*`, ...) so disabling a registry-side type
  collapses the matching dropdown options.

### Notes

- Internal Go signature changes (`BuildCatalog`, `GetAnthropicTools`,
  `NewAgent`, `NewToolRegistry`, `NewRegistryHandler`) are
  source-compatible only — any external Go consumers will need to
  pass the new parameters. There are no API-side breaking changes.
- The settings system migrates seamlessly: `SyncSettingsFromConfig`
  inserts the new `enabled_types` / `known_types` keys with empty
  defaults on first boot, then `SeedKnownAndEnabledTypes` populates
  them from the live registries — every type ends up enabled for
  existing deployments.
