// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"encoding/json"
	"testing"
)

// The ts-store wire convention is epoch SECONDS. messageToRecord must always
// emit the server-normalized seconds timestamp, even when the push payload
// carries its OWN `timestamp` field in a different scale (push-aggregated
// streams send milliseconds). Regression guard for the scatter multi-year-
// spread bug: a value-axis chart mixing seconds (backfill) + ms (stream).
func TestMessageToRecord_TimestampScale(t *testing.T) {
	h := &InboundHandler{}
	const ns = int64(1783452917617617750) // nanoseconds
	const wantSeconds = 1783452917.61761775

	tests := []struct {
		name string
		data string
	}{
		{"payload has no timestamp", `{"co2":391.0,"temperature":80.8}`},
		// Push-aggregated payload carrying a millisecond timestamp — must NOT win.
		{"payload timestamp in ms is overridden", `{"co2":391.0,"timestamp":1783452917617.75}`},
		{"payload timestamp in seconds is overridden", `{"co2":391.0,"timestamp":1783452917}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := &tsStorePushMessage{Type: "data", Timestamp: ns, Data: json.RawMessage(tt.data)}
			rec := h.messageToRecord(msg)
			got, ok := rec["timestamp"].(float64)
			if !ok {
				t.Fatalf("timestamp is %T, want float64 seconds", rec["timestamp"])
			}
			// ~1.7834e9 seconds; must be seconds scale, not ms (~1.78e12).
			if got < 1e9 || got > 1e10 {
				t.Fatalf("timestamp = %v, want seconds scale (~%v)", got, wantSeconds)
			}
			if diff := got - wantSeconds; diff > 1 || diff < -1 {
				t.Errorf("timestamp = %v, want ~%v (ns/1e9)", got, wantSeconds)
			}
			// The non-timestamp payload field still merges through.
			if rec["co2"] != 391.0 {
				t.Errorf("co2 = %v, want 391.0 (payload merge broken)", rec["co2"])
			}
		})
	}
}
