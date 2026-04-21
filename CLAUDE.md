# CLAUDE.md - AI Assistant Guide

This file provides context and guidance for AI assistants working on this project.

## Release & Deploy

See the `release-deploy` skill for the authoritative runbook (tagging, image build/push, homelab deploy, rollback). Do not duplicate the procedure here — project-specific overrides go in this section only.

**Project-specific defaults:** deploy target is `deploy-dashboard`, images land at `ghcr.io/trv-enterprises/dashboard-{server,client}`, token is `$TRVE_GH_TOKEN`. Everything else follows the skill.

## Development Rules

### 1. Build Number Increment
- **CRITICAL**: After every code change that affects functionality, increment the build number in `/client/build.json`
- Report the new build number to the user after incrementing
- Build number helps track changes and ensures proper cache busting
- Format: `{ "buildNumber": N }` where N is an integer

### 2. Terminology
- Use "connection" (not "data source" or "datasource") for external data connections in UI text
- Internal code can use `datasource` for backwards compatibility with existing database records
- API endpoints: `/api/connections` is preferred, `/api/datasources` kept as deprecated alias
- Use "display" (not "chart") for data visualization components in UI text
- Use "control" for interactive components (buttons, sliders, toggles)
- Internal code uses `component_type: 'chart'` in DB for displays (backward compatibility), but UI shows "Display"
- "Component" is the umbrella term for both displays and controls
- **Namespace** = the conflict-domain grouping on connections/components/dashboards. Uniqueness is `(namespace, name)` — two namespaces can each have an entity called `Home`. Slug-safe strings like `default`, `tviviano-homelab`. Namespaces are first-class records (name, description, color) managed at `/manage/namespaces`; active namespace is a per-user preference keyed on `active_namespace` in app_config. **Don't conflate with tags** — tags are descriptive (`environment:prod`), namespace is structural.

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
│   └── useDatasources.js   # Data sources-specific hook
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

**TRVE Dashboards** - A full-stack application for creating, managing, and viewing dynamic data visualization dashboards. The application features:

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
- **Layouts** (`/design/layouts`) - Define 12-column grid layouts with panels
- **Connections** (`/design/connections`) - Configure SQL, API, CSV, WebSocket connections
- **Components** (`/design/charts`) - Build displays (charts, gauges, tables) and controls (buttons, sliders)
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
│   │   ├── datasource/       # SQL, API, CSV, Socket adapters
│   │   ├── handlers/         # HTTP handlers
│   │   ├── mcp/              # MCP SSE endpoint
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
| GET | `/api/components` | List components |
| GET | `/api/components/systems` | Get system hierarchy |
| POST | `/api/components` | Create component |
| GET | `/api/components/:id` | Get component |
| PUT | `/api/components/:id` | Update component |
| DELETE | `/api/components/:id` | Delete component |
| **Charts** |||
| GET | `/api/charts` | List charts |
| POST | `/api/charts` | Create chart |
| GET | `/api/charts/:id` | Get chart |
| PUT | `/api/charts/:id` | Update chart |
| DELETE | `/api/charts/:id` | Delete chart |
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
| `tile_font_size` | appearance | Font size for compact tile controls (xs/sm/md/lg) |
| `dashboard_command_topic` | dashboard | MQTT topic the dashboard subscribes to for voice/kiosk commands |
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
- Go 1.25+ (via Homebrew on macOS)
- Node.js 18+
- Docker & Docker Compose
- MongoDB 7.x

### Quick Start

```bash
# Start infrastructure
docker compose up -d mongodb

# Start Go backend (Terminal 1)
cd server-go
# Go 1.25 is now the default, no PATH override needed
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

4. **Backend**: Add the control type constant in `server-go/internal/models/chart.go` (`ControlType*` constants)

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

12-column grid with 32px row height (based on Carbon $spacing-08):

```
┌────────────────────────────────────────────────────────────────┐
│  1   2   3   4   5   6   7   8   9  10  11  12                │
├────────────────────────────────────────────────────────────────┤
│ Panel A (x:0, y:0, w:6, h:8)  │  Panel B (x:6, y:0, w:6, h:4) │
│                               ├────────────────────────────────┤
│                               │  Panel C (x:6, y:4, w:6, h:4) │
└───────────────────────────────┴────────────────────────────────┘
```

## Current Status (2026-04-17)

### ✅ Completed
- Go backend with MongoDB (layouts, connections, components, dashboards, charts)
- React frontend with three modes (Design, View, Manage placeholder)
- Design Mode: All CRUD pages for layouts, connections, charts, dashboards
- View Mode: Dashboard viewer with real-time refresh, sidebar tiles, reduce-to-fit mode
- Carbon Design System theming throughout (g100 dark theme)
- Auto-redirect to first dashboard on app load
- **Chart Editor**: Full chart builder with live preview, data mapping, filters, aggregation
- **Control Components**: Button, toggle, slider, text input controls that send commands to bidirectional connections
- **Socket Connections**: WebSocket connections with parser config (data_path extraction, JSON/regex parsing)
- **Axis Labels**: Configurable X/Y axis labels for charts (e.g., "Temperature (°F)")
- **Timestamp Formatting**: Utility functions for consistent date/time display in charts
- **Chart Versioning**: Version tracking with increment on save, status (draft/final)
- **AI Builder (Phases 1-7)**: Full-page AI chat with SSE streaming, MCP tools, session management
- **AI Session API**: Start, message, save, cancel endpoints with `/api/ai/session`
- **Custom AI Icon**: Replaced WatsonxAi with custom sparkle icon component
- **SQL Connection Refactor**: Removed connection_string field; connection strings now built from individual fields (host, port, database, username, password, ssl, options)
- **Prometheus Connection**: Full Prometheus integration with schema discovery, visual PromQL builder, and AI tool support
- **EdgeLake Connection**: Full EdgeLake integration with distributed query support, cascading schema discovery (database → table → columns), visual query builder, and AI tool support
- **Terminology Rename**: "Data Sources" renamed to "Connections" throughout UI and API (`/api/connections`)
- **Terminology Rename**: "Chart" renamed to "Display" in UI (DB still uses `component_type: 'chart'` for backward compatibility)
- **MQTT Connection**: Full MQTT broker integration with Eclipse Paho v2, bidirectional pub/sub, visual topic selector with broker discovery, multi-topic subscription, and streaming support via SSE
- **Type Availability Gating** (v0.6.0): Admin-managed `enabled_types` setting toggles connection / chart / control / display types and integrations per deployment. Frigate and Weather are integrations; admins can enable/disable a whole bundle from Manage → Settings → Type Availability. Filter applies to picker UIs, AI agent prompt + tool enums, and MCP catalog. Existing dashboard components keep rendering even when their type is disabled.
- **WebSocket Bidirectional UI** (v0.6.0): Connection editor exposes a Bidirectional checkbox for WebSocket connections. When set, resolves to `stream.websocket-bidir` so the connection gains write capability for control commands.
- **Connection-Level Parser** (v0.6.0): WebSocket and TCP connections now expose a parser config (`data_path`, `timestamp_field`, `timestamp_scale`) at the connection layer with a ts-store preset and live test panel. MQTT connections keep per-component parsers because broker multiplexing means each topic may carry a different shape.
- **UDP and binary WebSocket removed** (v0.6.0): UDP wasn't used by realistic dashboard telemetry (MQTT/WebSocket/REST cover ~99% of cases) and the legacy adapter couldn't receive unsolicited packets. Binary message_format on WebSocket was dropped — binary frames carrying JSON still work transparently because the adapter ignores the frame type.

### 🚧 In Progress
- AI Builder Phase 8: Polish & Testing
- Error handling improvements
- Performance optimization

### 📋 Planned
- **Fix Component Tile View Thumbnails**: The component list page tile view shows placeholder icons instead of actual component preview images. Need to generate/capture chart thumbnails when saving components.
- **Fix AI Chart Builder 429 Rate Limit Error**: Hitting Anthropic's 30k input tokens/minute limit after just a few messages. Options: implement retry-with-backoff on 429 errors, trim conversation history to last N messages, or summarize older context to reduce token usage.
- **Tabbed Panel Layout**: Allow panels to contain multiple charts with tabs to switch between
- **Connection Testing in Editor**: Add connection test capability to connection editor UI (backend API already exists at `/api/connections/test`)
- **Fix `include_connections` Aggregation**: The `ListWithDatasources` MongoDB aggregation in `dashboard_repository.go` has a bug where `panel_count` returns 0. Currently worked around by fetching dashboards, charts, and connections separately client-side. Fix the aggregation to reduce API calls as dashboard count grows.
- User authentication
- ModeContext for shared state (replace localStorage-based mode switching)
- ErrorBoundary component for crash recovery
- Entity-specific hooks (useDashboard, useCharts, etc.)

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

**Last Updated**: 2026-03-06
**Build**: 578

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