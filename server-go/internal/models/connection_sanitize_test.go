// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"strings"
	"testing"
)

// sentinel is a value we should never see in sanitized output.
const sentinel = "SECRET-SHOULD-NEVER-APPEAR"

// fullyLoadedConnection builds a Connection with every connection type
// populated and every secret-bearing field set to the sentinel. The
// tests below walk the sanitized copy and assert the sentinel is gone
// from all of them.
func fullyLoadedConnection(maskSecrets bool) *Connection {
	return &Connection{
		Name:        "test",
		MaskSecrets: maskSecrets,
		Config: ConnectionConfig{
			SQL: &SQLConfig{
				Host:     "db",
				Password: sentinel,
				Options:  "sslmode=require&password=" + sentinel + "&connect_timeout=10",
			},
			API: &APIConfig{
				URL: "https://user:" + sentinel + "@api.example.com/v1",
				AuthCredentials: map[string]string{
					"token": sentinel,
					"key":   sentinel,
				},
				Headers: map[string]string{
					"Authorization":       "Bearer " + sentinel,
					"PROXY-AUTHORIZATION": sentinel,
					"x-api-key":           sentinel,
					"X-Auth-Token":        sentinel,
					"Cookie":              "session=" + sentinel,
					"X-Custom":            "not-a-secret",
				},
				Body: `{"api_key":"` + sentinel + `"}`,
				QueryParams: map[string]string{
					"api_key": sentinel,
				},
			},
			Socket: &SocketConfig{
				URL: "wss://user:" + sentinel + "@stream.example.com/ws",
				Headers: map[string]string{
					"Authorization": "Bearer " + sentinel,
					"X-API-Key":     sentinel,
					"X-Custom":      "not-a-secret",
				},
			},
			TSStore: &TSStoreConfig{
				Host:   "ts",
				APIKey: sentinel,
				Headers: map[string]string{
					"Authorization": "Bearer " + sentinel,
					"X-Custom":      "not-a-secret",
				},
			},
			Prometheus: &PrometheusConfig{
				URL:      "https://user:" + sentinel + "@prom.example.com",
				Password: sentinel,
			},
			MQTT: &MQTTConfig{
				BrokerURL: "mqtts://user:" + sentinel + "@broker.example.com:8883",
				Password:  sentinel,
			},
			Frigate: &FrigateConfig{
				Host:     "nvr",
				Password: sentinel,
			},
		},
	}
}

// containsSentinel walks string fields of interest on a sanitized
// Connection and returns the first location where the sentinel still
// appears, or "" if it's gone.
func containsSentinel(d *Connection) string {
	if d.Config.SQL != nil {
		if strings.Contains(d.Config.SQL.Password, sentinel) {
			return "SQL.Password"
		}
		if strings.Contains(d.Config.SQL.Options, sentinel) {
			return "SQL.Options"
		}
	}
	if d.Config.API != nil {
		if strings.Contains(d.Config.API.URL, sentinel) {
			return "API.URL"
		}
		for k, v := range d.Config.API.AuthCredentials {
			if strings.Contains(v, sentinel) {
				return "API.AuthCredentials[" + k + "]"
			}
		}
		for k, v := range d.Config.API.Headers {
			if strings.Contains(v, sentinel) {
				return "API.Headers[" + k + "]"
			}
		}
		if strings.Contains(d.Config.API.Body, sentinel) {
			return "API.Body"
		}
		for k, v := range d.Config.API.QueryParams {
			if strings.Contains(v, sentinel) {
				return "API.QueryParams[" + k + "]"
			}
		}
	}
	if d.Config.Socket != nil {
		if strings.Contains(d.Config.Socket.URL, sentinel) {
			return "Socket.URL"
		}
		for k, v := range d.Config.Socket.Headers {
			if strings.Contains(v, sentinel) {
				return "Socket.Headers[" + k + "]"
			}
		}
	}
	if d.Config.TSStore != nil {
		if strings.Contains(d.Config.TSStore.APIKey, sentinel) {
			return "TSStore.APIKey"
		}
		for k, v := range d.Config.TSStore.Headers {
			if strings.Contains(v, sentinel) {
				return "TSStore.Headers[" + k + "]"
			}
		}
	}
	if d.Config.Prometheus != nil {
		if strings.Contains(d.Config.Prometheus.URL, sentinel) {
			return "Prometheus.URL"
		}
		if strings.Contains(d.Config.Prometheus.Password, sentinel) {
			return "Prometheus.Password"
		}
	}
	if d.Config.MQTT != nil {
		if strings.Contains(d.Config.MQTT.BrokerURL, sentinel) {
			return "MQTT.BrokerURL"
		}
		if strings.Contains(d.Config.MQTT.Password, sentinel) {
			return "MQTT.Password"
		}
	}
	if d.Config.Frigate != nil {
		if strings.Contains(d.Config.Frigate.Password, sentinel) {
			return "Frigate.Password"
		}
	}
	return ""
}

func TestSanitizeForExport_RedactsEverySecretField(t *testing.T) {
	d := fullyLoadedConnection(true)
	got := d.SanitizeForExport()
	if leak := containsSentinel(got); leak != "" {
		t.Fatalf("SanitizeForExport leaked secret at %s", leak)
	}
}

func TestSanitizeForExport_IgnoresMaskSecretsFlag(t *testing.T) {
	// SanitizeForExport must redact even when MaskSecrets=false — the
	// flag is a UI-round-trip affordance, not an export policy.
	d := fullyLoadedConnection(false)
	got := d.SanitizeForExport()
	if leak := containsSentinel(got); leak != "" {
		t.Fatalf("SanitizeForExport respected MaskSecrets=false and leaked at %s", leak)
	}
}

func TestSanitizeForAPI_HonorsMaskSecretsFlag(t *testing.T) {
	// When MaskSecrets is false, SanitizeForAPI returns the original
	// object unchanged — this is load-bearing for the edit-form
	// round-trip.
	d := fullyLoadedConnection(false)
	got := d.SanitizeForAPI()
	if got.Config.SQL.Password != sentinel {
		t.Fatalf("SanitizeForAPI redacted despite MaskSecrets=false")
	}
}

func TestSanitizeForExport_PreservesNonSecretHeaders(t *testing.T) {
	d := fullyLoadedConnection(true)
	got := d.SanitizeForExport()
	if got.Config.API.Headers["X-Custom"] != "not-a-secret" {
		t.Fatalf("non-secret header was redacted: got %q", got.Config.API.Headers["X-Custom"])
	}
	if got.Config.Socket.Headers["X-Custom"] != "not-a-secret" {
		t.Fatalf("non-secret Socket header was redacted")
	}
	if got.Config.TSStore.Headers["X-Custom"] != "not-a-secret" {
		t.Fatalf("non-secret TSStore header was redacted")
	}
}

func TestSanitizeForExport_DoesNotMutateOriginal(t *testing.T) {
	d := fullyLoadedConnection(true)
	_ = d.SanitizeForExport()
	if d.Config.SQL.Password != sentinel {
		t.Fatalf("original was mutated — SQL password is now %q", d.Config.SQL.Password)
	}
	if d.Config.API.Headers["Authorization"] != "Bearer "+sentinel {
		t.Fatalf("original was mutated — API Authorization header changed")
	}
}

func TestMaskSQLOptions_PreservesOtherKeys(t *testing.T) {
	in := "sslmode=require&password=hunter2&connect_timeout=10"
	out := maskSQLOptions(in)
	if !strings.Contains(out, "sslmode=require") {
		t.Fatalf("non-secret key was dropped: %q", out)
	}
	if !strings.Contains(out, "connect_timeout=10") {
		t.Fatalf("non-secret key was dropped: %q", out)
	}
	if strings.Contains(out, "hunter2") {
		t.Fatalf("password leaked: %q", out)
	}
}

func TestMaskURLUserinfo_LeavesCleanURLsAlone(t *testing.T) {
	in := "https://prom.example.com/api"
	if maskURLUserinfo(in) != in {
		t.Fatalf("clean URL was altered")
	}
}
