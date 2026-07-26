// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"encoding/json"
	"strings"
	"testing"
)

const synoTestSecret = "super-secret-dsm-password"

// TestSynologySanitizeMasksPassword is the regression guard for a real leak:
// the Synology adapter shipped before sanitize() knew about its config block,
// so GET /api/connections/:id returned the DSM password in PLAINTEXT. Every
// config type with a credential needs a branch in sanitize() — adding the
// struct is not enough.
func TestSynologySanitizeMasksPassword(t *testing.T) {
	conn := &Connection{
		Name: "nas",
		Type: ConnectionTypeSynology,
		Config: ConnectionConfig{
			Synology: &SynologyDSMConfig{
				URL:      "https://nas.example:5001",
				Username: "svc",
				Password: synoTestSecret,
			},
		},
	}

	t.Run("api_path_masks", func(t *testing.T) {
		got := conn.SanitizeForAPI()
		if got.Config.Synology.Password != SecretMaskedValue {
			t.Fatalf("password = %q, want the %q sentinel", got.Config.Synology.Password, SecretMaskedValue)
		}
		// Non-secret fields must survive — the editor needs them.
		if got.Config.Synology.Username != "svc" {
			t.Errorf("username should not be masked, got %q", got.Config.Synology.Username)
		}
	})

	t.Run("export_path_empties", func(t *testing.T) {
		got := conn.SanitizeForExport()
		if got.Config.Synology.Password != "" {
			t.Fatalf("export password = %q, want empty", got.Config.Synology.Password)
		}
	})

	t.Run("original_untouched", func(t *testing.T) {
		// sanitize returns a COPY; mutating the copy must not clobber the
		// in-memory record the adapter will authenticate with.
		_ = conn.SanitizeForAPI()
		if conn.Config.Synology.Password != synoTestSecret {
			t.Fatalf("sanitize mutated the original: %q", conn.Config.Synology.Password)
		}
	})

	t.Run("secret_absent_from_serialized_api_payload", func(t *testing.T) {
		// The end-to-end property that actually matters: whatever the API
		// marshals must not contain the credential anywhere.
		blob, err := json.Marshal(conn.SanitizeForAPI())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(blob), synoTestSecret) {
			t.Fatal("serialized API payload still contains the plaintext password")
		}
	})
}

// TestSynologyHasSecret covers the editor's "is there a value here?" probe,
// which drives whether SecretTextInput shows a masked placeholder or an empty
// field prompting the admin to enter one.
func TestSynologyHasSecret(t *testing.T) {
	withPw := &Connection{Config: ConnectionConfig{Synology: &SynologyDSMConfig{Password: synoTestSecret}}}
	if !withPw.HasSecret("synology.password") {
		t.Error("HasSecret(synology.password) = false for a populated password")
	}

	noPw := &Connection{Config: ConnectionConfig{Synology: &SynologyDSMConfig{}}}
	if noPw.HasSecret("synology.password") {
		t.Error("HasSecret(synology.password) = true for an empty password")
	}

	absent := &Connection{Config: ConnectionConfig{}}
	if absent.HasSecret("synology.password") {
		t.Error("HasSecret(synology.password) = true when there is no synology config at all")
	}
}

// TestEverySecretBearingConfigIsSanitized is the systemic guard. Rather than
// testing one adapter, it builds a connection with EVERY password-bearing
// config block populated and asserts none of the secrets survive sanitization.
// A new adapter that adds a credential field but forgets its sanitize() branch
// fails here — which is exactly how the Synology leak slipped through.
func TestEverySecretBearingConfigIsSanitized(t *testing.T) {
	const secret = "LEAK-CANARY-VALUE"

	conn := &Connection{
		Config: ConnectionConfig{
			SQL:        &SQLConfig{Password: secret},
			Prometheus: &PrometheusConfig{Password: secret},
			MQTT:       &MQTTConfig{Password: secret},
			Frigate:    &FrigateConfig{Password: secret},
			Synology:   &SynologyDSMConfig{Password: secret},
			TSStore:    &TSStoreConfig{APIKey: secret},
		},
	}

	for _, tc := range []struct {
		name string
		out  *Connection
	}{
		{"SanitizeForAPI", conn.SanitizeForAPI()},
		{"SanitizeForExport", conn.SanitizeForExport()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			blob, err := json.Marshal(tc.out)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(blob), secret) {
				t.Fatalf("%s leaked a credential in the serialized payload:\n%s", tc.name, blob)
			}
		})
	}
}
