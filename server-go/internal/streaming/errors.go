// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import "errors"

// StreamStartError is the typed error a Streamer's Start returns when it can't
// establish its upstream connection. It carries enough for the Manager to
// decide whether to retry and for the SSE handler to tell the UI what's wrong.
//
//   - Code:     upstream HTTP status (e.g. 401 from ts-store), or 0 when the
//               failure happened before/without an HTTP response (dial/network).
//   - Terminal: true when retrying is pointless — an auth failure (bad/missing
//               api-key) won't self-heal, so the Manager must NOT re-dial in a
//               loop and the UI should stop reconnecting and show the message.
//   - Message:  actionable, user-facing (mentions the api-key for auth cases).
type StreamStartError struct {
	Code     int
	Terminal bool
	Message  string
}

func (e *StreamStartError) Error() string { return e.Message }

// AsStreamStartError unwraps err (through %w wrapping) to a *StreamStartError,
// returning it and true when present. Non-typed errors are treated as
// transient (Terminal=false) by callers.
func AsStreamStartError(err error) (*StreamStartError, bool) {
	var se *StreamStartError
	if errors.As(err, &se) {
		return se, true
	}
	return nil, false
}
