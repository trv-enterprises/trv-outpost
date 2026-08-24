// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// PushSecret authorises one URL-embedded secret for one ts-store
// inbound push channel (#260).
//
// Why the secret lives in the URL: ts-store dials OUT to the callback
// we register with it, and the push-connection API accepts only a URL
// — there is no header or body field we control on the frames it
// sends back. So the path is the single channel available to carry a
// credential, exactly as with the tsstore webhook receiver. See
// [WebhookSecret] for the same reasoning on the alert-delivery path.
//
// Scoped to a STREAM KEY rather than a connection: #248 made channel
// identity `connID` (pinned) or `connID/<hash>` (per-component store
// channel), and two stores' pushers must not be able to write to each
// other's channel. Binding to the stream key means a leaked secret
// reaches exactly one channel.
//
// Treat the field like a password: store the raw value (ts-store
// replays the URL verbatim, so we cannot hash it), never serialise it,
// and rotate by deleting the record — the next push registration mints
// a fresh one.
type PushSecret struct {
	ID string `json:"id" bson:"_id"`
	// Secret is the URL path segment. Never serialised to the wire.
	Secret string `json:"-" bson:"secret"`
	// StreamKey is the channel this secret authorises: "<connID>" for a
	// pinned connection, "<connID>/<hash>" for a per-component store
	// channel. Matches the path the inbound route resolves.
	StreamKey string `json:"stream_key" bson:"stream_key"`
	// ConnectionID is the owning connection, denormalised from
	// StreamKey so revoking every secret for a connection does not have
	// to parse paths.
	ConnectionID string     `json:"connection_id" bson:"connection_id"`
	CreatedAt    time.Time  `json:"created_at" bson:"created_at"`
	LastUsedAt   *time.Time `json:"last_used_at,omitempty" bson:"last_used_at,omitempty"`
}
