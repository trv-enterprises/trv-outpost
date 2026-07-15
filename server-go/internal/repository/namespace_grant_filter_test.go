// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"reflect"
	"testing"

	"go.mongodb.org/mongo-driver/bson"
)

func TestApplyNamespaceGrant(t *testing.T) {
	t.Run("unrestricted is a no-op", func(t *testing.T) {
		filter := bson.M{"name": "x"}
		applyNamespaceGrant(filter, false, nil)
		if _, has := filter["$and"]; has {
			t.Fatal("unrestricted must not add clauses")
		}
	})

	t.Run("restricted adds strict $in", func(t *testing.T) {
		filter := bson.M{}
		applyNamespaceGrant(filter, true, []string{"home"})
		and, ok := filter["$and"].([]bson.M)
		if !ok || len(and) != 1 {
			t.Fatalf("$and wrong: %#v", filter)
		}
		want := bson.M{"namespace": bson.M{"$in": []string{"home"}}}
		if !reflect.DeepEqual(and[0], want) {
			t.Fatalf("clause = %#v, want %#v", and[0], want)
		}
	})

	t.Run("restricted with nil allowed matches nothing", func(t *testing.T) {
		filter := bson.M{}
		applyNamespaceGrant(filter, true, nil)
		and := filter["$and"].([]bson.M)
		in := and[0]["namespace"].(bson.M)["$in"].([]string)
		if len(in) != 0 {
			t.Fatalf("expected empty $in (fail closed), got %v", in)
		}
	})

	t.Run("explicit namespace filter wins (service intersected already)", func(t *testing.T) {
		filter := bson.M{"namespace": "home"}
		applyNamespaceGrant(filter, true, []string{"home", "lab"})
		if _, has := filter["$and"]; has {
			t.Fatal("explicit namespace filter must be left alone")
		}
	})

	t.Run("does not clobber an existing top-level $or", func(t *testing.T) {
		// The component list filter uses $or for type matching.
		filter := bson.M{"$or": []bson.M{{"chart_type": "line"}}}
		applyNamespaceGrant(filter, true, []string{"home"})
		if _, has := filter["$or"]; !has {
			t.Fatal("type $or was clobbered")
		}
		if _, has := filter["$and"]; !has {
			t.Fatal("grant clause missing")
		}
	})
}
