// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection_test

// Live integration test for the /query SQL verb guard. Unlike sqlguard_test.go
// (which unit-tests the classifier in isolation), this drives the REAL running
// API over HTTP — the boundary where a type-confusion bypass actually lived and
// where unit tests can't reach. It codifies the manual breach matrix so the
// guard can't silently regress.
//
// It is SKIP-SAFE: if the dev server isn't reachable on localhost:3001 (or the
// seeded support user / a SQL connection aren't present), it t.Skip()s rather
// than failing — so `go test ./...` / `make test` stay green for anyone who
// hasn't booted the stack. When the stack IS up (the normal dev setup on this
// machine), it runs and gates the release.
//
// Override the base URL with OUTPOST_TEST_BASE_URL if the server runs elsewhere.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

const defaultBaseURL = "http://localhost:3001"

// viewOnlyUserGUID is the seeded "Support" pseudo-user — capabilities
// ["view","control"], i.e. NOT design/manage. This is the exact principal the
// original exploit used: a viewer replaying a rewritten /query request.
const viewOnlyUserGUID = "support-00000000-0000-0000-0000-000000000003"

func baseURL() string {
	if v := os.Getenv("OUTPOST_TEST_BASE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return defaultBaseURL
}

// liveClient is a tiny HTTP helper for the running server.
type liveClient struct {
	base  string
	token string
	http  *http.Client
}

// newLiveClientOrSkip probes /health and mints a view-only token. Skips the
// test (never fails) when the server is unreachable.
func newLiveClientOrSkip(t *testing.T) *liveClient {
	t.Helper()
	base := baseURL()
	hc := &http.Client{Timeout: 8 * time.Second}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/health", nil)
	resp, err := hc.Do(req)
	if err != nil {
		t.Skipf("dev server not reachable at %s (%v) — skipping live verb-guard test", base, err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Skipf("dev server at %s returned %d on /health — skipping", base, resp.StatusCode)
	}

	// Mint a session token for the seeded view-only user via legacy GUID auth.
	sreq, _ := http.NewRequest(http.MethodPost, base+"/api/auth/session", nil)
	sreq.Header.Set("X-User-ID", viewOnlyUserGUID)
	sresp, err := hc.Do(sreq)
	if err != nil {
		t.Skipf("could not mint session token (%v) — skipping", err)
	}
	defer sresp.Body.Close()
	if sresp.StatusCode != http.StatusOK {
		t.Skipf("auth/session returned %d (legacy GUID auth may be disabled) — skipping", sresp.StatusCode)
	}
	var sbody struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(sresp.Body).Decode(&sbody); err != nil || sbody.AccessToken == "" {
		t.Skipf("auth/session response had no access_token — skipping")
	}
	return &liveClient{base: base, token: sbody.AccessToken, http: hc}
}

// firstSQLConnectionID returns the id of any SQL connection, or skips.
func (c *liveClient) firstSQLConnectionID(t *testing.T) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, c.base+"/api/connections?limit=200", nil)
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		t.Skipf("could not list connections (%v) — skipping", err)
	}
	defer resp.Body.Close()
	var body struct {
		Connections []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"connections"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Skipf("could not decode connections list (%v) — skipping", err)
	}
	for _, conn := range body.Connections {
		if conn.Type == "sql" {
			return conn.ID
		}
	}
	t.Skip("no SQL connection present in this deployment — skipping live verb-guard test")
	return ""
}

// queryResult is the relevant slice of QueryResponse.
type queryResult struct {
	Success   bool   `json:"success"`
	ErrorCode string `json:"error_code"`
	Error     string `json:"error"`
	status    int
}

// query posts a raw JSON body to /query and returns the decoded result.
// rawBody is the FULL request body so tests can send malformed/tampered shapes
// (e.g. omit type, set type:"api") — exactly the bypass vectors.
func (c *liveClient) query(t *testing.T, connID, rawBody string) queryResult {
	t.Helper()
	url := fmt.Sprintf("%s/api/connections/%s/query", c.base, connID)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewBufferString(rawBody))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		t.Fatalf("query request failed: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var qr queryResult
	if err := json.Unmarshal(raw, &qr); err != nil {
		t.Fatalf("could not decode query response (%d): %s", resp.StatusCode, string(raw))
	}
	qr.status = resp.StatusCode
	return qr
}

// TestQueryGuard_LiveBreachMatrix replays the manual breach tests against the
// running API as a view-only user. Every write/DDL/tampered request must be
// refused with error_code "write_not_allowed"; legitimate reads must succeed.
func TestQueryGuard_LiveBreachMatrix(t *testing.T) {
	c := newLiveClientOrSkip(t)
	connID := c.firstSQLConnectionID(t)

	// Use a table that does not exist so even an erroneously-permitted write
	// can do no real damage — the guard rejects it before the DB is touched,
	// and if the guard ever regressed the DB would reject the missing table
	// (NOT a write_not_allowed code), which is exactly what these assertions
	// detect.
	const tbl = "outpost_guard_probe_nonexistent"

	t.Run("blocked", func(t *testing.T) {
		blocked := []struct {
			name string
			body string
		}{
			{"drop type=sql", `{"query":{"raw":"DROP TABLE ` + tbl + `","type":"sql"}}`},
			{"delete type=sql", `{"query":{"raw":"DELETE FROM ` + tbl + `","type":"sql"}}`},
			{"insert type=sql", `{"query":{"raw":"INSERT INTO ` + tbl + ` VALUES (1)","type":"sql"}}`},
			{"update type=sql", `{"query":{"raw":"UPDATE ` + tbl + ` SET x=1","type":"sql"}}`},
			// --- type-confusion bypass vectors (the bug found in breach testing) ---
			{"drop type=api (bypass)", `{"query":{"raw":"DROP TABLE ` + tbl + `","type":"api"}}`},
			{"drop type omitted (bypass)", `{"query":{"raw":"DROP TABLE ` + tbl + `"}}`},
			{"drop type=prometheus (bypass)", `{"query":{"raw":"DROP TABLE ` + tbl + `","type":"prometheus"}}`},
			{"drop type=tsstore (bypass)", `{"query":{"raw":"DROP TABLE ` + tbl + `","type":"tsstore"}}`},
			{"drop type bogus (bypass)", `{"query":{"raw":"DROP TABLE ` + tbl + `","type":"sqlx"}}`},
			// --- evasion vectors ---
			{"lowercase drop", `{"query":{"raw":"drop table ` + tbl + `","type":"sql"}}`},
			{"leading comment delete", `{"query":{"raw":"/*x*/ DELETE FROM ` + tbl + `","type":"sql"}}`},
			{"cte hides delete", `{"query":{"raw":"WITH a AS (SELECT 1) DELETE FROM ` + tbl + `","type":"sql"}}`},
			{"stacked select;drop", `{"query":{"raw":"SELECT 1; DROP TABLE ` + tbl + `","type":"sql"}}`},
			{"explain analyze delete", `{"query":{"raw":"EXPLAIN ANALYZE DELETE FROM ` + tbl + `","type":"sql"}}`},
		}
		for _, tc := range blocked {
			t.Run(tc.name, func(t *testing.T) {
				r := c.query(t, connID, tc.body)
				if r.Success {
					t.Fatalf("SECURITY: request succeeded but must be blocked: %s", tc.body)
				}
				if r.ErrorCode != "write_not_allowed" {
					t.Fatalf("SECURITY: expected error_code=write_not_allowed (guard), got code=%q err=%q — the statement may have reached the DB (guard bypassed): %s",
						r.ErrorCode, r.Error, tc.body)
				}
			})
		}
	})

	t.Run("allowed_reads", func(t *testing.T) {
		reads := []struct {
			name string
			body string
		}{
			{"select type=sql", `{"query":{"raw":"SELECT 1","type":"sql"}}`},
			// A read with a tampered type must STILL pass (guard polices verbs,
			// not the client-supplied type) — proves View Mode isn't broken.
			{"select type=api", `{"query":{"raw":"SELECT 1","type":"api"}}`},
		}
		for _, tc := range reads {
			t.Run(tc.name, func(t *testing.T) {
				r := c.query(t, connID, tc.body)
				if !r.Success {
					t.Fatalf("legitimate read was refused (View Mode would break): code=%q err=%q body=%s",
						r.ErrorCode, r.Error, tc.body)
				}
			})
		}
	})
}
