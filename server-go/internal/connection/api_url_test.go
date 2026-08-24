// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"errors"
	"testing"
)

// TestResolveAPIURL_AllowedForms covers every shape the query guidance
// documents. These must keep working — the fix is meant to refuse a host
// change, not to narrow the documented interface.
func TestResolveAPIURL_AllowedForms(t *testing.T) {
	tests := []struct {
		name string
		base string
		raw  string
		want string
	}{
		{"empty raw returns base", "https://api.example.com/v1/data", "", "https://api.example.com/v1/data"},
		{"query string appended", "https://api.example.com/v1/data", "?limit=10", "https://api.example.com/v1/data?limit=10"},
		{"query string merged into existing", "https://api.example.com/d?a=1", "?b=2", "https://api.example.com/d?a=1&b=2"},
		{"absolute path appended", "https://api.example.com/v1", "/items?x=1", "https://api.example.com/v1/items?x=1"},
		{"absolute path onto trailing slash", "https://api.example.com/v1/", "/items", "https://api.example.com/v1/items"},
		{"bare segment appended", "https://api.example.com/v1", "items", "https://api.example.com/v1/items"},
		// An absolute URL on the connection's OWN host stays allowed: stored
		// query_configs may legitimately hold one, and refusing it would
		// break working components for no security gain.
		{"absolute URL, same origin", "https://api.example.com/v1", "https://api.example.com/v1/items", "https://api.example.com/v1/items"},
		{"absolute URL, same origin with port", "http://host.internal:8080/a", "http://host.internal:8080/b", "http://host.internal:8080/b"},
		{"absolute URL, host case differs", "https://API.Example.com/v1", "https://api.example.com/v1/x", "https://api.example.com/v1/x"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveAPIURL(tt.base, tt.raw)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("resolveAPIURL(%q, %q) = %q, want %q", tt.base, tt.raw, got, tt.want)
			}
		})
	}
}

// TestResolveAPIURL_RefusesHostChange is the #287 regression test. Each
// case is a way to move the request off the configured host; every one
// must be refused, because the connection's stored credentials are
// attached to whatever URL this function returns.
func TestResolveAPIURL_RefusesHostChange(t *testing.T) {
	const base = "https://api.example.com/v1/data"

	tests := []struct {
		name string
		raw  string
	}{
		{"different host entirely", "https://evil.example.net/steal"},
		{"attacker host on http", "http://127.0.0.1:19099/stolen"},
		{"cloud metadata endpoint", "http://169.254.169.254/latest/meta-data/"},
		{"loopback", "http://localhost:8080/admin"},
		{"scheme downgrade to plaintext", "http://api.example.com/v1/data"},
		{"same name, different port", "https://api.example.com:8443/v1/data"},
		// Case is not a bypass: hasHTTPScheme folds case, so this is
		// recognised as absolute and origin-checked rather than falling
		// through to the path-segment branch.
		{"uppercase scheme", "HTTP://evil.example.net/steal"},
		{"mixed case scheme", "HtTpS://evil.example.net/steal"},
		// Userinfo must not be read as the host. "evil.net" is the real
		// destination here even though the configured host appears first.
		{"userinfo disguising the host", "https://api.example.com@evil.example.net/steal"},
		// A subdomain is a different host, not a child of the configured one.
		{"subdomain of configured host", "https://evil.api.example.com/steal"},
		{"configured host as a prefix of another", "https://api.example.com.evil.net/steal"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveAPIURL(base, tt.raw)
			if !errors.Is(err, ErrHostOverride) {
				t.Fatalf("resolveAPIURL(%q, %q) = (%q, %v); want ErrHostOverride", base, tt.raw, got, err)
			}
			if got != "" {
				t.Errorf("expected empty URL on refusal, got %q", got)
			}
		})
	}
}

// TestResolveAPIURL_RefusesUnparseableBase asserts the failure direction:
// a connection whose own URL will not parse cannot vouch for a candidate,
// so an absolute raw value is refused rather than allowed through.
func TestResolveAPIURL_RefusesUnparseableBase(t *testing.T) {
	_, err := resolveAPIURL("://not-a-url", "https://evil.example.net/steal")
	if !errors.Is(err, ErrHostOverride) {
		t.Fatalf("unparseable base should refuse an absolute override, got %v", err)
	}
}

// TestResolveAPIURL_ErrorNamesNoHost keeps the refusal from becoming a
// disclosure: this path is reachable by an unprivileged caller, so the
// message must not echo the configured host back to them.
func TestResolveAPIURL_ErrorNamesNoHost(t *testing.T) {
	_, err := resolveAPIURL("https://internal-secret-host.corp/v1", "https://evil.example.net/x")
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if got := err.Error(); got != ErrHostOverride.Error() {
		t.Errorf("error message = %q; must not vary with the configured host", got)
	}
}
