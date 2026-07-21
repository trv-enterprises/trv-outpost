// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package stats

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// ToFloat64 coerces the interface{} cell values a connection adapter
// returns into a float64. Mirrors streaming.toFloat64 but reports
// whether the value was actually numeric, so callers can count
// non-numeric cells instead of silently treating them as 0.
func ToFloat64(v interface{}) (float64, bool) {
	switch val := v.(type) {
	case float64:
		return val, true
	case float32:
		return float64(val), true
	case int:
		return float64(val), true
	case int64:
		return float64(val), true
	case int32:
		return float64(val), true
	case json.Number:
		f, err := val.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
		return f, err == nil
	default:
		return 0, false
	}
}

// ParseTimestamp mirrors streaming.parseTimestamp: accepts time.Time,
// numeric epochs with seconds-vs-milliseconds detection (>1e12 means
// milliseconds — the epoch-seconds→1970 trap), and RFC3339 or numeric
// strings. The zero time means unparseable.
func ParseTimestamp(v interface{}) time.Time {
	switch val := v.(type) {
	case time.Time:
		return val
	case int64:
		if val > 1e12 {
			return time.UnixMilli(val)
		}
		return time.Unix(val, 0)
	case float64:
		if val > 1e12 {
			return time.UnixMilli(int64(val))
		}
		return time.Unix(int64(val), 0)
	case string:
		if t, err := time.Parse(time.RFC3339, val); err == nil {
			return t
		}
		if t, err := time.Parse("2006-01-02 15:04:05", val); err == nil {
			return t
		}
		if i, err := strconv.ParseInt(val, 10, 64); err == nil {
			if i > 1e12 {
				return time.UnixMilli(i)
			}
			return time.Unix(i, 0)
		}
	}
	return time.Time{}
}
