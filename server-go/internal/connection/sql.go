// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
)

func init() {
	// Register all SQL database adapters
	for _, driver := range []string{"postgres", "mysql", "sqlite", "mssql", "oracle"} {
		d := driver // capture for closure
		registry.Register(
			"db."+d,
			driverDisplayName(d),
			registry.Capabilities{CanRead: true, CanWrite: false, CanStream: false},
			sqlConfigSchema(d),
			func(config map[string]interface{}) (registry.Adapter, error) {
				return newSQLAdapterFromConfig(d, config)
			},
		)
	}
}

// driverDisplayName returns a human-readable name for a SQL driver
func driverDisplayName(driver string) string {
	names := map[string]string{
		"postgres": "PostgreSQL",
		"mysql":    "MySQL",
		"sqlite":   "SQLite",
		"mssql":    "Microsoft SQL Server",
		"oracle":   "Oracle Database",
	}
	if name, ok := names[driver]; ok {
		return name
	}
	return driver
}

// sqlConfigSchema returns configuration fields for a SQL driver
func sqlConfigSchema(driver string) []registry.ConfigField {
	if driver == "sqlite" {
		return []registry.ConfigField{
			{Name: "database", Type: "string", Required: true, Description: "Database file path or :memory:"},
			{Name: "options", Type: "string", Required: false, Description: "Connection options"},
		}
	}

	return []registry.ConfigField{
		{Name: "host", Type: "string", Required: true, Description: "Database host"},
		{Name: "port", Type: "int", Required: true, Description: "Database port"},
		{Name: "database", Type: "string", Required: true, Description: "Database name"},
		{Name: "username", Type: "string", Required: true, Description: "Username"},
		{Name: "password", Type: "password", Required: false, Description: "Password"},
		{Name: "ssl", Type: "bool", Required: false, Default: false, Description: "Enable SSL"},
		{Name: "max_connections", Type: "int", Required: false, Default: 10, Description: "Max connections"},
		{Name: "timeout", Type: "int", Required: false, Default: 30, Description: "Connection timeout (seconds)"},
		{Name: "options", Type: "string", Required: false, Description: "Additional connection options"},
	}
}

// SQLAdapter implements registry.Adapter for SQL databases
type SQLAdapter struct {
	driver string
	config *models.SQLConfig
	db     *sql.DB
}

// newSQLAdapterFromConfig creates a SQL adapter from a config map
func newSQLAdapterFromConfig(driver string, config map[string]interface{}) (*SQLAdapter, error) {
	sqlConfig := &models.SQLConfig{
		Driver: driver,
	}

	// Parse config map into SQLConfig
	if host, ok := config["host"].(string); ok {
		sqlConfig.Host = host
	}
	if port, ok := config["port"].(float64); ok {
		sqlConfig.Port = int(port)
	} else if port, ok := config["port"].(int); ok {
		sqlConfig.Port = port
	}
	if database, ok := config["database"].(string); ok {
		sqlConfig.Database = database
	}
	if username, ok := config["username"].(string); ok {
		sqlConfig.Username = username
	}
	if password, ok := config["password"].(string); ok {
		sqlConfig.Password = password
	}
	if ssl, ok := config["ssl"].(bool); ok {
		sqlConfig.SSL = ssl
	}
	if maxConn, ok := config["max_connections"].(float64); ok {
		sqlConfig.MaxConnections = int(maxConn)
	} else if maxConn, ok := config["max_connections"].(int); ok {
		sqlConfig.MaxConnections = maxConn
	}
	if timeout, ok := config["timeout"].(float64); ok {
		sqlConfig.Timeout = int(timeout)
	} else if timeout, ok := config["timeout"].(int); ok {
		sqlConfig.Timeout = timeout
	}
	if options, ok := config["options"].(string); ok {
		sqlConfig.Options = options
	}

	return &SQLAdapter{
		driver: driver,
		config: sqlConfig,
	}, nil
}

// TypeID returns the adapter type identifier
func (a *SQLAdapter) TypeID() string {
	return "db." + a.driver
}

// DisplayName returns a human-readable name
func (a *SQLAdapter) DisplayName() string {
	return driverDisplayName(a.driver)
}

// Capabilities returns what this adapter can do
func (a *SQLAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: false}
}

// ConfigSchema returns configuration fields
func (a *SQLAdapter) ConfigSchema() []registry.ConfigField {
	return sqlConfigSchema(a.driver)
}

// Connect establishes the database connection
func (a *SQLAdapter) Connect(ctx context.Context) error {
	driverName := mapDriverName(a.config.Driver)
	connectionString := buildConnectionString(a.config)

	db, err := sql.Open(driverName, connectionString)
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}

	// Configure connection pool
	if a.config.MaxConnections > 0 {
		db.SetMaxOpenConns(a.config.MaxConnections)
		db.SetMaxIdleConns(a.config.MaxConnections / 2)
	}

	// Test connection
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return fmt.Errorf("failed to ping database: %w", err)
	}

	a.db = db
	return nil
}

// TestConnection verifies the connection works
func (a *SQLAdapter) TestConnection(ctx context.Context) error {
	// If already connected, just ping
	if a.db != nil {
		return a.db.PingContext(ctx)
	}

	// Otherwise connect and disconnect
	if err := a.Connect(ctx); err != nil {
		return err
	}
	return a.Close()
}

// Close closes the database connection
func (a *SQLAdapter) Close() error {
	if a.db != nil {
		err := a.db.Close()
		a.db = nil
		return err
	}
	return nil
}

// Query executes a SQL query and returns normalized results
func (a *SQLAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	if a.db == nil {
		if err := a.Connect(ctx); err != nil {
			return nil, err
		}
	}

	// Substitute the dashboard-variable token (if any) into the SQL as a
	// driver-correct bound parameter — injection-safe and dialect-correct.
	// The token scan builds args in occurrence order, which is what makes
	// positional binding deterministic (any pre-existing param-map iteration
	// is random-order; today the only such param is a single `limit`,
	// order-irrelevant, so appending it after the substituted args is safe).
	value, hasValue := dashboardVariableValue(query.Params)
	raw, args, err := substituteSQLToken(a.driver, query.Raw, value, hasValue)
	if err != nil {
		return nil, err
	}
	for k, v := range query.Params {
		if k == DashboardVariableParam {
			continue // consumed by token substitution above
		}
		args = append(args, v)
	}

	rows, err := a.db.QueryContext(ctx, raw, args...)
	if err != nil {
		return nil, fmt.Errorf("query execution failed: %w", err)
	}
	defer rows.Close()

	// Get column names
	columns, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("failed to get columns: %w", err)
	}

	// Prepare result set
	resultSet := &registry.ResultSet{
		Columns:  columns,
		Rows:     make([][]interface{}, 0),
		Metadata: make(map[string]interface{}),
	}

	// Scan rows
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			return nil, fmt.Errorf("failed to scan row: %w", err)
		}

		// Convert byte slices to strings
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}

		resultSet.Rows = append(resultSet.Rows, values)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("row iteration error: %w", err)
	}

	resultSet.Metadata["row_count"] = len(resultSet.Rows)
	resultSet.Metadata["column_count"] = len(columns)

	return resultSet, nil
}

// Stream executes a SQL query and streams results
func (a *SQLAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	if a.db == nil {
		if err := a.Connect(ctx); err != nil {
			return nil, err
		}
	}

	// Substitute the dashboard-variable token (if any) as a bound parameter,
	// matching the batch Query path. Args are built in occurrence order.
	value, hasValue := dashboardVariableValue(query.Params)
	raw, args, err := substituteSQLToken(a.driver, query.Raw, value, hasValue)
	if err != nil {
		return nil, err
	}
	for k, v := range query.Params {
		if k == DashboardVariableParam {
			continue // consumed by token substitution above
		}
		args = append(args, v)
	}

	rows, err := a.db.QueryContext(ctx, raw, args...)
	if err != nil {
		return nil, fmt.Errorf("query execution failed: %w", err)
	}

	// Get column names
	columns, err := rows.Columns()
	if err != nil {
		rows.Close()
		return nil, fmt.Errorf("failed to get columns: %w", err)
	}

	recordChan := make(chan registry.Record, 100)

	go func() {
		defer close(recordChan)
		defer rows.Close()

		for rows.Next() {
			values := make([]interface{}, len(columns))
			valuePtrs := make([]interface{}, len(columns))
			for i := range values {
				valuePtrs[i] = &values[i]
			}

			if err := rows.Scan(valuePtrs...); err != nil {
				continue
			}

			record := make(registry.Record)
			for i, col := range columns {
				val := values[i]
				if b, ok := val.([]byte); ok {
					val = string(b)
				}
				record[col] = val
			}

			select {
			case recordChan <- record:
			case <-ctx.Done():
				return
			}
		}
	}()

	return recordChan, nil
}

// Write is not supported for SQL adapters (read-only)
func (a *SQLAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("db.%s does not support write operations", a.driver)
}

// GetSchema implements SchemaProvider for SQL databases
func (a *SQLAdapter) GetSchema(ctx context.Context) (*models.SchemaInfo, error) {
	if a.db == nil {
		if err := a.Connect(ctx); err != nil {
			return nil, err
		}
	}

	schema := &models.SchemaInfo{
		Database: a.config.Database,
		Tables:   make([]models.TableInfo, 0),
	}

	tables, err := a.getTables(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get tables: %w", err)
	}

	for _, table := range tables {
		columns, err := a.getColumns(ctx, table.Name, table.Schema)
		if err != nil {
			continue
		}
		table.Columns = columns
		schema.Tables = append(schema.Tables, table)
	}

	return schema, nil
}

// ============================================================================
// Legacy compatibility - these functions are used by the old factory system
// ============================================================================

// SQLDataSource is the legacy type for backwards compatibility
type SQLDataSource struct {
	db     *sql.DB
	config *models.SQLConfig
}

// mapDriverName converts user-facing driver names to Go driver names
func mapDriverName(driver string) string {
	driverMap := map[string]string{
		"sqlite": "sqlite3",
	}
	if mapped, ok := driverMap[driver]; ok {
		return mapped
	}
	return driver
}

// buildConnectionString constructs a connection string from individual
// config fields. SSL + InsecureSkipVerify are translated per-driver:
//
//   postgres → sslmode=require (skip-verify) vs sslmode=verify-full (verify)
//   mysql    → tls=skip-verify (skip-verify) vs tls=true (verify)
//   mssql    → TrustServerCertificate=true (skip-verify) vs default (verify)
//   sqlite   → no TLS at all; both flags ignored
//   oracle   → not yet covered (driver-specific TLS configuration; see TODO)
//
// The per-connection skip-verify only takes effect when the server-
// level api.allow_insecure_tls is also true (the same two-gate model
// the HTTP adapters use). Both gates closed → full verification.
func buildConnectionString(config *models.SQLConfig) string {
	skipTLS := config.InsecureSkipVerify && IsInsecureTLSAllowed()

	switch config.Driver {
	case "postgres":
		connStr := fmt.Sprintf("host=%s port=%d user=%s dbname=%s",
			config.Host, config.Port, config.Username, config.Database)
		if config.Password != "" {
			connStr += fmt.Sprintf(" password=%s", config.Password)
		}
		if config.SSL {
			if skipTLS {
				// lib/pq: `require` encrypts but does not verify the
				// server cert — equivalent to "skip verify".
				connStr += " sslmode=require"
			} else {
				connStr += " sslmode=verify-full"
			}
		} else {
			connStr += " sslmode=disable"
		}
		if config.Timeout > 0 {
			connStr += fmt.Sprintf(" connect_timeout=%d", config.Timeout)
		}
		if config.Options != "" {
			connStr += " " + config.Options
		}
		return connStr

	case "mysql":
		connStr := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s",
			config.Username, config.Password, config.Host, config.Port, config.Database)
		params := []string{}
		if config.SSL {
			if skipTLS {
				// go-sql-driver/mysql ships a built-in "skip-verify"
				// preset that requires TLS but accepts any server cert.
				params = append(params, "tls=skip-verify")
			} else {
				params = append(params, "tls=true")
			}
		}
		if config.Timeout > 0 {
			params = append(params, fmt.Sprintf("timeout=%ds", config.Timeout))
		}
		if config.Options != "" {
			params = append(params, config.Options)
		}
		if len(params) > 0 {
			connStr += "?" + joinParams(params, "&")
		}
		return connStr

	case "sqlite":
		connStr := config.Database
		if config.Options != "" {
			connStr += "?" + config.Options
		}
		return connStr

	case "mssql":
		connStr := fmt.Sprintf("sqlserver://%s:%s@%s:%d?database=%s",
			config.Username, config.Password, config.Host, config.Port, config.Database)
		if config.SSL {
			connStr += "&encrypt=true"
			if skipTLS {
				connStr += "&TrustServerCertificate=true"
			}
		}
		if config.Timeout > 0 {
			connStr += fmt.Sprintf("&connection+timeout=%d", config.Timeout)
		}
		if config.Options != "" {
			connStr += "&" + config.Options
		}
		return connStr

	case "oracle":
		// TODO TLS skip-verify for Oracle. The Go Oracle driver
		// (sijms/go-ora) takes TLS settings via DSN params like
		// `SSL=true&SSL Verify=false` — different syntax than the
		// others, worth a separate pass.
		connStr := fmt.Sprintf("%s/%s@%s:%d/%s",
			config.Username, config.Password, config.Host, config.Port, config.Database)
		return connStr

	default:
		return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s",
			config.Host, config.Port, config.Username, config.Password, config.Database)
	}
}

// joinParams joins parameters with a separator
func joinParams(params []string, sep string) string {
	result := ""
	for i, p := range params {
		if i > 0 {
			result += sep
		}
		result += p
	}
	return result
}

// NewSQLDataSource creates a new SQL datasource (legacy factory method)
func NewSQLDataSource(config *models.SQLConfig) (*SQLDataSource, error) {
	driverName := mapDriverName(config.Driver)
	connectionString := buildConnectionString(config)
	db, err := sql.Open(driverName, connectionString)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if config.MaxConnections > 0 {
		db.SetMaxOpenConns(config.MaxConnections)
		db.SetMaxIdleConns(config.MaxConnections / 2)
	}

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &SQLDataSource{
		db:     db,
		config: config,
	}, nil
}

// Query executes a SQL query and returns normalized results
func (s *SQLDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	// Substitute the dashboard-variable token (if any) into the SQL as a
	// driver-correct bound parameter — injection-safe, dialect-correct, and
	// built in occurrence order. (This is the live SQL path the factory wires
	// for ConnectionTypeSQL — see CreateFromConfig → NewSQLDataSource.)
	value, hasValue := dashboardVariableValue(query.Params)
	raw, args, err := substituteSQLToken(s.config.Driver, query.Raw, value, hasValue)
	if err != nil {
		return nil, err
	}
	for k, v := range query.Params {
		if k == DashboardVariableParam {
			continue // consumed by token substitution above
		}
		args = append(args, v)
	}

	rows, err := s.db.QueryContext(ctx, raw, args...)
	if err != nil {
		return nil, fmt.Errorf("query execution failed: %w", err)
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("failed to get columns: %w", err)
	}

	resultSet := &models.ResultSet{
		Columns:  columns,
		Rows:     make([][]interface{}, 0),
		Metadata: make(map[string]interface{}),
	}

	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			return nil, fmt.Errorf("failed to scan row: %w", err)
		}

		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}

		resultSet.Rows = append(resultSet.Rows, values)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("row iteration error: %w", err)
	}

	resultSet.Metadata["row_count"] = len(resultSet.Rows)
	resultSet.Metadata["column_count"] = len(columns)

	return resultSet, nil
}

// Stream executes a SQL query and streams results
func (s *SQLDataSource) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	// Substitute the dashboard-variable token (if any) as a bound parameter,
	// matching the batch Query path.
	value, hasValue := dashboardVariableValue(query.Params)
	raw, args, err := substituteSQLToken(s.config.Driver, query.Raw, value, hasValue)
	if err != nil {
		return nil, err
	}
	for k, v := range query.Params {
		if k == DashboardVariableParam {
			continue // consumed by token substitution above
		}
		args = append(args, v)
	}

	rows, err := s.db.QueryContext(ctx, raw, args...)
	if err != nil {
		return nil, fmt.Errorf("query execution failed: %w", err)
	}

	columns, err := rows.Columns()
	if err != nil {
		rows.Close()
		return nil, fmt.Errorf("failed to get columns: %w", err)
	}

	recordChan := make(chan models.Record, 100)

	go func() {
		defer close(recordChan)
		defer rows.Close()

		for rows.Next() {
			values := make([]interface{}, len(columns))
			valuePtrs := make([]interface{}, len(columns))
			for i := range values {
				valuePtrs[i] = &values[i]
			}

			if err := rows.Scan(valuePtrs...); err != nil {
				continue
			}

			record := make(models.Record)
			for i, col := range columns {
				val := values[i]
				if b, ok := val.([]byte); ok {
					val = string(b)
				}
				record[col] = val
			}

			select {
			case recordChan <- record:
			case <-ctx.Done():
				return
			}
		}
	}()

	return recordChan, nil
}

// Close closes the database connection
func (s *SQLDataSource) Close() error {
	if s.db != nil {
		return s.db.Close()
	}
	return nil
}

// GetSchema implements SchemaProvider interface for SQL databases
func (s *SQLDataSource) GetSchema(ctx context.Context) (*models.SchemaInfo, error) {
	schema := &models.SchemaInfo{
		Database: s.config.Database,
		Tables:   make([]models.TableInfo, 0),
	}

	tables, err := s.getTables(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get tables: %w", err)
	}

	for _, table := range tables {
		columns, err := s.getColumns(ctx, table.Name, table.Schema)
		if err != nil {
			continue
		}
		table.Columns = columns
		schema.Tables = append(schema.Tables, table)
	}

	return schema, nil
}

// getTables returns all tables in the database based on driver dialect (for SQLAdapter)
func (a *SQLAdapter) getTables(ctx context.Context) ([]models.TableInfo, error) {
	var query string
	var tables []models.TableInfo

	switch a.config.Driver {
	case "postgres":
		query = `
			SELECT table_name, table_schema
			FROM information_schema.tables
			WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
			AND table_type = 'BASE TABLE'
			ORDER BY table_schema, table_name`
	case "mysql":
		query = `
			SELECT table_name, table_schema
			FROM information_schema.tables
			WHERE table_schema = DATABASE()
			AND table_type = 'BASE TABLE'
			ORDER BY table_name`
	case "sqlite":
		query = `
			SELECT name as table_name, '' as table_schema
			FROM sqlite_master
			WHERE type = 'table'
			AND name NOT LIKE 'sqlite_%'
			ORDER BY name`
	case "mssql":
		query = `
			SELECT TABLE_NAME as table_name, TABLE_SCHEMA as table_schema
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_TYPE = 'BASE TABLE'
			ORDER BY TABLE_SCHEMA, TABLE_NAME`
	default:
		return nil, fmt.Errorf("unsupported driver for schema discovery: %s", a.config.Driver)
	}

	rows, err := a.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query tables: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var tableName, schemaName string
		if err := rows.Scan(&tableName, &schemaName); err != nil {
			return nil, fmt.Errorf("failed to scan table row: %w", err)
		}
		tables = append(tables, models.TableInfo{
			Name:    tableName,
			Schema:  schemaName,
			Columns: make([]models.ColumnInfo, 0),
		})
	}

	return tables, rows.Err()
}

// getColumns returns column information for a specific table (for SQLAdapter)
func (a *SQLAdapter) getColumns(ctx context.Context, tableName, schemaName string) ([]models.ColumnInfo, error) {
	var query string
	var args []interface{}
	var columns []models.ColumnInfo

	switch a.config.Driver {
	case "postgres":
		query = `
			SELECT
				c.column_name,
				c.data_type,
				CASE WHEN c.is_nullable = 'YES' THEN true ELSE false END as nullable,
				CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
				COALESCE(c.column_default, '') as col_default
			FROM information_schema.columns c
			LEFT JOIN (
				SELECT ku.column_name
				FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage ku
					ON tc.constraint_name = ku.constraint_name
				WHERE tc.constraint_type = 'PRIMARY KEY'
				AND ku.table_name = $1
				AND ku.table_schema = $2
			) pk ON c.column_name = pk.column_name
			WHERE c.table_name = $1
			AND c.table_schema = $2
			ORDER BY c.ordinal_position`
		args = []interface{}{tableName, schemaName}

	case "mysql":
		query = `
			SELECT
				COLUMN_NAME,
				DATA_TYPE,
				CASE WHEN IS_NULLABLE = 'YES' THEN true ELSE false END as nullable,
				CASE WHEN COLUMN_KEY = 'PRI' THEN true ELSE false END as is_pk,
				COALESCE(COLUMN_DEFAULT, '') as col_default
			FROM information_schema.columns
			WHERE table_name = ?
			AND table_schema = DATABASE()
			ORDER BY ORDINAL_POSITION`
		args = []interface{}{tableName}

	case "sqlite":
		query = fmt.Sprintf("PRAGMA table_info('%s')", tableName)
		rows, err := a.db.QueryContext(ctx, query)
		if err != nil {
			return nil, fmt.Errorf("failed to get column info: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			var cid int
			var name, colType string
			var notNull, pk int
			var dfltValue interface{}
			if err := rows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); err != nil {
				return nil, fmt.Errorf("failed to scan column: %w", err)
			}
			defaultStr := ""
			if dfltValue != nil {
				defaultStr = fmt.Sprintf("%v", dfltValue)
			}
			columns = append(columns, models.ColumnInfo{
				Name:       name,
				Type:       colType,
				Nullable:   notNull == 0,
				PrimaryKey: pk == 1,
				Default:    defaultStr,
			})
		}
		return columns, rows.Err()

	case "mssql":
		query = `
			SELECT
				c.COLUMN_NAME,
				c.DATA_TYPE,
				CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END as nullable,
				CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_pk,
				COALESCE(c.COLUMN_DEFAULT, '') as col_default
			FROM INFORMATION_SCHEMA.COLUMNS c
			LEFT JOIN (
				SELECT ku.COLUMN_NAME
				FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
					ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
				WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
				AND ku.TABLE_NAME = @p1
				AND ku.TABLE_SCHEMA = @p2
			) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
			WHERE c.TABLE_NAME = @p1
			AND c.TABLE_SCHEMA = @p2
			ORDER BY c.ORDINAL_POSITION`
		args = []interface{}{tableName, schemaName}

	default:
		return nil, fmt.Errorf("unsupported driver for column discovery: %s", a.config.Driver)
	}

	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query columns: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var name, colType, defaultVal string
		var nullable, isPK bool
		if err := rows.Scan(&name, &colType, &nullable, &isPK, &defaultVal); err != nil {
			return nil, fmt.Errorf("failed to scan column row: %w", err)
		}
		columns = append(columns, models.ColumnInfo{
			Name:       name,
			Type:       colType,
			Nullable:   nullable,
			PrimaryKey: isPK,
			Default:    defaultVal,
		})
	}

	return columns, rows.Err()
}

// getTables returns all tables (legacy SQLDataSource)
func (s *SQLDataSource) getTables(ctx context.Context) ([]models.TableInfo, error) {
	var query string
	var tables []models.TableInfo

	switch s.config.Driver {
	case "postgres":
		query = `
			SELECT table_name, table_schema
			FROM information_schema.tables
			WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
			AND table_type = 'BASE TABLE'
			ORDER BY table_schema, table_name`
	case "mysql":
		query = `
			SELECT table_name, table_schema
			FROM information_schema.tables
			WHERE table_schema = DATABASE()
			AND table_type = 'BASE TABLE'
			ORDER BY table_name`
	case "sqlite":
		query = `
			SELECT name as table_name, '' as table_schema
			FROM sqlite_master
			WHERE type = 'table'
			AND name NOT LIKE 'sqlite_%'
			ORDER BY name`
	case "mssql":
		query = `
			SELECT TABLE_NAME as table_name, TABLE_SCHEMA as table_schema
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_TYPE = 'BASE TABLE'
			ORDER BY TABLE_SCHEMA, TABLE_NAME`
	default:
		return nil, fmt.Errorf("unsupported driver for schema discovery: %s", s.config.Driver)
	}

	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query tables: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var tableName, schemaName string
		if err := rows.Scan(&tableName, &schemaName); err != nil {
			return nil, fmt.Errorf("failed to scan table row: %w", err)
		}
		tables = append(tables, models.TableInfo{
			Name:    tableName,
			Schema:  schemaName,
			Columns: make([]models.ColumnInfo, 0),
		})
	}

	return tables, rows.Err()
}

// getColumns returns column information (legacy SQLDataSource)
func (s *SQLDataSource) getColumns(ctx context.Context, tableName, schemaName string) ([]models.ColumnInfo, error) {
	var query string
	var args []interface{}
	var columns []models.ColumnInfo

	switch s.config.Driver {
	case "postgres":
		query = `
			SELECT
				c.column_name,
				c.data_type,
				CASE WHEN c.is_nullable = 'YES' THEN true ELSE false END as nullable,
				CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
				COALESCE(c.column_default, '') as col_default
			FROM information_schema.columns c
			LEFT JOIN (
				SELECT ku.column_name
				FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage ku
					ON tc.constraint_name = ku.constraint_name
				WHERE tc.constraint_type = 'PRIMARY KEY'
				AND ku.table_name = $1
				AND ku.table_schema = $2
			) pk ON c.column_name = pk.column_name
			WHERE c.table_name = $1
			AND c.table_schema = $2
			ORDER BY c.ordinal_position`
		args = []interface{}{tableName, schemaName}

	case "mysql":
		query = `
			SELECT
				COLUMN_NAME,
				DATA_TYPE,
				CASE WHEN IS_NULLABLE = 'YES' THEN true ELSE false END as nullable,
				CASE WHEN COLUMN_KEY = 'PRI' THEN true ELSE false END as is_pk,
				COALESCE(COLUMN_DEFAULT, '') as col_default
			FROM information_schema.columns
			WHERE table_name = ?
			AND table_schema = DATABASE()
			ORDER BY ORDINAL_POSITION`
		args = []interface{}{tableName}

	case "sqlite":
		query = fmt.Sprintf("PRAGMA table_info('%s')", tableName)
		rows, err := s.db.QueryContext(ctx, query)
		if err != nil {
			return nil, fmt.Errorf("failed to get column info: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			var cid int
			var name, colType string
			var notNull, pk int
			var dfltValue interface{}
			if err := rows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); err != nil {
				return nil, fmt.Errorf("failed to scan column: %w", err)
			}
			defaultStr := ""
			if dfltValue != nil {
				defaultStr = fmt.Sprintf("%v", dfltValue)
			}
			columns = append(columns, models.ColumnInfo{
				Name:       name,
				Type:       colType,
				Nullable:   notNull == 0,
				PrimaryKey: pk == 1,
				Default:    defaultStr,
			})
		}
		return columns, rows.Err()

	case "mssql":
		query = `
			SELECT
				c.COLUMN_NAME,
				c.DATA_TYPE,
				CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END as nullable,
				CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_pk,
				COALESCE(c.COLUMN_DEFAULT, '') as col_default
			FROM INFORMATION_SCHEMA.COLUMNS c
			LEFT JOIN (
				SELECT ku.COLUMN_NAME
				FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
					ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
				WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
				AND ku.TABLE_NAME = @p1
				AND ku.TABLE_SCHEMA = @p2
			) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
			WHERE c.TABLE_NAME = @p1
			AND c.TABLE_SCHEMA = @p2
			ORDER BY c.ORDINAL_POSITION`
		args = []interface{}{tableName, schemaName}

	default:
		return nil, fmt.Errorf("unsupported driver for column discovery: %s", s.config.Driver)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query columns: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var name, colType, defaultVal string
		var nullable, isPK bool
		if err := rows.Scan(&name, &colType, &nullable, &isPK, &defaultVal); err != nil {
			return nil, fmt.Errorf("failed to scan column row: %w", err)
		}
		columns = append(columns, models.ColumnInfo{
			Name:       name,
			Type:       colType,
			Nullable:   nullable,
			PrimaryKey: isPK,
			Default:    defaultVal,
		})
	}

	return columns, rows.Err()
}
