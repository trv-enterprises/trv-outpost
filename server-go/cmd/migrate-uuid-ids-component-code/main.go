// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.
//
// Companion to migrate-uuid-ids: rewrites old connection ObjectID-hex
// strings INSIDE component_code source. The original migration only
// rewrote the structured connection_id field on each component, but
// chart authors often hard-code `connectionId: '<hex>'` directly in
// their JavaScript — those strings need rewriting too or the runtime
// will hit "connection not found" on every fetch.
//
// Builds the oldHex → newUUID map by joining a `connections_premigration`
// snapshot collection (restored from mongodump) against the live
// `connections` collection by name.
//
// Run on each environment that has been migrated:
//   1. mongorestore --uri=mongodb://<host>:27017 --db=dashboard \
//        --collection=connections_premigration backups/<...>/connections.bson
//   2. MONGO_URI=mongodb://<host>:27017 go run ./cmd/migrate-uuid-ids-component-code
//   3. (optional) mongo: db.connections_premigration.drop()
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const dbName = "dashboard"

var objectIDHex = regexp.MustCompile(`[0-9a-f]{24}`)

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

	idMap, err := buildIDMap(ctx, db)
	if err != nil {
		log.Fatalf("build id map: %v", err)
	}
	log.Printf("built oldHex → newUUID map: %d entries", len(idMap))
	if len(idMap) == 0 {
		log.Println("no mappings — was connections_premigration restored?")
		return
	}
	for old, new := range idMap {
		log.Printf("  %s → %s", old, new)
	}

	stats, err := rewriteComponentCode(ctx, db, idMap)
	if err != nil {
		log.Fatalf("rewrite component_code: %v", err)
	}
	log.Printf("scanned=%d  modified=%d  hex_replacements=%d  unmapped_hex_skipped=%d",
		stats.scanned, stats.modified, stats.replacements, stats.unmappedSkipped)
}

func buildIDMap(ctx context.Context, db *mongo.Database) (map[string]string, error) {
	idMap := make(map[string]string)

	pre := db.Collection("connections_premigration")
	cur := db.Collection("connections")

	cursor, err := pre.Find(ctx, bson.M{})
	if err != nil {
		return nil, fmt.Errorf("read pre-mig: %w", err)
	}
	defer cursor.Close(ctx)

	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		oldID, ok := doc["_id"]
		if !ok {
			continue
		}
		// Stringify old _id (it's an ObjectID).
		var oldHex string
		switch v := oldID.(type) {
		case string:
			oldHex = v
		default:
			// primitive.ObjectID has a Hex() method but we'll get it
			// via fmt.Sprintf — bson.M decode of ObjectID gives us a
			// primitive.ObjectID value which prints as "ObjectID(...)"
			// via %v. Use type assertion to the actual type.
			oldHex = fmt.Sprintf("%v", v)
			// Strip the ObjectID("…") wrapper if present.
			if strings.HasPrefix(oldHex, "ObjectID(\"") && strings.HasSuffix(oldHex, "\")") {
				oldHex = oldHex[len("ObjectID(\"") : len(oldHex)-2]
			}
		}
		name, _ := doc["name"].(string)
		namespace, _ := doc["namespace"].(string)
		if oldHex == "" || name == "" {
			continue
		}

		// Look up current connection by (namespace, name).
		filter := bson.M{"name": name}
		if namespace != "" {
			filter["namespace"] = namespace
		}
		var current bson.M
		if err := cur.FindOne(ctx, filter).Decode(&current); err != nil {
			if err == mongo.ErrNoDocuments {
				log.Printf("    skip %s (%s) — no current connection found", oldHex, name)
				continue
			}
			return nil, fmt.Errorf("lookup current %s: %w", name, err)
		}
		newID, ok := current["_id"].(string)
		if !ok {
			log.Printf("    skip %s — current connection's _id is not a string", oldHex)
			continue
		}
		idMap[oldHex] = newID
	}
	return idMap, cursor.Err()
}

type rewriteStats struct {
	scanned         int
	modified        int
	replacements    int
	unmappedSkipped int
}

func rewriteComponentCode(ctx context.Context, db *mongo.Database, idMap map[string]string) (rewriteStats, error) {
	stats := rewriteStats{}
	coll := db.Collection("components")

	cursor, err := coll.Find(ctx, bson.M{"component_code": bson.M{"$exists": true, "$ne": ""}})
	if err != nil {
		return stats, err
	}
	defer cursor.Close(ctx)

	for cursor.Next(ctx) {
		stats.scanned++
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return stats, err
		}
		code, ok := doc["component_code"].(string)
		if !ok || code == "" {
			continue
		}

		newCode, repl, unmapped := rewriteHexInString(code, idMap)
		stats.replacements += repl
		stats.unmappedSkipped += unmapped
		if repl == 0 {
			continue
		}

		if _, err := coll.UpdateOne(ctx, bson.M{"_id": doc["_id"]}, bson.M{"$set": bson.M{"component_code": newCode}}); err != nil {
			return stats, fmt.Errorf("update _id=%v: %w", doc["_id"], err)
		}
		stats.modified++
		if name, _ := doc["name"].(string); name != "" {
			log.Printf("  %s (%s): %d hex(es) rewritten", name, doc["_id"], repl)
		}
	}
	return stats, cursor.Err()
}

// rewriteHexInString replaces every 24-hex-char substring in s using
// the idMap. Returns the new string, count of replacements, and count
// of hex matches that weren't in the map (skipped).
func rewriteHexInString(s string, idMap map[string]string) (string, int, int) {
	repl := 0
	unmapped := 0
	out := objectIDHex.ReplaceAllStringFunc(s, func(match string) string {
		if newID, ok := idMap[match]; ok {
			repl++
			return newID
		}
		unmapped++
		return match
	})
	return out, repl, unmapped
}
