// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"fmt"
	"net/url"
	"strings"
)

// ErrHostOverride is returned when a query's raw value would send the
// request to a different host than the connection is configured for.
//
// This closes #287: the raw body used to be able to replace the URL
// outright, and the connection's stored credentials were attached AFTER
// that choice — so any caller who could reach the /query endpoint could
// aim a stored credential at a host of their choosing (a confused
// deputy), and reach anything the server could reach (SSRF). Both the
// legacy APIDataSource and the registry APIAdapter had their own copy of
// the logic; resolveAPIURL is now the single implementation.
var ErrHostOverride = fmt.Errorf("api: query may not change the connection's host")

// resolveAPIURL builds the request URL for an api-type connection from
// its configured base and the query's raw value.
//
// Accepted forms — every one the query guidance documents:
//
//	""                 → the base URL unchanged
//	"?a=1"             → query string appended (merged if the base has one)
//	"/path?a=1"        → path appended to the base
//	"path"             → same, treated as a path segment
//	"https://host/..." → allowed ONLY when scheme+host match the base
//
// The last form is what #287 exploited. It is kept rather than removed
// because a stored query_config may legitimately hold an absolute URL
// that points at the connection's own host — rejecting those outright
// would break working components for no security gain. What is refused
// is an absolute URL pointing somewhere ELSE.
//
// Comparison is on scheme+host (host includes the port), case-folded
// because neither is case-sensitive. Everything after the authority —
// path, query — stays entirely the caller's to choose, which is the
// documented interface.
func resolveAPIURL(baseURL, raw string) (string, error) {
	if raw == "" {
		return baseURL, nil
	}

	switch {
	case strings.HasPrefix(raw, "?"):
		// Bare query string — append to the base URL, preserving its path.
		// Merge if the base already has a query string ("base?a=1" + "?b=2").
		if strings.Contains(baseURL, "?") {
			return baseURL + "&" + strings.TrimPrefix(raw, "?"), nil
		}
		return baseURL + raw, nil

	case strings.HasPrefix(raw, "/"):
		return strings.TrimSuffix(baseURL, "/") + raw, nil

	case hasHTTPScheme(raw):
		// Absolute URL. Allowed only if it stays on the configured host.
		if err := sameOrigin(baseURL, raw); err != nil {
			return "", err
		}
		return raw, nil

	default:
		return strings.TrimSuffix(baseURL, "/") + "/" + raw, nil
	}
}

// hasHTTPScheme reports whether raw looks like an absolute http(s) URL.
// Case-insensitive: "HTTP://evil.example" is still an absolute URL, and
// a case-sensitive check would have let it past the origin comparison
// into the "treated as a path segment" branch — which resolves to a
// nonsense URL rather than an attack, but the check should not depend on
// that accident.
func hasHTTPScheme(raw string) bool {
	lower := strings.ToLower(raw)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

// sameOrigin returns nil when candidate has the same scheme and host as
// base. The error names neither host: this runs on a request path that
// an unprivileged caller can reach, and echoing the configured host back
// would turn a refusal into a disclosure.
func sameOrigin(base, candidate string) error {
	b, err := url.Parse(base)
	if err != nil {
		// A connection whose own URL will not parse cannot vouch for
		// anything. Refuse rather than fall through to the permissive
		// branch.
		return ErrHostOverride
	}
	c, err := url.Parse(candidate)
	if err != nil {
		return ErrHostOverride
	}
	if !strings.EqualFold(b.Scheme, c.Scheme) || !strings.EqualFold(b.Host, c.Host) {
		return ErrHostOverride
	}
	return nil
}
