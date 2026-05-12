// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// Event is the envelope every client receives over the SSE stream.
// Kind discriminates the payload shape — today the only kind is
// "alert", emitted by the ts-store webhook receiver. New event kinds
// (e.g. "deployment", "health") can append without breaking clients
// because the SSE consumer dispatches on Kind.
type Event struct {
	Kind    string      `json:"kind"`
	Payload interface{} `json:"payload"`
	// Namespace, when non-empty, scopes which subscribers receive
	// this event. Today every authenticated subscriber sees every
	// event regardless of namespace (namespace-as-authz is structural
	// only); the field is reserved so the hub can filter when
	// per-user namespace permissions land. Producers should set it
	// to the originating connection's namespace.
	Namespace string `json:"namespace,omitempty"`
}

// AlertPayload is the shape clients see for Kind=="alert" events.
// Surface-level fields only — the bell-panel UI renders Title +
// Subtitle directly; FiredAt drives ordering. The Source and RuleName
// give the user enough to find the underlying record / connection
// without exposing internal IDs.
type AlertPayload struct {
	Severity  string    `json:"severity"`              // "info" | "warning" | "error"
	Title     string    `json:"title"`                 // e.g. "high-temp on Proxmox API"
	Subtitle  string    `json:"subtitle,omitempty"`    // e.g. condition string
	Source    string    `json:"source,omitempty"`      // ts-store store name
	RuleName  string    `json:"rule_name,omitempty"`   // user-defined rule identifier
	FiredAt   time.Time `json:"fired_at"`              // when ts-store evaluated the rule
}

// EventHub is an in-process pub/sub fan-out. Subscribers register
// once at SSE-open time and receive every published event until they
// unsubscribe (typically on EventSource close).
//
// Implementation: each subscriber gets a buffered channel. Publish()
// non-blockingly drops to the next subscriber if a channel is full —
// the dashboard prefers to lose one slow client's events over
// stalling the producer (e.g. the inbound webhook handler). Slow
// clients can re-open the stream to catch up.
type EventHub struct {
	mu          sync.RWMutex
	subscribers map[string]*subscriber
}

type subscriber struct {
	id        string
	userID    string // Mongo _id of the authenticated user
	ch        chan Event
	closed    chan struct{}
	closeOnce sync.Once
}

// NewEventHub constructs an empty hub. Lifetime is the server process —
// no persistence, no replay.
func NewEventHub() *EventHub {
	return &EventHub{subscribers: make(map[string]*subscriber)}
}

// Subscription is what callers (the SSE handler) receive — a handle
// to a single subscriber's channel plus a function to unregister
// when the request context ends.
type Subscription struct {
	ID        string
	Events    <-chan Event
	close     func()
}

// Close removes the subscriber from the hub and frees its channel.
// Idempotent; safe to defer.
func (s *Subscription) Close() { s.close() }

// Subscribe registers a new subscriber and returns a Subscription
// handle. userID identifies which dashboard user the SSE stream
// belongs to; today it is purely informational (we fan out to every
// subscriber), but a future namespace-permissioning pass will use
// it to filter on Publish.
func (h *EventHub) Subscribe(userID string) *Subscription {
	sub := &subscriber{
		id:     uuid.New().String(),
		userID: userID,
		ch:     make(chan Event, 32),
		closed: make(chan struct{}),
	}
	h.mu.Lock()
	h.subscribers[sub.id] = sub
	h.mu.Unlock()
	return &Subscription{
		ID:     sub.id,
		Events: sub.ch,
		close: func() {
			h.mu.Lock()
			if _, ok := h.subscribers[sub.id]; ok {
				delete(h.subscribers, sub.id)
				sub.closeOnce.Do(func() { close(sub.closed); close(sub.ch) })
			}
			h.mu.Unlock()
		},
	}
}

// Publish fans an event out to every current subscriber. Sends are
// non-blocking — if a subscriber's buffer is full, the event is
// dropped for that subscriber (logged at the producer). Other
// subscribers are unaffected.
func (h *EventHub) Publish(ev Event) {
	h.mu.RLock()
	subs := make([]*subscriber, 0, len(h.subscribers))
	for _, s := range h.subscribers {
		subs = append(subs, s)
	}
	h.mu.RUnlock()

	for _, s := range subs {
		select {
		case s.ch <- ev:
		case <-s.closed:
			// Subscriber raced its own close — skip.
		default:
			// Buffer full. Drop for this subscriber. TODO once
			// telemetry lands: log a counter so operators can spot
			// chronically-slow clients.
		}
	}
}

// SubscriberCount returns the current number of open subscribers.
// Useful for /api/status health output and tests.
func (h *EventHub) SubscriberCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subscribers)
}
