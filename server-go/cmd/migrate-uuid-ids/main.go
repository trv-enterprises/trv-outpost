// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.
//
// One-shot migration: give every connection a UUID `_id` (matching the
// convention already used by `dashboards`, `namespaces`, `users`, etc.)
// and rewrite component → connection references to use those UUIDs.
//
// Components themselves are NOT promoted to UUID `_id`. The components
// collection is a multi-version store: each row is one version of an
// entity, and rows sharing the same `id` UUID belong to the same
// entity. The `id` field IS the canonical entity identity; the per-row
// `_id` is a Mongo-internal detail. Promoting `id` to `_id` would
// collapse versions (Mongo's _id uniqueness wouldn't allow it) and
// destroy version history.
//
// Before:
//   connections:  _id = ObjectID (auto)         (no separate id field)
//   components:   _id = ObjectID (per-row), id = UUID (per-entity)
//                 connection_id = ObjectID-hex string
// After:
//   connections:  _id = UUID
//   components:   _id = ObjectID (per-row, unchanged), id = UUID (per-entity, unchanged)
//                 connection_id = UUID  (rewritten via map)
//                 display_config.frigate_connection_id = UUID
//                 display_config.mqtt_connection_id    = UUID
//
// Run:
//   MONGO_URI=mongodb://localhost:27017 go run ./cmd/migrate-uuid-ids
//   MONGO_URI=mongodb://100.97.221.61:27017 go run ./cmd/migrate-uuid-ids
//
// The script is idempotent: it skips connection docs whose `_id` is
// already a UUID-shaped string, and component docs that have no `id`
// field. Re-running on a migrated database is a no-op (exit 0, "nothing
// to do").
//
// Records a row in the `migrations` collection with key `uuid_ids_v1`
// for visibility.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const (
	migrationKey = "uuid_ids_v1"
	dbName       = "dashboard"
)

// 24-character hex string — the shape of an old ObjectID stringified
// onto components.connection_id by the legacy code path.
var objectIDHex = regexp.MustCompile(`^[0-9a-f]{24}$`)

func main() {
	uri := os.Getenv("MONGO_URI")
	if uri == "" {
		log.Fatal("MONGO_URI must be set (e.g., mongodb://localhost:27017)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(uri))
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer client.Disconnect(context.Background())

	if err := client.Ping(ctx, nil); err != nil {
		log.Fatalf("ping: %v", err)
	}

	db := client.Database(dbName)
	connections := db.Collection("connections")
	components := db.Collection("components")
	migrations := db.Collection("migrations")

	// Idempotency check
	if err := migrations.FindOne(ctx, bson.M{"_id": migrationKey}).Err(); err == nil {
		log.Printf("migration %q already recorded — re-running anyway as a no-op verifier", migrationKey)
	}

	log.Println("=== phase 1: connections ===")
	connMap, connStats, err := migrateConnections(ctx, connections)
	if err != nil {
		log.Fatalf("connections: %v", err)
	}
	log.Printf("  scanned=%d  migrated=%d  already_uuid=%d", connStats.scanned, connStats.migrated, connStats.alreadyUUID)

	log.Println("=== phase 2: components ===")
	compStats, err := migrateComponents(ctx, components, connMap)
	if err != nil {
		log.Fatalf("components: %v", err)
	}
	log.Printf("  scanned=%d  rewrote_connection_id=%d  rewrote_frigate_id=%d  rewrote_mqtt_id=%d  orphaned_refs_unset=%d",
		compStats.scanned, compStats.rewroteConn, compStats.rewroteFrigate, compStats.rewroteMQTT, compStats.orphanedConn)

	log.Println("=== phase 3: verification ===")
	if err := verify(ctx, connections, components); err != nil {
		log.Fatalf("verification failed: %v", err)
	}
	log.Println("  ✓ all connections have UUID _id (no ObjectID-typed _id remains)")
	log.Println("  ✓ no components reference connections via ObjectID-hex strings")

	log.Println("=== phase 4: record migration ===")
	_, err = migrations.UpdateOne(ctx,
		bson.M{"_id": migrationKey},
		bson.M{"$set": bson.M{
			"applied_at": time.Now().UTC(),
			"description": "collapse dual-id (ObjectID + UUID) on connections + components into UUID _id",
		}},
		options.Update().SetUpsert(true),
	)
	if err != nil {
		log.Fatalf("record migration: %v", err)
	}
	log.Println("  ✓ migration recorded in migrations collection")
	log.Println("done.")
}

type connStats struct {
	scanned     int
	migrated    int
	alreadyUUID int
}

// migrateConnections reads every connection doc, generates a UUID for
// any that still have an ObjectID `_id`, inserts the new doc, deletes
// the old one, and returns a map oldHex → newUUID for component
// reference rewriting in phase 2.
func migrateConnections(ctx context.Context, coll *mongo.Collection) (map[string]string, connStats, error) {
	stats := connStats{}
	idMap := make(map[string]string)

	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		return nil, stats, err
	}
	defer cursor.Close(ctx)

	type rawConn struct {
		ID interface{} `bson:"_id"`
	}

	// We need the full doc to re-insert it under the new _id, so we
	// stream raw bson.M docs and rewrite the _id field per doc.
	for cursor.Next(ctx) {
		stats.scanned++

		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return nil, stats, fmt.Errorf("decode: %w", err)
		}

		rawID, ok := doc["_id"]
		if !ok {
			return nil, stats, fmt.Errorf("connection missing _id: %v", doc)
		}

		// If _id is already a string (UUID), nothing to do.
		if s, ok := rawID.(string); ok {
			stats.alreadyUUID++
			// Defensive: still record the identity mapping in case any
			// component connection_id was already updated to the UUID
			// during a prior partial run.
			idMap[s] = s
			continue
		}

		// Expect ObjectID type.
		oid, ok := rawID.(primitive.ObjectID)
		if !ok {
			return nil, stats, fmt.Errorf("connection _id is neither string nor ObjectID: %T %v", rawID, rawID)
		}
		oldHex := oid.Hex()
		newUUID := uuid.NewString()
		idMap[oldHex] = newUUID

		// Build the replacement doc with new _id.
		newDoc := bson.M{}
		for k, v := range doc {
			if k == "_id" {
				continue
			}
			newDoc[k] = v
		}
		newDoc["_id"] = newUUID

		// Delete old first, then insert new. The reverse order would
		// trip the unique compound index on (namespace, name) — Mongo
		// would see two docs with the same (ns, name) for a moment and
		// reject the insert. Standalone Mongo doesn't support
		// multi-doc transactions, so we accept a brief window where
		// the doc is gone before re-inserting; if the insert fails,
		// we log and bail so the operator can restore from backup or
		// re-insert manually.
		if _, err := coll.DeleteOne(ctx, bson.M{"_id": oid}); err != nil {
			return nil, stats, fmt.Errorf("delete old connection %s: %w", oldHex, err)
		}
		if _, err := coll.InsertOne(ctx, newDoc); err != nil {
			return nil, stats, fmt.Errorf("insert new connection %s after delete (data loss risk — restore from backup): %w", newUUID, err)
		}
		stats.migrated++
		log.Printf("    %s → %s", oldHex, newUUID)
	}
	return idMap, stats, cursor.Err()
}

type compStats struct {
	scanned        int
	rewroteConn    int
	rewroteFrigate int
	rewroteMQTT    int
	orphanedConn   int // refs to ObjectID hex not present in connections (dangling)
}

// migrateComponents rewrites every connection-id reference on each
// component (connection_id, display_config.frigate_connection_id,
// display_config.mqtt_connection_id) using the connections idMap.
//
// Components are intentionally NOT promoted to UUID `_id`: the
// collection is a multi-version store where each document is one
// version of an entity, and rows sharing the same `id` UUID belong
// to the same entity. Promoting `id` to `_id` would collapse versions
// (which Mongo's _id uniqueness wouldn't allow) and lose history.
// The canonical entity identity is the `id` field; the per-row `_id`
// (auto-generated ObjectID) is a Mongo-internal detail that's never
// referenced externally. So the only thing to fix here is the
// foreign-key references — which were storing connection ObjectIDs
// before the migration.
func migrateComponents(ctx context.Context, coll *mongo.Collection, idMap map[string]string) (compStats, error) {
	stats := compStats{}

	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		return stats, err
	}
	defer cursor.Close(ctx)

	for cursor.Next(ctx) {
		stats.scanned++
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return stats, fmt.Errorf("decode: %w", err)
		}

		updates := bson.M{}
		unsets := bson.M{}

		// Helper: rewrite a connection ref. If the ref is an ObjectID
		// hex but isn't in idMap, the connection has been deleted —
		// the reference is dangling. Null it out (the component was
		// already broken; pointing at a non-existent ObjectID is just
		// misleading) and log so the operator knows.
		handleRef := func(currentValue string, fieldPath, fieldKind string, statRewrote *int) {
			if currentValue == "" {
				return
			}
			if newID, found := idMap[currentValue]; found {
				if newID != currentValue {
					updates[fieldPath] = newID
					*statRewrote++
				}
				return
			}
			if objectIDHex.MatchString(currentValue) {
				// Dangling ObjectID-hex ref — connection was deleted.
				unsets[fieldPath] = ""
				stats.orphanedConn++
				log.Printf("    component %v %s=%s → orphan (connection deleted), unsetting", doc["_id"], fieldKind, currentValue)
			}
			// If currentValue isn't ObjectID hex format, assume it's
			// already a UUID and leave it alone.
		}

		if cid, ok := doc["connection_id"].(string); ok {
			handleRef(cid, "connection_id", "connection_id", &stats.rewroteConn)
		}
		if dc, ok := doc["display_config"].(bson.M); ok {
			if v, ok := dc["frigate_connection_id"].(string); ok {
				handleRef(v, "display_config.frigate_connection_id", "frigate_connection_id", &stats.rewroteFrigate)
			}
			if v, ok := dc["mqtt_connection_id"].(string); ok {
				handleRef(v, "display_config.mqtt_connection_id", "mqtt_connection_id", &stats.rewroteMQTT)
			}
		}

		if len(updates) == 0 && len(unsets) == 0 {
			continue
		}
		op := bson.M{}
		if len(updates) > 0 {
			op["$set"] = updates
		}
		if len(unsets) > 0 {
			op["$unset"] = unsets
		}
		if _, err := coll.UpdateOne(ctx, bson.M{"_id": doc["_id"]}, op); err != nil {
			return stats, fmt.Errorf("update component _id=%v: %w", doc["_id"], err)
		}
	}
	return stats, cursor.Err()
}

func verify(ctx context.Context, connections, components *mongo.Collection) error {
	// 1. No connection should still have ObjectID _id.
	objectIDConns, err := connections.CountDocuments(ctx, bson.M{"_id": bson.M{"$type": "objectId"}})
	if err != nil {
		return err
	}
	if objectIDConns > 0 {
		return fmt.Errorf("%d connections still have ObjectID _id", objectIDConns)
	}

	// 2. No component should still reference a connection via an
	//    ObjectID-hex string. We scan; the regex match is done in Go
	//    because Mongo's $regex is plenty fast for this size but we
	//    want to print the offenders if any are found.
	cursor, err := components.Find(ctx, bson.M{
		"$or": bson.A{
			bson.M{"connection_id": bson.M{"$regex": "^[0-9a-f]{24}$"}},
			bson.M{"display_config.frigate_connection_id": bson.M{"$regex": "^[0-9a-f]{24}$"}},
			bson.M{"display_config.mqtt_connection_id": bson.M{"$regex": "^[0-9a-f]{24}$"}},
		},
	})
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	var bad []string
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return err
		}
		fields := []string{}
		if v, ok := doc["connection_id"].(string); ok && objectIDHex.MatchString(v) {
			fields = append(fields, "connection_id="+v)
		}
		if dc, ok := doc["display_config"].(bson.M); ok {
			if v, ok := dc["frigate_connection_id"].(string); ok && objectIDHex.MatchString(v) {
				fields = append(fields, "frigate_connection_id="+v)
			}
			if v, ok := dc["mqtt_connection_id"].(string); ok && objectIDHex.MatchString(v) {
				fields = append(fields, "mqtt_connection_id="+v)
			}
		}
		if len(fields) > 0 {
			bad = append(bad, fmt.Sprintf("%v: %v", doc["_id"], fields))
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("components with unresolved ObjectID-hex refs:\n  %v", bad)
	}
	return nil
}
