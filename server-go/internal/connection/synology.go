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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	registry.Register(
		"api.synology",
		"Synology DSM",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true},
		synologyConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newSynologyAdapterFromConfig(config)
		},
	)
}

// synologyConfigSchema returns configuration fields for the Synology DSM adapter.
//
// NOTE: there is deliberately NO "session" field. DSM's SYNO.API.Auth `session`
// parameter is NOT a free-text label — DSM 7 validates it against known
// application names and returns error 402 for anything it doesn't recognize,
// which reads exactly like a permission failure. Logging in with `format=sid`
// and no `session` works and returns a usable SID.
func synologyConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "url", Type: "string", Required: true, Description: "DSM base URL including port (e.g. https://nas.example:5001)"},
		{Name: "username", Type: "string", Required: true, Description: "DSM account. SYNO.Core.* system reads require a group with administrator privilege; a plain user gets error 105."},
		{Name: "password", Type: "password", Required: true, Description: "DSM password"},
		{Name: "timeout", Type: "int", Required: false, Default: 30, Description: "Request timeout (seconds)"},
		{Name: "insecure_skip_verify", Type: "bool", Required: false, Default: false, Description: "Skip TLS certificate verification. DSM ships a self-signed certificate, so this is usually required unless the cert is trusted. Server must also have api.allow_insecure_tls enabled."},
	}
}

// SynologyConfig holds the resolved connection settings.
type SynologyConfig struct {
	URL                string
	Username           string
	Password           string
	Timeout            int
	InsecureSkipVerify bool
}

// SynologyAdapter implements registry.Adapter for Synology DSM.
//
// Session handling: DSM issues a session id (SID) on login which expires on an
// unpublished schedule (and on DSM reboot, package update, or password change).
// Rather than predict expiry we react to it — a call that fails with a session
// error triggers exactly one re-login + retry. The SID is runtime state and is
// never persisted; on server restart the adapter simply logs in again.
type SynologyAdapter struct {
	config *SynologyConfig
	client *http.Client

	mu  sync.Mutex // guards sid; serializes re-login so concurrent polls don't stampede
	sid string
}

func newSynologyAdapterFromConfig(config map[string]interface{}) (*SynologyAdapter, error) {
	cfg := &SynologyConfig{}

	if v, ok := config["url"].(string); ok {
		cfg.URL = strings.TrimSuffix(v, "/")
	}
	if v, ok := config["username"].(string); ok {
		cfg.Username = v
	}
	if v, ok := config["password"].(string); ok {
		cfg.Password = v
	}
	if v, ok := config["timeout"].(float64); ok {
		cfg.Timeout = int(v)
	} else if v, ok := config["timeout"].(int); ok {
		cfg.Timeout = v
	}
	if v, ok := config["insecure_skip_verify"].(bool); ok {
		cfg.InsecureSkipVerify = v
	}

	if cfg.URL == "" {
		return nil, fmt.Errorf("synology: url is required")
	}
	if cfg.Username == "" || cfg.Password == "" {
		return nil, fmt.Errorf("synology: username and password are required")
	}

	if cfg.InsecureSkipVerify && !IsInsecureTLSAllowed() {
		log.Printf("synology adapter %s: insecure_skip_verify is set on this connection but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it", cfg.URL)
	}

	return &SynologyAdapter{
		config: cfg,
		client: BuildAPIHTTPClient(cfg.Timeout, cfg.InsecureSkipVerify),
	}, nil
}

func (a *SynologyAdapter) TypeID() string      { return "api.synology" }
func (a *SynologyAdapter) DisplayName() string { return "Synology DSM" }

func (a *SynologyAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true}
}

func (a *SynologyAdapter) ConfigSchema() []registry.ConfigField {
	return synologyConfigSchema()
}

// Connect establishes a session.
func (a *SynologyAdapter) Connect(ctx context.Context) error {
	return a.login(ctx)
}

// TestConnection verifies credentials by logging in and reading system info.
func (a *SynologyAdapter) TestConnection(ctx context.Context) error {
	if err := a.login(ctx); err != nil {
		return err
	}
	_, err := a.call(ctx, "SYNO.Core.System", 1, "info", nil)
	return err
}

// Close logs the session out. Best-effort: a failed logout is not an error the
// caller can act on, and the SID expires on its own regardless.
func (a *SynologyAdapter) Close() error {
	a.mu.Lock()
	sid := a.sid
	a.sid = ""
	a.mu.Unlock()

	if sid == "" {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	form := url.Values{}
	form.Set("api", "SYNO.API.Auth")
	form.Set("version", "1")
	form.Set("method", "logout")
	form.Set("_sid", sid)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.config.URL+"/webapi/entry.cgi", strings.NewReader(form.Encode()))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := a.client.Do(req)
	if err == nil {
		resp.Body.Close()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// synologyAuthVersion is the SYNO.API.Auth version used for login. DSM 7
// reports maxVersion 7 for this API.
const synologyAuthVersion = 7

// login exchanges username/password for a SID.
//
// The request is a POST with a urlencoded body — NOT a GET. On the GET form the
// password lands in the query string and is therefore written to DSM's access
// log and any proxy log in between.
func (a *SynologyAdapter) login(ctx context.Context) error {
	form := url.Values{}
	form.Set("api", "SYNO.API.Auth")
	form.Set("version", strconv.Itoa(synologyAuthVersion))
	form.Set("method", "login")
	form.Set("account", a.config.Username)
	form.Set("passwd", a.config.Password)
	form.Set("format", "sid")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.config.URL+"/webapi/entry.cgi", strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("synology: build login request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("synology: login request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("synology: read login response: %w", err)
	}

	var parsed struct {
		Success bool `json:"success"`
		Data    struct {
			SID string `json:"sid"`
		} `json:"data"`
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("synology: decode login response: %w", err)
	}

	if !parsed.Success {
		code := 0
		if parsed.Error != nil {
			code = parsed.Error.Code
		}
		return fmt.Errorf("synology: login failed: %s", synologyAuthErrorText(code))
	}
	if parsed.Data.SID == "" {
		return fmt.Errorf("synology: login succeeded but returned no session id")
	}

	a.mu.Lock()
	a.sid = parsed.Data.SID
	a.mu.Unlock()
	return nil
}

// synologyAuthErrorText maps SYNO.API.Auth error codes to actionable messages.
// These codes are auth-specific and differ from the generic API codes below —
// notably 402 here is NOT "OTP required" (that is 403); 402 is what DSM returns
// when the login is otherwise valid but refused, including when an unrecognized
// `session` value is supplied.
func synologyAuthErrorText(code int) string {
	switch code {
	case 400:
		return "invalid credentials (code 400)"
	case 401:
		return "account disabled (code 401)"
	case 402:
		return "permission denied (code 402) — the account exists and the password is correct, but DSM refused the login"
	case 403:
		return "two-factor authentication code required (code 403) — unattended logins need an account without 2FA, or a trusted-device token"
	case 404:
		return "two-factor authentication code was incorrect (code 404)"
	case 407:
		return "IP address is blocked by DSM auto-block (code 407)"
	default:
		return fmt.Sprintf("code %d", code)
	}
}

// isSynologySessionError reports whether a DSM error code means "your SID is no
// longer good" — the only class of failure worth a transparent re-login.
// 105 (insufficient permission) is deliberately NOT included: it is a privilege
// problem that re-logging in cannot fix, and retrying it would double every
// request against a misconfigured account.
func isSynologySessionError(code int) bool {
	switch code {
	case 106, 107, 119:
		// 106 session timeout, 107 session interrupted by duplicate login,
		// 119 SID not found / invalid.
		return true
	default:
		return false
	}
}

// synologyAPIErrorText maps the generic DSM API error codes.
func synologyAPIErrorText(code int) string {
	switch code {
	case 102:
		return "no such API (code 102) — check the API name"
	case 103:
		return "no such method (code 103) — check the method name and API version"
	case 104:
		return "this API version is not supported (code 104)"
	case 105:
		return "insufficient permission (code 105) — SYNO.Core.* system reads require an account with administrator privilege"
	case 106:
		return "session timeout (code 106)"
	case 107:
		return "session interrupted by duplicate login (code 107)"
	case 119:
		return "invalid session id (code 119)"
	default:
		return fmt.Sprintf("code %d", code)
	}
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type synologyResponse struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   *struct {
		Code int `json:"code"`
	} `json:"error"`
}

// call issues one entry.cgi request with the current SID, logging in first if
// there isn't one. It does NOT retry — Query owns the retry decision.
func (a *SynologyAdapter) call(ctx context.Context, api string, version int, method string, extra map[string]string) (json.RawMessage, error) {
	a.mu.Lock()
	sid := a.sid
	a.mu.Unlock()

	if sid == "" {
		if err := a.login(ctx); err != nil {
			return nil, err
		}
		a.mu.Lock()
		sid = a.sid
		a.mu.Unlock()
	}

	q := url.Values{}
	q.Set("api", api)
	q.Set("version", strconv.Itoa(version))
	q.Set("method", method)
	q.Set("_sid", sid)
	for k, v := range extra {
		q.Set(k, v)
	}

	endpoint := a.config.URL + "/webapi/entry.cgi?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("synology: build request: %w", err)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("synology: request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("synology: read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("synology: %s returned HTTP %d", api, resp.StatusCode)
	}

	var parsed synologyResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("synology: decode %s response: %w", api, err)
	}
	if !parsed.Success {
		code := 0
		if parsed.Error != nil {
			code = parsed.Error.Code
		}
		return nil, &synologyError{Code: code, API: api}
	}
	return parsed.Data, nil
}

// synologyError carries the DSM error code so the retry path can inspect it.
type synologyError struct {
	Code int
	API  string
}

func (e *synologyError) Error() string {
	return fmt.Sprintf("synology: %s failed: %s", e.API, synologyAPIErrorText(e.Code))
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

// Query executes a DSM API call and normalizes the response into a ResultSet.
//
//	Raw    — the DSM API name, e.g. "SYNO.Core.System.Utilization"
//	Params — method       (string, default "get")
//	         version      (int,    default 1)
//	         result_path  (string, dot path into `data`; empty = whole object)
//	         additional   (string, passed through verbatim — several DSM APIs
//	                       return null status fields unless asked, notably
//	                       SYNO.Core.Package which needs additional=["status"])
//
// Shape rule: if result_path resolves to an ARRAY, each element becomes a row
// (tall). If it resolves to an OBJECT, the object becomes a single row with
// dot-joined column names (wide). Nested objects inside a tall row's elements
// are flattened the same way.
func (a *SynologyAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	api := strings.TrimSpace(query.Raw)
	if api == "" {
		return nil, fmt.Errorf("synology: query must name a DSM API (e.g. SYNO.Core.System.Utilization)")
	}

	method := "get"
	version := 1
	resultPath := ""
	extra := map[string]string{}

	if query.Params != nil {
		if v, ok := query.Params["method"].(string); ok && v != "" {
			method = v
		}
		switch v := query.Params["version"].(type) {
		case float64:
			version = int(v)
		case int:
			version = v
		case string:
			if n, err := strconv.Atoi(v); err == nil {
				version = n
			}
		}
		if v, ok := query.Params["result_path"].(string); ok {
			resultPath = v
		}
		if v, ok := query.Params["additional"].(string); ok && v != "" {
			extra["additional"] = v
		}
	}

	data, err := a.call(ctx, api, version, method, extra)
	if err != nil {
		var syn *synologyError
		if ok := asSynologyError(err, &syn); ok && isSynologySessionError(syn.Code) {
			// Session died — re-login once and retry exactly once.
			if relogErr := a.login(ctx); relogErr != nil {
				return nil, relogErr
			}
			data, err = a.call(ctx, api, version, method, extra)
		}
		if err != nil {
			return nil, err
		}
	}

	var decoded interface{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, fmt.Errorf("synology: decode %s data: %w", api, err)
	}

	node, err := synologyResolvePath(decoded, resultPath)
	if err != nil {
		return nil, err
	}

	rs := synologyToResultSet(node)
	rs.Metadata = map[string]interface{}{
		"api":         api,
		"method":      method,
		"version":     version,
		"result_path": resultPath,
	}
	return rs, nil
}

// asSynologyError is a tiny errors.As shim kept local to avoid pulling errors
// into the hot path signature.
func asSynologyError(err error, target **synologyError) bool {
	if e, ok := err.(*synologyError); ok {
		*target = e
		return true
	}
	return false
}

// synologyResolvePath walks a dot path into the decoded `data` object.
func synologyResolvePath(root interface{}, path string) (interface{}, error) {
	if strings.TrimSpace(path) == "" {
		return root, nil
	}
	cur := root
	for _, seg := range strings.Split(path, ".") {
		m, ok := cur.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("synology: result_path %q — %q is not an object", path, seg)
		}
		next, exists := m[seg]
		if !exists {
			return nil, fmt.Errorf("synology: result_path %q — no such field %q", path, seg)
		}
		cur = next
	}
	return cur, nil
}

// synologyToResultSet normalizes a JSON node into rows/columns.
func synologyToResultSet(node interface{}) *registry.ResultSet {
	switch v := node.(type) {
	case []interface{}:
		return synologyRowsFromArray(v)
	case map[string]interface{}:
		flat := map[string]interface{}{}
		synologyFlatten(v, "", flat)
		cols := synologySortedKeys(flat)
		row := make([]interface{}, len(cols))
		for i, c := range cols {
			row[i] = flat[c]
		}
		return &registry.ResultSet{Columns: cols, Rows: [][]interface{}{row}}
	default:
		// A scalar at the resolved path — surface it as a 1x1 result.
		return &registry.ResultSet{
			Columns: []string{"value"},
			Rows:    [][]interface{}{{synologyCoerce(node)}},
		}
	}
}

// synologyRowsFromArray turns an array into rows, unioning keys across elements
// so a field missing from one element still gets a column (filled nil).
func synologyRowsFromArray(arr []interface{}) *registry.ResultSet {
	if len(arr) == 0 {
		return &registry.ResultSet{Columns: []string{}, Rows: [][]interface{}{}}
	}

	flats := make([]map[string]interface{}, 0, len(arr))
	colSet := map[string]struct{}{}
	scalarOnly := true

	for _, el := range arr {
		if m, ok := el.(map[string]interface{}); ok {
			scalarOnly = false
			flat := map[string]interface{}{}
			synologyFlatten(m, "", flat)
			flats = append(flats, flat)
			for k := range flat {
				colSet[k] = struct{}{}
			}
			continue
		}
		flats = append(flats, map[string]interface{}{"value": synologyCoerce(el)})
		colSet["value"] = struct{}{}
	}

	cols := make([]string, 0, len(colSet))
	for k := range colSet {
		cols = append(cols, k)
	}
	sort.Strings(cols)
	_ = scalarOnly

	rows := make([][]interface{}, 0, len(flats))
	for _, f := range flats {
		row := make([]interface{}, len(cols))
		for i, c := range cols {
			if val, ok := f[c]; ok {
				row[i] = val
			}
		}
		rows = append(rows, row)
	}
	return &registry.ResultSet{Columns: cols, Rows: rows}
}

// synologyFlatten flattens nested objects into dot-joined keys. Arrays nested
// inside a row are left as-is (JSON-marshaled by the caller's transport) rather
// than exploded — exploding them would multiply rows unpredictably.
func synologyFlatten(m map[string]interface{}, prefix string, out map[string]interface{}) {
	for k, v := range m {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if nested, ok := v.(map[string]interface{}); ok {
			synologyFlatten(nested, key, out)
			continue
		}
		out[key] = synologyCoerce(v)
	}
}

// synologyCoerce converts DSM's string-encoded numbers into float64 so numeric
// components can chart them. DSM returns several genuinely numeric fields as
// strings — notably disk `size_total` ("8001563222016") and `cpu_cores` ("4") —
// and a value tile fed a string renders it as text instead of a number.
//
// Only strings that parse cleanly AND look numeric are converted; anything else
// (model names, status words, DSM version strings) passes through untouched.
func synologyCoerce(v interface{}) interface{} {
	s, ok := v.(string)
	if !ok {
		return v
	}
	if s == "" {
		return v
	}
	// Reject leading zeros ("0187" is a version fragment, not a number) but
	// allow a bare "0".
	if len(s) > 1 && s[0] == '0' && s[1] != '.' {
		return v
	}
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		return n
	}
	return v
}

func synologySortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

// Stream polls Query on an interval. DSM has no push/subscribe surface and no
// server-side history — every read is an instantaneous snapshot — so polling is
// the only option. `interval_seconds` (default 15) controls the cadence.
func (a *SynologyAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	interval := 15 * time.Second
	if query.Params != nil {
		switch v := query.Params["interval_seconds"].(type) {
		case float64:
			if v > 0 {
				interval = time.Duration(v) * time.Second
			}
		case int:
			if v > 0 {
				interval = time.Duration(v) * time.Second
			}
		}
	}

	ch := make(chan registry.Record, 100)

	go func() {
		defer close(ch)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		emit := func() {
			rs, err := a.Query(ctx, query)
			if err != nil {
				log.Printf("synology stream: %v", err)
				return
			}
			for _, row := range rs.Rows {
				rec := registry.Record{}
				for i, col := range rs.Columns {
					if i < len(row) {
						rec[col] = row[i]
					}
				}
				select {
				case ch <- rec:
				case <-ctx.Done():
					return
				}
			}
		}

		emit() // first sample immediately, so a panel isn't blank for a full interval
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				emit()
			}
		}
	}()

	return ch, nil
}

// Write is not supported — this adapter is read-only by design.
func (a *SynologyAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("synology: adapter is read-only; write is not supported")
}
