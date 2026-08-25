// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"fmt"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/bsontype"
)

// PushFrom is the starting timestamp for a ts-store push connection, in
// nanoseconds (0 = oldest data, -1 = realtime only).
//
// It exists as a named type solely to carry a tolerant BSON decoder. Prod
// records were found with `from` stored as an embedded document —
// `{high: 0, low: 0, unsigned: false}` — which is a JavaScript `Long` that a
// non-Go driver serialized structurally instead of as a BSON int64. Go's
// decoder refused it:
//
//	error decoding key config.tsstore.push.from:
//	cannot decode embedded document into an integer type
//
// That error is worse than it sounds: the connections list decodes every
// record in one pass, so ONE malformed document 500'd the entire
// /api/connections response and made the Connections page unusable, not just
// the affected connection.
//
// Nothing in this codebase writes that shape — the value arrives from an
// external tool (a mongosh script or a Node driver). Since we do not control
// the writer, we accept both shapes on read and normalize on write. A boot
// migration (tsstore_push_from_long_object_v1) repairs stored records so the
// tolerance is a safety net rather than the mechanism.
type PushFrom int64

// UnmarshalBSONValue accepts the numeric BSON types and the {high, low,
// unsigned} document form.
func (p *PushFrom) UnmarshalBSONValue(t bsontype.Type, data []byte) error {
	switch t {
	case bsontype.Null, bsontype.Undefined:
		*p = 0
		return nil

	case bsontype.Int64, bsontype.Int32, bsontype.Double:
		var n int64
		if err := bson.UnmarshalValue(t, data, &n); err != nil {
			return fmt.Errorf("decode push.from as number: %w", err)
		}
		*p = PushFrom(n)
		return nil

	case bsontype.EmbeddedDocument:
		// A structurally-serialized JS Long. Reassemble the 64-bit value from
		// its halves; `low` is an unsigned 32-bit quantity carried in a signed
		// field, so mask before combining or a negative low corrupts the result.
		var raw struct {
			High *int32 `bson:"high"`
			Low  *int32 `bson:"low"`
		}
		if err := bson.UnmarshalValue(t, data, &raw); err != nil {
			return fmt.Errorf("decode push.from as Long document: %w", err)
		}
		if raw.High == nil && raw.Low == nil {
			// Some other document shape entirely — treat as unset rather than
			// failing the whole list decode.
			*p = 0
			return nil
		}
		var high, low int64
		if raw.High != nil {
			high = int64(*raw.High)
		}
		if raw.Low != nil {
			low = int64(uint32(*raw.Low))
		}
		*p = PushFrom(high<<32 | low)
		return nil

	default:
		// Unknown shape: default to 0 (oldest data) rather than breaking the
		// decode of every other connection in the list.
		*p = 0
		return nil
	}
}

// MarshalBSONValue always writes a plain int64, so a record this server
// rewrites is normalized regardless of how it arrived.
func (p PushFrom) MarshalBSONValue() (bsontype.Type, []byte, error) {
	return bson.MarshalValue(int64(p))
}
