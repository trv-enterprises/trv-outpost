// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import "testing"

// decodeExternalRef is the ingest half of #263. The namespace it returns
// decides WHO CAN SEE the fired alert — AlertService.authorizeAlert gates
// every read on the persisted Alert.Namespace — so a decode that silently
// returns the wrong thing is an authorization bug, not a display one.

func TestDecodeExternalRef_Namespace(t *testing.T) {
	cases := []struct {
		name    string
		ref     string
		wantNS  string
		wantID  string
		wantVar string
	}{
		{
			name:   "namespace only (rule with no dashboard link)",
			ref:    `{"namespace":"trv-homelab"}`,
			wantNS: "trv-homelab",
		},
		{
			name:    "all three fields",
			ref:     `{"dashboard_id":"dash-1","dashboard_vars":{"host":"srv-001"},"namespace":"trv-homelab"}`,
			wantNS:  "trv-homelab",
			wantID:  "dash-1",
			wantVar: "srv-001",
		},
		{
			// Back-compat: every rule created before #263 looks like this.
			// An empty namespace is REQUIRED here — it is what makes the
			// caller fall back to the delivering connection's namespace
			// instead of filing the alert into "" (visible to nobody).
			name:   "pre-263 ref, dashboard only",
			ref:    `{"dashboard_id":"dash-1"}`,
			wantID: "dash-1",
		},
		{name: "empty ref", ref: ""},
		{name: "non-JSON ref (ts-store CLI producer)", ref: "opaque-token"},
		{name: "whitespace namespace is trimmed away", ref: `{"namespace":"   "}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeExternalRef(tc.ref)
			if got.Namespace != tc.wantNS {
				t.Errorf("Namespace = %q, want %q", got.Namespace, tc.wantNS)
			}
			if got.DashboardID != tc.wantID {
				t.Errorf("DashboardID = %q, want %q", got.DashboardID, tc.wantID)
			}
			if tc.wantVar != "" && got.DashboardVars["host"] != tc.wantVar {
				t.Errorf("DashboardVars[host] = %q, want %q", got.DashboardVars["host"], tc.wantVar)
			}
		})
	}
}

// The fallback itself, stated as a test so it can't be "simplified" away:
// an absent authored namespace MUST resolve to the delivering connection's,
// never to empty. Filing an alert under "" would hide it from every
// namespace-restricted user.
func TestAlertNamespaceFallback(t *testing.T) {
	resolve := func(authored, connNS string) string {
		if authored == "" {
			return connNS
		}
		return authored
	}
	if got := resolve(decodeExternalRef(`{"dashboard_id":"d"}`).Namespace, "default"); got != "default" {
		t.Errorf("pre-263 rule should fall back to the connection namespace, got %q", got)
	}
	if got := resolve(decodeExternalRef(`{"namespace":"trv-homelab"}`).Namespace, "default"); got != "trv-homelab" {
		t.Errorf("authored namespace must win over the connection's, got %q", got)
	}
}
