package models

import (
	"testing"

	"go.mongodb.org/mongo-driver/bson"
)

// The shape found on prod: a JavaScript Long serialized structurally by a
// non-Go driver. Go's default decoder refused it with "cannot decode embedded
// document into an integer type", which 500'd the WHOLE connections list
// because every record decodes in one pass.
func TestPushFromDecodesLongDocument(t *testing.T) {
	cases := []struct {
		name string
		doc  bson.M
		want PushFrom
	}{
		{"prod shape, zero", bson.M{"from": bson.M{"high": int32(0), "low": int32(0), "unsigned": false}}, 0},
		{"low half only", bson.M{"from": bson.M{"high": int32(0), "low": int32(1500)}}, 1500},
		{"high half sets the upper word", bson.M{"from": bson.M{"high": int32(1), "low": int32(0)}}, 1 << 32},
		// low is an unsigned 32-bit value carried in a signed field: without
		// masking, a "negative" low corrupts the reassembled number.
		{"low with the sign bit set", bson.M{"from": bson.M{"high": int32(0), "low": int32(-1)}}, 0xFFFFFFFF},
		{"unrecognized document shape falls back to 0", bson.M{"from": bson.M{"nope": "x"}}, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := bson.Marshal(tc.doc)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var out struct {
				From PushFrom `bson:"from"`
			}
			if err := bson.Unmarshal(raw, &out); err != nil {
				t.Fatalf("unmarshal returned an error (this is the bug): %v", err)
			}
			if out.From != tc.want {
				t.Errorf("From = %d, want %d", out.From, tc.want)
			}
		})
	}
}

// The normal path must keep working — most records store a plain int64.
func TestPushFromDecodesNumbers(t *testing.T) {
	cases := []struct {
		name string
		doc  bson.M
		want PushFrom
	}{
		{"int64 zero", bson.M{"from": int64(0)}, 0},
		{"int64 realtime sentinel", bson.M{"from": int64(-1)}, -1},
		{"int64 nanoseconds", bson.M{"from": int64(1735689600000000000)}, 1735689600000000000},
		{"int32", bson.M{"from": int32(42)}, 42},
		{"double", bson.M{"from": float64(99)}, 99},
		{"null", bson.M{"from": nil}, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := bson.Marshal(tc.doc)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var out struct {
				From PushFrom `bson:"from"`
			}
			if err := bson.Unmarshal(raw, &out); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if out.From != tc.want {
				t.Errorf("From = %d, want %d", out.From, tc.want)
			}
		})
	}
}

// Whatever shape came in, what this server writes back is a plain int64.
func TestPushFromMarshalsAsInt64(t *testing.T) {
	raw, err := bson.Marshal(bson.M{"from": PushFrom(-1)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out struct {
		From int64 `bson:"from"`
	}
	if err := bson.Unmarshal(raw, &out); err != nil {
		t.Fatalf("plain int64 could not read it back: %v", err)
	}
	if out.From != -1 {
		t.Errorf("From = %d, want -1", out.From)
	}
}

// A malformed record must not break decoding of the others alongside it —
// that blast radius was the actual severity of this bug.
func TestOneBadRecordDoesNotBreakTheList(t *testing.T) {
	docs := []bson.M{
		{"name": "good", "from": int64(5)},
		{"name": "bad", "from": bson.M{"high": int32(0), "low": int32(0), "unsigned": false}},
		{"name": "also good", "from": int64(-1)},
	}
	want := []PushFrom{5, 0, -1}

	for i, d := range docs {
		raw, err := bson.Marshal(d)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var out struct {
			Name string   `bson:"name"`
			From PushFrom `bson:"from"`
		}
		if err := bson.Unmarshal(raw, &out); err != nil {
			t.Fatalf("record %q failed to decode: %v", d["name"], err)
		}
		if out.From != want[i] {
			t.Errorf("%s: From = %d, want %d", out.Name, out.From, want[i])
		}
	}
}
