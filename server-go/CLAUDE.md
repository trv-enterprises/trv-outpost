# Dashboard Server (Go) - Development Status

## Project Overview
Go-based backend server for the TRVE Dashboards project. Replacing Node.js server with Go + MongoDB.

## Current Status (2025-11-20)

### ✅ Phase 1: Foundation - COMPLETE
- **Go Version**: 1.23.12 (via Homebrew)
- **Server**: Gin framework on port 3001
- **Database**: MongoDB 7 (via Docker)
- **Config**: Viper with YAML + ENV override
- **Swagger**: v1.8.12 (CLI and library matched)
- **Health Check**: `/health` endpoint working
- **Swagger UI**: http://localhost:3001/swagger/index.html

**Key Files:**
- `cmd/server/main.go` - Server entry point
- `config/config.yaml` - Base configuration
- `internal/database/mongodb.go` - MongoDB connection
- `docs/` - Generated Swagger documentation

**MongoDB Indexes Fixed:**
- Changed from `map[string]interface{}` to `bson.D`/`bson.E` for compound indexes
- All collections: layouts, datasources, components, dashboards, chat_sessions

**Docker Services:**
```bash
docker compose up -d mongodb  # Start services
make run                            # Run server
```

### ✅ Phase 2: Layouts System - COMPLETE

**API Endpoints:**
- `POST /api/layouts` - Create layout
- `GET /api/layouts` - List layouts (pagination)
- `GET /api/layouts/:id` - Get layout by ID
- `PUT /api/layouts/:id` - Update layout
- `DELETE /api/layouts/:id` - Delete layout

**Architecture:**
```
models → repository → service → handlers → routes
```

**Key Features:**
- 12-column grid system (32px = $spacing-08)
- Panel positioning with x, y, width, height
- Panel validation (bounds checking, ID uniqueness)
- Default grid configuration
- Name uniqueness enforcement

**Key Files:**
- `internal/models/layout.go` - Layout data structures
- `internal/repository/layout_repository.go` - MongoDB operations
- `internal/service/layout_service.go` - Business logic
- `internal/handlers/layout_handler.go` - HTTP handlers

**Tested:**
- Created layout: "Main Dashboard"
- Listed layouts with pagination
- Retrieved by ID
- Updated description
- All CRUD working

### ✅ Phase 3: Datasources System - COMPLETE

**API Endpoints:**
- `POST /api/datasources` - Create datasource
- `GET /api/datasources` - List datasources (pagination)
- `GET /api/datasources/:id` - Get datasource by ID
- `PUT /api/datasources/:id` - Update datasource
- `DELETE /api/datasources/:id` - Delete datasource
- `POST /api/datasources/test` - Test datasource connection
- `POST /api/datasources/:id/health` - Check datasource health
- `POST /api/datasources/:id/query` - Execute query against datasource

**Architecture:**
```
DataSource Interface (Query/Stream/Close)
    ↓
Adapters: SQL | CSV | Socket | API
    ↓
DataSourceFactory
    ↓
models → repository → service → handlers → routes
```

**Key Features:**
- **Unified Interface Pattern**: All datasources implement `DataSource` interface
- **Query Normalization**: Converts different data formats into standardized `ResultSet`
- **Streaming Support**: Channel-based streaming for real-time data via `Stream()` method
- **Four Datasource Types**:
  - **SQL**: PostgreSQL, MySQL, SQLite, MSSQL, Oracle support
  - **CSV**: File-based with delimiter, header detection, filtering
  - **Socket**: TCP, UDP, WebSocket protocols with reconnection
  - **API**: REST APIs with retry logic, auth (Bearer, Basic, API-Key), response parsing
- **Connection Validation**: Test and health check endpoints for all types
- **Factory Pattern**: `DataSourceFactory` manages datasource instances

**Key Files:**
- `internal/models/datasource.go` - Core models and DataSource interface
- `internal/datasource/sql.go` - SQL adapter (database/sql)
- `internal/datasource/csv.go` - CSV adapter (encoding/csv)
- `internal/datasource/socket.go` - Socket adapter (gorilla/websocket)
- `internal/datasource/api.go` - API adapter (net/http)
- `internal/datasource/factory.go` - DataSourceFactory
- `internal/repository/datasource_repository.go` - MongoDB operations
- `internal/service/datasource_service.go` - Business logic + query execution
- `internal/handlers/datasource_handler.go` - HTTP handlers

**Data Structures:**
```go
// Unified query interface
type Query struct {
    Raw    string                 // SQL, filter, or API query
    Params map[string]interface{} // Query parameters
    Type   QueryType              // sql, csv_filter, stream_filter, api
}

// Normalized response
type ResultSet struct {
    Columns  []string        // Column names
    Rows     [][]interface{} // Data rows
    Metadata map[string]interface{} // Additional info
}

// DataSource interface
type DataSource interface {
    Query(ctx, query) (*ResultSet, error)  // Batch query
    Stream(ctx, query) (<-chan Record, error) // Streaming
    Close() error
}
```

**Dependencies Installed:**
- `github.com/gorilla/websocket` v1.5.3 - WebSocket support
- `github.com/lib/pq` v1.10.9 - PostgreSQL driver
- `github.com/go-sql-driver/mysql` v1.9.3 - MySQL driver
- `github.com/mattn/go-sqlite3` v1.14.32 - SQLite driver

**Usage Pattern:**
```go
// LLM generates query
query := models.Query{
    Raw:  "SELECT * FROM metrics WHERE timestamp > $1",
    Type: models.QueryTypeSQL,
    Params: map[string]interface{}{"timestamp": "2024-01-01"},
}

// Execute against any datasource type
response := service.QueryDatasource(ctx, datasourceID, &QueryRequest{Query: query})

// Normalized results ready for React dashboard
resultSet := response.ResultSet
```

### ✅ Phase 4: Components/Charts System - COMPLETE

**API Endpoints:**
- `GET /api/components/systems` - Get all systems and sources with counts
- `POST /api/components` - Create component
- `GET /api/components` - List components (pagination, filtering)
- `GET /api/components/:id` - Get component by ID
- `PUT /api/components/:id` - Update component
- `DELETE /api/components/:id` - Delete component

**Architecture:**
```
models → repository → service → handlers → routes
```

**Key Features:**
- **System/Source Organization**: Components organized by system and source categories
- **React Component Storage**: Store JSX/React component code as strings
- **Metadata Support**: Tags, categories, visualization config, required APIs
- **Filtering**: Filter by system, source, category, or tag
- **Pagination**: Page-based pagination with configurable page size
- **Unique Naming**: Enforce unique component names within system/source
- **UUID-based IDs**: Automatic UUID generation for components

**Key Files:**
- `internal/models/component.go` - Component models and metadata structures
- `internal/repository/component_repository.go` - MongoDB operations with aggregation
- `internal/service/component_service.go` - Business logic and validation
- `internal/handlers/component_handler.go` - HTTP handlers with Swagger annotations

**Data Structures:**
```go
type Component struct {
    ID            string            // UUID
    Name          string            // Component name (unique per system/source)
    System        string            // System category (e.g., "visualization")
    Source        string            // Source subcategory (e.g., "charts")
    Description   string            // Human-readable description
    ComponentCode string            // JSX/React code as string
    Metadata      ComponentMetadata // Additional metadata
    Created       time.Time
    Updated       time.Time
}

type ComponentMetadata struct {
    Category        string                 // "demo", "visualization", etc.
    Tags            []string               // Searchable tags
    Visualization   *VisualizationConfig   // Chart type, library
    RequiredAPIs    []string               // Required hooks/APIs
    DatasourceType  string                 // Expected datasource type
    RefreshInterval int                    // Auto-refresh interval (ms)
    Custom          map[string]interface{} // Extensible metadata
}
```

**Dependencies:**
- `github.com/google/uuid` v1.6.0 - UUID generation

**Tested:**
- Created component: "test-counter" in test/demo
- Listed components with pagination
- Retrieved component by ID
- Got systems hierarchy
- All CRUD endpoints working

### ✅ Phase 5: Dashboards System - COMPLETE

**API Endpoints:**
- `POST /api/dashboards` - Create dashboard
- `GET /api/dashboards` - List dashboards (pagination, filtering)
- `GET /api/dashboards/:id` - Get dashboard by ID
- `GET /api/dashboards/:id/details` - Get dashboard with expanded layout and component details
- `PUT /api/dashboards/:id` - Update dashboard
- `DELETE /api/dashboards/:id` - Delete dashboard

**Architecture:**
```
models → repository → service → handlers → routes
Dashboard references Layout (by ID) + Components (by ID)
Service validates layout exists, components exist, panels exist in layout
```

**Key Features:**
- **Layout + Component Integration**: Dashboards combine a layout with multiple components
- **Component-to-Panel Mapping**: Each DashboardComponent maps a component to a specific panel in the layout
- **Cross-entity Validation**: Service layer validates that:
  - Referenced layout exists
  - All referenced components exist
  - All panel IDs are valid in the chosen layout
- **Dashboard Settings**: Theme, refresh interval, timezone, public access, export permissions
- **Expanded Details Endpoint**: `/details` endpoint fetches full layout and component objects in single call
- **Metadata Support**: Custom metadata, tags, author information
- **UUID Generation**: Automatic UUID for dashboard and dashboard component placements

**Key Files:**
- `internal/models/dashboard.go` - Dashboard, DashboardComponent, DashboardSettings models
- `internal/repository/dashboard_repository.go` - MongoDB operations with pagination
- `internal/service/dashboard_service.go` - Business logic with cross-entity validation
- `internal/handlers/dashboard_handler.go` - HTTP handlers with Swagger annotations

**Data Structures:**
```go
type Dashboard struct {
    ID          string                 // UUID
    Name        string                 // Dashboard name (unique)
    Description string                 // Human-readable description
    LayoutID    string                 // Reference to Layout
    Components  []DashboardComponent   // Components mapped to panels
    Settings    DashboardSettings      // Dashboard-level settings
    Metadata    map[string]interface{} // Custom metadata
    Created     time.Time
    Updated     time.Time
}

type DashboardComponent struct {
    ID          string                 // Unique placement ID
    ComponentID string                 // Reference to Component
    PanelID     string                 // Reference to Panel in Layout
    Config      map[string]interface{} // Component-specific config
    Props       map[string]interface{} // Runtime props
}

type DashboardSettings struct {
    Theme           string // "light", "dark", "auto"
    RefreshInterval int    // Auto-refresh interval (ms)
    TimeZone        string // Timezone for dashboard
    DefaultView     string // Default view mode
    IsPublic        bool   // Public access
    AllowExport     bool   // Export permission
}
```

**Validation Logic:**
1. **Name uniqueness**: Dashboard names must be unique across all dashboards
2. **Layout validation**: Referenced layout ID must exist in layouts collection
3. **Component validation**: All component IDs must exist in components collection
4. **Panel validation**: All panel IDs must exist in the chosen layout's panels array

**Tested:**
- Created dashboard: "Test Dashboard" with 1 component in panel-1
- Listed dashboards with pagination
- Retrieved dashboard by ID
- Retrieved dashboard with expanded details (includes full layout + component objects)
- All CRUD endpoints working
- Cross-entity validation working (rejects invalid layout/component/panel IDs)

### 📋 Future Phases (From Refactor Plan)
- Phase 6: Chat/AI Integration
- Phase 7: Asynq Workers
- Phase 8: Testing & Documentation
- Phase 9: SQL Metadata Discovery
- Phase 10: EdgeLake Query Builder

### 🚧 Phase 9: SQL Metadata Discovery - FUTURE

**Goal:** Discover database schema metadata to help LLM generate accurate queries

**Planned Features:**
- Table listing queries (SHOW TABLES, information_schema queries)
- Column metadata discovery (data types, constraints)
- Schema introspection for SQL datasources
- Cache metadata to reduce database queries
- Support for different SQL dialects (PostgreSQL, MySQL, SQLite, etc.)

**Key Considerations:**
- Different SQL databases have different metadata queries
- PostgreSQL: `SELECT * FROM information_schema.tables`
- MySQL: `SHOW TABLES`, `DESCRIBE table_name`
- SQLite: `SELECT name FROM sqlite_master WHERE type='table'`
- Caching strategy for metadata to improve performance

### 🚧 Phase 10: EdgeLake Query Builder - FUTURE

**Goal:** Construct EdgeLake-specific queries for distributed database operations

**Planned Features:**
- EdgeLake query syntax builder
- Query templates for common operations
- Integration with SQL datasource adapter
- EdgeLake-specific query validation
- Support for AnyLog/EdgeLake commands:
  - `sql <dbms> [options] <query>` - Execute SQL query on EdgeLake cluster
  - `get status` - Cluster status information
  - `get processes` - Running processes on nodes
  - `blockchain get *` - Blockchain/metadata queries
- Query result transformation for dashboard consumption

**Key Considerations:**
- EdgeLake uses REST API endpoints for query submission
- Queries are distributed across cluster nodes
- Response aggregation from multiple nodes
- Integration with existing API datasource adapter

**Implementation Steps:**
1. Create EdgeLake query builder service
2. Define EdgeLake query templates
3. Add EdgeLake-specific validation
4. Create helper methods for common EdgeLake operations
5. Test against EdgeLake cluster endpoints

**Reference:**
- EdgeLake documentation: `/Users/tviviano/Documents/GitHub/documentation`
- EdgeLake Docker commands: `mel down/clean/up <edgelake-type>`

## Important Notes

### Swagger Version Compatibility
- **Issue**: swag CLI v1.16.6 generates code incompatible with library v1.8.12
- **Solution**: Downgraded CLI to v1.8.12 to match library
```bash
go install github.com/swaggo/swag/cmd/swag@v1.8.12
$GOPATH/bin/swag init -g cmd/server/main.go -o docs
```

### Go Environment
Server requires Go 1.23 from Homebrew (not system Go):
```bash
export PATH="/opt/homebrew/opt/go@1.23/bin:$PATH"
export GOROOT="/opt/homebrew/opt/go@1.23/libexec"
export GOPATH="/Users/tviviano/go"
```

### Running the Server
```bash
# Kill old server
pkill -f "./bin/server"

# Build and run with disown (prevents SIGHUP)
go build -o bin/server cmd/server/main.go && (./bin/server & disown)

# Test health
curl http://localhost:3001/health
```

### Development Workflow
1. Make code changes
2. Regenerate Swagger if adding endpoints:
   ```bash
   $GOPATH/bin/swag init -g cmd/server/main.go -o docs
   ```
3. Rebuild and restart:
   ```bash
   pkill -f "./bin/server" && go build -o bin/server cmd/server/main.go && (./bin/server & disown)
   ```
4. Test with curl or Swagger UI

## Reference Documents
- `../docs/architecture/ARCHITECTURE.md` — landing page for the current architecture doc set
- `../docs/architecture/backend.md` — Go backend layered architecture
- `../docs/architecture/streaming.md` — SSE + MQTT streaming, retained-state cache
- `../docs/architecture/database.md` — MongoDB collations, migrations, indexes
- `../docs/plans-archive/` — historical planning docs (Go migration, old Node.js data layer, Asynq exploration)
- Parent CLAUDE.md — overall project context

## Current Server Status
- Running: Yes (PID varies)
- Port: 3001
- MongoDB: Healthy
- Layouts in DB: 1 (test layout)

## Last Updated
2025-11-20 23:00 CST
