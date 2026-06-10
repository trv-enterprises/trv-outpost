// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// QueryType represents the type of query
type QueryType string

const (
	QueryTypeSQL          QueryType = "sql"
	QueryTypeCSVFilter    QueryType = "csv_filter"
	QueryTypeStreamFilter QueryType = "stream_filter"
	QueryTypeAPI          QueryType = "api"
	QueryTypeTSStore      QueryType = "tsstore"
	QueryTypePrometheus   QueryType = "prometheus"
	QueryTypeEdgeLake     QueryType = "edgelake"
	QueryTypeMQTT         QueryType = "mqtt"
)

// ConnectionType represents the type of data source
type ConnectionType string

const (
	ConnectionTypeSQL        ConnectionType = "sql"
	ConnectionTypeCSV        ConnectionType = "csv"
	ConnectionTypeSocket     ConnectionType = "socket"
	ConnectionTypeAPI        ConnectionType = "api"
	ConnectionTypeTSStore    ConnectionType = "tsstore"
	ConnectionTypePrometheus ConnectionType = "prometheus"
	ConnectionTypeEdgeLake  ConnectionType = "edgelake"
	ConnectionTypeMQTT     ConnectionType = "mqtt"
	ConnectionTypeFrigate  ConnectionType = "frigate"
)

// HealthStatus represents the health status of a data source
type HealthStatus string

const (
	HealthStatusUnknown   HealthStatus = "unknown"
	HealthStatusHealthy   HealthStatus = "healthy"
	HealthStatusUnhealthy HealthStatus = "unhealthy"
	HealthStatusDegraded  HealthStatus = "degraded"
)

// SecretMaskedValue is the placeholder shown for masked secrets
// Frontend uses this to detect if a secret field has a value set
const SecretMaskedValue = "********"

// Query represents a query to execute against a datasource
type Query struct {
	Raw    string                 `json:"raw" bson:"raw"`                         // Raw query string (SQL, filter expression, etc.)
	Params map[string]interface{} `json:"params,omitempty" bson:"params,omitempty"` // Query parameters
	Type   QueryType              `json:"type" bson:"type"`                       // Query type
}

// Record represents a single record in a stream
type Record map[string]interface{}

// ResultSet represents query results in a normalized format
type ResultSet struct {
	Columns  []string                 `json:"columns" bson:"columns"`             // Column names
	Rows     [][]interface{}          `json:"rows" bson:"rows"`                   // Data rows
	Metadata map[string]interface{}   `json:"metadata,omitempty" bson:"metadata,omitempty"` // Additional metadata
}

// ConnectionAdapter is the interface that all datasource implementations must satisfy
type ConnectionAdapter interface {
	Query(ctx context.Context, query Query) (*ResultSet, error)
	Stream(ctx context.Context, query Query) (<-chan Record, error)
	Close() error
}

// Connection represents a data source configuration stored in MongoDB.
// ID is a UUID string stored in `_id` (matches the convention used by
// dashboards, namespaces, users, etc.). Pre-v0.14 deployments used
// auto-generated ObjectID `_id` here; the migration in
// `cmd/migrate-uuid-ids` rewrites old data to UUIDs and updates
// component → connection references accordingly.
type Connection struct {
	ID          string `json:"id" bson:"_id,omitempty"`
	Name        string `json:"name" bson:"name" binding:"required"`
	Description string `json:"description" bson:"description"`
	Namespace   string `json:"namespace" bson:"namespace"` // Conflict-domain; uniqueness is (namespace, name). See models.Namespace.

	// NEW: Registry-based type system (preferred)
	// TypeID format: "category.name" (e.g., "db.postgres", "stream.websocket-bidir")
	TypeID     string                 `json:"type_id,omitempty" bson:"type_id,omitempty"`
	TypeConfig map[string]interface{} `json:"type_config,omitempty" bson:"type_config,omitempty"`

	// LEGACY: Keep for backwards compatibility during migration
	Type   ConnectionType   `json:"type,omitempty" bson:"type,omitempty"`
	Config ConnectionConfig `json:"config,omitempty" bson:"config,omitempty"`

	Health HealthInfo `json:"health" bson:"health"`
	Tags   []string   `json:"tags,omitempty" bson:"tags,omitempty"`

	// Control schema support - which control schemas this connection supports
	SupportedSchemas []string `json:"supported_schemas,omitempty" bson:"supported_schemas,omitempty"`

	// DiscoveredValues caches the distinct values of a column for the
	// dashboard-variable dropdown, keyed by column name. Populated by an
	// authoring-side capture (the editor's Fetch flow) for connection types
	// that have no engine-side DISTINCT (streams/sockets) — the connection
	// defines the API/topic and therefore the value domain, so the list lives
	// here, not on the component or dashboard. Additive + nil-safe: absent on
	// older records, no migration needed. A connection may filter on several
	// columns over time, hence a map.
	DiscoveredValues map[string]DiscoveredValueList `json:"discovered_values,omitempty" bson:"discovered_values,omitempty"`

	CreatedAt time.Time `json:"created_at" bson:"created_at"`
	UpdatedAt time.Time `json:"updated_at" bson:"updated_at"`
}

// DiscoveredValueList is one column's cached distinct values for the
// dashboard-variable dropdown. Partial is true when the capture was cut short
// (record cap hit or the user stopped early), so consumers can label the list
// "may be incomplete". CapturedAt records when it was harvested so a stale list
// can be regenerated.
type DiscoveredValueList struct {
	Values     []string  `json:"values" bson:"values"`
	Partial    bool      `json:"partial,omitempty" bson:"partial,omitempty"`
	CapturedAt time.Time `json:"captured_at" bson:"captured_at"`
}

// IsRegistryBased returns true if this datasource uses the new registry-based type system
func (d *Connection) IsRegistryBased() bool {
	return d.TypeID != ""
}

// GetEffectiveTypeID returns the registry type ID, converting from legacy Type if needed
func (d *Connection) GetEffectiveTypeID() string {
	if d.TypeID != "" {
		return d.TypeID
	}

	// Convert legacy Type to registry TypeID
	switch d.Type {
	case ConnectionTypeSQL:
		if d.Config.SQL != nil {
			return "db." + d.Config.SQL.Driver
		}
		return "db.postgres" // default
	case ConnectionTypeCSV:
		return "file.csv"
	case ConnectionTypeSocket:
		if d.Config.Socket != nil {
			switch d.Config.Socket.Protocol {
			case "websocket":
				if d.Config.Socket.Bidirectional {
					return "stream.websocket-bidir"
				}
				return "stream.websocket"
			case "tcp":
				return "stream.tcp"
			}
		}
		return "stream.websocket"
	case ConnectionTypeAPI:
		return "api.rest"
	case ConnectionTypeTSStore:
		return "store.tsstore"
	case ConnectionTypePrometheus:
		return "api.prometheus"
	case ConnectionTypeEdgeLake:
		return "api.edgelake"
	case ConnectionTypeMQTT:
		return "stream.mqtt"
	case ConnectionTypeFrigate:
		return "nvr.frigate"
	default:
		return ""
	}
}

// GetEffectiveConfig returns the unified config map, converting from legacy Config if needed
func (d *Connection) GetEffectiveConfig() map[string]interface{} {
	if d.TypeConfig != nil {
		return d.TypeConfig
	}

	// Convert legacy Config to map
	config := make(map[string]interface{})

	switch d.Type {
	case ConnectionTypeSQL:
		if d.Config.SQL != nil {
			config["host"] = d.Config.SQL.Host
			config["port"] = d.Config.SQL.Port
			config["database"] = d.Config.SQL.Database
			config["username"] = d.Config.SQL.Username
			config["password"] = d.Config.SQL.Password
			config["ssl"] = d.Config.SQL.SSL
			config["max_connections"] = d.Config.SQL.MaxConnections
			config["timeout"] = d.Config.SQL.Timeout
			config["options"] = d.Config.SQL.Options
		}
	case ConnectionTypeCSV:
		if d.Config.CSV != nil {
			config["path"] = d.Config.CSV.Path
			config["delimiter"] = d.Config.CSV.Delimiter
			config["has_header"] = d.Config.CSV.HasHeader
			config["columns"] = d.Config.CSV.Columns
			config["encoding"] = d.Config.CSV.Encoding
		}
	case ConnectionTypeSocket:
		if d.Config.Socket != nil {
			config["url"] = d.Config.Socket.URL
			config["headers"] = d.Config.Socket.Headers
			config["reconnect_on_error"] = d.Config.Socket.ReconnectOnError
			config["reconnect_delay"] = d.Config.Socket.ReconnectDelay
			config["ping_interval"] = d.Config.Socket.PingInterval
			config["buffer_size"] = d.Config.Socket.BufferSize
			config["message_format"] = d.Config.Socket.MessageFormat
			if d.Config.Socket.Parser != nil {
				config["data_path"] = d.Config.Socket.Parser.DataPath
				config["timestamp_field"] = d.Config.Socket.Parser.TimestampField
			}
		}
	case ConnectionTypeAPI:
		if d.Config.API != nil {
			config["url"] = d.Config.API.URL
			config["method"] = d.Config.API.Method
			config["headers"] = d.Config.API.Headers
			config["auth_type"] = d.Config.API.AuthType
			config["auth_credentials"] = d.Config.API.AuthCredentials
			config["query_params"] = d.Config.API.QueryParams
			config["body"] = d.Config.API.Body
			config["timeout"] = d.Config.API.Timeout
			config["retry_count"] = d.Config.API.RetryCount
			config["retry_delay"] = d.Config.API.RetryDelay
			if d.Config.API.ResponseConfig != nil {
				config["data_path"] = d.Config.API.ResponseConfig.DataPath
			}
		}
	case ConnectionTypeTSStore:
		if d.Config.TSStore != nil {
			config["transport"] = string(d.Config.TSStore.Transport)
			config["protocol"] = string(d.Config.TSStore.Protocol)
			config["host"] = d.Config.TSStore.Host
			config["port"] = d.Config.TSStore.Port
			config["store_name"] = d.Config.TSStore.StoreName
			config["data_type"] = string(d.Config.TSStore.DataType)
			config["api_key"] = d.Config.TSStore.APIKey
			config["timeout"] = d.Config.TSStore.Timeout
		}
	case ConnectionTypePrometheus:
		if d.Config.Prometheus != nil {
			config["url"] = d.Config.Prometheus.URL
			config["username"] = d.Config.Prometheus.Username
			config["password"] = d.Config.Prometheus.Password
			config["timeout"] = d.Config.Prometheus.Timeout
		}
	case ConnectionTypeEdgeLake:
		if d.Config.EdgeLake != nil {
			config["host"] = d.Config.EdgeLake.Host
			config["port"] = d.Config.EdgeLake.Port
			config["timeout"] = d.Config.EdgeLake.Timeout
			config["use_distributed_query"] = d.Config.EdgeLake.UseDistributedQuery
		}
	case ConnectionTypeMQTT:
		if d.Config.MQTT != nil {
			config["broker_url"] = d.Config.MQTT.BrokerURL
			config["client_id"] = d.Config.MQTT.ClientID
			config["username"] = d.Config.MQTT.Username
			config["password"] = d.Config.MQTT.Password
			config["tls"] = d.Config.MQTT.TLS
			config["keep_alive"] = d.Config.MQTT.KeepAlive
			config["qos"] = d.Config.MQTT.QoS
			config["clean_start"] = d.Config.MQTT.CleanStart
			config["buffer_size"] = d.Config.MQTT.BufferSize
		}
	case ConnectionTypeFrigate:
		if d.Config.Frigate != nil {
			config["host"] = d.Config.Frigate.Host
			config["port"] = d.Config.Frigate.Port
			config["username"] = d.Config.Frigate.Username
			config["password"] = d.Config.Frigate.Password
			config["go2rtc_port"] = d.Config.Frigate.Go2RTCPort
		}
	}

	return config
}

// ConnectionConfig holds type-specific configuration
type ConnectionConfig struct {
	SQL        *SQLConfig        `json:"sql,omitempty" bson:"sql,omitempty"`
	CSV        *CSVConfig        `json:"csv,omitempty" bson:"csv,omitempty"`
	Socket     *SocketConfig     `json:"socket,omitempty" bson:"socket,omitempty"`
	API        *APIConfig        `json:"api,omitempty" bson:"api,omitempty"`
	TSStore    *TSStoreConfig    `json:"tsstore,omitempty" bson:"tsstore,omitempty"`
	Prometheus *PrometheusConfig `json:"prometheus,omitempty" bson:"prometheus,omitempty"`
	EdgeLake   *EdgeLakeConfig   `json:"edgelake,omitempty" bson:"edgelake,omitempty"`
	MQTT       *MQTTConfig       `json:"mqtt,omitempty" bson:"mqtt,omitempty"`
	Frigate    *FrigateConfig    `json:"frigate,omitempty" bson:"frigate,omitempty"`
}

// SQLConfig represents configuration for SQL databases
type SQLConfig struct {
	Driver         string `json:"driver" bson:"driver" binding:"required,oneof=postgres mysql sqlite mssql oracle"`
	Host           string `json:"host,omitempty" bson:"host,omitempty"`
	Port           int    `json:"port,omitempty" bson:"port,omitempty"`
	Database       string `json:"database,omitempty" bson:"database,omitempty"`
	Username       string `json:"username,omitempty" bson:"username,omitempty"`
	Password       string `json:"password,omitempty" bson:"password,omitempty"`
	SSL            bool   `json:"ssl,omitempty" bson:"ssl,omitempty"`
	// InsecureSkipVerify disables TLS certificate verification when
	// SSL is true. Same two-gate model as APIConfig — the server-
	// level api.allow_insecure_tls must also be true. Driver-specific
	// translation in buildConnectionString:
	//   postgres → sslmode=require (vs verify-full when off)
	//   mysql    → tls=skip-verify (vs tls=true when off)
	//   mssql    → TrustServerCertificate=true (vs default when off)
	//   sqlite, oracle → ignored (sqlite has no TLS; oracle is
	//   driver-specific and not yet covered).
	InsecureSkipVerify bool `json:"insecure_skip_verify,omitempty" bson:"insecure_skip_verify,omitempty"`
	MaxConnections     int  `json:"max_connections,omitempty" bson:"max_connections,omitempty"`
	Timeout            int  `json:"timeout,omitempty" bson:"timeout,omitempty"` // seconds
	Options            string `json:"options,omitempty" bson:"options,omitempty"` // Optional connection parameters (e.g., "sslmode=require&connect_timeout=10")
}

// CSVConfig represents configuration for CSV files
type CSVConfig struct {
	Path         string   `json:"path" bson:"path" binding:"required"`
	Delimiter    string   `json:"delimiter,omitempty" bson:"delimiter,omitempty"` // default: ","
	HasHeader    bool     `json:"has_header" bson:"has_header"`                   // default: true
	Columns      []string `json:"columns,omitempty" bson:"columns,omitempty"`     // explicit column names
	WatchChanges bool     `json:"watch_changes" bson:"watch_changes"`
	Encoding     string   `json:"encoding,omitempty" bson:"encoding,omitempty"` // utf-8, ascii, etc.
}

// SocketConfig represents configuration for socket/WebSocket streams
type SocketConfig struct {
	URL              string              `json:"url" bson:"url" binding:"required"`
	Protocol         string              `json:"protocol" bson:"protocol" binding:"required,oneof=tcp websocket"`
	// InsecureSkipVerify disables TLS certificate verification when
	// the URL uses wss://. Same two-gate model as APIConfig — the
	// server-level api.allow_insecure_tls must also be true. Plain
	// ws:// and tcp:// connections ignore this entirely.
	InsecureSkipVerify bool `json:"insecure_skip_verify,omitempty" bson:"insecure_skip_verify,omitempty"`
	Bidirectional    bool                `json:"bidirectional,omitempty" bson:"bidirectional,omitempty"`     // WebSocket only — when true, resolves to stream.websocket-bidir (write-capable, used for control commands)
	Headers          map[string]string   `json:"headers,omitempty" bson:"headers,omitempty"`
	ReconnectOnError bool                `json:"reconnect_on_error" bson:"reconnect_on_error"`
	ReconnectDelay   int                 `json:"reconnect_delay,omitempty" bson:"reconnect_delay,omitempty"` // milliseconds
	PingInterval     int                 `json:"ping_interval,omitempty" bson:"ping_interval,omitempty"`     // seconds
	MessageFormat    string              `json:"message_format,omitempty" bson:"message_format,omitempty"`   // json, text
	BufferSize       int                 `json:"buffer_size,omitempty" bson:"buffer_size,omitempty"`         // number of messages to buffer
	Parser           *SocketParserConfig `json:"parser,omitempty" bson:"parser,omitempty"`                   // parser configuration
}

// SocketParserConfig specifies how to parse incoming socket messages into tabular data
type SocketParserConfig struct {
	// DataPath is the JSON path to the data payload (e.g., "data", "payload", "message.readings")
	// Supports dot notation for nested paths. If empty, treats entire message as the data object.
	DataPath string `json:"data_path,omitempty" bson:"data_path,omitempty"`

	// TimestampField specifies which field contains the timestamp (default: use server receive time)
	TimestampField string `json:"timestamp_field,omitempty" bson:"timestamp_field,omitempty"`

	// TimestampScale hints how to interpret a numeric timestamp value: "ns" (nanoseconds), "ms" (milliseconds), or empty (auto-detect by magnitude). Mirrors the chart-side parser's timestamp_scale field.
	TimestampScale string `json:"timestamp_scale,omitempty" bson:"timestamp_scale,omitempty"`

	// TimestampFormat is the Go time format string for parsing timestamps (default: RFC3339)
	// Common formats: "2006-01-02T15:04:05Z07:00" (RFC3339), "2006-01-02 15:04:05", unix timestamp
	TimestampFormat string `json:"timestamp_format,omitempty" bson:"timestamp_format,omitempty"`

	// FieldMappings renames fields in the output (e.g., {"temp": "temperature", "ts": "timestamp"})
	FieldMappings map[string]string `json:"field_mappings,omitempty" bson:"field_mappings,omitempty"`

	// IncludeFields limits output to only these fields (empty = include all)
	IncludeFields []string `json:"include_fields,omitempty" bson:"include_fields,omitempty"`

	// ExcludeFields removes these fields from output
	ExcludeFields []string `json:"exclude_fields,omitempty" bson:"exclude_fields,omitempty"`
}

// APIConfig represents configuration for REST API data sources
type APIConfig struct {
	URL             string             `json:"url" bson:"url" binding:"required"`                       // Full API endpoint URL
	Method          string             `json:"method" bson:"method"`                                    // HTTP method (GET, POST, etc.)
	Headers         map[string]string  `json:"headers,omitempty" bson:"headers,omitempty"`              // Request headers
	AuthType        string             `json:"auth_type,omitempty" bson:"auth_type,omitempty"`          // none, bearer, basic, api-key
	AuthCredentials map[string]string  `json:"auth_credentials,omitempty" bson:"auth_credentials,omitempty"`
	QueryParams     map[string]string  `json:"query_params,omitempty" bson:"query_params,omitempty"`    // Query parameters
	Body            string             `json:"body,omitempty" bson:"body,omitempty"`                    // Request body template
	Timeout         int                `json:"timeout,omitempty" bson:"timeout,omitempty"`              // seconds
	RetryCount      int                `json:"retry_count,omitempty" bson:"retry_count,omitempty"`
	RetryDelay      int                `json:"retry_delay,omitempty" bson:"retry_delay,omitempty"`      // milliseconds
	ResponseConfig  *APIResponseConfig `json:"response_config,omitempty" bson:"response_config,omitempty"` // Response parsing config
	// InsecureSkipVerify disables TLS certificate verification for
	// this connection. The adapter only honors this when the server
	// deployment also has `api.allow_insecure_tls: true` — both gates
	// must agree before verification is actually skipped. Intended
	// for development / homelab sources with self-signed certs
	// (Proxmox UI, internal management appliances). Never set on a
	// public-internet endpoint; MITM goes undetected when on.
	InsecureSkipVerify bool `json:"insecure_skip_verify,omitempty" bson:"insecure_skip_verify,omitempty"`
}

// APIResponseConfig specifies how to parse API responses
type APIResponseConfig struct {
	// DataPath is the JSON path to the array of records (e.g., "data", "results", "items")
	// If empty, assumes response is already an array or will be parsed as key-value pairs
	DataPath string `json:"data_path,omitempty" bson:"data_path,omitempty"`
}

// TSStoreDataType represents the data type stored in a TSStore
type TSStoreDataType string

const (
	TSStoreDataTypeJSON   TSStoreDataType = "json"   // Arbitrary JSON objects
	TSStoreDataTypeSchema TSStoreDataType = "schema" // Schema-defined compact JSON
	TSStoreDataTypeText   TSStoreDataType = "text"   // UTF-8 text
)

// TSStoreProtocol represents the protocol for TSStore connections
type TSStoreProtocol string

const (
	TSStoreProtocolHTTP  TSStoreProtocol = "http"  // HTTP/WS (unencrypted)
	TSStoreProtocolHTTPS TSStoreProtocol = "https" // HTTPS/WSS (encrypted)
)

// TSStoreTransport represents the transport mode for TSStore connections
type TSStoreTransport string

const (
	TSStoreTransportREST      TSStoreTransport = "rest"      // HTTP polling (default)
	TSStoreTransportStreaming  TSStoreTransport = "streaming" // WebSocket push (real-time)
)

// TSStoreConfig represents configuration for TSStore (timeseries store) data sources
// TSStore stores arbitrary objects at timestamps, using a block-based storage system.
// Data does not have a predefined schema - schema is inferred from the first N records.
type TSStoreConfig struct {
	Transport TSStoreTransport  `json:"transport,omitempty" bson:"transport,omitempty"`                // Transport mode: "rest" (default) or "streaming"
	Protocol  TSStoreProtocol   `json:"protocol" bson:"protocol" binding:"required,oneof=http https"` // Protocol: "http" (HTTP/WS) or "https" (HTTPS/WSS)
	Host      string            `json:"host" bson:"host" binding:"required"`                          // Hostname or IP address
	Port      int               `json:"port" bson:"port" binding:"required"`                          // Port number
	StoreName string            `json:"store_name" bson:"store_name" binding:"required"`              // Name of the store to query
	DataType  TSStoreDataType   `json:"data_type,omitempty" bson:"data_type,omitempty"`               // Store data type: json, schema, text (default: json)
	APIKey    string            `json:"api_key,omitempty" bson:"api_key,omitempty"`                   // Optional API key for authentication
	Headers   map[string]string `json:"headers,omitempty" bson:"headers,omitempty"`                   // Additional HTTP headers
	Timeout   int               `json:"timeout,omitempty" bson:"timeout,omitempty"`                   // Request timeout in seconds (default: 30)

	// InsecureSkipVerify disables TLS certificate verification when
	// Protocol is "https". Same two-gate model as APIConfig: the
	// deployment must also have `api.allow_insecure_tls: true`
	// before either gate actually takes effect. Intended for homelab
	// ts-store instances behind self-signed certs; never set on a
	// public-internet endpoint.
	InsecureSkipVerify bool `json:"insecure_skip_verify,omitempty" bson:"insecure_skip_verify,omitempty"`

	// Push connection configuration for streaming transport (ts-store v0.2.2+)
	// Only used when Transport is "streaming". Dashboard calls ts-store API to create
	// a push connection and ts-store dials out to dashboard's inbound WebSocket endpoint.
	Push *TSStorePushConfig `json:"push,omitempty" bson:"push,omitempty"`
}

// IsStreaming returns true if this TSStore connection uses WebSocket push transport
func (c *TSStoreConfig) IsStreaming() bool {
	return c.Transport == TSStoreTransportStreaming
}

// TSStorePushConfig configures the outbound WebSocket push from ts-store to dashboard
// See ts-store docs: /docs/outbound-data-ws.md
type TSStorePushConfig struct {
	// From is the starting timestamp in nanoseconds (0 = oldest data, -1 = current time/realtime only)
	From int64 `json:"from" bson:"from"`

	// Format specifies the message format: "full" (default) or "compact" (for schema stores)
	Format string `json:"format,omitempty" bson:"format,omitempty"`

	// Filter is an optional substring filter - only send matching records
	Filter string `json:"filter,omitempty" bson:"filter,omitempty"`

	// FilterIgnoreCase enables case-insensitive filter matching
	FilterIgnoreCase bool `json:"filter_ignore_case,omitempty" bson:"filter_ignore_case,omitempty"`

	// AggWindow is the aggregation window duration (e.g., "1m", "5m", "1h")
	// When set, records are aggregated over this time window before sending
	AggWindow string `json:"agg_window,omitempty" bson:"agg_window,omitempty"`

	// AggFields specifies per-field aggregation functions (e.g., "temp:avg,count:sum")
	AggFields string `json:"agg_fields,omitempty" bson:"agg_fields,omitempty"`

	// AggDefault is the default aggregation function for fields not in AggFields
	// Options: avg, sum, min, max, first, last, count
	AggDefault string `json:"agg_default,omitempty" bson:"agg_default,omitempty"`

	// ConnectionID stores the active push connection ID returned by ts-store
	// This is set when the push connection is created and used to manage/delete it
	ConnectionID string `json:"connection_id,omitempty" bson:"connection_id,omitempty"`
}

// BaseURL returns the HTTP base URL built from protocol, host, and port
func (c *TSStoreConfig) BaseURL() string {
	protocol := string(c.Protocol)
	if protocol == "" {
		protocol = "http"
	}
	return fmt.Sprintf("%s://%s:%d", protocol, c.Host, c.Port)
}

// WebSocketURL returns the WebSocket base URL built from protocol, host, and port
func (c *TSStoreConfig) WebSocketURL() string {
	wsProtocol := "ws"
	if c.Protocol == TSStoreProtocolHTTPS {
		wsProtocol = "wss"
	}
	return fmt.Sprintf("%s://%s:%d", wsProtocol, c.Host, c.Port)
}

// PrometheusConfig represents configuration for Prometheus data sources
type PrometheusConfig struct {
	URL      string `json:"url" bson:"url" binding:"required"`           // Prometheus server URL (e.g., "http://localhost:9090")
	Username string `json:"username,omitempty" bson:"username,omitempty"` // Basic auth username (optional)
	Password string `json:"password,omitempty" bson:"password,omitempty"` // Basic auth password (optional)
	Timeout  int    `json:"timeout,omitempty" bson:"timeout,omitempty"`   // Query timeout in seconds (default: 30)
	// InsecureSkipVerify disables TLS certificate verification when
	// the URL uses https://. Same two-gate model as APIConfig — the
	// server-level api.allow_insecure_tls must also be true.
	InsecureSkipVerify bool `json:"insecure_skip_verify,omitempty" bson:"insecure_skip_verify,omitempty"`
}

// MQTTConfig represents configuration for MQTT broker connections
type MQTTConfig struct {
	BrokerURL  string `json:"broker_url" bson:"broker_url" binding:"required"`   // mqtt://host:1883 or mqtts://host:8883
	ClientID   string `json:"client_id" bson:"client_id"`                         // MQTT client identifier (auto-generated if empty)
	Username   string `json:"username,omitempty" bson:"username,omitempty"`        // Auth username (optional)
	Password   string `json:"password,omitempty" bson:"password,omitempty"`        // Auth password (optional)
	TLS        bool   `json:"tls" bson:"tls"`                                     // Use TLS (mqtts://)
	KeepAlive  int    `json:"keep_alive,omitempty" bson:"keep_alive,omitempty"`    // Seconds (default 60)
	QoS        int    `json:"qos,omitempty" bson:"qos,omitempty"`                 // Default Quality of Service (0, 1, or 2)
	CleanStart bool   `json:"clean_start" bson:"clean_start"`                     // Clean session on connect
	BufferSize int    `json:"buffer_size,omitempty" bson:"buffer_size,omitempty"`  // Message buffer size (default 100)
}

// FrigateConfig represents configuration for Frigate NVR connections
type FrigateConfig struct {
	Host       string `json:"host" bson:"host" binding:"required"`                           // Frigate hostname or IP
	Port       int    `json:"port" bson:"port"`                                              // Frigate API port (default: 5000)
	Username   string `json:"username,omitempty" bson:"username,omitempty"`                   // Basic auth username (optional)
	Password   string `json:"password,omitempty" bson:"password,omitempty"`                   // Basic auth password (optional)
	Go2RTCPort int    `json:"go2rtc_port,omitempty" bson:"go2rtc_port,omitempty"`             // go2rtc port (default: 1984)
}

// BaseURL returns the Frigate API base URL
func (c *FrigateConfig) BaseURL() string {
	port := c.Port
	if port == 0 {
		port = 5000
	}
	return fmt.Sprintf("http://%s:%d", c.Host, port)
}

// JSMPEGURL returns the WebSocket base URL for JSMPEG live streams
func (c *FrigateConfig) JSMPEGURL() string {
	port := c.Port
	if port == 0 {
		port = 5000
	}
	return fmt.Sprintf("ws://%s:%d", c.Host, port)
}

// Go2RTCURL returns the go2rtc base URL
func (c *FrigateConfig) Go2RTCURL() string {
	port := c.Go2RTCPort
	if port == 0 {
		port = 1984
	}
	return fmt.Sprintf("http://%s:%d", c.Host, port)
}

// EdgeLakeConfig represents configuration for EdgeLake data sources
type EdgeLakeConfig struct {
	Host                string `json:"host" bson:"host" binding:"required"`                                   // EdgeLake node IP/hostname
	Port                int    `json:"port" bson:"port" binding:"required"`                                   // REST API port (default: 32049)
	Timeout             int    `json:"timeout,omitempty" bson:"timeout,omitempty"`                             // Request timeout in seconds (default: 20)
	UseDistributedQuery bool   `json:"use_distributed_query" bson:"use_distributed_query"`                     // Add "destination: network" header
}

// EdgeLakeSchemaInfo represents EdgeLake schema information
type EdgeLakeSchemaInfo struct {
	Databases []string              `json:"databases"`           // Available databases
	Tables    []EdgeLakeTableInfo   `json:"tables,omitempty"`    // Tables (populated when database is selected)
}

// EdgeLakeTableInfo represents information about an EdgeLake table
type EdgeLakeTableInfo struct {
	Database string                `json:"database"`
	Name     string                `json:"name"`
	Columns  []EdgeLakeColumnInfo  `json:"columns,omitempty"`
}

// EdgeLakeColumnInfo represents a column in an EdgeLake table
type EdgeLakeColumnInfo struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
}

// PrometheusQueryType represents the type of Prometheus query
type PrometheusQueryType string

const (
	PrometheusQueryTypeInstant PrometheusQueryType = "instant" // Single point in time
	PrometheusQueryTypeRange   PrometheusQueryType = "range"   // Time series over a range
)

// PrometheusQueryParams holds parameters for Prometheus queries
type PrometheusQueryParams struct {
	QueryType PrometheusQueryType `json:"query_type"` // "instant" or "range"
	Start     string              `json:"start"`      // Start time: RFC3339, unix timestamp, or relative ("now-1h")
	End       string              `json:"end"`        // End time: RFC3339, unix timestamp, or relative ("now")
	Step      string              `json:"step"`       // Query resolution step: "15s", "1m", "5m"
}

// HealthInfo represents health check information
type HealthInfo struct {
	Status       HealthStatus `json:"status" bson:"status"`
	LastCheck    time.Time    `json:"last_check,omitempty" bson:"last_check,omitempty"`
	LastSuccess  time.Time    `json:"last_success,omitempty" bson:"last_success,omitempty"`
	ErrorMessage string       `json:"error_message,omitempty" bson:"error_message,omitempty"`
	ResponseTime int64        `json:"response_time,omitempty" bson:"response_time,omitempty"` // milliseconds
}

// CreateConnectionRequest represents request to create a data source
type CreateConnectionRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
	Namespace   string `json:"namespace,omitempty"` // Empty defaults to "default" in the handler.

	// NEW: Registry-based type system (preferred)
	TypeID     string                 `json:"type_id,omitempty"`
	TypeConfig map[string]interface{} `json:"type_config,omitempty"`

	// LEGACY: Keep for backwards compatibility
	Type   ConnectionType   `json:"type,omitempty"`
	Config ConnectionConfig `json:"config,omitempty"`

	Tags             []string `json:"tags,omitempty"`
	SupportedSchemas []string `json:"supported_schemas,omitempty"`
}

// UpdateConnectionRequest represents request to update a data source
type UpdateConnectionRequest struct {
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	Namespace   string `json:"namespace,omitempty"` // Empty = leave current namespace unchanged.

	// NEW: Registry-based type system
	TypeID     string                 `json:"type_id,omitempty"`
	TypeConfig map[string]interface{} `json:"type_config,omitempty"`

	// LEGACY: Keep for backwards compatibility
	Config ConnectionConfig `json:"config,omitempty"`

	Tags             []string `json:"tags,omitempty"`
	SupportedSchemas []string `json:"supported_schemas,omitempty"`
}

// TestConnectionRequest represents request to test a data source connection
type TestConnectionRequest struct {
	// NEW: Registry-based type system (preferred)
	TypeID     string                 `json:"type_id,omitempty"`
	TypeConfig map[string]interface{} `json:"type_config,omitempty"`

	// LEGACY: Keep for backwards compatibility
	Type   ConnectionType   `json:"type,omitempty"`
	Config ConnectionConfig `json:"config,omitempty"`

	// Optional: existing connection ID to resolve masked secrets from DB
	ID string `json:"id,omitempty"`
}

// TestConnectionResponse represents response from testing a data source
type TestConnectionResponse struct {
	Success      bool         `json:"success"`
	Status       HealthStatus `json:"status"`
	Message      string       `json:"message,omitempty"`
	ResponseTime int64        `json:"response_time,omitempty"` // milliseconds
	Data         interface{}  `json:"data,omitempty"`
}

// QueryRequest represents a request to query a datasource
type QueryRequest struct {
	Query Query `json:"query" binding:"required"`
}

// QueryResponse represents a response from querying a datasource
type QueryResponse struct {
	Success   bool       `json:"success"`
	ResultSet *ResultSet `json:"result_set,omitempty"`
	Error     string     `json:"error,omitempty"`
	// ErrorCode is a stable machine-readable classifier for the error, when
	// one applies (empty otherwise). Lets the client distinguish recoverable
	// states (e.g. "dashboard_variable_not_set" → render a friendly
	// select-a-value empty-state) from genuine query failures without
	// string-matching the human-readable Error message.
	ErrorCode string `json:"error_code,omitempty"`
	Duration  int64  `json:"duration"` // milliseconds
}

// Query error codes for QueryResponse.ErrorCode.
const (
	// QueryErrorVariableNotSet indicates the query references the dashboard
	// variable token but no value was supplied. The panel should prompt the
	// user to pick a value rather than showing an error.
	QueryErrorVariableNotSet = "dashboard_variable_not_set"

	// QueryErrorWriteNotAllowed indicates the server-side verb guard refused
	// the SQL statement: a write verb (INSERT/UPDATE/DELETE) without the
	// matching admin opt-in, a DDL statement (always refused), or a
	// multi-statement / unclassifiable body. The client should surface the
	// returned Error verbatim and not retry. Protects /query against
	// replay/body-tampering that swaps in a write or DDL statement.
	QueryErrorWriteNotAllowed = "write_not_allowed"
)

// VariableValuesRequest asks for the distinct values of a column on a
// connection, used to populate a dashboard-variable picker. Column/Table may be
// supplied explicitly by the caller or derived from a component's query.
type VariableValuesRequest struct {
	Column         string `json:"column"`                    // column whose distinct values to list (required)
	Table          string `json:"table,omitempty"`           // source table (required for SQL/EdgeLake)
	Database       string `json:"database,omitempty"`        // EdgeLake routes queries by database name (taken from the component's query params)
	Field          string `json:"field,omitempty"`           // record field for streaming/record-based sources (defaults to Column)
	Limit          int    `json:"limit,omitempty"`           // max distinct values (default 1000)
	CaptureSeconds int    `json:"capture_seconds,omitempty"` // streaming capture window (default applied server-side)
}

// VariableValuesResponse is the distinct-value list for a variable picker.
type VariableValuesResponse struct {
	Success bool     `json:"success"`
	Values  []string `json:"values"`
	Count   int      `json:"count"`
	// Partial is true when a streaming capture was cut short (timeout / client
	// stop / cap) and the list may be incomplete.
	Partial bool   `json:"partial,omitempty"`
	Error   string `json:"error,omitempty"`
}

// SaveDiscoveredValuesRequest persists a client-side-captured distinct-value
// list onto a connection (one column), for the dashboard-variable dropdown.
// The route is design-gated, so only authors can write; viewers keep a
// session-only override on the client.
type SaveDiscoveredValuesRequest struct {
	Column  string   `json:"column" binding:"required"` // the column the list is for
	Values  []string `json:"values"`                    // distinct values
	Partial bool     `json:"partial,omitempty"`         // true when capture was cut short
}

// SchemaProvider is an optional interface for datasources that support schema discovery
// SQL databases implement this; CSV/API/Socket do not
type SchemaProvider interface {
	GetSchema(ctx context.Context) (*SchemaInfo, error)
}

// SchemaInfo represents database schema information
type SchemaInfo struct {
	Database string      `json:"database"`          // Current database name
	Tables   []TableInfo `json:"tables"`            // Tables in the database
}

// TableInfo represents a database table
type TableInfo struct {
	Name    string       `json:"name"`              // Table name
	Schema  string       `json:"schema,omitempty"`  // Schema/namespace (e.g., "public" for PostgreSQL)
	Columns []ColumnInfo `json:"columns"`           // Columns in the table
}

// ColumnInfo represents a database column
type ColumnInfo struct {
	Name       string `json:"name"`                  // Column name
	Type       string `json:"type"`                  // Data type (e.g., "varchar", "integer")
	Nullable   bool   `json:"nullable"`              // Whether column allows NULL
	PrimaryKey bool   `json:"primary_key,omitempty"` // Whether column is part of primary key
	Default    string `json:"default,omitempty"`     // Default value if any
}

// SchemaResponse represents the API response for schema discovery
type SchemaResponse struct {
	Success          bool                    `json:"success"`
	Schema           *SchemaInfo             `json:"schema,omitempty"`              // For SQL datasources
	PrometheusSchema *PrometheusSchemaInfo   `json:"prometheus_schema,omitempty"`   // For Prometheus datasources
	Error            string                  `json:"error,omitempty"`
	Duration         int64                   `json:"duration"` // milliseconds
}

// PrometheusSchemaInfo represents Prometheus schema information
type PrometheusSchemaInfo struct {
	Metrics []PrometheusMetricInfo `json:"metrics"` // Available metrics
	Labels  []string               `json:"labels"`  // All label names
}

// PrometheusMetricInfo represents information about a Prometheus metric
type PrometheusMetricInfo struct {
	Name   string   `json:"name"`             // Metric name (e.g., "http_requests_total")
	Type   string   `json:"type,omitempty"`   // Metric type: "counter", "gauge", "histogram", "summary"
	Help   string   `json:"help,omitempty"`   // Description from metadata
	Labels []string `json:"labels,omitempty"` // Labels seen with this metric
}

// PrometheusSchemaProvider is an interface for Prometheus schema discovery
type PrometheusSchemaProvider interface {
	GetMetrics(ctx context.Context) ([]string, error)
	GetLabels(ctx context.Context) ([]string, error)
	GetLabelValues(ctx context.Context, labelName string) ([]string, error)
}

// UnifiedSchemaResponse is the response format for the get_schema tool
// It provides a consistent schema format for all connection types
type UnifiedSchemaResponse struct {
	Connection UnifiedSchemaSourceInfo `json:"connection"`
	Schema     UnifiedSchema           `json:"schema"`
}

// UnifiedSchemaSourceInfo contains basic info about the datasource
type UnifiedSchemaSourceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// UnifiedSchema represents schema information in a unified format
type UnifiedSchema struct {
	// For datasources without tables (API, CSV, Socket, TSStore)
	Columns []UnifiedSchemaColumn `json:"columns,omitempty"`

	// For datasources with tables (SQL, EdgeLake)
	Tables []UnifiedSchemaTable `json:"tables,omitempty"`

	// For Prometheus - metrics and labels
	Metrics []string `json:"metrics,omitempty"`
	Labels  []string `json:"labels,omitempty"`

	// Row count (when available from sample data)
	RowCount int `json:"row_count,omitempty"`
}

// UnifiedSchemaTable represents a table with its columns
type UnifiedSchemaTable struct {
	Name    string                `json:"name"`
	Columns []UnifiedSchemaColumn `json:"columns"`
}

// UnifiedSchemaColumn represents a column with inferred type and metadata
type UnifiedSchemaColumn struct {
	Name string `json:"name"`
	Type string `json:"type"` // timestamp, integer, float, string, boolean, mixed

	// For string columns with limited unique values (≤20)
	UniqueValues []interface{} `json:"unique_values,omitempty"`
	UniqueCount  int           `json:"unique_count,omitempty"`

	// For numeric columns
	Min interface{} `json:"min,omitempty"`
	Max interface{} `json:"max,omitempty"`

	// Sample value (first non-null value seen)
	Sample interface{} `json:"sample,omitempty"`
}

// authHeaderNames is the set of HTTP header names whose values are treated
// as secrets and redacted on sanitize. Matched case-insensitively.
var authHeaderNames = map[string]struct{}{
	"authorization":       {},
	"proxy-authorization": {},
	"cookie":              {},
	"set-cookie":          {},
	"x-api-key":           {},
	"x-auth-token":        {},
	"x-access-token":      {},
}

// maskAuthHeaders is the SanitizeForAPI shape: replaces matching
// header values with the round-trip sentinel.
func maskAuthHeaders(headers map[string]string) map[string]string {
	return maskAuthHeadersWith(headers, SecretMaskedValue)
}

// maskAuthHeadersWith returns a copy of headers with any header whose
// name matches authHeaderNames (case-insensitive) replaced with
// `replacement`. Preserves the original key casing. The two call
// sites (API vs export) supply different replacement strings.
func maskAuthHeadersWith(headers map[string]string, replacement string) map[string]string {
	if len(headers) == 0 {
		return headers
	}
	out := make(map[string]string, len(headers))
	for k, v := range headers {
		if _, ok := authHeaderNames[strings.ToLower(k)]; ok {
			out[k] = replacement
		} else {
			out[k] = v
		}
	}
	return out
}

// maskURLUserinfo strips `user:password@` from a URL. If the string
// does not parse as a URL or has no userinfo component, it is returned
// unchanged.
func maskURLUserinfo(raw string) string {
	if raw == "" {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	u.User = nil
	return u.String()
}

// maskSQLOptions is the SanitizeForAPI shape: replaces password-like
// segments with the round-trip sentinel.
func maskSQLOptions(opts string) string {
	return maskSQLOptionsWith(opts, SecretMaskedValue)
}

// maskSQLOptionsWith redacts password-like segments inside a SQL
// connection options string (e.g.
// "sslmode=require&password=hunter2&connect_timeout=10") with the
// supplied replacement value. Supports `&`-separated, `;`-separated,
// and space-separated key=value pairs — the three common driver
// conventions. Keys matched case-insensitively.
func maskSQLOptionsWith(opts, replacement string) string {
	if opts == "" {
		return opts
	}
	sensitiveKeys := map[string]struct{}{
		"password":    {},
		"passwd":      {},
		"pwd":         {},
		"sslpassword": {},
	}
	mask := func(kv string) string {
		eq := strings.IndexByte(kv, '=')
		if eq < 0 {
			return kv
		}
		key := strings.ToLower(strings.TrimSpace(kv[:eq]))
		if _, ok := sensitiveKeys[key]; ok {
			return kv[:eq+1] + replacement
		}
		return kv
	}
	// Pick the separator the string already uses; default to &.
	sep := "&"
	if strings.ContainsRune(opts, ';') && !strings.ContainsRune(opts, '&') {
		sep = ";"
	} else if !strings.ContainsRune(opts, '&') && !strings.ContainsRune(opts, ';') && strings.ContainsRune(opts, ' ') {
		sep = " "
	}
	parts := strings.Split(opts, sep)
	for i, p := range parts {
		parts[i] = mask(p)
	}
	return strings.Join(parts, sep)
}

// SanitizeForAPI returns a copy of the connection with every populated
// secret field replaced by the SecretMaskedValue sentinel. Empty
// secrets stay empty. The editor reads this shape: a "********"
// sentinel tells SecretTextInput "the server has a value here, leave
// it alone to preserve"; an empty string tells the editor "there is
// nothing here, the user must fill it in."
//
// The sentinel doubles as the round-trip contract on update: when
// the editor saves with a "********" still in a field, the server's
// preserveSecrets() restores the actual value from disk before
// writing. Any other value (including empty) replaces what was
// stored. See connection_service.go::preserveSecrets.
func (d *Connection) SanitizeForAPI() *Connection {
	return d.sanitize(SecretMaskedValue)
}

// SanitizeForExport returns a copy of the connection with every
// populated secret field replaced by the empty string. Unlike the
// API path, the export path's contract is "bundles never carry
// secrets in any form" — there is no round-trip sentinel because
// there is nothing to round-trip to. Importing a bundle never
// overwrites existing secrets (the import-update path explicitly
// preserves existing secrets regardless of bundle contents); a
// new-connection import lands with empty secret fields that an
// admin must fill in via the editor on the target deployment.
//
// Emitting "" instead of "********" makes raw-JSON readers see
// exactly what will land in the DB: nothing. The field name is
// still present so it's discoverable as something that needs a
// value.
func (d *Connection) SanitizeForExport() *Connection {
	return d.sanitize("")
}

// sanitize returns a masked copy of the connection. replacement is
// the string substituted for every populated secret field. Pass
// SecretMaskedValue for the API/editor shape, "" for the export-
// bundle shape.
func (d *Connection) sanitize(replacement string) *Connection {
	sanitized := *d

	if d.Config.SQL != nil {
		sqlCopy := *d.Config.SQL
		if sqlCopy.Password != "" {
			sqlCopy.Password = replacement
		}
		sqlCopy.Options = maskSQLOptionsWith(sqlCopy.Options, replacement)
		sanitized.Config.SQL = &sqlCopy
	}

	if d.Config.API != nil {
		apiCopy := *d.Config.API
		apiCopy.URL = maskURLUserinfo(apiCopy.URL)
		if len(apiCopy.AuthCredentials) > 0 {
			maskedCreds := make(map[string]string, len(apiCopy.AuthCredentials))
			for k := range apiCopy.AuthCredentials {
				maskedCreds[k] = replacement
			}
			apiCopy.AuthCredentials = maskedCreds
		}
		apiCopy.Headers = maskAuthHeadersWith(apiCopy.Headers, replacement)
		// Body and QueryParams are user-authored freeform fields that
		// commonly contain tokens or api keys. We can't reliably
		// redact inside them, so mask them whole on any non-empty
		// value. Importer will prompt the user to re-enter (or, on
		// the export path, leaves the field empty for discovery).
		if apiCopy.Body != "" {
			apiCopy.Body = replacement
		}
		if len(apiCopy.QueryParams) > 0 {
			maskedParams := make(map[string]string, len(apiCopy.QueryParams))
			for k := range apiCopy.QueryParams {
				maskedParams[k] = replacement
			}
			apiCopy.QueryParams = maskedParams
		}
		sanitized.Config.API = &apiCopy
	}

	if d.Config.TSStore != nil {
		tsCopy := *d.Config.TSStore
		if tsCopy.APIKey != "" {
			tsCopy.APIKey = replacement
		}
		tsCopy.Headers = maskAuthHeadersWith(tsCopy.Headers, replacement)
		sanitized.Config.TSStore = &tsCopy
	}

	if d.Config.Socket != nil {
		socketCopy := *d.Config.Socket
		socketCopy.URL = maskURLUserinfo(socketCopy.URL)
		socketCopy.Headers = maskAuthHeadersWith(socketCopy.Headers, replacement)
		sanitized.Config.Socket = &socketCopy
	}

	if d.Config.Prometheus != nil {
		promCopy := *d.Config.Prometheus
		promCopy.URL = maskURLUserinfo(promCopy.URL)
		if promCopy.Password != "" {
			promCopy.Password = replacement
		}
		sanitized.Config.Prometheus = &promCopy
	}

	if d.Config.MQTT != nil {
		mqttCopy := *d.Config.MQTT
		mqttCopy.BrokerURL = maskURLUserinfo(mqttCopy.BrokerURL)
		if mqttCopy.Password != "" {
			mqttCopy.Password = replacement
		}
		sanitized.Config.MQTT = &mqttCopy
	}

	if d.Config.Frigate != nil {
		frigateCopy := *d.Config.Frigate
		if frigateCopy.Password != "" {
			frigateCopy.Password = replacement
		}
		sanitized.Config.Frigate = &frigateCopy
	}

	return &sanitized
}

// HasSecret checks if a field currently has a secret value set (not empty).
// Used by frontend to show "********" vs empty field.
func (d *Connection) HasSecret(fieldPath string) bool {
	switch fieldPath {
	case "sql.password":
		return d.Config.SQL != nil && d.Config.SQL.Password != ""
	case "api.auth_credentials":
		return d.Config.API != nil && len(d.Config.API.AuthCredentials) > 0
	case "tsstore.api_key":
		return d.Config.TSStore != nil && d.Config.TSStore.APIKey != ""
	case "mqtt.password":
		return d.Config.MQTT != nil && d.Config.MQTT.Password != ""
	case "frigate.password":
		return d.Config.Frigate != nil && d.Config.Frigate.Password != ""
	default:
		return false
	}
}
