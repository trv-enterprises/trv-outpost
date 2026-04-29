// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package database

import (
	"context"
	"fmt"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// migrateNamespacingV1 backfills the namespace field on every existing
// connection/component/dashboard record, resolves (namespace, name)
// collisions inside the `default` bucket by auto-renaming, and drops the
// old name-only unique indexes on datasources + dashboards so the
// compound indexes in mongodb.go can replace them on the next
// CreateIndexes call.
//
// This runs exactly once per deployment (tracked in the `migrations`
// collection). It's intentionally idempotent at every step — rerunning
// a partial run is safe.
//
// Steps:
//  1. Seed the `default` namespace row if missing (normally redundant
//     with the startup SeedDefault call, but we can't depend on call
//     ordering between the two).
//  2. UpdateMany: for each entity collection, set namespace=default on
//     records where namespace is missing or empty.
//  3. Within the default bucket, find (namespace, name) collisions and
//     rename the younger records with a numeric suffix until unique.
//     Charts are versioned — a single chart id has many rows, so we
//     group by id first, pick the oldest id as the winner, and rename
//     every version of the losing ids together.
//  4. Drop the legacy name_1 unique indexes on datasources + dashboards.
//     (Charts never had a unique name index.) The new compound indexes
//     are created by CreateIndexes at startup, after this migration.
func migrateNamespacingV1(ctx context.Context, db *mongo.Database) error {
	// Step 1: ensure default namespace row exists.
	if err := ensureDefaultNamespaceRow(ctx, db); err != nil {
		return fmt.Errorf("seed default namespace: %w", err)
	}

	// Step 2: backfill namespace=default on legacy records.
	backfillFilter := bson.M{
		"$or": []bson.M{
			{"namespace": bson.M{"$exists": false}},
			{"namespace": ""},
		},
	}
	backfillUpdate := bson.M{"$set": bson.M{"namespace": "default"}}

	for _, name := range []string{"datasources", "components", "dashboards"} {
		res, err := db.Collection(name).UpdateMany(ctx, backfillFilter, backfillUpdate)
		if err != nil {
			return fmt.Errorf("backfill namespace on %s: %w", name, err)
		}
		log.Printf("  namespacing_v1: backfilled %d %s records with namespace=default", res.ModifiedCount, name)
	}

	// Step 3: resolve collisions within the default bucket.
	if err := resolveNamespaceCollisions(ctx, db, "datasources", false); err != nil {
		return fmt.Errorf("resolve datasource collisions: %w", err)
	}
	if err := resolveNamespaceCollisions(ctx, db, "dashboards", false); err != nil {
		return fmt.Errorf("resolve dashboard collisions: %w", err)
	}
	if err := resolveNamespaceCollisions(ctx, db, "components", true); err != nil {
		return fmt.Errorf("resolve component collisions: %w", err)
	}

	// Step 4: drop old unique name indexes. Tolerate "not found" because
	// a fresh DB that never had the old index still errors cleanly.
	for _, name := range []string{"datasources", "dashboards"} {
		if _, err := db.Collection(name).Indexes().DropOne(ctx, "name_1"); err != nil {
			// Mongo returns a CommandError with code 27 (IndexNotFound) when
			// the index doesn't exist — log and continue.
			log.Printf("  namespacing_v1: dropping %s.name_1 index (ok if not found): %v", name, err)
		}
	}

	return nil
}

// ensureDefaultNamespaceRow upserts the `default` namespace in the
// namespaces collection. Kept outside the service layer because this
// migration runs inside the database package before any service is
// instantiated.
func ensureDefaultNamespaceRow(ctx context.Context, db *mongo.Database) error {
	now := time.Now()
	_, err := db.Collection("namespaces").UpdateOne(
		ctx,
		bson.M{"_id": "default"},
		bson.M{
			"$set": bson.M{
				"name":        "default",
				"description": "Default namespace — legacy records migrate here and new records land here unless an active namespace is selected.",
				"color":       "#6f6f6f",
				"updated":     now,
			},
			"$setOnInsert": bson.M{
				"created": now,
			},
		},
		options.Update().SetUpsert(true),
	)
	return err
}

// resolveNamespaceCollisions finds duplicate (namespace, name) pairs in
// a collection (scoped to namespace=default) and renames the non-winning
// records with a numeric suffix so the new compound unique index can be
// created without rejecting any pre-existing data.
//
// Winner = earliest-created record. For versioned collections (charts),
// the "record" is an id — winner's ALL versions keep the name, and every
// version of every loser id is renamed together.
func resolveNamespaceCollisions(ctx context.Context, db *mongo.Database, collName string, versioned bool) error {
	coll := db.Collection(collName)

	// Find groups of 2+ records sharing (namespace=default, name).
	var groupStage bson.M
	if versioned {
		// Versioned collections: collapse to unique ids first (min created
		// per id), then group by name to find id-level collisions.
		groupStage = bson.M{
			"$group": bson.M{
				"_id":     bson.M{"id": "$id"},
				"created": bson.M{"$min": "$created"},
				"name":    bson.M{"$first": "$name"},
			},
		}
	} else {
		groupStage = bson.M{
			"$group": bson.M{
				"_id":     "$_id",
				"created": bson.M{"$first": "$created_at"}, // datasource/dashboard field name
				"name":    bson.M{"$first": "$name"},
			},
		}
	}

	match := bson.M{"$match": bson.M{"namespace": "default"}}
	groupByName := bson.M{
		"$group": bson.M{
			"_id":   "$name",
			"count": bson.M{"$sum": 1},
			"items": bson.M{"$push": bson.M{
				"id":      "$_id",
				"created": "$created",
			}},
		},
	}
	onlyDupes := bson.M{"$match": bson.M{"count": bson.M{"$gt": 1}}}

	pipeline := []bson.M{match, groupStage, groupByName, onlyDupes}
	cursor, err := coll.Aggregate(ctx, pipeline)
	if err != nil {
		return fmt.Errorf("aggregate collisions: %w", err)
	}
	defer cursor.Close(ctx)

	type groupItem struct {
		ID      interface{} `bson:"id"`
		Created time.Time   `bson:"created"`
	}
	type groupResult struct {
		Name  string      `bson:"_id"`
		Count int         `bson:"count"`
		Items []groupItem `bson:"items"`
	}

	var groups []groupResult
	if err := cursor.All(ctx, &groups); err != nil {
		return err
	}

	if len(groups) == 0 {
		return nil
	}
	log.Printf("  namespacing_v1: %s — resolving %d name collision group(s)", collName, len(groups))

	for _, g := range groups {
		// Sort items by created ascending — oldest wins. Items is small,
		// a bubble sort would be fine but a single-pass O(n^2) min-finder
		// keeps the code dependency-free.
		winner := g.Items[0]
		for _, it := range g.Items[1:] {
			if it.Created.Before(winner.Created) {
				winner = it
			}
		}

		// Rename every loser, picking the next free suffix by checking
		// existing names as we go.
		suffix := 2
		for _, it := range g.Items {
			if it.ID == winner.ID {
				continue
			}
			newName, err := nextFreeName(ctx, coll, g.Name, &suffix)
			if err != nil {
				return fmt.Errorf("pick unique name for %s/%s: %w", collName, g.Name, err)
			}
			if err := renameRecord(ctx, coll, collName, it.ID, newName, versioned); err != nil {
				return fmt.Errorf("rename %s record %v: %w", collName, it.ID, err)
			}
			log.Printf("    %s: renamed %q → %q (id=%v, reason=collision in default namespace)", collName, g.Name, newName, it.ID)
		}
	}

	return nil
}

// nextFreeName increments the suffix counter until a name with that
// suffix doesn't already exist in the (namespace=default) scope. The
// caller owns the counter so a single collision group produces
// `foo-2`, `foo-3`, `foo-4`, … without reusing suffixes within the group.
func nextFreeName(ctx context.Context, coll *mongo.Collection, base string, suffix *int) (string, error) {
	for {
		candidate := fmt.Sprintf("%s-%d", base, *suffix)
		*suffix++
		count, err := coll.CountDocuments(ctx, bson.M{
			"namespace": "default",
			"name":      candidate,
		})
		if err != nil {
			return "", err
		}
		if count == 0 {
			return candidate, nil
		}
	}
}

// renameRecord updates a record's name. For versioned collections the
// "record" is an id with N versions; all rows sharing that id get
// renamed together so later list queries still find the same logical
// chart under the new name.
func renameRecord(ctx context.Context, coll *mongo.Collection, collName string, id interface{}, newName string, versioned bool) error {
	var filter bson.M
	if versioned {
		// charts: id field is "id", not _id
		filter = bson.M{"id": id}
	} else {
		filter = bson.M{"_id": id}
	}
	_, err := coll.UpdateMany(ctx, filter, bson.M{"$set": bson.M{"name": newName}})
	return err
}
