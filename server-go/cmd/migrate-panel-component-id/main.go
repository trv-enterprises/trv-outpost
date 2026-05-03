// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.
//
// One-shot migration: rename `panel.chart_id` to `panel.component_id`
// in every dashboard's panels[] array.
//
// Background: dashboards have always referenced their visual content
// via `panel.chart_id`, but that field is a holdover from before the
// v0.11.x charts → components rename. Each panel actually points at a
// component (which may be a chart, control, or display sub-type), so
// `component_id` is the correct field name. The corresponding Go field
// `DashboardPanel.ChartID` becomes `DashboardPanel.ComponentID` in
// v0.14.1.
//
// Idempotent: skips panels that already have component_id set, and
// dashboards that have no panels with chart_id.
//
// Run:
//   MONGO_URI=mongodb://localhost:27017 go run ./cmd/migrate-panel-component-id
//   MONGO_URI=mongodb://100.97.221.61:27017 go run ./cmd/migrate-panel-component-id
//
// Records `panel_component_id_v1` in the migrations collection.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const (
	dbName       = "dashboard"
	migrationKey = "panel_component_id_v1"
)

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
	dashboards := db.Collection("dashboards")
	migrations := db.Collection("migrations")

	stats := struct {
		dashboardsScanned   int
		dashboardsModified  int
		panelsRewrittenTot  int
		panelsAlreadyDone   int
	}{}

	cursor, err := dashboards.Find(ctx, bson.M{})
	if err != nil {
		log.Fatalf("find dashboards: %v", err)
	}
	defer cursor.Close(ctx)

	for cursor.Next(ctx) {
		stats.dashboardsScanned++
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			log.Fatalf("decode: %v", err)
		}

		rawPanels, ok := doc["panels"].(bson.A)
		if !ok || len(rawPanels) == 0 {
			continue
		}

		// Build a new panels array with chart_id → component_id where applicable.
		newPanels := make(bson.A, 0, len(rawPanels))
		modified := false
		for _, p := range rawPanels {
			panel, ok := p.(bson.M)
			if !ok {
				newPanels = append(newPanels, p)
				continue
			}
			chartID, hasChart := panel["chart_id"]
			_, hasComp := panel["component_id"]
			switch {
			case hasComp && hasChart:
				// Both set — already partially-migrated state. Drop chart_id.
				delete(panel, "chart_id")
				modified = true
				stats.panelsAlreadyDone++
			case hasChart && !hasComp:
				// Migrate.
				panel["component_id"] = chartID
				delete(panel, "chart_id")
				modified = true
				stats.panelsRewrittenTot++
			case hasComp:
				stats.panelsAlreadyDone++
			default:
				// No reference at all (empty panel). Nothing to do.
			}
			newPanels = append(newPanels, panel)
		}

		if !modified {
			continue
		}

		if _, err := dashboards.UpdateOne(ctx, bson.M{"_id": doc["_id"]}, bson.M{"$set": bson.M{"panels": newPanels}}); err != nil {
			log.Fatalf("update _id=%v: %v", doc["_id"], err)
		}
		stats.dashboardsModified++
		if name, _ := doc["name"].(string); name != "" {
			log.Printf("  %s (%v): updated", name, doc["_id"])
		}
	}
	if err := cursor.Err(); err != nil {
		log.Fatalf("cursor: %v", err)
	}

	log.Printf("dashboards_scanned=%d  dashboards_modified=%d  panels_rewritten=%d  panels_already_done=%d",
		stats.dashboardsScanned, stats.dashboardsModified, stats.panelsRewrittenTot, stats.panelsAlreadyDone)

	// Verify no panels have chart_id remaining.
	remaining, err := dashboards.CountDocuments(ctx, bson.M{"panels.chart_id": bson.M{"$exists": true}})
	if err != nil {
		log.Fatalf("verify: %v", err)
	}
	if remaining > 0 {
		log.Fatalf("verification failed: %d dashboards still have panels with chart_id", remaining)
	}
	log.Println("✓ no panels with chart_id remain")

	if _, err := migrations.UpdateOne(ctx,
		bson.M{"_id": migrationKey},
		bson.M{"$set": bson.M{
			"applied_at":  time.Now().UTC(),
			"description": fmt.Sprintf("rename panel.chart_id → panel.component_id (%d panels rewritten)", stats.panelsRewrittenTot),
		}},
		options.Update().SetUpsert(true),
	); err != nil {
		log.Fatalf("record migration: %v", err)
	}
	log.Println("✓ migration recorded")
}
