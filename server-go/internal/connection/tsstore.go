// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	// Register TSStore adapter
	registry.Register(
		"store.tsstore",
		"TSStore Time Series",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true},
		tsstoreConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newTSStoreAdapterFromConfig(config)
		},
	)
	// Declare the per-component store surface (#248): on an endpoint-scoped
	// connection (no pinned store_name) the component editor renders a store
	// picker fed by GET /api/connections/:id/stores. Orthogonal to the query
	// itself, hence its own kind rather than "catalog" presets.
	registry.RegisterQuerySurface("store.tsstore", registry.QuerySurface{
		Kind:        registry.QuerySurfaceStoreList,
		Label:       "Store",
		Description: "Store this component reads from (endpoint-scoped connections only — a pinned connection is bound to its one store)",
	})
}

// tsstoreConfigSchema returns configuration fields for TSStore adapter
func tsstoreConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "transport", Type: "string", Required: false, Options: []string{"rest", "streaming"}, Default: "rest", Description: "Transport mode: rest (HTTP polling) or streaming (WebSocket push)"},
		{Name: "protocol", Type: "string", Required: true, Options: []string{"http", "https"}, Description: "Protocol (http or https)"},
		{Name: "host", Type: "string", Required: true, Description: "TSStore host"},
		{Name: "port", Type: "int", Required: true, Description: "TSStore port"},
		{Name: "store_name", Type: "string", Required: false, Description: "Pinned store (optional). Set to bind this connection to one store; leave empty for an endpoint-scoped connection where each component chooses its store"},
		{Name: "data_type", Type: "string", Required: false, Options: []string{"json", "schema", "text"}, Description: "Data type"},
		{Name: "api_key", Type: "password", Required: false, Description: "API key"},
		{Name: "timeout", Type: "int", Required: false, Default: 30, Description: "Timeout (seconds)"},
		{Name: "insecure_skip_verify", Type: "bool", Required: false, Default: false, Description: "Skip TLS certificate verification for HTTPS endpoints (self-signed certs). Server must also have api.allow_insecure_tls enabled."},
	}
}

// resolveEffectiveStore returns the store a query should hit. The connection
// pin wins when set — a pinned connection is bound to exactly one store and a
// component cannot override it (a stray params.store is ignored, not an
// error, so a same-type swap onto a pinned connection stays coherent).
// Endpoint-scoped connections (no pin) require the component to name a store
// via query_config.params.store.
func resolveEffectiveStore(cfg *models.TSStoreConfig, params map[string]interface{}) (string, error) {
	if cfg.StoreName != "" {
		return cfg.StoreName, nil
	}
	if store := resolveStoreParam(params); store != "" {
		return store, nil
	}
	return "", fmt.Errorf("endpoint-scoped tsstore connection: no store selected — choose a store on the component, or pin one on the connection")
}

// ---- Per-store data-type cache (endpoint-scoped connections) --------------
//
// data_type (json/schema/text) is a property of the STORE, not the
// connection: it decides compact-format reads and result decoding. Pinned
// connections keep the config-level value (auto-detected at Test time as
// before). Endpoint-scoped connections resolve it per effective store from
// ts-store's unauthenticated /stats endpoint, cached process-wide because
// adapter instances are per-request. TTL guards against a store being
// deleted and recreated with a different type.

const storeDataTypeTTL = 5 * time.Minute

var storeDataTypeCache = struct {
	sync.Mutex
	entries map[string]storeDataTypeEntry
}{entries: map[string]storeDataTypeEntry{}}

type storeDataTypeEntry struct {
	dataType models.TSStoreDataType
	fetched  time.Time
}

// lookupStoreDataType resolves a store's data type via the cache, falling
// back to a GET /api/stores/<store>/stats probe. Returns "" (treated as
// json, matching the long-standing unset-data_type behavior) when the probe
// fails — the real query will surface any actual connectivity error.
func lookupStoreDataType(ctx context.Context, httpClient *http.Client, cfg *models.TSStoreConfig, store string, addHeaders func(*http.Request)) models.TSStoreDataType {
	key := cfg.BaseURL() + "|" + store
	storeDataTypeCache.Lock()
	if e, ok := storeDataTypeCache.entries[key]; ok && time.Since(e.fetched) < storeDataTypeTTL {
		storeDataTypeCache.Unlock()
		return e.dataType
	}
	storeDataTypeCache.Unlock()

	reqURL := fmt.Sprintf("%s/api/stores/%s/stats", cfg.BaseURL(), store)
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return ""
	}
	addHeaders(req)
	resp, err := httpClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var stats storeStatsResponse
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return ""
	}

	dt := models.TSStoreDataType(stats.DataType)
	switch dt {
	case models.TSStoreDataTypeJSON, models.TSStoreDataTypeSchema, models.TSStoreDataTypeText:
	default:
		dt = models.TSStoreDataTypeJSON
	}
	storeDataTypeCache.Lock()
	storeDataTypeCache.entries[key] = storeDataTypeEntry{dataType: dt, fetched: time.Now()}
	storeDataTypeCache.Unlock()
	return dt
}

// tsStoreListResponse is ts-store's GET /api/stores envelope.
type tsStoreListResponse struct {
	Stores []registry.StoreInfo `json:"stores"`
}

// listTSStoreStores fetches the keyed store listing (ts-store GET
// /api/stores): every store the connection's key holds ANY grant on, each
// entry carrying the key's effective access classes (v0.20.0-rc.2+). Doubles
// as the connectivity+auth test for endpoint-scoped connections — the
// endpoint 401s on a missing/invalid key.
func listTSStoreStores(ctx context.Context, httpClient *http.Client, cfg *models.TSStoreConfig, addHeaders func(*http.Request)) ([]registry.StoreInfo, error) {
	reqURL := cfg.BaseURL() + "/api/stores"
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	addHeaders(req)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		if cfg.APIKey == "" {
			return nil, fmt.Errorf("API key required: the store listing is authenticated — configure an api_key")
		}
		return nil, fmt.Errorf("api_key rejected by the ts-store server (HTTP %d) — check the key's grants (tsstore key list)", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore error (status %d): %s", resp.StatusCode, string(body))
	}

	var listResp tsStoreListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("failed to decode store listing: %w", err)
	}
	return listResp.Stores, nil
}

// ListStores implements registry.StoreLister for the registry adapter.
func (a *TSStoreAdapter) ListStores(ctx context.Context) ([]registry.StoreInfo, error) {
	return listTSStoreStores(ctx, a.httpClient, a.config, a.addHeaders)
}

// ListStores implements registry.StoreLister for the legacy datasource.
func (t *TSStoreDataSource) ListStores(ctx context.Context) ([]registry.StoreInfo, error) {
	return listTSStoreStores(ctx, t.httpClient, t.config, t.addHeaders)
}

// resolveQueryStore resolves the effective (store, dataType) for one query
// against this config. Pinned → the pin and the config's data type
// (unchanged behavior). Endpoint-scoped → the component's params.store and a
// per-store data-type lookup.
func resolveQueryStore(ctx context.Context, httpClient *http.Client, cfg *models.TSStoreConfig, params map[string]interface{}, addHeaders func(*http.Request)) (string, models.TSStoreDataType, error) {
	store, err := resolveEffectiveStore(cfg, params)
	if err != nil {
		return "", "", err
	}
	if cfg.StoreName != "" {
		return store, cfg.DataType, nil
	}
	return store, lookupStoreDataType(ctx, httpClient, cfg, store, addHeaders), nil
}

// TSStoreAdapter implements registry.Adapter for TSStore.
//
// store/dataType are the EFFECTIVE store + data type for the current query.
// They are seeded from the connection config at construction (the pinned
// store) and re-resolved at the top of Query for endpoint-scoped connections
// (no pin), where the component names the store via params.store and the data
// type is a per-store property looked up from ts-store (#248). Adapter
// instances are created per request by the stateless factory, so per-query
// state on the instance is safe.
type TSStoreAdapter struct {
	config     *models.TSStoreConfig
	httpClient *http.Client
	schema     *tsStoreSchema
	store      string
	dataType   models.TSStoreDataType
}

// newTSStoreAdapterFromConfig creates a TSStore adapter from config map
func newTSStoreAdapterFromConfig(config map[string]interface{}) (*TSStoreAdapter, error) {
	tsConfig := &models.TSStoreConfig{}

	if transport, ok := config["transport"].(string); ok {
		tsConfig.Transport = models.TSStoreTransport(transport)
	}
	if protocol, ok := config["protocol"].(string); ok {
		tsConfig.Protocol = models.TSStoreProtocol(protocol)
	}
	if host, ok := config["host"].(string); ok {
		tsConfig.Host = host
	}
	if port, ok := config["port"].(float64); ok {
		tsConfig.Port = int(port)
	} else if port, ok := config["port"].(int); ok {
		tsConfig.Port = port
	}
	if storeName, ok := config["store_name"].(string); ok {
		tsConfig.StoreName = storeName
	}
	if dataType, ok := config["data_type"].(string); ok {
		tsConfig.DataType = models.TSStoreDataType(dataType)
	}
	if apiKey, ok := config["api_key"].(string); ok {
		tsConfig.APIKey = apiKey
	}
	if timeout, ok := config["timeout"].(float64); ok {
		tsConfig.Timeout = int(timeout)
	} else if timeout, ok := config["timeout"].(int); ok {
		tsConfig.Timeout = timeout
	}
	if skip, ok := config["insecure_skip_verify"].(bool); ok {
		tsConfig.InsecureSkipVerify = skip
	}

	// Same two-gate parity warning as the api adapter: a per-conn
	// skip flag without the deployment-level allow is silently
	// ignored, which is hard to debug without a hint at boot.
	if tsConfig.InsecureSkipVerify && !IsInsecureTLSAllowed() {
		log.Printf("tsstore adapter %s://%s:%d/%s: insecure_skip_verify is set on this connection but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it",
			tsConfig.Protocol, tsConfig.Host, tsConfig.Port, tsConfig.StoreName)
	}

	return &TSStoreAdapter{
		config:     tsConfig,
		httpClient: BuildAPIHTTPClient(tsConfig.Timeout, tsConfig.InsecureSkipVerify),
		store:      tsConfig.StoreName,
		dataType:   tsConfig.DataType,
	}, nil
}

// TypeID returns the adapter type identifier
func (a *TSStoreAdapter) TypeID() string {
	return "store.tsstore"
}

// DisplayName returns a human-readable name
func (a *TSStoreAdapter) DisplayName() string {
	return "TSStore Time Series"
}

// Capabilities returns what this adapter can do
func (a *TSStoreAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true}
}

// ConfigSchema returns configuration fields
func (a *TSStoreAdapter) ConfigSchema() []registry.ConfigField {
	return tsstoreConfigSchema()
}

// Connect tests the connection to TSStore
func (a *TSStoreAdapter) Connect(ctx context.Context) error {
	return a.TestConnection(ctx)
}

// TestConnection tests the connection to TSStore
func (a *TSStoreAdapter) TestConnection(ctx context.Context) error {
	// Endpoint-scoped connection (no pinned store): a single keyed
	// GET /api/stores answers connectivity + auth in one call. Empty listing
	// = the key holds no grants at all (any-grant visibility) → failure.
	if a.config.StoreName == "" {
		stores, err := a.ListStores(ctx)
		if err != nil {
			return err
		}
		if len(stores) == 0 {
			return fmt.Errorf("the API key holds no grants on this ts-store server — no stores are accessible")
		}
		return nil
	}

	reqURL := fmt.Sprintf("%s/api/stores/%s/stats", a.config.BaseURL(), a.store)
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return err
	}
	a.addHeaders(req)

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("store '%s' not found", a.store)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("TSStore error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// Close is a no-op for TSStore
func (a *TSStoreAdapter) Close() error {
	return nil
}

// Query fetches data from TSStore
func (a *TSStoreAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	// Resolve the effective store first: pin wins; endpoint-scoped reads
	// params.store and resolves the store's own data type (#248).
	store, dataType, err := resolveQueryStore(ctx, a.httpClient, a.config, query.Params, a.addHeaders)
	if err != nil {
		return nil, err
	}
	if store != a.store {
		a.schema = nil // schema cache is per store
	}
	a.store, a.dataType = store, dataType

	var limit int
	hasExplicitLimit := false
	if l, ok := query.Params["limit"].(float64); ok {
		limit = int(l)
		hasExplicitLimit = true
	} else if l, ok := query.Params["limit"].(int); ok {
		limit = l
		hasExplicitLimit = true
	}

	filter := resolveFilterParam(query.Params)
	filterIgnoreCase, _ := query.Params["filter_ignore_case"].(bool)
	// group_by (pivot series column, v0.18.0) partitions step downsampling per
	// series. Forwarded on BOTH the structured-range and raw-DSL paths;
	// setGroupByParam only emits it when a step is actually present.
	groupBy := resolveGroupByParam(query.Params)
	// Raw-DSL step: the raw:"newest"/"since:"/"range:" paths previously
	// hardcoded step to "" (dropping any step/agg_window the caller passed as
	// flat params). Read it here so a raw stepped+grouped query works too. The
	// structured range path uses tr.Step instead.
	rawStep := resolveStepParam(query.Params)

	var objects []dataResponse

	// latest_by (ts-store v0.19.0): newest record per distinct value of a
	// field — "current state per series", one request. It lives on
	// /data/newest ONLY and is mutually exclusive with step/agg_window
	// (ts-store 400s on the combination), so it overrides the normal
	// dispatch: any step (range-picker or raw param) and group_by are
	// dropped — a now-lookup has no window to downsample. A RELATIVE window
	// (structured range or since: DSL) still bounds the scan via `since`
	// (only series that reported within it); an absolute range can't be
	// expressed on /data/newest and is ignored. limit caps DISTINCT GROUPS
	// (unset → ts-store's default of up to 1000 groups, not the newest
	// default of 10 — hence limit 0 to omit the param).
	if latestBy := resolveLatestByParam(query.Params); latestBy != "" {
		since := ""
		if spec, ok := resolveRange(query.Params); ok {
			if tr, valid := tsstoreRangeFromSpec(spec); valid && tr.Relative {
				since = tr.Since
			}
		} else if strings.HasPrefix(query.Raw, "since:") {
			since = query.Raw[len("since:"):]
		}
		if !hasExplicitLimit {
			limit = 0
		}
		objects, err = a.fetchNewest(ctx, limit, since, filter, filterIgnoreCase, "", "", latestBy)
		if err != nil {
			return nil, err
		}
		return a.toRegistryResultSet(ctx, objects)
	}

	// Range variable (structured path, auto-apply): consume the active range
	// directly (no token in query.Raw). Relative → native since:<token>;
	// absolute → a [from,to] range fetch.
	if spec, ok := resolveRange(query.Params); ok {
		if tr, valid := tsstoreRangeFromSpec(spec); valid {
			// A range query's WINDOW governs how many rows come back — the
			// component's saved limit is the streaming buffer size (default
			// 1000), a live-tail concern that has nothing to do with a
			// historical window. Carrying it here silently truncates a wide
			// window to the most-recent N rows (e.g. 6h@15s = 1081 rows clipped
			// to 1000 ≈ 4h). Always use the range ceiling; the step clamp bounds
			// the real point count well under it, so this is a cap, not a target.
			limit = tsstoreRangeRowCap
			if tr.Relative {
				objects, err = a.fetchNewest(ctx, limit, tr.Since, filter, filterIgnoreCase, tr.Step, groupBy, "")
			} else {
				objects, err = a.fetchRange(ctx, tr.FromEpoch, tr.ToEpoch, limit, filter, filterIgnoreCase, tr.Step, groupBy)
			}
			if err != nil {
				return nil, err
			}
			return a.toRegistryResultSet(ctx, objects)
		}
	}

	queryType := query.Raw
	if queryType == "" {
		queryType = "newest"
	}

	switch {
	case queryType == "newest":
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = a.fetchNewest(ctx, limit, "", filter, filterIgnoreCase, rawStep, groupBy, "")
	case queryType == "oldest":
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = a.fetchOldest(ctx, limit, filter, filterIgnoreCase)
	case len(queryType) > 6 && queryType[:6] == "since:":
		if !hasExplicitLimit {
			limit = 100000
		}
		since := queryType[6:]
		objects, err = a.fetchNewest(ctx, limit, since, filter, filterIgnoreCase, rawStep, groupBy, "")
	case len(queryType) > 6 && queryType[:6] == "range:":
		if !hasExplicitLimit {
			limit = 100000
		}
		var startTime, endTime int64
		if _, parseErr := fmt.Sscanf(queryType, "range:%d:%d", &startTime, &endTime); parseErr == nil {
			objects, err = a.fetchRange(ctx, startTime, endTime, limit, filter, filterIgnoreCase, rawStep, groupBy)
		} else {
			return nil, fmt.Errorf("invalid range format")
		}
	default:
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = a.fetchNewest(ctx, limit, "", filter, filterIgnoreCase, rawStep, groupBy, "")
	}

	if err != nil {
		return nil, err
	}

	return a.toRegistryResultSet(ctx, objects)
}

// Stream is not supported on the adapter: ts-store removed the /ws/read
// endpoint this used to dial (v0.14.x), and live ts-store streaming runs
// through the streaming manager's TSStoreStream (REST backfill + push)
// instead. CanStream stays true in Capabilities — it describes the
// connection type, whose streaming rides that manager path.
func (a *TSStoreAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	return nil, fmt.Errorf("store.tsstore does not support adapter streaming — ts-store live data flows through the streaming manager")
}

// Write is not supported for TSStore adapter
func (a *TSStoreAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("store.tsstore does not support write operations")
}

// toRegistryResultSet converts TSStore objects to registry.ResultSet
func (a *TSStoreAdapter) toRegistryResultSet(ctx context.Context, objects []dataResponse) (*registry.ResultSet, error) {
	if len(objects) == 0 {
		return &registry.ResultSet{
			Columns:  []string{"timestamp"},
			Rows:     make([][]interface{}, 0),
			Metadata: map[string]interface{}{"row_count": 0},
		}, nil
	}

	metadata := map[string]interface{}{
		"store_name":  a.store,
		"source_type": "tsstore",
		"data_type":   string(a.dataType),
	}

	if a.dataType == models.TSStoreDataTypeSchema {
		schema, err := a.fetchSchemaInternal(ctx)
		if err == nil && schema != nil {
			schemaFields := make([]map[string]interface{}, len(schema.Fields))
			for i, f := range schema.Fields {
				schemaFields[i] = map[string]interface{}{
					"index": f.Index,
					"name":  f.Name,
					"type":  f.Type,
				}
			}
			metadata["schema"] = map[string]interface{}{
				"version": schema.Version,
				"fields":  schemaFields,
			}
		}
	}

	if a.dataType == models.TSStoreDataTypeText {
		return a.textToRegistryResultSet(objects, metadata)
	}

	return a.jsonToRegistryResultSet(objects, metadata)
}

// textToRegistryResultSet converts text objects to ResultSet
func (a *TSStoreAdapter) textToRegistryResultSet(objects []dataResponse, metadata map[string]interface{}) (*registry.ResultSet, error) {
	columns := []string{"timestamp", "data"}
	rows := make([][]interface{}, 0, len(objects))

	for _, obj := range objects {
		timestamp := obj.Timestamp / 1e9
		var text string
		if err := json.Unmarshal(obj.Data, &text); err != nil {
			text = string(obj.Data)
		}
		rows = append(rows, []interface{}{timestamp, text})
	}

	metadata["row_count"] = len(rows)
	return &registry.ResultSet{Columns: columns, Rows: rows, Metadata: metadata}, nil
}

// jsonToRegistryResultSet converts JSON objects to ResultSet.
//
// For SCHEMA stores the read uses compact format, so each record's JSON keys
// are field INDICES as strings ("1","2",…), not names. We remap those to the
// schema's field names and fix the column order to the schema's index order
// (#137) — without this, columns surface as numeric indices in Go's
// nondeterministic map-iteration order and a chart can't bind a named y-axis.
func (a *TSStoreAdapter) jsonToRegistryResultSet(objects []dataResponse, metadata map[string]interface{}) (*registry.ResultSet, error) {
	// Build index-string → name map for schema stores. Empty for json/text.
	indexToName := map[string]string{}
	if a.dataType == models.TSStoreDataTypeSchema && a.schema != nil {
		for _, f := range a.schema.Fields {
			indexToName[strconv.Itoa(f.Index)] = f.Name
		}
	}
	renameKey := func(key string) string {
		if name, ok := indexToName[key]; ok {
			return name
		}
		return key
	}

	columnSet := make(map[string]bool)
	columnOrder := []string{"timestamp"}
	columnSet["timestamp"] = true
	// Seed the column order from the schema (index order) so named columns
	// appear deterministically left-to-right, not in map-iteration order.
	if len(indexToName) > 0 {
		for _, f := range a.schema.Fields {
			if f.Name == "timestamp" {
				continue // already first
			}
			if !columnSet[f.Name] {
				columnSet[f.Name] = true
				columnOrder = append(columnOrder, f.Name)
			}
		}
	}

	decodedObjects := make([]map[string]interface{}, 0, len(objects))

	// Remap a record's compact index keys to field names (no-op when not a
	// schema store). Returns a fresh map so we don't mutate while iterating.
	normalize := func(record map[string]interface{}) map[string]interface{} {
		if len(indexToName) == 0 {
			return record
		}
		out := make(map[string]interface{}, len(record))
		for k, v := range record {
			out[renameKey(k)] = v
		}
		return out
	}

	for _, obj := range objects {
		timestamp := obj.Timestamp / 1e9

		var records []map[string]interface{}
		if err := json.Unmarshal(obj.Data, &records); err == nil {
			for _, record := range records {
				record = normalize(record)
				record["timestamp"] = timestamp
				for key := range record {
					if !columnSet[key] {
						columnSet[key] = true
						columnOrder = append(columnOrder, key)
					}
				}
				decodedObjects = append(decodedObjects, record)
			}
		} else {
			var record map[string]interface{}
			if err := json.Unmarshal(obj.Data, &record); err != nil {
				record = map[string]interface{}{"data": string(obj.Data)}
			}
			record = normalize(record)
			record["timestamp"] = timestamp
			for key := range record {
				if !columnSet[key] {
					columnSet[key] = true
					columnOrder = append(columnOrder, key)
				}
			}
			decodedObjects = append(decodedObjects, record)
		}
	}

	rows := make([][]interface{}, 0, len(decodedObjects))
	for _, record := range decodedObjects {
		row := make([]interface{}, len(columnOrder))
		for i, col := range columnOrder {
			if val, exists := record[col]; exists {
				row[i] = flattenValue(val)
			} else {
				row[i] = nil
			}
		}
		rows = append(rows, row)
	}

	metadata["row_count"] = len(rows)
	return &registry.ResultSet{Columns: columnOrder, Rows: rows, Metadata: metadata}, nil
}

// fetchSchemaInternal fetches and caches schema
func (a *TSStoreAdapter) fetchSchemaInternal(ctx context.Context) (*tsStoreSchema, error) {
	if a.schema != nil {
		return a.schema, nil
	}

	reqURL := fmt.Sprintf("%s/api/stores/%s/schema", a.config.BaseURL(), a.store)
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	a.addHeaders(req)

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch schema: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore schema error (status %d): %s", resp.StatusCode, string(body))
	}

	var schema tsStoreSchema
	if err := json.NewDecoder(resp.Body).Decode(&schema); err != nil {
		return nil, fmt.Errorf("failed to decode schema: %w", err)
	}

	a.schema = &schema
	return a.schema, nil
}

// addHeaders adds authentication and custom headers
func (a *TSStoreAdapter) addHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if a.config.APIKey != "" {
		req.Header.Set("X-API-Key", a.config.APIKey)
	}
	for k, v := range a.config.Headers {
		req.Header.Set(k, v)
	}
}

// tsstoreRangeRowCap is the row ceiling for a ranged ts-store query. It exists
// only to bound a pathological unbucketed pull; for any real window the step
// clamp (tsstoreMaxPoints = 5000) keeps the actual row count far below it. A
// ranged query must NOT inherit the component's streaming buffer limit (default
// 1000) — that would truncate a wide window to its most-recent N rows.
const tsstoreRangeRowCap = 100000

// setStepParam applies a downsampling step to a ts-store data request.
//
// ts-store's `step` is a shorthand for `agg_window` that additionally implies
// agg_default=avg (Prometheus-style downsampling: numeric fields are averaged
// per bucket rather than agg_window's plain "last"). Empty step → no-op, and
// ts-store returns raw records.
//
// ts-store REJECTS a request carrying BOTH step and agg_window ("set either
// step or agg_window, not both", HTTP 400), so this must never be combined with
// an agg_window param on the same request. Nothing sets agg_window on this path
// today; this guard exists so that stays true.
func setStepParam(params url.Values, step string) {
	if strings.TrimSpace(step) == "" {
		return
	}
	if params.Get("agg_window") != "" {
		// Defensive: ts-store would 400. Prefer the explicit agg_window.
		return
	}
	params.Set("step", step)
}

// setGroupByParam applies a per-series group_by (ts-store v0.18.0) to a data
// request. group_by partitions step/agg_window downsampling so each series
// (identified by the named field, e.g. `container`) downsamples independently
// instead of being blended into one value per time bucket. It ONLY has an
// effect alongside an aggregation window, so it is applied only when the
// request already carries a step or agg_window — sending it on a raw
// (unaggregated) pull would be a no-op at best. Empty group field → no-op.
func setGroupByParam(params url.Values, groupBy string) {
	if strings.TrimSpace(groupBy) == "" {
		return
	}
	if params.Get("step") == "" && params.Get("agg_window") == "" {
		// group_by only modifies aggregation; without a window it does nothing.
		return
	}
	params.Set("group_by", groupBy)
}

// setLatestByParam applies a newest-per-group lookup (ts-store v0.19.0
// latest_by) to a /data/newest request: the single newest record for each
// distinct value of the named field ("current state per series"). ts-store
// REJECTS latest_by combined with step/agg_window (HTTP 400) — the Query
// dispatch guarantees the conflict can't arise by suppressing step/group_by
// whenever latest_by is set; the guard here is defensive backstop only.
// Empty field → no-op.
func setLatestByParam(params url.Values, latestBy string) {
	if strings.TrimSpace(latestBy) == "" {
		return
	}
	if params.Get("step") != "" || params.Get("agg_window") != "" {
		// Defensive: ts-store would 400 on the combination.
		return
	}
	params.Set("latest_by", latestBy)
}

// fetchNewest retrieves newest objects. step (optional) downsamples server-side
// — see setStepParam. latestBy (optional) switches to a newest-per-group
// lookup — see setLatestByParam. limit <= 0 omits the param so ts-store
// applies its own default (10 records; up to 1000 groups under latest_by).
func (a *TSStoreAdapter) fetchNewest(ctx context.Context, limit int, since string, filter string, filterIgnoreCase bool, step string, groupBy string, latestBy string) ([]dataResponse, error) {
	params := url.Values{}
	if limit > 0 {
		params.Set("limit", strconv.Itoa(limit))
	}
	if since != "" {
		params.Set("since", since)
	}
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if a.dataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}
	setStepParam(params, step)
	setGroupByParam(params, groupBy)
	setLatestByParam(params, latestBy)

	endpoint := fmt.Sprintf("/api/stores/%s/data/newest?%s", a.store, params.Encode())
	return a.fetchList(ctx, endpoint)
}

// fetchOldest retrieves oldest objects
func (a *TSStoreAdapter) fetchOldest(ctx context.Context, limit int, filter string, filterIgnoreCase bool) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if a.dataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/oldest?%s", a.store, params.Encode())
	return a.fetchList(ctx, endpoint)
}

// fetchRange retrieves objects in time range. Callers pass start/end as
// epoch SECONDS (the single user-facing convention shared with since: and
// the range: DSL); the ts-store /data/range endpoint expects epoch
// NANOSECONDS, so we convert here — the one dialect-specific conversion
// point, per "one user convention, backend converts as needed". (Sending
// seconds verbatim silently returned zero rows.)
// step (optional) downsamples server-side — see setStepParam.
func (a *TSStoreAdapter) fetchRange(ctx context.Context, startTime, endTime int64, limit int, filter string, filterIgnoreCase bool, step string, groupBy string) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("start_time", strconv.FormatInt(toEpochNanos(startTime), 10))
	params.Set("end_time", strconv.FormatInt(toEpochNanos(endTime), 10))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("include_data", "true")
	setStepParam(params, step)
	setGroupByParam(params, groupBy)
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if a.dataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/range?%s", a.store, params.Encode())
	return a.fetchList(ctx, endpoint)
}

// toEpochNanos normalizes a caller-supplied epoch to NANOSECONDS for the
// ts-store /data/range endpoint. Callers pass seconds by convention, but
// the function is tolerant of values already in larger units so a literal
// ns value typed into the range: DSL isn't double-scaled. Heuristic by
// digit magnitude (all comfortably distinct for any realistic recent date):
//
//	seconds      ~1.7e9   (10 digits) → ×1e9
//	milliseconds ~1.7e12  (13 digits) → ×1e6
//	microseconds ~1.7e15  (16 digits) → ×1e3
//	nanoseconds  ~1.7e18  (19 digits) → as-is
func toEpochNanos(v int64) int64 {
	if v <= 0 {
		return v
	}
	switch {
	case v < 1e11: // seconds
		return v * 1_000_000_000
	case v < 1e14: // milliseconds
		return v * 1_000_000
	case v < 1e17: // microseconds
		return v * 1_000
	default: // already nanoseconds
		return v
	}
}

// fetchList makes request to list endpoint
func (a *TSStoreAdapter) fetchList(ctx context.Context, endpoint string) ([]dataResponse, error) {
	reqURL := a.config.BaseURL() + endpoint

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	a.addHeaders(req)

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch data: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore API error (status %d): %s", resp.StatusCode, string(body))
	}

	var listResp dataListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return listResp.Objects, nil
}

// TSStoreDataSource implements the DataSource interface for TSStore timeseries databases.
// TSStore stores objects at timestamps with support for json, schema (compact json), and text data types.
// Uses the unified /data/* endpoints.
type TSStoreDataSource struct {
	config     *models.TSStoreConfig
	httpClient *http.Client
	schema     *tsStoreSchema // Cached schema for schema-type stores
	// store/dataType are the EFFECTIVE store + data type for the current
	// query: seeded from the config (the pin) at construction, re-resolved
	// per query on endpoint-scoped connections. See TSStoreAdapter.
	store    string
	dataType models.TSStoreDataType
}

// tsStoreSchema represents the schema for a schema-type store
type tsStoreSchema struct {
	Version int                  `json:"version"`
	Fields  []tsStoreSchemaField `json:"fields"`
}

// tsStoreSchemaField represents a field in the schema
type tsStoreSchemaField struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Type  string `json:"type"`
}

// dataResponse represents a single data object from TSStore
type dataResponse struct {
	Timestamp int64           `json:"timestamp"`
	BlockNum  uint32          `json:"block_num"`
	Size      uint32          `json:"size"`
	Data      json.RawMessage `json:"data"`
}

// dataListResponse represents a list response from TSStore
type dataListResponse struct {
	Objects []dataResponse `json:"objects"`
	Count   int            `json:"count"`
}

// storeStatsResponse represents the stats response from TSStore
type storeStatsResponse struct {
	Name         string `json:"name"`
	DataType     string `json:"data_type"`
	NumBlocks    uint32 `json:"num_blocks"`
	ActiveBlocks uint32 `json:"active_blocks"`
	HeadBlock    uint32 `json:"head_block"`
	TailBlock    uint32 `json:"tail_block"`
}

// NewTSStoreDataSource creates a new TSStore datasource. Uses
// BuildAPIHTTPClient so the same two-gate TLS skip model applies
// here as on the registry adapter: per-conn flag + server allow.
func NewTSStoreDataSource(config *models.TSStoreConfig) (*TSStoreDataSource, error) {
	if config.InsecureSkipVerify && !IsInsecureTLSAllowed() {
		log.Printf("tsstore datasource %s://%s:%d/%s: insecure_skip_verify is set on this connection but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it",
			config.Protocol, config.Host, config.Port, config.StoreName)
	}

	return &TSStoreDataSource{
		config:     config,
		httpClient: BuildAPIHTTPClient(config.Timeout, config.InsecureSkipVerify),
		store:      config.StoreName,
		dataType:   config.DataType,
	}, nil
}

// Query fetches data from TSStore using the unified /data endpoints.
// Query.Raw can specify:
// - "newest" or empty: fetch the N newest objects (default 10)
// - "oldest": fetch the N oldest objects
// - "since:DURATION": fetch objects from the last duration (e.g., "since:30m", "since:2h", "since:7d")
// - "range:START_TIME:END_TIME": fetch objects in time range (epoch nanoseconds)
// Query.Params can include:
//   - "limit": number of records to fetch
//   - "filter": substring filter
//   - "filter_ignore_case": true/false for case-insensitive filtering
//   - "latest_by": field name — newest record per distinct value ("current
//     state per series"); overrides the raw dispatch, suppresses step/group_by
func (t *TSStoreDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	// Resolve the effective store first: pin wins; endpoint-scoped reads
	// params.store and resolves the store's own data type (#248).
	store, dataType, err := resolveQueryStore(ctx, t.httpClient, t.config, query.Params, t.addHeaders)
	if err != nil {
		return nil, err
	}
	if store != t.store {
		t.schema = nil // schema cache is per store
	}
	t.store, t.dataType = store, dataType

	// Get limit from params, default depends on query type
	var limit int
	hasExplicitLimit := false
	if l, ok := query.Params["limit"].(float64); ok {
		limit = int(l)
		hasExplicitLimit = true
	} else if l, ok := query.Params["limit"].(int); ok {
		limit = l
		hasExplicitLimit = true
	}

	// Get filter params
	filter := resolveFilterParam(query.Params)
	filterIgnoreCase, _ := query.Params["filter_ignore_case"].(bool)
	// group_by (pivot series column, v0.18.0) + raw-DSL step — see the
	// TSStoreAdapter.Query notes; same forwarding on both paths.
	groupBy := resolveGroupByParam(query.Params)
	rawStep := resolveStepParam(query.Params)

	var objects []dataResponse

	// latest_by (ts-store v0.19.0): newest record per distinct value of a
	// field. Overrides the normal dispatch — see the TSStoreAdapter.Query
	// note for the full semantics (newest-only, step/group_by suppressed,
	// relative window → since, absolute range ignored, limit caps groups).
	if latestBy := resolveLatestByParam(query.Params); latestBy != "" {
		since := ""
		if spec, ok := resolveRange(query.Params); ok {
			if tr, valid := tsstoreRangeFromSpec(spec); valid && tr.Relative {
				since = tr.Since
			}
		} else if strings.HasPrefix(query.Raw, "since:") {
			since = query.Raw[len("since:"):]
		}
		if !hasExplicitLimit {
			limit = 0
		}
		objects, err = t.fetchNewest(ctx, limit, since, filter, filterIgnoreCase, "", "", latestBy)
		if err != nil {
			return nil, err
		}
		return t.toResultSet(ctx, objects)
	}

	// Range variable (structured path, auto-apply): the active range takes
	// precedence over the raw newest/since:/range: dispatch. Relative → native
	// since:<token>; absolute → a [from,to] range fetch (epoch seconds). This is
	// the live ts-store path (factory → NewTSStoreDataSource).
	if spec, ok := resolveRange(query.Params); ok {
		if tr, valid := tsstoreRangeFromSpec(spec); valid {
			// The range WINDOW governs the row count; the component's saved
			// limit is the streaming buffer size and would truncate a wide
			// window to the most-recent N. See the TSStoreAdapter.Query note.
			limit = tsstoreRangeRowCap
			if tr.Relative {
				objects, err = t.fetchNewest(ctx, limit, tr.Since, filter, filterIgnoreCase, tr.Step, groupBy, "")
			} else {
				objects, err = t.fetchRange(ctx, tr.FromEpoch, tr.ToEpoch, limit, filter, filterIgnoreCase, tr.Step, groupBy)
			}
			if err != nil {
				return nil, err
			}
			return t.toResultSet(ctx, objects)
		}
	}

	queryType := query.Raw
	if queryType == "" {
		queryType = "newest"
	}

	switch {
	case queryType == "newest":
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = t.fetchNewest(ctx, limit, "", filter, filterIgnoreCase, rawStep, groupBy, "")
	case queryType == "oldest":
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = t.fetchOldest(ctx, limit, filter, filterIgnoreCase)
	case len(queryType) > 6 && queryType[:6] == "since:":
		// Relative time query: "since:30m", "since:2h", "since:7d"
		if !hasExplicitLimit {
			limit = 100000 // High default for time-range queries
		}
		since := queryType[6:]
		objects, err = t.fetchNewest(ctx, limit, since, filter, filterIgnoreCase, rawStep, groupBy, "")
	case len(queryType) > 6 && queryType[:6] == "range:":
		// Absolute time range: "range:START:END"
		if !hasExplicitLimit {
			limit = 100000
		}
		var startTime, endTime int64
		if _, parseErr := fmt.Sscanf(queryType, "range:%d:%d", &startTime, &endTime); parseErr == nil {
			objects, err = t.fetchRange(ctx, startTime, endTime, limit, filter, filterIgnoreCase, rawStep, groupBy)
		} else {
			return nil, fmt.Errorf("invalid range format, expected 'range:START_TIME:END_TIME'")
		}
	default:
		// Default to newest with low limit
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = t.fetchNewest(ctx, limit, "", filter, filterIgnoreCase, rawStep, groupBy, "")
	}

	if err != nil {
		return nil, err
	}

	// Convert objects to ResultSet
	return t.toResultSet(ctx, objects)
}

// fetchNewest retrieves the N newest objects. step (optional) downsamples
// server-side — see setStepParam. latestBy (optional) switches to a
// newest-per-group lookup — see setLatestByParam. limit <= 0 omits the param
// so ts-store applies its own default (10 records; up to 1000 groups under
// latest_by).
func (t *TSStoreDataSource) fetchNewest(ctx context.Context, limit int, since string, filter string, filterIgnoreCase bool, step string, groupBy string, latestBy string) ([]dataResponse, error) {
	params := url.Values{}
	if limit > 0 {
		params.Set("limit", strconv.Itoa(limit))
	}
	if since != "" {
		params.Set("since", since)
	}
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	// For schema stores, request compact format (frontend will expand)
	if t.dataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}
	setStepParam(params, step)
	setGroupByParam(params, groupBy)
	setLatestByParam(params, latestBy)

	endpoint := fmt.Sprintf("/api/stores/%s/data/newest?%s", t.store, params.Encode())
	return t.fetchList(ctx, endpoint)
}

// fetchOldest retrieves the N oldest objects
func (t *TSStoreDataSource) fetchOldest(ctx context.Context, limit int, filter string, filterIgnoreCase bool) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if t.dataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/oldest?%s", t.store, params.Encode())
	return t.fetchList(ctx, endpoint)
}

// fetchRange retrieves objects within a time range. step (optional) downsamples
// server-side — see setStepParam.
func (t *TSStoreDataSource) fetchRange(ctx context.Context, startTime, endTime int64, limit int, filter string, filterIgnoreCase bool, step string, groupBy string) ([]dataResponse, error) {
	params := url.Values{}
	// start/end arrive as epoch seconds; /data/range wants nanoseconds.
	// See the TSStoreAdapter.fetchRange note above.
	params.Set("start_time", strconv.FormatInt(toEpochNanos(startTime), 10))
	params.Set("end_time", strconv.FormatInt(toEpochNanos(endTime), 10))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("include_data", "true")
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if t.dataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}
	setStepParam(params, step)
	setGroupByParam(params, groupBy)

	endpoint := fmt.Sprintf("/api/stores/%s/data/range?%s", t.store, params.Encode())
	return t.fetchList(ctx, endpoint)
}

// fetchList makes a request to a list endpoint and returns the objects
func (t *TSStoreDataSource) fetchList(ctx context.Context, endpoint string) ([]dataResponse, error) {
	reqURL := t.config.BaseURL() + endpoint

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	t.addHeaders(req)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch data: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore API error (status %d): %s", resp.StatusCode, string(body))
	}

	var listResp dataListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return listResp.Objects, nil
}

// fetchSchema retrieves and caches the schema for schema-type stores
func (t *TSStoreDataSource) fetchSchema(ctx context.Context) (*tsStoreSchema, error) {
	if t.schema != nil {
		return t.schema, nil
	}

	reqURL := fmt.Sprintf("%s/api/stores/%s/schema", t.config.BaseURL(), t.store)

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	t.addHeaders(req)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch schema: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore schema error (status %d): %s", resp.StatusCode, string(body))
	}

	var schema tsStoreSchema
	if err := json.NewDecoder(resp.Body).Decode(&schema); err != nil {
		return nil, fmt.Errorf("failed to decode schema: %w", err)
	}

	t.schema = &schema
	return t.schema, nil
}

// GetStoreStats retrieves store statistics including data type
func (t *TSStoreDataSource) GetStoreStats(ctx context.Context) (*storeStatsResponse, error) {
	reqURL := fmt.Sprintf("%s/api/stores/%s/stats", t.config.BaseURL(), t.store)

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	t.addHeaders(req)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch stats: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("store '%s' not found", t.store)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore API error (status %d): %s", resp.StatusCode, string(body))
	}

	var stats storeStatsResponse
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return nil, fmt.Errorf("failed to decode stats: %w", err)
	}

	return &stats, nil
}

// toResultSet converts TSStore objects to a normalized ResultSet
// For schema stores, includes schema in metadata for frontend expansion
func (t *TSStoreDataSource) toResultSet(ctx context.Context, objects []dataResponse) (*models.ResultSet, error) {
	if len(objects) == 0 {
		return &models.ResultSet{
			Columns:  []string{"timestamp"},
			Rows:     make([][]interface{}, 0),
			Metadata: map[string]interface{}{"row_count": 0},
		}, nil
	}

	metadata := map[string]interface{}{
		"store_name":  t.store,
		"source_type": "tsstore",
		"data_type":   string(t.dataType),
	}

	// For schema stores, fetch and include schema for frontend expansion
	if t.dataType == models.TSStoreDataTypeSchema {
		schema, err := t.fetchSchema(ctx)
		if err == nil && schema != nil {
			// Convert schema to format frontend can use
			schemaFields := make([]map[string]interface{}, len(schema.Fields))
			for i, f := range schema.Fields {
				schemaFields[i] = map[string]interface{}{
					"index": f.Index,
					"name":  f.Name,
					"type":  f.Type,
				}
			}
			metadata["schema"] = map[string]interface{}{
				"version": schema.Version,
				"fields":  schemaFields,
			}
		}
	}

	// Handle text data type - simple single column
	if t.dataType == models.TSStoreDataTypeText {
		return t.textToResultSet(objects, metadata)
	}

	// Handle JSON and Schema data types
	return t.jsonToResultSet(objects, metadata)
}

// textToResultSet converts text objects to ResultSet
func (t *TSStoreDataSource) textToResultSet(objects []dataResponse, metadata map[string]interface{}) (*models.ResultSet, error) {
	columns := []string{"timestamp", "data"}
	rows := make([][]interface{}, 0, len(objects))

	for _, obj := range objects {
		timestamp := obj.Timestamp / 1e9 // nanoseconds -> seconds
		// Text data comes as a JSON string
		var text string
		if err := json.Unmarshal(obj.Data, &text); err != nil {
			// If not a JSON string, use raw
			text = string(obj.Data)
		}
		rows = append(rows, []interface{}{timestamp, text})
	}

	metadata["row_count"] = len(rows)
	return &models.ResultSet{
		Columns:  columns,
		Rows:     rows,
		Metadata: metadata,
	}, nil
}

// jsonToResultSet converts JSON/Schema objects to ResultSet.
// For JSON: discovers columns from the data structure.
// For Schema: the read is compact, so record keys are field INDICES as
// strings ("1","2",…). We remap them to the schema's field names and order
// columns by index (#137) — otherwise schema-store columns surface as
// numeric indices in nondeterministic map-iteration order and a chart can't
// bind a named y-axis. (Was previously left for the frontend, which never
// did the expansion.)
func (t *TSStoreDataSource) jsonToResultSet(objects []dataResponse, metadata map[string]interface{}) (*models.ResultSet, error) {
	// Build index-string → name map for schema stores. Empty for json/text.
	indexToName := map[string]string{}
	if t.dataType == models.TSStoreDataTypeSchema && t.schema != nil {
		for _, f := range t.schema.Fields {
			indexToName[strconv.Itoa(f.Index)] = f.Name
		}
	}
	normalize := func(record map[string]interface{}) map[string]interface{} {
		if len(indexToName) == 0 {
			return record
		}
		out := make(map[string]interface{}, len(record))
		for k, v := range record {
			if name, ok := indexToName[k]; ok {
				out[name] = v
			} else {
				out[k] = v
			}
		}
		return out
	}

	// Discover columns from all objects
	columnSet := make(map[string]bool)
	columnOrder := []string{"timestamp"}
	columnSet["timestamp"] = true
	// Seed column order from the schema (index order) so named columns appear
	// deterministically left-to-right, not in map-iteration order.
	if len(indexToName) > 0 {
		for _, f := range t.schema.Fields {
			if f.Name == "timestamp" {
				continue // already first
			}
			if !columnSet[f.Name] {
				columnSet[f.Name] = true
				columnOrder = append(columnOrder, f.Name)
			}
		}
	}

	// First pass: decode all objects and discover columns
	decodedObjects := make([]map[string]interface{}, 0, len(objects))

	for _, obj := range objects {
		timestamp := obj.Timestamp / 1e9 // nanoseconds -> seconds

		// Try to parse as array of records
		var records []map[string]interface{}
		if err := json.Unmarshal(obj.Data, &records); err == nil {
			for _, record := range records {
				record = normalize(record)
				record["timestamp"] = timestamp
				for key := range record {
					if !columnSet[key] {
						columnSet[key] = true
						columnOrder = append(columnOrder, key)
					}
				}
				decodedObjects = append(decodedObjects, record)
			}
		} else {
			// Try as single object
			var record map[string]interface{}
			if err := json.Unmarshal(obj.Data, &record); err != nil {
				record = map[string]interface{}{"data": string(obj.Data)}
			}
			record = normalize(record)
			record["timestamp"] = timestamp
			for key := range record {
				if !columnSet[key] {
					columnSet[key] = true
					columnOrder = append(columnOrder, key)
				}
			}
			decodedObjects = append(decodedObjects, record)
		}
	}

	// Second pass: build rows with consistent column order
	rows := make([][]interface{}, 0, len(decodedObjects))
	for _, record := range decodedObjects {
		row := make([]interface{}, len(columnOrder))
		for i, col := range columnOrder {
			if val, exists := record[col]; exists {
				row[i] = flattenValue(val)
			} else {
				row[i] = nil
			}
		}
		rows = append(rows, row)
	}

	metadata["row_count"] = len(rows)
	return &models.ResultSet{
		Columns:  columnOrder,
		Rows:     rows,
		Metadata: metadata,
	}, nil
}

// addHeaders adds authentication and custom headers to requests
func (t *TSStoreDataSource) addHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")

	if t.config.APIKey != "" {
		req.Header.Set("X-API-Key", t.config.APIKey)
	}

	for k, v := range t.config.Headers {
		req.Header.Set(k, v)
	}
}

// Stream is not supported on the datasource: ts-store removed the /ws/read
// endpoint this used to dial (v0.14.x), and live ts-store streaming runs
// through the streaming manager's TSStoreStream (REST backfill + push)
// instead.
func (t *TSStoreDataSource) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	return nil, fmt.Errorf("tsstore does not support datasource streaming — ts-store live data flows through the streaming manager")
}

// Close closes the TSStore datasource
func (t *TSStoreDataSource) Close() error {
	return nil
}

// TestConnection tests the connection to TSStore so a passing result
// actually means "the dashboard can use this connection end-to-end" — not
// just "the host is reachable."
//
// PINNED connection (store_name set) — two stages:
//
//  1. GetStoreStats — hits /api/stores/:store/stats, which ts-store
//     leaves unauthenticated by design (monitoring/dashboards poll
//     it without a key). Confirms the host is up, the store exists,
//     protocol/host/port/store_name are right, and lets us auto-
//     detect the data type below.
//  2. probeAuth — hits an authenticated READ endpoint
//     (/data/newest?limit=1) to confirm the api_key holds a read grant
//     on this store. Under ts-store's scoped keys (#138) grants are
//     per-store and read/write/manage are independent flags, so a key
//     valid elsewhere can still 403 here — stage 1 alone wouldn't catch
//     it.
//
// ENDPOINT-SCOPED connection (no store_name): a single keyed
// GET /api/stores is connectivity + auth in one call; see the branch
// below.
func (t *TSStoreDataSource) TestConnection(ctx context.Context) error {
	// Endpoint-scoped connection (no pinned store): a single keyed
	// GET /api/stores answers connectivity + auth in one call — the listing
	// requires a valid scoped key and returns only granted stores. An empty
	// listing means the key holds no grants at all (visibility is any-grant
	// as of ts-store v0.20.0-rc.2), which for a dashboard connection is a
	// misconfigured key, not a healthy state.
	if t.config.StoreName == "" {
		stores, err := t.ListStores(ctx)
		if err != nil {
			return err
		}
		if len(stores) == 0 {
			return fmt.Errorf("the API key holds no grants on this ts-store server — no stores are accessible")
		}
		return nil
	}

	stats, err := t.GetStoreStats(ctx)
	if err != nil {
		return err
	}

	// Auto-detect and set data type from store if not configured
	if t.dataType == "" {
		switch stats.DataType {
		case "json":
			t.dataType = models.TSStoreDataTypeJSON
		case "schema":
			t.dataType = models.TSStoreDataTypeSchema
		case "text":
			t.dataType = models.TSStoreDataTypeText
		default:
			t.dataType = models.TSStoreDataTypeJSON
		}
		t.config.DataType = t.dataType
	}

	return t.probeAuth(ctx)
}

// probeAuth hits an authenticated READ endpoint so TestConnection can catch
// a wrong / missing / under-granted api_key at edit time. The probe is
// /data/newest?limit=1 — the cheapest read-classed call, and read is exactly
// what a dashboard connection needs (under ts-store's scoped keys, the old
// /alerts probe became a manage-classed call, which a healthy read-only
// dashboard key would rightly 403). Returns nil on any 2xx; shapes a clear
// error on 401/403 so the user knows the fix is in the key's grants, not the
// network.
func (t *TSStoreDataSource) probeAuth(ctx context.Context) error {
	url := fmt.Sprintf("%s/api/stores/%s/data/newest?limit=1", t.config.BaseURL(), t.store)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	t.addHeaders(req)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("authenticated probe failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		if t.config.APIKey == "" {
			return fmt.Errorf("authentication required: this store expects an API key but none is configured")
		}
		return fmt.Errorf("api_key rejected for store '%s' (HTTP %d): the key has no read grant on this store — check the key's grants on the ts-store host (tsstore key list)", t.store, resp.StatusCode)
	}
	return fmt.Errorf("authenticated probe returned HTTP %d", resp.StatusCode)
}
