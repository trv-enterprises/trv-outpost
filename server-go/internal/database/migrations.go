// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package database

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/componenttemplates"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
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
		{"strip_literal_secret_sentinels_v1", migrateStripLiteralSecretSentinels},
		{"users_backfill_control_capability_v1", migrateBackfillControlCapability},
		{"seed_global_snippets_v1", migrateSeedGlobalSnippetsV1},
		{"spec_driven_chart_code_v1", migrateSpecDrivenChartCode},
		{"refresh_assistant_model_description_v1", migrateRefreshAssistantModelDescription},
		{"assistant_enabled_to_ai_enabled_v1", migrateAssistantEnabledToAIEnabled},
		{"refresh_tile_font_size_description_v1", migrateRefreshTileFontSizeDescription},
		{"drop_panel_pin_connection_v1", migrateDropPanelPinConnection},
		{"prefix_restart_required_descriptions_v1", migratePrefixRestartRequiredDescriptions},
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

// migrateSpecDrivenChartCode repairs chart components whose stored
// component_code is a legacy hardcoded-column ECharts template (or empty)
// rather than the spec-driven one-liner. Before v0.24 the server create
// path (component_service.CreateComponent) injected a per-type template
// with literal column names ('timestamp'/'value', 'day'/'mean', …) for
// agent-built charts (chat agent, component agent, MCP). Those records
// render "No data" against any schema whose columns differ from the
// template's literals. The fix rewrites them to
// `<SpecDrivenChart specName="..." />`, which draws from the saved
// data_mapping / options config at runtime — identical to editor-built
// charts.
//
// Scope: every version row of a chart component that is spec-driven
// (registry.IsSpecDrivenChart) and not in custom-code mode, whose code
// does not already defer to SpecDrivenChart. Custom-code charts and the
// `custom` type are left untouched. Idempotent — already-converted rows
// contain "SpecDrivenChart" and are skipped, and the migration framework
// guards against re-running.
func migrateSpecDrivenChartCode(ctx context.Context, db *mongo.Database) error {
	coll := db.Collection("components")

	// Candidate set: chart components not flagged as custom-code whose
	// code doesn't already reference SpecDrivenChart. The per-type
	// spec-driven check happens in Go below (the registry is the source
	// of truth for which chart_types are spec-driven).
	filter := bson.M{
		"component_type": "chart",
		"use_custom_code": bson.M{"$ne": true},
		"component_code":  bson.M{"$not": bson.M{"$regex": "SpecDrivenChart"}},
	}
	cursor, err := coll.Find(ctx, filter)
	if err != nil {
		return fmt.Errorf("find chart components to repair: %w", err)
	}
	defer cursor.Close(ctx)

	updated := 0
	skipped := 0
	for cursor.Next(ctx) {
		var doc struct {
			ID        interface{} `bson:"_id"`
			ChartType string      `bson:"chart_type"`
		}
		if err := cursor.Decode(&doc); err != nil {
			return fmt.Errorf("decode component: %w", err)
		}
		// Only rewrite chart types that actually have a spec-driven render
		// path. A non-spec type with hand-or-template code is left alone.
		if !registry.IsSpecDrivenChart(doc.ChartType) {
			skipped++
			continue
		}
		newCode := componenttemplates.SpecDrivenOneLiner(doc.ChartType)
		_, err := coll.UpdateByID(ctx, doc.ID, bson.M{"$set": bson.M{"component_code": newCode}})
		if err != nil {
			return fmt.Errorf("update component %v: %w", doc.ID, err)
		}
		updated++
	}
	if err := cursor.Err(); err != nil {
		return fmt.Errorf("cursor: %w", err)
	}

	log.Printf("  components: rewrote %d chart rows to the spec-driven one-liner (%d non-spec rows left untouched)", updated, skipped)
	return nil
}

// migrateRefreshAssistantModelDescription updates the stored description
// for the assistant.model setting. The settings sync only INSERTS missing
// keys (DB values take precedence and are never overwritten), so when the
// help text changes in user-configurable.yaml an already-seeded deployment
// keeps the stale description in its Manage → Settings UI. This refreshes
// it to match the YAML (the sonnet/opus aliases now track latest, plus the
// pin-a-specific-model-id option). Value is left untouched — only the
// human-facing description changes. Idempotent: $set to the current text.
func migrateRefreshAssistantModelDescription(ctx context.Context, db *mongo.Database) error {
	const desc = "Anthropic model the Dashboard Assistant runs. Use the alias `sonnet` (latest Sonnet — fast + cheaper, the default and a solid all-round choice) or `opus` (latest Opus — strongest reasoning + layout/design quality, higher cost; recommended for building polished multi-panel dashboards). Aliases auto-track the newest model each release. To pin a specific snapshot (e.g. for A/B comparison), enter a full model ID like `claude-sonnet-4-20250514` instead of an alias. Takes effect on next server restart. Per-deployment choice; not per-user."

	res, err := db.Collection("settings").UpdateOne(
		ctx,
		bson.M{"_id": "assistant.model"},
		bson.M{"$set": bson.M{"description": desc}},
	)
	if err != nil {
		return fmt.Errorf("refresh assistant.model description: %w", err)
	}
	log.Printf("  settings: refreshed assistant.model description (matched %d)", res.MatchedCount)
	return nil
}

// migrateRefreshTileFontSizeDescription updates the tile_font_size
// setting's description in existing DBs to the current wording (the
// settings sync never overwrites an existing doc, so a YAML edit alone
// doesn't reach deployments that already seeded it). Same shape as
// migrateRefreshAssistantModelDescription — a no-op when the setting is
// absent (fresh DBs seed the new text directly).
func migrateRefreshTileFontSizeDescription(ctx context.Context, db *mongo.Database) error {
	const desc = "Font size for compact tile control titles (xs, sm, md, lg). Applies to control components of the tile_* control types."
	res, err := db.Collection("settings").UpdateOne(
		ctx,
		bson.M{"_id": "tile_font_size"},
		bson.M{"$set": bson.M{"description": desc}},
	)
	if err != nil {
		return fmt.Errorf("refresh tile_font_size description: %w", err)
	}
	log.Printf("  settings: refreshed tile_font_size description (matched %d)", res.MatchedCount)
	return nil
}

// migratePrefixRestartRequiredDescriptions refreshes the descriptions of the
// restart-required settings so they LEAD with "Server Restart Required." — the
// admin should see, at a glance in Manage → Settings, that changing one of
// these won't take effect until the server restarts. These three are read once
// at boot (ai.enabled gates AI construction; assistant.model resolves the chat
// model; assistant.daily_token_budget is captured into the budget object), not
// re-read per request. Same refresh-an-existing-description shape as the two
// migrations above (the settings sync never overwrites an existing doc, so a
// YAML edit alone doesn't reach already-seeded deployments). Idempotent: $set
// to the current text; no-op on a fresh DB (the seed lands the new text).
func migratePrefixRestartRequiredDescriptions(ctx context.Context, db *mongo.Database) error {
	descs := map[string]string{
		"ai.enabled":                  "Server Restart Required. AI features master switch — governs BOTH the Component AI agent (Create/Edit with AI) and the Dashboard Assistant (header chat). Requires an Anthropic API key at server start; this is the admin soft kill-switch on top of that.",
		"assistant.model":             "Server Restart Required. Anthropic model the Dashboard Assistant runs. Use the alias `sonnet` (latest Sonnet — fast + cheaper, the default and a solid all-round choice) or `opus` (latest Opus — strongest reasoning + layout/design quality, higher cost; recommended for building polished multi-panel dashboards). Aliases auto-track the newest model each release. To pin a specific snapshot (e.g. for A/B comparison), enter a full model ID like `claude-sonnet-4-20250514` instead of an alias. Per-deployment choice; not per-user.",
		"assistant.daily_token_budget": "Server Restart Required. Per-user daily token budget for the Dashboard Assistant. Object with `input` and `output` keys. Counted in Anthropic tokens, resets at UTC midnight. Defaults to 1M input / 250k output — generous for most workflows; lower if costs run away, raise for power users. A user past either cap is refused new turns until the next UTC day; their conversation is not lost.",
	}
	for key, desc := range descs {
		res, err := db.Collection("settings").UpdateOne(
			ctx,
			bson.M{"_id": key},
			bson.M{"$set": bson.M{"description": desc}},
		)
		if err != nil {
			return fmt.Errorf("refresh %s description: %w", key, err)
		}
		log.Printf("  settings: prefixed 'Server Restart Required' on %s description (matched %d)", key, res.MatchedCount)
	}
	return nil
}

// migrateAssistantEnabledToAIEnabled folds the former
// `assistant.enabled` admin setting into the new unified `ai.enabled`
// master switch (which now governs BOTH the Component AI agent and the
// Dashboard Assistant — see config/user-configurable.yaml). Runs BEFORE
// the settings seed (migrations are applied at boot ahead of
// SyncSettingsFromConfig), so:
//   - If ai.enabled already exists → no-op (idempotent / already migrated).
//   - Else if assistant.enabled exists → create ai.enabled carrying its
//     value, so an admin who had explicitly turned the Assistant OFF
//     keeps AI off after the merge (and the seed then skips it).
//   - Else (fresh DB) → do nothing; the seed creates ai.enabled=true.
// Finally removes the orphaned assistant.enabled doc.
func migrateAssistantEnabledToAIEnabled(ctx context.Context, db *mongo.Database) error {
	settings := db.Collection("settings")

	existsAI, err := settings.CountDocuments(ctx, bson.M{"_id": "ai.enabled"})
	if err != nil {
		return fmt.Errorf("check ai.enabled: %w", err)
	}
	if existsAI == 0 {
		var old struct {
			Value interface{} `bson:"value"`
		}
		err := settings.FindOne(ctx, bson.M{"_id": "assistant.enabled"}).Decode(&old)
		if err == nil {
			// Carry the old value forward into the new key.
			now := time.Now()
			_, err = settings.UpdateByID(
				ctx,
				"ai.enabled",
				bson.M{"$set": bson.M{
					"key":         "ai.enabled",
					"value":       old.Value,
					"category":    "ai",
					"description": "AI features master switch — governs BOTH the Component AI agent (Create/Edit with AI) and the Dashboard Assistant (header chat). Requires an Anthropic API key at server start; this is the admin soft kill-switch on top of that. Restart required for changes to take effect.",
					"updated":     now,
				}, "$setOnInsert": bson.M{"created": now}},
				options.Update().SetUpsert(true),
			)
			if err != nil {
				return fmt.Errorf("create ai.enabled from assistant.enabled: %w", err)
			}
			log.Printf("  settings: migrated assistant.enabled (value=%v) → ai.enabled", old.Value)
		} else if err != mongo.ErrNoDocuments {
			return fmt.Errorf("read assistant.enabled: %w", err)
		}
		// err == ErrNoDocuments → fresh DB, leave ai.enabled for the seed.
	}

	// Remove the orphaned old key (no-op if already gone).
	res, err := settings.DeleteOne(ctx, bson.M{"_id": "assistant.enabled"})
	if err != nil {
		return fmt.Errorf("delete assistant.enabled: %w", err)
	}
	if res.DeletedCount > 0 {
		log.Printf("  settings: removed orphaned assistant.enabled")
	}
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

// migrateDropPanelPinConnection removes the legacy `pin_connection` field
// from every dashboard panel. The per-panel connection-swap opt-out was
// replaced by per-panel component-swap rules (`component_overrides`); a panel
// that must stay fixed now simply has no overrides and points its default
// component at the desired connection. A previously-pinned panel becomes a
// plain default-only panel (which now follows the connection swap like any
// other) — acceptable since pinning was a wrong stand-in for the override
// feature. Idempotent: only touches docs that still carry the field, and the
// `$[]` all-positional operator unsets it from every panel in the array.
func migrateDropPanelPinConnection(ctx context.Context, db *mongo.Database) error {
	res, err := db.Collection("dashboards").UpdateMany(
		ctx,
		bson.M{"panels.pin_connection": bson.M{"$exists": true}},
		bson.M{"$unset": bson.M{"panels.$[].pin_connection": ""}},
	)
	if err != nil {
		return fmt.Errorf("drop panel pin_connection: %w", err)
	}
	log.Printf("  dashboards: dropped pin_connection from %d documents", res.ModifiedCount)
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

// migrateBackfillControlCapability adds `control` to every existing
// human user's capabilities array. Before v0.18.x, control execution
// was gated on the view-floor (anything with view could fire any
// control). v0.18.x introduces a dedicated `control` capability that
// gates POST /api/controls/:id/execute. To preserve today's effective
// behaviour — every existing human user can still fire controls —
// we backfill it here. System users are untouched because their
// default shape is read-only / inbound-only; admins explicitly add
// control to a kiosk system user via the System Users page when they
// want it interactive.
//
// Uses $addToSet so the migration is idempotent and safe if it runs
// against a record that already has control (e.g. a record seeded
// fresh under the new defaults).
func migrateBackfillControlCapability(ctx context.Context, db *mongo.Database) error {
	res, err := db.Collection("users").UpdateMany(
		ctx,
		bson.M{
			// Treat missing kind as human (matches IsSystem semantics).
			"$or": []bson.M{
				{"kind": "human"},
				{"kind": bson.M{"$exists": false}},
				{"kind": ""},
			},
		},
		bson.M{"$addToSet": bson.M{"capabilities": "control"}},
	)
	if err != nil {
		return fmt.Errorf("backfill users.capabilities += control: %w", err)
	}
	log.Printf("  users: ensured control capability on %d human records", res.ModifiedCount)
	return nil
}

// migrateStripLiteralSecretSentinels cleans up connection records
// that have the literal "********" sentinel stored in a secret
// field. Such records came from v0.16.x bundle-import-create, which
// inserted the bundle's masked placeholder verbatim into the DB.
// Those connections then sent "********" as the actual credential
// at runtime, producing confusing upstream errors like ts-store's
// `{"error":"invalid API key format"}`.
//
// Post-v0.17.4 the import path strips the sentinel itself (see
// service/connection_service.go::stripPlaceholderSecrets), so new
// imports land empty. This migration patches up the leftover
// records from before the fix.
//
// The list of fields below mirrors what models.Connection.sanitize
// masks, so a record that the sanitizer would have replaced with
// the sentinel is exactly the record we clear here.
func migrateStripLiteralSecretSentinels(ctx context.Context, db *mongo.Database) error {
	const sentinel = "********"
	fields := []string{
		"config.sql.password",
		"config.tsstore.api_key",
		"config.prometheus.password",
		"config.mqtt.password",
		"config.frigate.password",
	}
	totalModified := int64(0)
	for _, f := range fields {
		res, err := db.Collection("connections").UpdateMany(
			ctx,
			bson.M{f: sentinel},
			bson.M{"$set": bson.M{f: ""}},
		)
		if err != nil {
			return fmt.Errorf("strip sentinel from %s: %w", f, err)
		}
		if res.ModifiedCount > 0 {
			log.Printf("  connections: cleared sentinel from %s in %d documents", f, res.ModifiedCount)
			totalModified += res.ModifiedCount
		}
	}
	// Map-valued fields (API.auth_credentials, API.headers,
	// TSStore.headers, Socket.headers, API.query_params) can't be
	// patched as cheaply with a single update — each map key would
	// need its own filter. Stream through and rewrite per-document
	// when any map value equals the sentinel.
	for _, coll := range []string{"connections"} {
		cur, err := db.Collection(coll).Find(ctx, bson.M{})
		if err != nil {
			return fmt.Errorf("scan %s for map-secret sentinels: %w", coll, err)
		}
		for cur.Next(ctx) {
			var doc bson.M
			if err := cur.Decode(&doc); err != nil {
				continue
			}
			id, _ := doc["_id"]
			cfg, _ := doc["config"].(bson.M)
			if cfg == nil {
				continue
			}
			update := bson.M{}
			stripMapField := func(parentKey, mapKey string) {
				parent, _ := cfg[parentKey].(bson.M)
				if parent == nil {
					return
				}
				m, _ := parent[mapKey].(bson.M)
				if m == nil {
					return
				}
				changed := false
				for k, v := range m {
					if s, ok := v.(string); ok && s == sentinel {
						m[k] = ""
						changed = true
					}
				}
				if changed {
					update["config."+parentKey+"."+mapKey] = m
				}
			}
			stripMapField("api", "auth_credentials")
			stripMapField("api", "headers")
			stripMapField("api", "query_params")
			stripMapField("tsstore", "headers")
			stripMapField("socket", "headers")
			// API.body is a string, not a map.
			if api, ok := cfg["api"].(bson.M); ok {
				if body, ok := api["body"].(string); ok && body == sentinel {
					update["config.api.body"] = ""
				}
			}
			if len(update) > 0 {
				_, err := db.Collection(coll).UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": update})
				if err == nil {
					totalModified++
				}
			}
		}
		cur.Close(ctx)
	}
	log.Printf("  connections: stripped %d total literal-sentinel secret occurrences", totalModified)
	return nil
}

// migrateSeedGlobalSnippetsV1 seeds a small starter pack of global
// snippets for the EdgeLake terminal on first boot. The migrations
// framework only runs this once; an admin who deletes a seeded
// snippet keeps it deleted, and no future deploy re-seeds.
//
// Snippets here are intentionally EdgeLake-flavored — the snippets
// panel is a generic primitive, but the first surface that mounts it
// is the EdgeLake terminal, so the starter pack matches that surface.
// Other surfaces (MQTT publisher, SQL ad-hoc, etc.) get their own
// per-context seed migration when they ship.
func migrateSeedGlobalSnippetsV1(ctx context.Context, db *mongo.Database) error {
	coll := db.Collection("snippets")

	// Defensive — if any globals already exist for this context (e.g.
	// an admin manually inserted some), don't add the starter pack.
	count, err := coll.CountDocuments(ctx, bson.M{
		"context": "edgelake-terminal",
		"scope":   "global",
	})
	if err != nil {
		return err
	}
	if count > 0 {
		log.Printf("  snippets: edgelake-terminal globals already present (%d) — skipping seed", count)
		return nil
	}

	now := time.Now()
	type starterRow struct {
		Title   string
		Command string
		Tags    []string
	}
	starter := []starterRow{
		{"GET STATUS", "get status", []string{"Investigation"}},
		{"GET CONNECTIONS", "get connections", []string{"Investigation"}},
		{"GET SERVERS", "get servers", []string{"Investigation"}},
		{"TEST NETWORK", "test network", []string{"Network"}},
		{"BLOCKCHAIN GET OPERATOR", "blockchain get table where type=operator", []string{"Network"}},
		{"SET DEBUG ON", "set debug on", []string{"Debug"}},
	}

	docs := make([]interface{}, 0, len(starter))
	for _, s := range starter {
		docs = append(docs, bson.M{
			"_id":     uuid.New().String(),
			"scope":   "global",
			"context": "edgelake-terminal",
			"title":   s.Title,
			"command": s.Command,
			"tags":    s.Tags,
			"created": now,
			"updated": now,
		})
	}
	if _, err := coll.InsertMany(ctx, docs); err != nil {
		return err
	}
	log.Printf("  snippets: seeded %d global starter snippets for edgelake-terminal", len(docs))
	return nil
}
