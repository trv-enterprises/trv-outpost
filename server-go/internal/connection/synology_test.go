// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"encoding/json"
	"testing"
)

// Fixtures below are trimmed from real DSM 7.3.2 responses (DS1525+). Identifying
// values (serial number, host) are scrubbed — the SHAPE is what matters here.

const fixtureUtilization = `{
  "cpu": {"15min_load": 111, "1min_load": 107, "5min_load": 115, "device": "System",
          "other_load": 2, "system_load": 0, "user_load": 0},
  "disk": {
    "disk": [
      {"device": "sata1", "display_name": "Drive 2", "read_access": 0, "read_byte": 0,
       "type": "internal", "utilization": 0, "write_access": 2, "write_byte": 24576},
      {"device": "sata2", "display_name": "Drive 3", "read_access": 1, "read_byte": 512,
       "type": "internal", "utilization": 3, "write_access": 1, "write_byte": 4096}
    ],
    "total": {"device": "total", "read_access": 0, "read_byte": 3584,
              "utilization": 0, "write_access": 5, "write_byte": 58880}
  },
  "memory": {"avail_real": 344580, "avail_swap": 1637528, "buffer": 4192,
             "cached": 6883512, "device": "Memory", "memory_size": 8388608,
             "real_usage": 10, "total_real": 8083776, "total_swap": 2097084,
             "swap_usage": 21},
  "network": [
    {"device": "total", "rx": 1024, "tx": 2048},
    {"device": "eth0", "rx": 512, "tx": 1024}
  ],
  "space": {
    "volume": [
      {"device": "md2", "display_name": "volume_1", "read_access": 0, "read_byte": 0,
       "utilization": 0, "write_access": 0, "write_byte": 0}
    ]
  },
  "time": 1785099749
}`

const fixtureStorageDisks = `{
  "disks": [
    {"id": "sata1", "device": "/dev/sata1", "status": "normal", "temp": 41,
     "size_total": "8001563222016", "model": "ST8000VN004-3CP101",
     "smart_status": "normal", "name": "Drive 2"},
    {"id": "sata2", "device": "/dev/sata2", "status": "normal", "temp": 39,
     "size_total": "8001563222016", "model": "ST8000VN004-3CP101",
     "smart_status": "normal", "name": "Drive 3"}
  ]
}`

const fixtureServices = `{
  "service": [
    {"service_id": "ssh-shell", "enable_status": "enabled",
     "display_name_section_key": "firewall:firewall_service_opt_ssh"},
    {"service_id": "nfs-server", "enable_status": "enabled",
     "display_name_section_key": "nfs:nfs_title"},
    {"service_id": "telnetd", "enable_status": "disabled",
     "display_name_section_key": "firewall:firewall_service_opt_telnet"}
  ]
}`

// Package status lives under `additional`, NOT at the top level — the adapter
// must flatten it to additional.status for the column to be usable.
const fixturePackages = `{
  "packages": [
    {"id": "Tailscale", "name": "Tailscale", "version": "1.58.2-700058002",
     "additional": {"status": "running", "install_type": "system"}},
    {"id": "syncthing", "name": "Syncthing", "version": "2.0.16-35",
     "additional": {"status": "running", "install_type": ""}}
  ],
  "total": 2
}`

func decodeFixture(t *testing.T, raw string) interface{} {
	t.Helper()
	var v interface{}
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("fixture decode failed: %v", err)
	}
	return v
}

func colIndex(cols []string, name string) int {
	for i, c := range cols {
		if c == name {
			return i
		}
	}
	return -1
}

// TestSynologyWideShape locks in the "object → single row, dotted columns"
// rule. This is what feeds value tiles and gauges: one row of scalars.
func TestSynologyWideShape(t *testing.T) {
	node, err := synologyResolvePath(decodeFixture(t, fixtureUtilization), "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	rs := synologyToResultSet(node)

	if len(rs.Rows) != 1 {
		t.Fatalf("wide shape must yield exactly 1 row, got %d", len(rs.Rows))
	}
	for _, want := range []string{"cpu.user_load", "memory.real_usage", "memory.total_real", "time"} {
		if colIndex(rs.Columns, want) < 0 {
			t.Errorf("missing flattened column %q; got %v", want, rs.Columns)
		}
	}
	// Nested arrays must NOT explode the row count.
	if got := len(rs.Rows[0]); got != len(rs.Columns) {
		t.Fatalf("row width %d != column count %d", got, len(rs.Columns))
	}
}

// TestSynologyTallShape locks in "array → one row per element".
func TestSynologyTallShape(t *testing.T) {
	cases := []struct {
		name     string
		fixture  string
		path     string
		wantRows int
		wantCol  string
	}{
		{"disk io", fixtureUtilization, "disk.disk", 2, "display_name"},
		{"network", fixtureUtilization, "network", 2, "rx"},
		{"volumes", fixtureUtilization, "space.volume", 1, "utilization"},
		{"storage disks", fixtureStorageDisks, "disks", 2, "temp"},
		{"services", fixtureServices, "service", 3, "service_id"},
		{"packages", fixturePackages, "packages", 2, "additional.status"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			node, err := synologyResolvePath(decodeFixture(t, tc.fixture), tc.path)
			if err != nil {
				t.Fatalf("resolve %q: %v", tc.path, err)
			}
			rs := synologyToResultSet(node)
			if len(rs.Rows) != tc.wantRows {
				t.Fatalf("path %q: got %d rows, want %d", tc.path, len(rs.Rows), tc.wantRows)
			}
			if colIndex(rs.Columns, tc.wantCol) < 0 {
				t.Fatalf("path %q: missing column %q; got %v", tc.path, tc.wantCol, rs.Columns)
			}
			for i, row := range rs.Rows {
				if len(row) != len(rs.Columns) {
					t.Fatalf("row %d width %d != column count %d", i, len(row), len(rs.Columns))
				}
			}
		})
	}
}

// TestSynologyPackageStatusFlattens is the regression guard for the trap that
// cost real debugging time: SYNO.Core.Package returns status nested under
// `additional`, so a naive top-level read yields null for every package. The
// caller must also pass additional=["status",...] or DSM omits the field
// entirely — this test covers the flattening half.
func TestSynologyPackageStatusFlattens(t *testing.T) {
	node, err := synologyResolvePath(decodeFixture(t, fixturePackages), "packages")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	rs := synologyToResultSet(node)

	idx := colIndex(rs.Columns, "additional.status")
	if idx < 0 {
		t.Fatalf("additional.status column missing; got %v", rs.Columns)
	}
	for i, row := range rs.Rows {
		if row[idx] != "running" {
			t.Errorf("row %d: additional.status = %v, want \"running\"", i, row[idx])
		}
	}
}

// TestSynologyCoerce covers the string-number conversion. DSM returns
// size_total as a STRING; a value tile fed a string renders it as text, so the
// adapter converts cleanly-numeric strings to float64 — and leaves everything
// else (model names, statuses, version strings) alone.
func TestSynologyCoerce(t *testing.T) {
	cases := []struct {
		name string
		in   interface{}
		want interface{}
	}{
		{"size string", "8001563222016", float64(8001563222016)},
		{"cores string", "4", float64(4)},
		{"zero", "0", float64(0)},
		{"negative", "-5", float64(-5)},
		{"decimal", "1.5", 1.5},
		{"model name", "ST8000VN004-3CP101", "ST8000VN004-3CP101"},
		{"status word", "running", "running"},
		{"dsm version", "DSM 7.3.2-86009 Update 4", "DSM 7.3.2-86009 Update 4"},
		{"leading zero stays text", "0187", "0187"},
		{"empty stays empty", "", ""},
		{"already number", float64(41), float64(41)},
		{"bool untouched", true, true},
		{"nil untouched", nil, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := synologyCoerce(tc.in)
			if got != tc.want {
				t.Fatalf("synologyCoerce(%#v) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}
}

// TestSynologySizeTotalIsNumeric ties the coercion to the real payload: the
// storage disks table must expose size_total as a number, not a string.
func TestSynologySizeTotalIsNumeric(t *testing.T) {
	node, _ := synologyResolvePath(decodeFixture(t, fixtureStorageDisks), "disks")
	rs := synologyToResultSet(node)
	idx := colIndex(rs.Columns, "size_total")
	if idx < 0 {
		t.Fatalf("size_total column missing; got %v", rs.Columns)
	}
	if _, ok := rs.Rows[0][idx].(float64); !ok {
		t.Fatalf("size_total = %#v (%T), want float64", rs.Rows[0][idx], rs.Rows[0][idx])
	}
}

// TestSynologyResolvePathErrors ensures a bad result_path fails loudly with an
// actionable message rather than silently returning an empty chart.
func TestSynologyResolvePathErrors(t *testing.T) {
	root := decodeFixture(t, fixtureUtilization)

	if _, err := synologyResolvePath(root, "nope"); err == nil {
		t.Error("expected error for missing field")
	}
	if _, err := synologyResolvePath(root, "time.deeper"); err == nil {
		t.Error("expected error for descending into a scalar")
	}
	if got, err := synologyResolvePath(root, ""); err != nil || got == nil {
		t.Errorf("empty path must return the root object, got %v (err %v)", got, err)
	}
}

// TestSynologyUnionsKeysAcrossRows guards the ragged-array case: if one element
// lacks a field the others have, the column still exists and that cell is nil
// (rather than the row being short and shifting every later column).
func TestSynologyUnionsKeysAcrossRows(t *testing.T) {
	raw := `[{"a": 1, "b": 2}, {"a": 3}, {"a": 4, "c": 5}]`
	var arr interface{}
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		t.Fatal(err)
	}
	rs := synologyToResultSet(arr)

	if len(rs.Columns) != 3 {
		t.Fatalf("want 3 unioned columns, got %v", rs.Columns)
	}
	for i, row := range rs.Rows {
		if len(row) != len(rs.Columns) {
			t.Fatalf("row %d ragged: %d cells vs %d columns", i, len(row), len(rs.Columns))
		}
	}
	bIdx := colIndex(rs.Columns, "b")
	if rs.Rows[1][bIdx] != nil {
		t.Errorf("missing field should be nil, got %#v", rs.Rows[1][bIdx])
	}
}

// TestSynologyEmptyArray — DSM returns empty arrays for absent hardware (lun,
// smb_cmd). These must produce zero rows, not a spurious one.
func TestSynologyEmptyArray(t *testing.T) {
	var arr interface{}
	if err := json.Unmarshal([]byte(`[]`), &arr); err != nil {
		t.Fatal(err)
	}
	rs := synologyToResultSet(arr)
	if len(rs.Rows) != 0 {
		t.Fatalf("empty array must yield 0 rows, got %d", len(rs.Rows))
	}
}

// TestSynologySessionErrorClassification is the retry contract. 106/107/119 mean
// the SID is stale and a re-login will fix it. 105 is a PRIVILEGE failure that
// re-login cannot fix — retrying it would double every request against a
// misconfigured account, so it must not be treated as a session error.
func TestSynologySessionErrorClassification(t *testing.T) {
	for _, code := range []int{106, 107, 119} {
		if !isSynologySessionError(code) {
			t.Errorf("code %d should be a session error (re-login + retry)", code)
		}
	}
	for _, code := range []int{100, 102, 103, 104, 105, 400, 402} {
		if isSynologySessionError(code) {
			t.Errorf("code %d must NOT trigger a re-login retry", code)
		}
	}
}

// TestSynologyAuthErrorText pins the codes that cost real debugging time:
// 402 is NOT "OTP required" (403 is). 402 is what DSM returns when the
// credentials are valid but the login is refused — including when an
// unrecognized `session` parameter is sent.
func TestSynologyAuthErrorText(t *testing.T) {
	if got := synologyAuthErrorText(400); got == "" || !contains(got, "credential") {
		t.Errorf("400 should mention credentials, got %q", got)
	}
	if got := synologyAuthErrorText(403); !contains(got, "two-factor") {
		t.Errorf("403 is the 2FA code, got %q", got)
	}
	if got := synologyAuthErrorText(402); contains(got, "two-factor") {
		t.Errorf("402 must NOT be described as 2FA, got %q", got)
	}
}

// TestSynologyConfigSchemaHasNoSessionField guards the 402 trap at the schema
// level: DSM validates `session` against known application names, so exposing
// it as a free-text field would let an author configure a connection that
// cannot log in.
func TestSynologyConfigSchemaHasNoSessionField(t *testing.T) {
	for _, f := range synologyConfigSchema() {
		if f.Name == "session" || f.Name == "session_name" {
			t.Fatalf("config schema must not expose a %q field — DSM rejects unknown session names with error 402", f.Name)
		}
	}
	required := map[string]bool{"url": false, "username": false, "password": false}
	for _, f := range synologyConfigSchema() {
		if _, ok := required[f.Name]; ok {
			required[f.Name] = f.Required
		}
	}
	for name, isRequired := range required {
		if !isRequired {
			t.Errorf("field %q must be required", name)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
