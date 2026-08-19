// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"errors"
	"testing"
)

// The alert-rule path had no test coverage at all before #242. These
// cover the two pieces that decide what actually reaches ts-store:
// which fields land in the request body, and which requests we refuse
// before sending. Both are shared by CreateAlert and UpdateAlert, so a
// regression here would silently corrupt every rule write.

func TestCommonAlertBody_ConditionRule(t *testing.T) {
	body := commonAlertBody(&CreateAlertRequest{
		Type:      "webhook",
		RuleName:  "cpu hot",
		Condition: "temp.c > 80",
	})

	if got := body["condition"]; got != "temp.c > 80" {
		t.Errorf("condition = %v, want the expression", got)
	}
	// rule_type is deliberately omitted for condition rules so the
	// bodies we send stay byte-identical to pre-#134 ones.
	if _, present := body["rule_type"]; present {
		t.Errorf("rule_type should be omitted for a condition rule, got %v", body["rule_type"])
	}
	if _, present := body["max_age"]; present {
		t.Errorf("max_age must never be sent for a condition rule, got %v", body["max_age"])
	}
}

func TestCommonAlertBody_StalenessRule(t *testing.T) {
	body := commonAlertBody(&CreateAlertRequest{
		Type:     "webhook",
		RuleName: "collector went quiet",
		RuleType: RuleTypeStaleness,
		MaxAge:   "5m",
	})

	if got := body["rule_type"]; got != RuleTypeStaleness {
		t.Errorf("rule_type = %v, want %q", got, RuleTypeStaleness)
	}
	if got := body["max_age"]; got != "5m" {
		t.Errorf("max_age = %v, want 5m", got)
	}
	// The regression this guards: `condition` used to be set
	// unconditionally, which sent "" for a staleness rule — a body
	// ts-store rejects outright.
	if _, present := body["condition"]; present {
		t.Errorf("condition must never be sent for a staleness rule, got %q", body["condition"])
	}
}

func TestCommonAlertBody_OptionalFieldsStayConditional(t *testing.T) {
	// PUT is a full replace upstream: a field we omit reverts to its
	// default. So an empty optional must NOT appear as an empty string.
	body := commonAlertBody(&CreateAlertRequest{
		Type: "webhook", RuleName: "n", Condition: "a > 1",
	})
	for _, k := range []string{"cooldown", "poll_interval", "restart_policy", "max_replay", "external_ref"} {
		if _, present := body[k]; present {
			t.Errorf("%s should be omitted when unset, got %v", k, body[k])
		}
	}

	full := commonAlertBody(&CreateAlertRequest{
		Type: "webhook", RuleName: "n", Condition: "a > 1",
		Cooldown: "5m", PollInterval: "30s", RestartPolicy: "resume", MaxReplay: "1h",
	})
	for k, want := range map[string]string{
		"cooldown": "5m", "poll_interval": "30s", "restart_policy": "resume", "max_replay": "1h",
	} {
		if got := full[k]; got != want {
			t.Errorf("%s = %v, want %v", k, got, want)
		}
	}
}

func TestEffectiveRuleType(t *testing.T) {
	// Rules created before ts-store#134 carry no rule_type and must keep
	// behaving exactly as before.
	for in, want := range map[string]string{
		"":                  RuleTypeCondition,
		RuleTypeCondition:   RuleTypeCondition,
		RuleTypeStaleness:   RuleTypeStaleness,
		"something-unknown": "something-unknown", // passed through so validation can reject it
	} {
		if got := effectiveRuleType(in); got != want {
			t.Errorf("effectiveRuleType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidateRuleTypeFields(t *testing.T) {
	cases := []struct {
		name    string
		req     CreateAlertRequest
		wantErr bool
	}{
		{"condition rule with a condition", CreateAlertRequest{Condition: "a > 1"}, false},
		{"condition rule, explicit type", CreateAlertRequest{RuleType: RuleTypeCondition, Condition: "a > 1"}, false},
		{"condition rule missing condition", CreateAlertRequest{}, true},
		{"condition rule with whitespace-only condition", CreateAlertRequest{Condition: "   "}, true},
		{"condition rule carrying max_age", CreateAlertRequest{Condition: "a > 1", MaxAge: "5m"}, true},

		{"staleness rule with max_age", CreateAlertRequest{RuleType: RuleTypeStaleness, MaxAge: "5m"}, false},
		{"staleness rule missing max_age", CreateAlertRequest{RuleType: RuleTypeStaleness}, true},
		{"staleness rule carrying a condition", CreateAlertRequest{RuleType: RuleTypeStaleness, MaxAge: "5m", Condition: "a > 1"}, true},

		{"unknown rule type", CreateAlertRequest{RuleType: "eventually", Condition: "a > 1"}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateRuleTypeFields(&tc.req)
			if tc.wantErr && err == nil {
				t.Fatal("expected an error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
			// Every refusal here is the caller's fault, so it must carry
			// the sentinel that maps it to a 400 rather than a 500.
			if err != nil && !errors.Is(err, ErrAlertValidation) {
				t.Errorf("error %v does not wrap ErrAlertValidation", err)
			}
		})
	}
}

// A max_age that doesn't parse is deliberately NOT checked locally —
// ts-store validates it and returns a well-worded 400. Mirroring value
// rules is what drifts (#242 part 2); we only enforce field SHAPE.
func TestValidateRuleTypeFields_DoesNotParseMaxAge(t *testing.T) {
	if err := validateRuleTypeFields(&CreateAlertRequest{
		RuleType: RuleTypeStaleness, MaxAge: "not-a-duration",
	}); err != nil {
		t.Fatalf("local validation should defer max_age parsing to ts-store, got %v", err)
	}
}

// ─── #263: alert namespace as a rule property ────────────────────────
//
// Which namespace a fired alert is filed into decides WHO CAN SEE IT
// (AlertService.authorizeAlert gates every read on it). Before #263 it was
// inherited from whichever connection delivered the webhook, so with one
// store reachable through several connections in different namespaces,
// visibility depended on which connection happened to be picked.

func TestEncodeExternalRef_NamespaceOnly(t *testing.T) {
	// A rule with no dashboard deep-link must still carry its namespace —
	// encodeExternalRef used to return "" whenever dashboard_id was empty,
	// which would have silently dropped it.
	ref := encodeExternalRef("", nil, "trv-homelab")
	if ref == "" {
		t.Fatal("namespace alone must produce an external_ref, got empty")
	}
	if got := decodeNamespace(ref); got != "trv-homelab" {
		t.Errorf("decodeNamespace = %q, want trv-homelab", got)
	}
	if got := decodeDashboardID(ref); got != "" {
		t.Errorf("dashboard_id should be absent, got %q", got)
	}
}

func TestEncodeExternalRef_RoundTripsAllThree(t *testing.T) {
	ref := encodeExternalRef("dash-1", map[string]string{"host": "srv-001"}, "trv-homelab")
	if got := decodeDashboardID(ref); got != "dash-1" {
		t.Errorf("dashboard_id = %q, want dash-1", got)
	}
	if got := decodeNamespace(ref); got != "trv-homelab" {
		t.Errorf("namespace = %q, want trv-homelab", got)
	}
	if got := decodeDashboardVars(ref)["host"]; got != "srv-001" {
		t.Errorf("dashboard_vars[host] = %q, want srv-001", got)
	}
}

func TestEncodeExternalRef_StaysEmptyWhenNothingToCarry(t *testing.T) {
	// Preserves the pre-#263 wire shape on the common path: a rule with
	// neither a dashboard nor a namespace sends no external_ref at all.
	if ref := encodeExternalRef("", nil, ""); ref != "" {
		t.Errorf("expected empty ref, got %q", ref)
	}
	if ref := encodeExternalRef("", nil, "   "); ref != "" {
		t.Errorf("whitespace-only namespace should not produce a ref, got %q", ref)
	}
}

func TestDecodeNamespace_BackCompat(t *testing.T) {
	// Rules that predate #263, come from the ts-store CLI, or carry a
	// non-JSON ref must decode to "" so the caller falls back to the
	// delivering connection's namespace (the old behavior).
	for name, ref := range map[string]string{
		"empty":             "",
		"pre-263 dash-only": `{"dashboard_id":"dash-1"}`,
		"non-JSON":          "some-cli-provided-token",
		"JSON, no ns key":   `{"other":"value"}`,
	} {
		if got := decodeNamespace(ref); got != "" {
			t.Errorf("%s: decodeNamespace = %q, want empty (so the caller falls back)", name, got)
		}
	}
}
