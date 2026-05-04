// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.
//
// One-shot migration: drop the legacy `mask_secrets` field from
// every connection document.
//
// Background: connections used to carry a per-record `mask_secrets`
// flag that allowed an internal caller to opt out of secret masking
// on GET responses (originally added for a never-built "direct
// connection mode" where the browser would authenticate to the data
// source itself). The flag has been removed — every API response now
// always masks secrets and the only way to update a secret is to
// POST/PUT a new value. This migration removes the field from
// stored documents so the DB matches the new model.
//
// Idempotent: only updates documents that still carry the field.
//
// Run:
//   MONGO_URI=mongodb://localhost:27017 go run ./cmd/migrate-drop-mask-secrets
//   MONGO_URI=mongodb://prod-host:27017 go run ./cmd/migrate-drop-mask-secrets
//
// Records `drop_mask_secrets_v1` in the migrations collection.
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
	migrationKey = "drop_mask_secrets_v1"
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
	connections := db.Collection("connections")
	migrations := db.Collection("migrations")

	res, err := connections.UpdateMany(ctx,
		bson.M{"mask_secrets": bson.M{"$exists": true}},
		bson.M{"$unset": bson.M{"mask_secrets": ""}},
	)
	if err != nil {
		log.Fatalf("update: %v", err)
	}
	log.Printf("connections_matched=%d  connections_modified=%d", res.MatchedCount, res.ModifiedCount)

	remaining, err := connections.CountDocuments(ctx, bson.M{"mask_secrets": bson.M{"$exists": true}})
	if err != nil {
		log.Fatalf("verify: %v", err)
	}
	if remaining > 0 {
		log.Fatalf("verification failed: %d connections still carry mask_secrets", remaining)
	}
	log.Println("✓ no connections with mask_secrets remain")

	if _, err := migrations.UpdateOne(ctx,
		bson.M{"_id": migrationKey},
		bson.M{"$set": bson.M{
			"applied_at":  time.Now().UTC(),
			"description": fmt.Sprintf("dropped mask_secrets from %d connections", res.ModifiedCount),
		}},
		options.Update().SetUpsert(true),
	); err != nil {
		log.Fatalf("record migration: %v", err)
	}
	log.Println("✓ migration recorded:", migrationKey)
}
