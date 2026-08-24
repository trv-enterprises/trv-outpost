// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"strings"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// TestTSStoreChannelHashStability locks the two properties the channel key's
// correctness rests on: it is a PURE function of config (stable across
// restarts — a drifting key permanently orphans the ts-store push connection
// and its persisted cursor), and semantically-identical configs hash
// identically regardless of authoring order.
func TestTSStoreChannelHashStability(t *testing.T) {
	push := &models.TSStorePushConfig{
		Format:     "full",
		AggWindow:  "1m",
		AggDefault: "avg,sum",
	}

	t.Run("pure function of config", func(t *testing.T) {
		a := tsstoreChannelHash("home-env", push)
		b := tsstoreChannelHash("home-env", push)
		if a != b {
			t.Fatalf("same config hashed differently: %s vs %s", a, b)
		}
		if len(a) != 16 {
			t.Fatalf("hash length = %d, want 16 hex chars", len(a))
		}
	})

	t.Run("agg_default checkbox order cannot split a channel", func(t *testing.T) {
		other := *push
		other.AggDefault = "sum, avg" // toggle order + stray space from the UI builder
		if tsstoreChannelHash("home-env", push) != tsstoreChannelHash("home-env", &other) {
			t.Fatal("order-only agg_default difference produced two channels — would double the ts-store aggregators")
		}
	})

	t.Run("different store = different channel", func(t *testing.T) {
		if tsstoreChannelHash("home-env", push) == tsstoreChannelHash("garage-env", push) {
			t.Fatal("two stores hashed to one channel")
		}
	})

	t.Run("different agg config = different channel", func(t *testing.T) {
		other := *push
		other.AggWindow = "5m"
		if tsstoreChannelHash("home-env", push) == tsstoreChannelHash("home-env", &other) {
			t.Fatal("distinct agg windows must not share a channel — the payloads differ")
		}
	})

	t.Run("nil push config is valid", func(t *testing.T) {
		a := tsstoreChannelHash("home-env", nil)
		b := tsstoreChannelHash("home-env", &models.TSStorePushConfig{})
		if a != b {
			t.Fatal("nil and zero-value push configs must hash identically")
		}
	})
}

func TestComposeStreamKeyShape(t *testing.T) {
	key := composeStreamKey("conn-123", "home-env", nil)
	if !strings.HasPrefix(key, "conn-123/") {
		t.Fatalf("key = %q — the connection id must stay a visible prefix", key)
	}
	if strings.Count(key, "/") != 1 {
		t.Fatalf("key = %q, want exactly one path separator (two URL segments)", key)
	}
}

// TestInboundURLShapes locks the wire contract: the channel path is the
// stream key — one segment for a pinned channel, two for a per-store
// channel (#248) — followed by the per-channel push secret (#260).
//
// NOTE: #260 deliberately BROKE the "zero migration for existing ts-store
// push registrations" property this test previously asserted. Every
// callback now carries a credential, so a pre-#260 registration dialling a
// secret-less URL is refused. Existing registrations are replaced on the
// owning stream's next start, and stale-push cleanup matches on the channel
// path prefix so the orphaned one is removed rather than left dialling.
func TestInboundURLShapes(t *testing.T) {
	if got := GetInboundURL("host:3001", "conn-123", "SEC", false); got != "ws://host:3001/api/streams/inbound/conn-123/SEC" {
		t.Fatalf("pinned URL changed: %s", got)
	}
	key := composeStreamKey("conn-123", "home-env", nil)
	got := GetInboundURL("host:3001", key, "SEC", false)
	if !strings.HasPrefix(got, "ws://host:3001/api/streams/inbound/conn-123/") {
		t.Fatalf("store-channel URL = %s, want two-segment path under the connection id", got)
	}
	if !strings.HasSuffix(got, "/SEC") {
		t.Fatalf("store-channel URL = %s, want the secret as the final segment", got)
	}
}

func TestNormalizeCommaList(t *testing.T) {
	cases := map[string]string{
		"":                 "",
		"avg":              "avg",
		"sum,avg":          "avg,sum",
		" sum , avg ,":     "avg,sum",
		"temp:avg,hum:max": "hum:max,temp:avg",
	}
	for in, want := range cases {
		if got := normalizeCommaList(in); got != want {
			t.Errorf("normalizeCommaList(%q) = %q, want %q", in, got, want)
		}
	}
}
