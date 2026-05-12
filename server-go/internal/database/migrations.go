// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package database

import (
	"context"
	"fmt"
	"log"
	"strings"

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
		{"strip_chart_thumbnail_v1", migrateStripChartThumbnail},
		{"rename_charts_to_components_v1", migrateRenameChartsToComponents},
		{"rename_datasources_to_connections_v1", migrateRenameDatasourcesToConnections},
		{"rename_datasource_id_field_v1", migrateRenameDatasourceIDField},
		{"rename_datasourceId_in_component_code_v1", migrateRenameDatasourceIdInComponentCode},
		{"drop_mask_secrets_v1", migrateDropMaskSecrets},
		{"users_kind_human_default_v1", migrateUsersKindHumanDefault},
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

// migrateStripChartThumbnail removes the legacy `thumbnail` field
// from every document in the `charts` collection. Component
// thumbnails were captured on chart save and stored as base64 PNGs
// (often 50–200 KB each) but never read by any UI. The field was
// dead weight in every backup. This migration is idempotent — once
// it runs, the field is gone and the migrations registry blocks it
// from re-running.
func migrateStripChartThumbnail(ctx context.Context, db *mongo.Database) error {
	res, err := db.Collection("charts").UpdateMany(
		ctx,
		bson.M{"thumbnail": bson.M{"$exists": true}},
		bson.M{"$unset": bson.M{"thumbnail": ""}},
	)
	if err != nil {
		return fmt.Errorf("strip thumbnail: %w", err)
	}
	log.Printf("  charts: stripped thumbnail from %d documents", res.ModifiedCount)
	return nil
}

// migrateRenameChartsToComponents renames the legacy `charts` collection
// to `components`. The umbrella entity that holds chart, control, and
// display sub-types is now called Component everywhere in the codebase;
// this migration brings the on-disk name in line.
//
// Idempotent: no-op when `charts` doesn't exist (fresh install) or when
// `components` already exists (this migration already ran). When `charts`
// exists and `components` does not, runs the admin renameCollection
// command. Indexes do NOT carry through a rename — the per-repository
// CreateIndexes call rebuilds them on the next startup, immediately
// after migrations finish.
func migrateRenameChartsToComponents(ctx context.Context, db *mongo.Database) error {
	chartsExists, _, err := collectionState(ctx, db, "charts")
	if err != nil {
		return fmt.Errorf("check charts collection: %w", err)
	}
	if !chartsExists {
		log.Printf("  charts: collection does not exist (fresh install), nothing to rename")
		return nil
	}

	componentsExists, _, err := collectionState(ctx, db, "components")
	if err != nil {
		return fmt.Errorf("check components collection: %w", err)
	}
	if componentsExists {
		log.Printf("  components: already exists, leaving charts in place — manual cleanup required")
		return nil
	}

	dbName := db.Name()
	renameCmd := bson.D{
		{Key: "renameCollection", Value: dbName + ".charts"},
		{Key: "to", Value: dbName + ".components"},
	}
	if err := db.Client().Database("admin").RunCommand(ctx, renameCmd).Err(); err != nil {
		return fmt.Errorf("rename charts → components: %w", err)
	}
	log.Printf("  charts → components: renamed (indexes will be rebuilt by ComponentRepository.CreateIndexes)")
	return nil
}

// migrateRenameDatasourcesToConnections renames the legacy `datasources`
// collection to `connections`. The wire format and UI both call these
// "Connections" — this brings the on-disk name in line and removes the
// last surface using the older "datasource" nomenclature.
//
// Idempotent: no-op when `datasources` doesn't exist (fresh install)
// or when `connections` already exists (already ran). When the source
// exists and the target does not, runs the admin renameCollection
// command. Indexes are recreated by the per-repository CreateIndexes
// call on the next startup, after migrations finish.
func migrateRenameDatasourcesToConnections(ctx context.Context, db *mongo.Database) error {
	srcExists, _, err := collectionState(ctx, db, "datasources")
	if err != nil {
		return fmt.Errorf("check datasources collection: %w", err)
	}
	if !srcExists {
		log.Printf("  datasources: collection does not exist (fresh install), nothing to rename")
		return nil
	}

	dstExists, _, err := collectionState(ctx, db, "connections")
	if err != nil {
		return fmt.Errorf("check connections collection: %w", err)
	}
	if dstExists {
		log.Printf("  connections: already exists, leaving datasources in place — manual cleanup required")
		return nil
	}

	dbName := db.Name()
	renameCmd := bson.D{
		{Key: "renameCollection", Value: dbName + ".datasources"},
		{Key: "to", Value: dbName + ".connections"},
	}
	if err := db.Client().Database("admin").RunCommand(ctx, renameCmd).Err(); err != nil {
		return fmt.Errorf("rename datasources → connections: %w", err)
	}
	log.Printf("  datasources → connections: renamed (indexes will be rebuilt by ConnectionRepository.CreateIndexes)")
	return nil
}

// migrateRenameDatasourceIDField copies `datasource_id` to `connection_id`
// on every document that has it, then unsets the old field. Atomic per
// document via a server-side aggregation pipeline. Idempotent — if a doc
// has only `connection_id` already (already ran, or fresh write), the
// $exists guard skips it.
//
// Today this only matters for the `components` collection. Pre-flight
// audit (2026-04-30) showed: components=97, dashboards=0 nested+top.
// We sweep dashboards too, defensively, so future panel-config changes
// that re-introduce datasource_id won't quietly leak through.
func migrateRenameDatasourceIDField(ctx context.Context, db *mongo.Database) error {
	collections := []string{"components", "dashboards"}
	totalModified := int64(0)
	for _, name := range collections {
		coll := db.Collection(name)
		// Aggregation pipeline: $set the new field from the old, then
		// $unset the old. The pipeline form of UpdateMany guarantees
		// both happen atomically per document.
		res, err := coll.UpdateMany(
			ctx,
			bson.M{"datasource_id": bson.M{"$exists": true}},
			mongo.Pipeline{
				bson.D{{Key: "$set", Value: bson.M{"connection_id": "$datasource_id"}}},
				bson.D{{Key: "$unset", Value: "datasource_id"}},
			},
		)
		if err != nil {
			return fmt.Errorf("rename datasource_id on %s: %w", name, err)
		}
		log.Printf("  %s: renamed datasource_id → connection_id on %d documents", name, res.ModifiedCount)
		totalModified += res.ModifiedCount
	}
	log.Printf("  total datasource_id → connection_id rewrites: %d", totalModified)
	return nil
}

// migrateRenameDatasourceIdInComponentCode rewrites the legacy
// `datasourceId:` token inside stored component_code strings to
// `connectionId:`. The chart code we ship is generated and lives in
// MongoDB as plain text, evaluated at runtime by the dynamic loader.
// When useData was renamed (datasourceId → connectionId in the prop
// shape), every previously-saved component still passed the old key
// and the hook silently no-op'd — components stuck on "Loading."
//
// Scope: only the standalone `datasourceId:` form inside object
// literals — the pattern emitted by chartCodeGenerator. We don't
// touch other occurrences (variable names, comments) because those
// are internal to the chart code's own logic and may legitimately
// keep the old name. The string the runtime hook reads is the only
// thing that has to change.
//
// Idempotent: if a doc already has only `connectionId:`, the
// substring match no-ops. Safe to re-run.
func migrateRenameDatasourceIdInComponentCode(ctx context.Context, db *mongo.Database) error {
	coll := db.Collection("components")
	cursor, err := coll.Find(ctx, bson.M{"component_code": bson.M{"$regex": "datasourceId:"}})
	if err != nil {
		return fmt.Errorf("find components with datasourceId in code: %w", err)
	}
	defer cursor.Close(ctx)

	updated := 0
	for cursor.Next(ctx) {
		var doc struct {
			ID            interface{} `bson:"_id"`
			ComponentCode string      `bson:"component_code"`
		}
		if err := cursor.Decode(&doc); err != nil {
			return fmt.Errorf("decode component: %w", err)
		}
		newCode := strings.ReplaceAll(doc.ComponentCode, "datasourceId:", "connectionId:")
		if newCode == doc.ComponentCode {
			continue
		}
		_, err := coll.UpdateByID(ctx, doc.ID, bson.M{"$set": bson.M{"component_code": newCode}})
		if err != nil {
			return fmt.Errorf("update component %v: %w", doc.ID, err)
		}
		updated++
	}
	if err := cursor.Err(); err != nil {
		return fmt.Errorf("cursor: %w", err)
	}

	log.Printf("  components: rewrote datasourceId: → connectionId: in %d component_code blobs", updated)
	return nil
}

// migrateDropMaskSecrets removes the legacy `mask_secrets` field from
// every connection document. The per-connection opt-out flag was
// removed in v0.14.3; the API now always masks secrets in GET
// responses. This migration cleans the field out of stored documents
// so the DB matches the new model. Idempotent: only updates documents
// that still carry the field, and the registry framework guards
// against re-running.
func migrateDropMaskSecrets(ctx context.Context, db *mongo.Database) error {
	res, err := db.Collection("connections").UpdateMany(
		ctx,
		bson.M{"mask_secrets": bson.M{"$exists": true}},
		bson.M{"$unset": bson.M{"mask_secrets": ""}},
	)
	if err != nil {
		return fmt.Errorf("drop mask_secrets: %w", err)
	}
	log.Printf("  connections: dropped mask_secrets from %d documents", res.ModifiedCount)
	return nil
}

// migrateUsersKindHumanDefault stamps `kind: "human"` on every
// existing user record that lacks the field. After v0.16.x the User
// model distinguishes humans from system principals via a `kind`
// field; pre-migration records have no kind, which IsSystem()
// already treats as "human" but the explicit value keeps queries
// like `{kind: "system"}` correct.
func migrateUsersKindHumanDefault(ctx context.Context, db *mongo.Database) error {
	res, err := db.Collection("users").UpdateMany(
		ctx,
		bson.M{"kind": bson.M{"$exists": false}},
		bson.M{"$set": bson.M{"kind": "human"}},
	)
	if err != nil {
		return fmt.Errorf("set users.kind=human: %w", err)
	}
	log.Printf("  users: set kind=human on %d documents", res.ModifiedCount)
	return nil
}
