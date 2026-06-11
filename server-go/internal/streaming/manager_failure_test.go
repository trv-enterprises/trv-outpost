// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// newTestManager builds a Manager with a nil repo. Safe for the gate/backoff
// tests below because getOrCreateStream consults the failed-stream map BEFORE
// it ever touches the repo — terminal and cooling-down paths return early.
func newTestManager() *Manager {
	return &Manager{
		streams: make(map[string]Streamer),
		failed:  make(map[string]*failedStream),
		config:  DefaultManagerConfig(),
		ctx:     context.Background(),
	}
}

// TestGate_TerminalNeverRedials: a terminal failure (e.g. rejected api-key) is
// returned from the gate without re-dialing — the repo (nil here) is never hit,
// so if the gate tried to re-create the stream this would panic.
func TestGate_TerminalNeverRedials(t *testing.T) {
	m := newTestManager()
	const id = "conn-terminal"
	wantErr := &StreamStartError{Code: 401, Terminal: true, Message: "api key rejected"}
	m.failed[id] = &failedStream{err: wantErr, terminal: true, attempts: 1}

	m.mu.Lock()
	stream, err := m.getOrCreateStream(context.Background(), id)
	m.mu.Unlock()

	if stream != nil {
		t.Fatalf("expected nil stream for terminal failure, got %v", stream)
	}
	if !errors.Is(err, error(wantErr)) {
		t.Fatalf("expected the cached terminal error, got %v", err)
	}
}

// TestGate_TransientCoolingDown: a transient failure within its backoff window
// returns the cached error without re-dialing.
func TestGate_TransientCoolingDown(t *testing.T) {
	m := newTestManager()
	const id = "conn-transient"
	wantErr := &StreamStartError{Code: 503, Terminal: false, Message: "upstream 503"}
	m.failed[id] = &failedStream{
		err:       wantErr,
		terminal:  false,
		attempts:  2,
		nextRetry: time.Now().Add(10 * time.Second), // still cooling down
	}

	m.mu.Lock()
	stream, err := m.getOrCreateStream(context.Background(), id)
	m.mu.Unlock()

	if stream != nil {
		t.Fatalf("expected nil stream while cooling down, got %v", stream)
	}
	if err == nil || err.Error() != "upstream 503" {
		t.Fatalf("expected cached transient error, got %v", err)
	}
}

// TestGate_LiveStreamWins: an existing live stream is returned without consulting
// the failed map or the repo.
func TestGate_LiveStreamWins(t *testing.T) {
	m := newTestManager()
	const id = "conn-live"
	stub := &stubStreamer{}
	m.streams[id] = stub

	m.mu.Lock()
	stream, err := m.getOrCreateStream(context.Background(), id)
	m.mu.Unlock()

	if err != nil {
		t.Fatalf("unexpected error for live stream: %v", err)
	}
	if stream != stub {
		t.Fatalf("expected the cached live stream, got %v", stream)
	}
}

// TestRecordFailure_BackoffGrows: successive transient failures grow the backoff
// (capped), and terminal failures carry the terminal flag with no nextRetry.
func TestRecordFailure_BackoffGrows(t *testing.T) {
	m := newTestManager()
	const id = "conn-backoff"

	m.recordFailure(id, &StreamStartError{Terminal: false, Message: "x"})
	d1 := time.Until(m.failed[id].nextRetry)
	m.recordFailure(id, &StreamStartError{Terminal: false, Message: "x"})
	d2 := time.Until(m.failed[id].nextRetry)

	if m.failed[id].attempts != 2 {
		t.Fatalf("expected attempts=2, got %d", m.failed[id].attempts)
	}
	if d2 <= d1 {
		t.Fatalf("expected backoff to grow: d1=%v d2=%v", d1, d2)
	}

	// Terminal failure: no nextRetry, terminal flag set.
	m.recordFailure(id, &StreamStartError{Terminal: true, Message: "auth"})
	if !m.failed[id].terminal {
		t.Fatalf("expected terminal=true after a terminal failure")
	}
	if !m.failed[id].nextRetry.IsZero() {
		t.Fatalf("expected zero nextRetry for terminal failure, got %v", m.failed[id].nextRetry)
	}
}

// TestBackoffDelay_Caps: backoff is exponential and capped at RetryMaxDelay.
func TestBackoffDelay_Caps(t *testing.T) {
	m := newTestManager() // base 1s, cap 30s
	if got := m.backoffDelay(1); got != 1*time.Second {
		t.Errorf("attempt 1: want 1s, got %v", got)
	}
	if got := m.backoffDelay(3); got != 4*time.Second {
		t.Errorf("attempt 3: want 4s, got %v", got)
	}
	if got := m.backoffDelay(20); got != 30*time.Second { // would overflow → cap
		t.Errorf("attempt 20: want cap 30s, got %v", got)
	}
}

// TestInvalidateStream_ClearsFailure: invalidating clears terminal/backoff
// memory so a re-saved (fixed) connection re-dials on the next subscribe.
func TestInvalidateStream_ClearsFailure(t *testing.T) {
	m := newTestManager()
	const id = "conn-fixed"
	m.failed[id] = &failedStream{err: errors.New("old"), terminal: true, attempts: 1}

	m.InvalidateStream(id)

	if _, ok := m.failed[id]; ok {
		t.Fatalf("expected failed entry cleared after InvalidateStream")
	}
}

// TestStreamStartError_AsAndClassification: the typed error unwraps through
// %w-wrapping and reports its terminal flag.
func TestStreamStartError_AsAndClassification(t *testing.T) {
	base := &StreamStartError{Code: 403, Terminal: true, Message: "forbidden"}
	wrapped := errors.Join(errors.New("failed to create push connection"), base)
	se, ok := AsStreamStartError(wrapped)
	if !ok {
		t.Fatalf("expected AsStreamStartError to unwrap the typed error")
	}
	if !se.Terminal || se.Code != 403 {
		t.Fatalf("unexpected classification: %+v", se)
	}
}

// stubStreamer is a minimal Streamer for the live-stream gate test.
type stubStreamer struct{}

func (s *stubStreamer) Start(ctx context.Context) error      { return nil }
func (s *stubStreamer) Stop()                                {}
func (s *stubStreamer) Subscribe() chan models.Record        { return make(chan models.Record) }
func (s *stubStreamer) Unsubscribe(ch chan models.Record)    {}
func (s *stubStreamer) GetBuffer() []models.Record           { return nil }
func (s *stubStreamer) BufferCount() int                     { return 0 }
func (s *stubStreamer) SubscriberCount() int                 { return 0 }
func (s *stubStreamer) IsConnected() bool                    { return true }
func (s *stubStreamer) LastError() error                     { return nil }
