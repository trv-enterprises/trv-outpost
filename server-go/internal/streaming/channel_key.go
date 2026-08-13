// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Channel identity (#248 PR 2).
//
// A stream key identifies one source channel in the Manager, the
// InboundHandler, and the aggregator feed:
//
//   - Every non-tsstore stream, and every PINNED tsstore connection, keeps
//     the bare connection id — identical to the pre-#248 identity, so
//     existing deployments see no re-keying, no inbound-URL change, and no
//     push-connection churn.
//   - A per-component store channel on an ENDPOINT-SCOPED tsstore connection
//     gets a composite key: connectionID + "/" + hash(store + push config).
//     The hash is a pure function of config, so the key (and the inbound URL
//     derived from it) is STABLE ACROSS RESTARTS — a random component would
//     orphan the ts-store push connection and its persisted cursor on every
//     restart, permanently.
//
// The hash covers the connection-level push config even though PR 2 keeps
// push-agg authoring on the connection: a later per-component override
// (design § 5, staged) then changes only where the values come from, not the
// identity scheme.
//
// The hash is computed SERVER-SIDE ONLY. The client's stream keys are
// client-local fan-out tags and never mirror this composition (avoiding a
// second hand-synced key implementation — see BucketConfig.ConfigKey vs
// _aggStreamKey for how that pairing drifts).

// tsstoreChannelHash returns the 16-hex-char channel discriminator for a
// per-component store channel: sha256 over the store name and the
// order-normalized push config, first 8 bytes.
func tsstoreChannelHash(store string, push *models.TSStorePushConfig) string {
	format, filter, aggWindow, aggFields, aggDefault := "", "", "", "", ""
	ignoreCase := false
	if push != nil {
		format = push.Format
		filter = push.Filter
		ignoreCase = push.FilterIgnoreCase
		aggWindow = push.AggWindow
		aggFields = normalizeCommaList(push.AggFields)
		aggDefault = normalizeCommaList(push.AggDefault)
	}
	data := fmt.Sprintf("%s|%s|%s|%v|%s|%s|%s",
		store, format, filter, ignoreCase, aggWindow, aggDefault, aggFields)
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:8])
}

// normalizeCommaList sort-normalizes a comma-joined list so authoring order
// can't split one channel into two: the connection editor builds agg_default
// by checkbox toggle order ("avg,sum" vs "sum,avg" are the same config).
// Same lesson as BucketConfig.ConfigKey's sorted ValueCols.
func normalizeCommaList(s string) string {
	if s == "" {
		return ""
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// composeStreamKey builds the Manager/inbound key for a per-component store
// channel. The connection id stays a visible prefix (not hashed) so URLs,
// logs, and ts-store's connection list remain attributable to a connection.
func composeStreamKey(connectionID, store string, push *models.TSStorePushConfig) string {
	return connectionID + "/" + tsstoreChannelHash(store, push)
}
