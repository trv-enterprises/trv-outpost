# CLAUDE.md - AI Assistant Guide

This file provides context and guidance for AI assistants working on this project.

## Release & Deploy

See the `release-deploy` skill for the authoritative runbook (tagging, image build/push, homelab deploy, rollback). Do not duplicate the procedure here — project-specific overrides go in this section only.

**Project-specific defaults:** deploy target is `deploy-dashboard`, images land at `ghcr.io/trv-enterprises/dashboard-{server,client}`, token is `$TRVE_GH_TOKEN`. Everything else follows the skill.

**API docs regeneration is part of release.** `make release` calls `make api-docs-check`, which regenerates `server-go/docs/swagger.{json,yaml,go}` (via `swag init`) and `docs/postman/trv-outpost.postman_collection.json` (via `docs/postman/build-collection.js`), then fails if any of those files diff. If you've added or changed an API handler since the last release, run `make api-docs` and commit the result before tagging — otherwise the release target stops you with a one-line `git add … && git commit` recipe.

**Release notes are mandatory.** After tagging and pushing, run step 4b of the skill (`gh release create vX.Y.Z --title … --notes …`). The tag annotation does not become the GitHub release body — without this step the Releases page shows only the empty `Release vX.Y.Z (BUILD ####)` placeholder. Use the feature-release or fix-release template documented in the skill. Then add the same content as a new entry at the top of `CHANGELOG.md` (Keep-a-Changelog format) so git-clone users see it too.

## Database Migrations

**Default: add to the in-process migration framework**, not as a standalone `cmd/migrate-*` binary. The framework lives in `server-go/internal/database/migrations.go` — append a `{name, fn}` entry to the `migrations` slice and write a function with the same shape as `migrateStripChartThumbnail` or `migrateDropMaskSecrets`. The framework is idempotent (tracks completed migrations in the `migrations` collection) and runs at server startup, **before** index creation. This means every prod deploy of a new server image automatically applies pending migrations — no separate scp / docker exec / ad-hoc step. See `docs/architecture/database.md` for the full lifecycle.

**Standalone `cmd/migrate-*` binaries are the exception, not the rule.** Reserve them for cases that genuinely don't fit on-boot:
- Structural rewrites that touch many collections at once and benefit from a separate audit run (e.g. `migrate-uuid-ids`, which rewrote `_id` types and re-pointed every component reference).
- Migrations that need to run *before* a code-incompatible server boot (the new server can't start cleanly until the data is converted).
- One-shots that are too expensive or risky to gate every server start on (multi-hour sweeps, network-bound rewrites).

For everything else — `$set`, `$unset`, `$rename`, simple aggregation rewrites — write it in `migrations.go`. It ships in the image, runs automatically on the next deploy, and never needs a manual step.

## Development Rules

### 1. Build Number Increment
- **CRITICAL**: After every code change that affects functionality, increment the build number in `/client/build.json`
- Report the new build number to the user after incrementing
- Build number helps track changes and ensures proper cache busting
- Format: `{ "buildNumber": N }` where N is an integer

### 2. Terminology
- Use "connection" (not "data source" or "datasource") for external data connections in UI text and code. The `datasource` nomenclature has been fully retired — collection is `connections`, BSON field is `connection_id`, Go types are `Connection` / `ConnectionRepository` / `ConnectionService` / `ConnectionAdapter` (the runtime interface), API route is `/api/connections`. The legacy `datasource_id` field name and `/api/datasources` alias were removed in v0.11.x.
- **Component** is the umbrella entity. Three sub-types via `component_type`:
  - `chart` — ECharts visualizations (bar/line/pie/scatter/gauge/number/dataview/custom). Discriminated further by `chart_type`.
  - `display` — non-chart visual components (frigate cameras, frigate alerts, weather). Discriminated by `display_type`.
  - `control` — interactive components (buttons, toggles, sliders, plugs, dimmers). Discriminated by `control_type`.
- The word "chart" in UI/code refers strictly to `component_type=chart`. Don't use "chart" as a synonym for "component".
- **Namespace** = the conflict-domain grouping on connections/components/dashboards. Uniqueness is `(namespace, name)` — two namespaces can each have an entity called `Home`. Slug-safe strings like `default`, `my-homelab`. Namespaces are first-class records (name, description, color) managed at `/manage/namespaces`; active namespace is a per-user preference keyed on `active_namespace` in app_config. **Don't conflate with tags** — tags are descriptive (`environment:prod`), namespace is structural.

### 3. Full-Stack Awareness
- **Always consider frontend impact**: When making backend changes (API endpoints, models, response formats), identify and implement the corresponding frontend changes (API client, components, forms, types).
- Backend model changes typically require updates to:
  - `client/src/api/client.js` - API client methods
  - Form components that create/edit the entity
  - Display components that show the entity
  - Any TypeScript types or PropTypes if used
- Don't leave the frontend out of sync with backend changes.

### 4. Testing Reminder
- **Triggers**: Session start, server restart, or daylog write
- **Action**: Immediately remind the user to test:
  - "Don't forget to test! Test plan: [docs/TEST_PLAN.md](docs/TEST_PLAN.md)"
- For session start: Show reminder as first response
- For daylog write: Show reminder immediately after confirming daylog was written

---

## React Architecture Rules

These rules establish consistent patterns for the React frontend. Based on 2025 best practices.

### 1. State Management

| State Type | Tool | When to Use |
|------------|------|-------------|
| **Local UI State** | `useState` | Toggles, form inputs, modal open/close, component-specific state |
| **Shared Client State** | `useContext` + `useReducer` | App-wide state (mode, theme, user preferences) |
| **Server/Remote State** | Custom hooks wrapping `apiClient` | Data from backend APIs |

**Rules:**
- Keep state as local as possible - lift only when needed
- Mode state should use Context (not localStorage alone)
- Never duplicate server state in multiple components - use shared hooks

**Future:** Consider TanStack Query for server state caching and background refresh.

### 2. Data Fetching

**ALWAYS use `apiClient`** from `src/api/client.js` - never raw `fetch()` in components.

**Pattern for pages:**
```javascript
// Good - use apiClient
const data = await apiClient.getDashboard(id);

// Bad - raw fetch
const response = await fetch(`http://localhost:3001/api/dashboards/${id}`);
```

**Create entity-specific hooks:**
```javascript
// src/hooks/useDashboard.js
function useDashboard(id) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiClient.getDashboard(id)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [id]);

  return { data, loading, error, refetch: () => {...} };
}
```

**Existing hooks to use:** `useData`, `useComponents`, `useSources` in `src/hooks/`

### 3. Component Organization

| Type | Location | Responsibility | Max Lines |
|------|----------|----------------|-----------|
| **Pages** | `src/pages/` | Route handling, layout composition, data orchestration | ~400 |
| **Components** | `src/components/` | Reusable UI, receive data via props | ~200 |
| **Hooks** | `src/hooks/` | Reusable logic (data fetching, subscriptions) | ~100 |

**Rules:**
- Pages should NOT contain complex business logic - extract to hooks
- Components should be presentational where possible
- If a component exceeds 400 lines, break it into smaller components

### 4. File Structure (Target)

```
src/
├── api/
│   └── client.js           # API client singleton (ALWAYS use this)
├── hooks/
│   ├── useData.js          # Generic data fetching hook
│   ├── useDashboard.js     # Dashboard-specific hook
│   ├── useCharts.js        # Charts-specific hook
│   └── useConnections.js   # Connections-specific hook
├── context/
│   ├── ModeContext.jsx     # App mode (Design/View/Manage)
│   └── ThemeContext.jsx    # Theme preferences (future)
├── components/
│   ├── mode/               # Mode toggle components
│   ├── navigation/         # Nav components per mode
│   ├── charts/             # Chart-related components
│   └── shared/             # Truly shared components
├── pages/                  # Route components
├── utils/                  # Pure utility functions
└── config/                 # Configuration constants
```

### 5. Error Handling

**Rules:**
- **Never use `alert()`** - use Carbon `InlineNotification` or `Modal`
- Wrap app in `ErrorBoundary` component for crash recovery
- Data fetching errors: Show inline notification with retry option
- Form validation errors: Show per-field errors, not just form-level

**Pattern:**
```javascript
// Good
{error && (
  <InlineNotification
    kind="error"
    title="Failed to load"
    subtitle={error.message}
    actions={<Button onClick={refetch}>Retry</Button>}
  />
)}

// Bad
catch (err) {
  alert(err.message);
}
```

### 6. Forms

**Current:** Controlled components with individual `useState` calls.

**Rules:**
- Use Carbon form components exclusively
- Validate on blur/submit, not on every keystroke
- Track dirty state with single `hasChanges` boolean
- Show field-level validation errors

**Future:** Consider React Hook Form for complex forms to reduce boilerplate.

### 7. Styling

**Rules:**
- One SCSS file per component, co-located (e.g., `Page.jsx` + `Page.scss`)
- Use Carbon CSS variables: `var(--cds-text-primary)`, `var(--cds-background)`
- Use Carbon spacing tokens: `spacing.$spacing-05`
- Never hardcode colors - use Carbon tokens
- Minimal inline styles (only for truly dynamic values like dimensions)

**Carbon Token Hierarchy (prefer abstract tokens):**

Use the most abstract (semantic) token available. This ensures theme compatibility if switching between light/dark modes:

| Level | Example | When to Use |
|-------|---------|-------------|
| **Semantic tokens** (best) | `theme.$button-disabled`, `var(--cds-text-primary)` | Always prefer - adapts to theme |
| **Role tokens** | `var(--cds-layer-01)`, `var(--cds-border-subtle-01)` | For layout/structural elements |
| **Primitive colors** (avoid) | `$gray-70`, `#525252` | Only when no semantic token exists |

**SCSS Pattern for Theme Tokens:**
```scss
@use 'sass:map';
@use '@carbon/styles/scss/themes' as themes;
@use '@carbon/styles/scss/theme' as theme with (
  $theme: themes.$g100
);

// Good - extract from theme map (theme-aware, change themes.$g100 to switch themes)
--cds-button-disabled: #{map.get(themes.$g100, 'button-disabled')};

// Bad - hardcoded hex value
--cds-button-disabled: #525252;
```

**CSS Variable Overrides:**
- Set global overrides on `:root` in `App.scss` (not component-level) for portal compatibility
- Use `map.get(themes.$g100, 'token-name')` to extract values from the theme map
- To switch themes, change `themes.$g100` to `themes.$white`, `themes.$g10`, or `themes.$g90`

---

## Project Overview

**TRV Outpost** - A full-stack application for creating, managing, and viewing dynamic data visualization dashboards. The application features:

1. **Three Operating Modes**: Design, View, and Manage
2. **Dynamic Chart Builder**: Create React components with ECharts visualizations
3. **Multi-Source Data**: Connect to SQL, API, CSV, WebSocket, and MQTT data sources
4. **Real-time Updates**: Auto-refresh dashboards with configurable intervals

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Port 5173)                                 │
│                    React 18 + Vite + Carbon Design System                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Design Mode          │  View Mode            │  Manage Mode                │
│  - Layouts            │  - Dashboard Viewer   │  - Settings                 │
│  - Connections        │  - Real-time Data     │  - Users                    │
│  - Charts/Components  │  - Auto-refresh       │  - Device Types             │
│  - Dashboards         │  - Fullscreen         │                             │
│  - Dashboards         │  - Fullscreen         │                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ REST API
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GO BACKEND (Port 3001)                                  │
│                    Gin + MongoDB + Swagger                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  /api/layouts    │  /api/connections  │  /api/components  │  /api/dashboards│
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────────────────────┐
                    ▼                               ▼
              ┌──────────────┐              ┌───────────────┐
              │   MongoDB    │              │  Connections  │
              │    7.x       │              │ SQL/API/CSV/  │
              │              │              │ WS/MQTT       │
              └──────────────┘              └───────────────┘
```

## Technology Stack

### Frontend
| Technology | Version | Purpose |
|------------|---------|---------|
| React | 18.x | UI Framework |
| Vite | 5.x | Build Tool & Dev Server |
| React Router | 6.x | Client-side Routing |
| Carbon Design System | 11.x | UI Components (g100 dark theme) |
| ECharts | 5.x | Data Visualization |
| SCSS | - | Styling with Carbon tokens |

### Backend (Go)
| Technology | Version | Purpose |
|------------|---------|---------|
| Go | 1.25.x | Primary Language |
| Gin | 1.x | HTTP Framework |
| MongoDB | 7.x | Primary Database |
| Swaggo | 1.8.x | API Documentation |

## Application Modes

### Design Mode (`/design/*`)
Create and configure dashboard components:
- **Layouts** (`/design/layouts`) - Define cell-grid layouts with panels (32 × 32 px cells; cols/rows derive from canvas)
- **Connections** (`/design/connections`) - Configure SQL, API, CSV, WebSocket connections
- **Components** (`/design/components`) - Build charts, displays, and controls. Three sub-types: `chart` (ECharts visualizations — bar/line/pie/etc.), `display` (cameras, weather, frigate alerts), `control` (buttons, toggles, sliders).
- **Dashboards** (`/design/dashboards`) - Combine components with layouts

### View Mode (`/view/*`)
End-user dashboard viewing:
- **Dashboard Viewer** (`/view/dashboards/:id`) - View dashboards with real-time data
- Sidebar shows selectable dashboard tiles
- Auto-refresh based on dashboard settings
- Fullscreen viewing capability

### Manage Mode (`/manage`)
System administration and configuration:
- **Settings** (`/manage/settings`) - Admin-configurable settings (layout dimensions, tile font size)
- **Users** (`/manage/users`) - User management (create, edit users with name/GUID)
- **Device Types** (`/manage/device-types`) - Define device types with command schemas for controls

## File Structure

```
dashboard/
├── client/                    # React Frontend
│   ├── src/
│   │   ├── api/              # API client
│   │   ├── components/
│   │   │   ├── mode/         # ModeToggle, ModeSelector
│   │   │   ├── navigation/   # DesignModeNav, ViewModeNav, ManageModeNav
│   │   │   └── ...           # DynamicComponentLoader, etc.
│   │   ├── config/           # layoutConfig.js (MODES enum)
│   │   ├── pages/            # All page components
│   │   ├── theme/            # carbonEchartsTheme.js
│   │   ├── App.jsx           # Main app with routing
│   │   └── App.scss          # Global styles
│   ├── build.json            # Build number tracker
│   └── package.json
│
├── server-go/                 # Go Backend (Main API + AI Integration)
│   ├── cmd/server/main.go    # Entry point
│   ├── config/               # Configuration (Viper)
│   ├── internal/
│   │   ├── ai/               # AI agent, tools, system prompt
│   │   ├── database/         # MongoDB connection
│   │   ├── connection/       # SQL, API, CSV, Socket adapters (runtime adapter implementations)
│   │   ├── handlers/         # HTTP handlers
│   │   ├── mcp/              # MCP endpoint + shared dashboard-builder prompt
│   │   ├── models/           # Data models
│   │   ├── repository/       # Database operations
│   │   └── service/          # Business logic
│   └── docs/                  # Swagger documentation
│
└── docs/                      # Documentation
    ├── architecture/          # Architecture doc set (start at ARCHITECTURE.md)
    ├── DEPLOYMENT.md
    ├── TEST_PLAN.md
    └── plans-archive/         # Historical planning docs
```

## API Endpoints

### Go Backend (Port 3001)

| Method | Endpoint | Description |
|--------|----------|-------------|
| **Layouts** |||
| GET | `/api/layouts` | List layouts (paginated) |
| POST | `/api/layouts` | Create layout |
| GET | `/api/layouts/:id` | Get layout |
| PUT | `/api/layouts/:id` | Update layout |
| DELETE | `/api/layouts/:id` | Delete layout |
| **Connections** |||
| GET | `/api/connections` | List connections |
| POST | `/api/connections` | Create connection |
| GET | `/api/connections/:id` | Get connection |
| PUT | `/api/connections/:id` | Update connection |
| DELETE | `/api/connections/:id` | Delete connection |
| POST | `/api/connections/test` | Test connection |
| POST | `/api/connections/:id/query` | Execute query |
| **Controls** |||
| POST | `/api/controls/:id/execute` | Execute control command |
| **Components** |||
| GET | `/api/components` | List components (chart, display, and control sub-types) |
| GET | `/api/components/summaries` | Lightweight summaries for selection cards |
| POST | `/api/components` | Create component |
| GET | `/api/components/:id` | Get component (latest version) |
| PUT | `/api/components/:id` | Update component |
| DELETE | `/api/components/:id` | Delete component (all versions) |
| GET | `/api/components/:id/versions` | List component versions |
| GET | `/api/components/:id/versions/:version` | Get a specific version |
| DELETE | `/api/components/:id/versions/:version` | Delete a specific version |
| GET | `/api/components/:id/version-info` | Version metadata (count, has draft) |
| GET | `/api/components/:id/draft` | Get the draft version (if any) |
| DELETE | `/api/components/:id/draft` | Delete the draft version |
| **Dashboards** |||
| GET | `/api/dashboards` | List dashboards |
| POST | `/api/dashboards` | Create dashboard |
| GET | `/api/dashboards/:id` | Get dashboard |
| GET | `/api/dashboards/:id/details` | Get with expanded data |
| PUT | `/api/dashboards/:id` | Update dashboard |
| DELETE | `/api/dashboards/:id` | Delete dashboard |
| POST | `/api/dashboards/export/preview` | Export preview — counts + warnings for the selected dashboard IDs |
| POST | `/api/dashboards/export` | Build an ExportBundle JSON for the selected dashboard IDs |
| POST | `/api/dashboards/import/preflight` | Classify each object in a bundle as identical/conflict/new/blocked |
| POST | `/api/dashboards/import/apply` | Apply a bundle with per-conflict overwrite decisions |
| **Namespaces** |||
| GET | `/api/namespaces` | List namespaces |
| POST | `/api/namespaces` | Create namespace |
| GET | `/api/namespaces/:id` | Get namespace |
| PUT | `/api/namespaces/:id` | Update (rename cascades into referring records) |
| DELETE | `/api/namespaces/:id` | Delete (409 when in use, with per-type counts) |
| GET | `/api/namespaces/:id/usage` | Per-entity usage counts |
| **AI Sessions** |||
| POST | `/api/ai/sessions` | Create AI session |
| GET | `/api/ai/sessions/:id` | Get session state |
| POST | `/api/ai/sessions/:id/messages` | Send message (SSE streaming) |
| GET | `/api/ai/sessions/:id/ws` | WebSocket connection |
| POST | `/api/ai/sessions/:id/save` | Save session |
| DELETE | `/api/ai/sessions/:id` | Cancel session |
| **Settings (Admin)** |||
| GET | `/api/settings` | List all admin settings |
| GET | `/api/settings/:key` | Get setting by key |
| PUT | `/api/settings/:key` | Update setting value |
| **Config (App/User)** |||
| GET | `/api/config/system` | Get system-wide app config |
| PUT | `/api/config/system` | Update system config |
| GET | `/api/config/user/:user_id` | Get user preferences |
| PUT | `/api/config/user/:user_id` | Update user preferences (merges keys) |
| **Registry (type catalog)** |||
| GET | `/api/registry/connections` | List connection types from adapter registry |
| GET | `/api/registry/connections/:typeId` | Get a single connection type |
| GET | `/api/registry/categories` | List connection-type categories |
| GET | `/api/registry/components` | List component subtypes (filter `?category=chart\|control\|display`) |
| GET | `/api/registry/components/:typeId` | Get a single component subtype |
| GET | `/api/registry/catalog` | Unified catalog: connections + components + device types |
| GET | `/api/registry/catalog.md` | Same catalog rendered as markdown for LLM prompts |
| **Extensions** — optional, admin-gated. Each route group sits behind `RequireExtensionEnabled` middleware that 403s when the matching `extensions.<name>.enabled` setting is off. |||
| GET | `/api/tsstore-alerts/rules` | Aggregated alert-rule list across every tsstore connection |
| GET | `/api/tsstore-alerts/rules/:alert_id` | Single alert detail (requires `connection_id` query param) |
| POST | `/api/tsstore-alerts/rules` | Create a new alert rule (webhook or MQTT transport) |
| DELETE | `/api/tsstore-alerts/rules/:alert_id` | Delete an alert (and ALL its rules — ts-store has no per-rule delete) |
| GET | `/api/tsstore-alerts/probe` | Auth probe used by the rule-create wizard |
| POST | `/api/edgelake-terminal/execute` | Send a raw AnyLog command to an EdgeLake connection; honors `destination`, `method` (auto/GET/POST), `timeout_seconds` |
| **MCP (external agent SSE bridge)** |||
| GET | `/mcp/sse` | SSE connection for MCP — used with [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) by Claude Desktop |
| POST | `/mcp/message` | JSON-RPC message endpoint |

## Settings & Configuration

The application has two configuration systems:

### Admin Settings (`/manage/settings`)

Global settings managed by administrators through the Settings page in Manage mode.

- **Storage**: MongoDB `settings` collection, seeded from `server-go/config/user-configurable.yaml` on first run
- **API**: `GET/PUT /api/settings/:key`
- **Frontend**: `apiClient.getSettings()`, `apiClient.getSetting(key)`, `apiClient.updateSetting(key, value)`
- **DB values take precedence** over YAML defaults after first sync

**Current settings:**

| Key | Category | Description |
|-----|----------|-------------|
| `default_layout_dimension` | layout | Default dimension preset for new dashboards |
| `layout_dimensions` | layout | Array of available dashboard dimension presets |
| `tile_font_size` | appearance | Font size for compact tile control titles (xs/sm/md/lg). Applies to `tile_*` control components. |
| `title_font_size` | appearance | Component title size as a percentage of the 1rem base (50–200). Scales BOTH the title font and the title-band height across charts, number tiles, data views, and data tables. 100 = default. Applies on next page load. |
| `stream_buffer_size` | dashboard | Max data points a streaming chart keeps in client memory (the backfill/buffer depth). Higher = more history per live chart at the cost of browser memory. Default 1000. Applies on next page load. |
| `ai.enabled` | ai | Unified gate for both AI surfaces (the in-editor Component agent and the Dashboard Assistant). When off, both are hidden/disabled regardless of API key. Both surfaces also require an Anthropic key at server start. |
| `dashboard_command_topic` | dashboard | MQTT topic the dashboard subscribes to for voice/kiosk commands. Messages are JSON `{target, action, ...}`. Only `target: "frigate-alert"` is wired up today (see `docs/architecture/frontend.md`). Single global topic — every open viewer receives every command. |
| `dashboard_command_connection` | dashboard | MQTT connection ID used for dashboard commands |
| `enabled_types` | availability | Allowlist of integrations + connection / chart / control / display types available in this deployment. Edited via the hierarchical Type Availability modal; see the type-availability gating section. |
| `known_types` | availability | Server-maintained ledger of every type/integration the system has seen across upgrades. Hidden from the settings UI. New types in upgrades auto-enable on first boot; admin disables persist. |

**Adding a new admin setting:**
1. Add entry to `server-go/config/user-configurable.yaml` with key, category, description, value
2. Add a `case` to `SettingsPage.jsx` `handleEdit()` switch statement
3. Create a custom editor modal component (follows `onClose`, `currentValue`, `onSave` pattern)
4. Import and render the modal in SettingsPage

### User Preferences (`/api/config/user/:user_id`)

Per-user preferences stored as a key-value map. No predefined schema — any key can be set.

- **Storage**: MongoDB `app_config` collection with `scope: "user"` and `user_id`
- **API**: `GET/PUT /api/config/user/:user_id` — PUT merges individual keys (doesn't replace the whole map)
- **Frontend**: `apiClient.getUserConfig(userId)`, `apiClient.updateUserConfig(userId, settings)`
- **User ID**: Retrieved via `apiClient.getCurrentUserGuid()` (set by user selection dropdown in header)

**Current user preferences:**

| Key | Description | Used In |
|-----|-------------|---------|
| `dashboard_reduceToFit` | Whether dashboard view uses "fit to screen" mode (boolean) | `DashboardViewerPage.jsx` |
| `active_namespace` | Currently-selected namespace slug for this user — drives the header picker, the default namespace for newly-created records, and the scope filter on list pages. Falls back to `"default"` when unset. | `NamespaceContext.jsx` |

**Pattern for adding a new user preference:**
```javascript
// Read on mount
const userGuid = apiClient.getCurrentUserGuid();
const config = await apiClient.getUserConfig(userGuid);
const myPref = config?.settings?.my_preference ?? defaultValue;

// Save on change
await apiClient.updateUserConfig(userGuid, { my_preference: newValue });
```

For instant render, cache in `localStorage` and sync from server on mount (see `DashboardViewerPage.jsx` `reduceToFit` for the pattern).

## Development Setup

### Prerequisites
- Go 1.26+ (via Homebrew on macOS)
- Node.js 18+
- Docker & Docker Compose
- MongoDB 7.x

### Quick Start

```bash
# Start infrastructure
docker compose up -d mongodb

# Start Go backend (Terminal 1)
cd server-go
# Go 1.26 is now the default, no PATH override needed
go build -o bin/server cmd/server/main.go && ./bin/server

# Start React frontend (Terminal 2)
cd client
npm install
npm run dev
```

### URLs
- Frontend: http://localhost:5173
- Go API: http://localhost:3001
- Swagger UI: http://localhost:3001/swagger/index.html

## UI Framework: Carbon Design System

**Enforced Dark Mode**: g100 theme

**CRITICAL**: Always use Carbon React components - never create custom UI components.

### Common Components
- Forms: `TextInput`, `Select`, `NumberInput`, `Checkbox`, `Toggle`
- Buttons: `Button`, `IconButton`
- Data: `DataTable`, `Tag`, `Tile`
- Feedback: `Modal`, `Loading`, `InlineNotification`
- Navigation: `Header`, `SideNav`, `SideNavLink`

### Color Tokens
- Primary Blue: `#0f62fe` (blue60)
- Green: `#24a148` (green50)
- Red: `#da1e28` (red60)
- Gray: `#161616` to `#f4f4f4`

Use CSS variables: `var(--cds-text-primary)`, `var(--cds-background)`, etc.

## Dynamic Component Loading

Components are stored as JavaScript code strings and evaluated at runtime.

**Available in component scope:**
- React hooks: `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`
- ECharts: `echarts`, `ReactECharts`
- Themes: `carbonTheme`, `carbonDarkTheme`

**Example Component:**
```javascript
const Component = () => {
  const option = {
    xAxis: { type: 'category', data: ['A', 'B', 'C'] },
    yAxis: { type: 'value' },
    series: [{ data: [120, 200, 150], type: 'bar' }]
  };
  return <ReactECharts option={option} theme="carbon-dark" />;
};
```

## Control Components

Controls are interactive UI elements (buttons, toggles, sliders, plugs, dimmers) that send commands to connections (MQTT, WebSocket). They live in `client/src/components/controls/`.

### Architecture

- **Shared hooks**: `useControlState` (MQTT subscription) and `useControlCommand` (command execution + notifications)
- **Shared utilities**: `controlUtils.js` (topic derivation, boolean normalization, state extraction)
- **Self-registration**: Controls call `registerControl(type, Component)` at module load. `ControlRenderer` looks up components from the registry — no manual switch/map needed.
- **Type metadata**: `controlTypes.js` defines `CONTROL_TYPES`, `CONTROL_TYPE_INFO` (labels, icons, categories, capabilities, default UI config), and `CONTROL_CATEGORIES`
- **Barrel export**: `index.js` re-exports all controls, hooks, utils, and types. Importing a control triggers its self-registration.

### Adding a New Control Type

1. **Create the component** in `controls/ControlMyType.jsx`:
   - Use `useControlState` for MQTT state subscription (if the control reads state)
   - Use `useControlCommand` for sending commands (if the control is writable)
   - Accept `readOnly` prop to support state-only mode
   - Call `registerControl('mytype', ControlMyType)` before the default export
   - Import `./controls.scss` and add styles there

2. **Add metadata** in `controls/controlTypes.js`:
   - Add to `CONTROL_TYPES` constant
   - Add to `CONTROL_TYPE_INFO` with: `label`, `description`, `icon` (MDI name), `category`, `canWrite`, `canRead`, `defaultUIConfig` (including `state_field`)

3. **Add export** in `controls/index.js`:
   - Add `export { default as ControlMyType } from './ControlMyType'`
   - (This triggers the self-registration — no changes to ControlRenderer needed)

4. **Backend**: Add the control type constant in `server-go/internal/models/component.go` (`ControlType*` constants)

5. **AI support**: Update `update_control_config` tool enum in `server-go/internal/ai/tools.go` and control types list in `server-go/internal/ai/system_prompt.go`

### Read-Only Controls

Controls with `canWrite: false` in `CONTROL_TYPE_INFO` are automatically passed `readOnly={true}` by `ControlRenderer`. Use this for state indicators (garage door status, temperature sensors, door/window contacts) that subscribe to MQTT but don't send commands. The `useControlCommand` hook is not needed for read-only controls.

### Custom Control Layout

**Don't render a title inside a custom control** between the icon/visual and the state text. `ControlRenderer` already renders a `.control-title` at the top of the panel for every non-tile, non-text_label control when the control has a `title` set. Putting another title inside the control body creates a duplicate (one on top, one stacked above the state) that users will ask you to remove.

The canonical layout for a read-only status control is:

```
┌────────────────────┐
│   Control Title    │  ← rendered by ControlRenderer (.control-title)
├────────────────────┤
│                    │
│    [icon/SVG]      │  ← your component's primary visual
│                    │
│      STATE         │  ← your component's state readout
└────────────────────┘
```

**Title vs name**: `control.name` is the unique internal identifier and tends to be long/contextual ("Home Front Garage Door Sensor - Contact"). `control.title` is the user-facing display label and is usually shorter ("Front Garage"). The rule across the whole app (charts, displays, controls) is **use `title` when set, fall back to `name` when not**: `control.title || control.name`. Users should set an explicit title when they want a concise label, but when they don't, the name is still better than showing nothing.

Tiles (`tile_*`) and `text_label` skip the top `.control-title` entirely — they manage their own layout inside `ControlRenderer`'s tile-mode wrapper and apply the same `title || name` fallback inside their own inline labels.

## Grid System

32 × 32 px cells in both axes (cell size = Carbon `$spacing-08`),
4 px gaps between cells. Column and row counts derive from canvas
size minus a fixed viewer-chrome budget (57 px vertical = the viewer
toolbar; the displayed dashboard has no app header above it, so only
the toolbar is reserved — and 4 px horizontal):

```
cols = floor( canvas_width            / 36 )
rows = floor( (canvas_height - 53)    / 36 )
```

A 2560 × 1440 canvas is **71 cols × 38 rows**. Panel geometry is
stored as `{x, y, w, h}` in cell units. See
[docs/architecture/grid-system.md](docs/architecture/grid-system.md)
for fit-mode behavior and layout-dimension presets.

## Planned Work

For shipped features and release history, see [`CHANGELOG.md`](CHANGELOG.md).
The list below is curated from the maintainer's working memory — not
exhaustive, not prioritized except where noted.

### Higher priority
- **Allow N y-axis series when they share a range + rename "Series Column"**
  — current 2-column cap is "≤2 axes" misimplemented as "≤2 columns
  total"; should be N columns mapped to ≤2 axes. UI shape sketched.
  The misleading "Series Column" pivot field rename lands together.
- **AI surface must respect `enabled_types`** — preflight modal +
  agent catalog already filter, but sample prompts (if/when they
  land), MCP tool descriptions, legacy fallback prompt, and
  `get_component_template` need the same audit. Don't promote
  disabled types to the user or the agent.
- **Chart-options storage cleanup + AI configure-first hallucination
  audit** — strip chart-type-irrelevant fields from component
  records AND extend structured tools (y-axis range, x-axis range,
  log scale, tooltip formatter) so the agent stops calling
  wrong-tool-then-claiming-success. Prompt-side guard landed
  2026-05-19; tool/codegen/storage audit still open and pairs as one
  effort.
- **ComponentEditor stale-codegen cliff** — older charts with
  `use_custom_code: undefined` open as custom-code by default (the
  `!!chart.component_code` fallback). Codegen still runs but is
  ignored. Fix is flipping the fallback polarity + a migration to
  stamp explicit `true` on records whose code differs from current
  codegen.
- **Aggregation SSE-stream sharing** — server `BucketAggregator`
  already dedups math by `configKey` but each browser still gets
  its own SSE stream. Mirror `StreamConnectionManager`'s broker
  pattern for aggregated streams. Full design in
  `docs/design-notes/aggregation-sharing.md`.
- **Server metrics + telemetry publishing** — internal metrics
  buckets with current+peak gauges + `GET /api/stats` /
  `POST /api/stats/reset`, plus periodic publish of the same data
  to log or a configurable MQTT topic via Manage Settings.
  Tenant-agnostic.

### Streaming + connections
- **StreamConnectionManager connection pooling** — dashboard
  switching causes ~30s reconnection delay.
- **ts-store push cursor ignores `from=-1`** (upstream ts-store fix)
  — push connections resume from the persisted cursor, ignoring
  `from=-1`.
- **MQTT multi-topic support** — allow a single component to read
  from multiple topics.
- **MQTT publish (Write) UI** for control components.
- **Parser layer expansion** — extend `StreamParserConfig` beyond
  `data_path` / `timestamp_field`. CSV parser (line-delimited CSV
  streams from instruments / SCADA exports), regex parser (named
  capture groups for unstructured `[2026-04-16] temp=22.5` logs),
  formalize multi-message JSON arrays. Pairs with TCP/WebSocket
  "text" mode. Investigate moving parser config from per-component
  to per-connection.
- **WebSocket connection test**: grab a live message (if available)
  and show it instead of the static example message.

### Components + UI
- **Components list — custom-code indicator + column** — surface
  `use_custom_code` on each row + a way to spot empty
  `component_code` records. The picker silently drops chart
  components with empty code.
- **DataTable header tooltip for truncated field names** — Carbon
  `TableHeader` truncates without exposing full text on hover; add
  tooltip/title across list pages (dashboards, components,
  connections, alerts).
- **Tabbed panel layout** — allow panels to contain multiple
  components with tabs to switch between.
- **Connection testing in editor** — add connection-test capability
  to the connection editor UI (backend API already exists at
  `/api/connections/test`).
- **Component tile-view thumbnails** — component-list tile view
  shows placeholder icons instead of actual previews; need to
  generate/capture thumbnails when saving components.
- **Fix `include_connections` aggregation** —
  `ListWithConnections` in `dashboard_repository.go` has had
  panel-count drift in the past; verify and lock down.

### Controls
- **Control widgets expansion** — MDI icons, indicator tiles,
  widget selector redesign. Includes compact indicator tiles
  (state buttons with popup controls), text/label components for
  section headers, and spacer components for layout.
- **Control type selector redesign** — categorized dropdown with
  MDI icons as control types grow.
- **Control design licensing** — HAKit is proprietary; original
  Carbon-styled control designs needed.

### AI builder
- **AI MQTT dashboard auto-builder** — AI creates a tile dashboard
  from all topics on a broker.

### Alerts
- **ts-store alerts — phase 2** — design locked: central `/alerts`
  management page (one table across every ts-store connection) +
  status-only dashboard component for ambient awareness. ts-store
  is authoritative for rules; dashboard is editor over its API.
  Phase 1 shipped v0.16.1–v0.16.4; ts-store v0.6.3 added
  `external_ref`.

### Auth + multitenancy
- **Kiosk auth strategy when Clerk is enabled** — kiosk has no
  human at the keyboard. **DO NOT enable Clerk on homelab without
  first sorting kiosk auth**. Recommended path is a
  `KIOSK_BYPASS_TOKEN` env var.
- **Remove webhook purpose from system users** — after the
  secret-URL path lands, system users become strictly
  read-only/kiosk; deprecate the old authenticated ts-store webhook
  receiver.
- **Multitenant capabilities** (multi-month scope) — make one
  server host many tenants without Grafana-style "one stack per
  tenant." Per-tenant database isolation, tenant management CLI,
  tenant-pinned-to-instance routing, tenant-scoped namespaces /
  settings / users / connections / components / dashboards.

### Packaging + docs
- **Local docker-compose quickstart** (low priority) — evaluators
  with Docker but not Go/Node would benefit from a `docker compose up`
  quickstart pulling published images.
- **README bio + portfolio framing** — repo is Apache 2.0 as a
  deliberate portfolio bet; README still reads as docs-only and
  needs author bio, "why this exists," contact/availability line
  to actually generate leads.
- **Bundled weather icons refresh** — Meteocons SVGs under
  `client/public/weather-icons/` last synced 2026-04-10; check
  upstream ~annually for new icons/fixes (next ~2027-04-10).

---

## Key Files to Understand

1. `client/src/App.jsx` - Main app with routing and mode switching
2. `client/src/pages/DashboardViewerPage.jsx` - Dashboard rendering in View Mode
3. `client/src/components/DynamicComponentLoader.jsx` - Runtime component evaluation
4. `server-go/cmd/server/main.go` - Go backend entry point
5. `server-go/internal/handlers/` - API request handlers
6. `server-go/internal/ai/system_prompt.go` - AI component specification

## Documentation

- [Architecture doc set](docs/architecture/ARCHITECTURE.md) — landing page for current architecture (data model, backend, frontend, streaming, connections, database, api reference, grid system)
- [Deployment](docs/DEPLOYMENT.md)
- [Test plan](docs/TEST_PLAN.md)
- [Third-party licenses](THIRD_PARTY_LICENSES.md)
- Historical plans + archived implementation notes live in [`docs/plans-archive/`](docs/plans-archive/)
- Swagger UI: http://localhost:3001/swagger/index.html

---

**Last Updated**: 2026-06-02
**Build**: 1682
**Version**: 0.26.1

## Simulator Services

Simulators run on a homelab host and expose the port range 21xxx:

| Service    | Port  | Protocol |
|------------|-------|----------|
| ts-store   | 21080 | HTTP     |
| WebSocket  | 21081 | WS (`/ws`) |
| REST API   | 21082 | HTTP     |
| CSV Server | 21083 | HTTP     |
| PostgreSQL | 21432 | TCP      |

The host is deployment-specific. Use the `homelab-deploy` MCP tools to resolve the current simulator host — don't hard-code an address here. See `simulators/README.md` for full documentation.