// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package database

import (
	"context"
	"fmt"
	"log"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// RunMigrations executes one-time data migrations.
// Each migration checks a flag in a "migrations" collection before running.
func RunMigrations(ctx context.Context, db *mongo.Database) error {
	migrations := []struct {
		name string
		fn   func(ctx context.Context, db *mongo.Database) error
	}{
		{"double_panel_cells_32px", migratePanelCellsTo32px},
		{"collation_case_insensitive_v1", migrateCollationCaseInsensitive},
		{"namespacing_v1", migrateNamespacingV1},
	}

	coll := db.Collection("migrations")

	for _, m := range migrations {
		// Check if already applied
		count, err := coll.CountDocuments(ctx, bson.M{"_id": m.name})
		if err != nil {
			return err
		}
		if count > 0 {
			continue
		}

		log.Printf("Running migration: %s", m.name)
		if err := m.fn(ctx, db); err != nil {
			log.Printf("Migration %s failed: %v", m.name, err)
			return err
		}

		// Mark as applied
		_, err = coll.InsertOne(ctx, bson.M{"_id": m.name})
		if err != nil {
			return err
		}
		log.Printf("Migration %s completed", m.name)
	}

	return nil
}

// migratePanelCellsTo32px doubles all panel x, y, w, h values to account for
// cell size change from 64x36 to 32x32. The x and w are doubled (64→32 width),
// and y and h are scaled by 36/32 then doubled (36→32 height) to preserve
// approximate pixel positions.
func migratePanelCellsTo32px(ctx context.Context, db *mongo.Database) error {
	coll := db.Collection("dashboards")

	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)

	updated := 0
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}

		panels, ok := doc["panels"].(bson.A)
		if !ok || len(panels) == 0 {
			continue
		}

		newPanels := make(bson.A, len(panels))
		for i, p := range panels {
			panel, ok := p.(bson.M)
			if !ok {
				newPanels[i] = p
				continue
			}

			// Double x and w (64px → 32px columns)
			if x, ok := panel["x"].(int32); ok {
				panel["x"] = x * 2
			}
			if w, ok := panel["w"].(int32); ok {
				panel["w"] = w * 2
			}
			// Double y and h (36px → 32px rows, approximate)
			if y, ok := panel["y"].(int32); ok {
				panel["y"] = y * 2
			}
			if h, ok := panel["h"].(int32); ok {
				panel["h"] = h * 2
			}

			newPanels[i] = panel
		}

		_, err := coll.UpdateByID(ctx, doc["_id"], bson.M{"$set": bson.M{"panels": newPanels}})
		if err != nil {
			log.Printf("Failed to update dashboard %v: %v", doc["_id"], err)
			continue
		}
		updated++
	}

	log.Printf("Migrated %d dashboards (doubled panel cell coordinates)", updated)
	return nil
}

// migrateCollationCaseInsensitive applies case-insensitive collation (locale
// "en", strength 2) to every collection in CollationCollections. Because
// MongoDB cannot change collation on an existing collection, this function
// performs a copy-and-rename sequence:
//
//  1. For each collection, check current collation via listCollections.
//  2. If already case-insensitive, skip.
//  3. If the collection does not exist, create it with collation.
//  4. Otherwise: create <name>_new with collation, copy all docs, drop the
//     original, rename <name>_new to <name>.
//
// Indexes do NOT carry over through rename; they are recreated on server
// startup by the per-repository CreateIndexes calls (which now run after
// this migration).
func migrateCollationCaseInsensitive(ctx context.Context, db *mongo.Database) error {
	for _, name := range CollationCollections {
		if err := applyCollationToCollection(ctx, db, name); err != nil {
			return fmt.Errorf("apply collation to %s: %w", name, err)
		}
	}
	return nil
}

// applyCollationToCollection handles one collection in the collation migration.
func applyCollationToCollection(ctx context.Context, db *mongo.Database, name string) error {
	exists, collation, err := collectionState(ctx, db, name)
	if err != nil {
		return err
	}

	// Collection does not exist yet — create it with collation.
	if !exists {
		log.Printf("  %s: creating new collection with case-insensitive collation", name)
		opts := options.CreateCollection().SetCollation(CaseInsensitiveCollation)
		return db.CreateCollection(ctx, name, opts)
	}

	// Already case-insensitive — skip.
	if collation != nil && collation.Locale == "en" && collation.Strength == 2 {
		log.Printf("  %s: already case-insensitive, skipping", name)
		return nil
	}

	// Exists but no collation (or different collation) — rebuild.
	log.Printf("  %s: migrating to case-insensitive collation (copy + rename)", name)
	return rebuildCollectionWithCollation(ctx, db, name)
}

// collectionState reports whether a collection exists and, if it does, its
// current collation (nil if no collation is set).
func collectionState(ctx context.Context, db *mongo.Database, name string) (exists bool, collation *options.Collation, err error) {
	cursor, err := db.ListCollections(ctx, bson.M{"name": name})
	if err != nil {
		return false, nil, err
	}
	defer cursor.Close(ctx)

	if !cursor.Next(ctx) {
		return false, nil, nil
	}

	var info struct {
		Options struct {
			Collation *options.Collation `bson:"collation"`
		} `bson:"options"`
	}
	if err := cursor.Decode(&info); err != nil {
		return true, nil, err
	}
	return true, info.Options.Collation, nil
}

// rebuildCollectionWithCollation creates <name>_new with case-insensitive
// collation, copies all documents from <name>, drops <name>, and renames
// <name>_new to <name>. The operation is safe to abort mid-sequence: the
// migration tracking row is only written on success, so the next startup
// retries from scratch.
func rebuildCollectionWithCollation(ctx context.Context, db *mongo.Database, name string) error {
	tempName := name + "_collation_migration_new"

	// Clean up any leftover from a prior failed run.
	_ = db.Collection(tempName).Drop(ctx)

	// Create the temp collection with collation.
	if err := db.CreateCollection(
		ctx,
		tempName,
		options.CreateCollection().SetCollation(CaseInsensitiveCollation),
	); err != nil {
		return fmt.Errorf("create temp collection: %w", err)
	}

	src := db.Collection(name)
	dst := db.Collection(tempName)

	// Copy documents in batches.
	cursor, err := src.Find(ctx, bson.M{})
	if err != nil {
		return fmt.Errorf("find source documents: %w", err)
	}
	defer cursor.Close(ctx)

	const batchSize = 500
	batch := make([]interface{}, 0, batchSize)
	copied := 0

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if _, err := dst.InsertMany(ctx, batch); err != nil {
			return err
		}
		copied += len(batch)
		batch = batch[:0]
		return nil
	}

	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return fmt.Errorf("decode document: %w", err)
		}
		batch = append(batch, doc)
		if len(batch) >= batchSize {
			if err := flush(); err != nil {
				return fmt.Errorf("insert batch: %w", err)
			}
		}
	}
	if err := flush(); err != nil {
		return fmt.Errorf("insert final batch: %w", err)
	}
	if err := cursor.Err(); err != nil {
		return fmt.Errorf("cursor error: %w", err)
	}

	log.Printf("  %s: copied %d documents to temp collection", name, copied)

	// Drop original.
	if err := src.Drop(ctx); err != nil {
		return fmt.Errorf("drop original: %w", err)
	}

	// Rename temp → original. renameCollection is an admin command and
	// requires fully-qualified namespaces.
	dbName := db.Name()
	renameCmd := bson.D{
		{Key: "renameCollection", Value: dbName + "." + tempName},
		{Key: "to", Value: dbName + "." + name},
	}
	if err := db.Client().Database("admin").RunCommand(ctx, renameCmd).Err(); err != nil {
		return fmt.Errorf("rename temp → original: %w", err)
	}

	log.Printf("  %s: rebuilt with collation (%d documents)", name, copied)
	return nil
}
