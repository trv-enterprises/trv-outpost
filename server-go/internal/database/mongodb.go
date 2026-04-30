// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package database

import (
	"context"
	"fmt"
	"time"

	"github.com/trv-enterprises/trve-dashboard/config"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

// MongoDB holds the MongoDB client and database
type MongoDB struct {
	Client   *mongo.Client
	Database *mongo.Database
}

// NewMongoDB creates a new MongoDB connection
func NewMongoDB(cfg config.MongoDBConfig) (*MongoDB, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cfg.ConnectionTimeout)
	defer cancel()

	// Set client options
	clientOptions := options.Client().
		ApplyURI(cfg.URI).
		SetMaxPoolSize(cfg.MaxPoolSize).
		SetMinPoolSize(cfg.MinPoolSize)

	// Connect to MongoDB
	client, err := mongo.Connect(ctx, clientOptions)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to mongodb: %w", err)
	}

	// Ping the database
	if err := client.Ping(ctx, readpref.Primary()); err != nil {
		return nil, fmt.Errorf("failed to ping mongodb: %w", err)
	}

	database := client.Database(cfg.Database)

	fmt.Printf("✓ Connected to MongoDB: %s\n", cfg.Database)

	return &MongoDB{
		Client:   client,
		Database: database,
	}, nil
}

// Disconnect closes the MongoDB connection
func (m *MongoDB) Disconnect() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := m.Client.Disconnect(ctx); err != nil {
		return fmt.Errorf("failed to disconnect from mongodb: %w", err)
	}

	fmt.Println("✓ Disconnected from MongoDB")
	return nil
}

// Collection returns a collection
func (m *MongoDB) Collection(name string) *mongo.Collection {
	return m.Database.Collection(name)
}

// Collections returns collection helpers
func (m *MongoDB) Collections() Collections {
	return Collections{
		Connections:  m.Collection("connections"),
		Dashboards:   m.Collection("dashboards"),
		ChatSessions: m.Collection("chat_sessions"),
		AISessions:   m.Collection("ai_sessions"),
	}
}

// Collections holds references to all collections
type Collections struct {
	Connections  *mongo.Collection
	Dashboards   *mongo.Collection
	ChatSessions *mongo.Collection
	AISessions   *mongo.Collection
}

// CreateIndexes creates indexes for all collections
func (m *MongoDB) CreateIndexes(ctx context.Context) error {
	collections := m.Collections()

	// Connections indexes
	if err := createIndexes(ctx, collections.Connections, connectionIndexes()); err != nil {
		return fmt.Errorf("connections indexes: %w", err)
	}

	// Dashboards indexes
	if err := createIndexes(ctx, collections.Dashboards, dashboardIndexes()); err != nil {
		return fmt.Errorf("dashboards indexes: %w", err)
	}

	// Chat sessions indexes
	if err := createIndexes(ctx, collections.ChatSessions, chatSessionIndexes()); err != nil {
		return fmt.Errorf("chat_sessions indexes: %w", err)
	}

	fmt.Println("✓ Created MongoDB indexes")
	return nil
}

func createIndexes(ctx context.Context, collection *mongo.Collection, models []mongo.IndexModel) error {
	if len(models) == 0 {
		return nil
	}

	_, err := collection.Indexes().CreateMany(ctx, models)
	return err
}

// Index model helpers
//
// All collections managed here have case-insensitive collation (see
// migrateCollationCaseInsensitive). Indexes created on these collections
// inherit the collation automatically, so unique constraints on `name`
// reject case-variant duplicates.
//
// `bson.D` is used instead of map[string]interface{} to guarantee field
// ordering for compound indexes.

func connectionIndexes() []mongo.IndexModel {
	return []mongo.IndexModel{
		// Uniqueness is scoped to (namespace, name) — two namespaces can
		// each have a connection called "Home". The old name-only unique
		// index is dropped by the namespacing_v1 migration before this
		// index is created.
		{
			Keys:    bson.D{{Key: "namespace", Value: 1}, {Key: "name", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		// Hot path: list by namespace (matches the active-namespace
		// filter on the connections list page) with newest-first sort.
		{Keys: bson.D{{Key: "namespace", Value: 1}, {Key: "created_at", Value: -1}}},
		// Hot path: list by type with newest-first sort.
		{Keys: bson.D{{Key: "type", Value: 1}, {Key: "created_at", Value: -1}}},
		// Tag filtering (Part 3) with newest-first sort.
		{Keys: bson.D{{Key: "tags", Value: 1}, {Key: "created_at", Value: -1}}},
		// FindAll fallback sort.
		{Keys: bson.D{{Key: "created_at", Value: -1}}},
		// Health-monitoring background jobs.
		{Keys: bson.D{{Key: "health.status", Value: 1}}},
		{Keys: bson.D{{Key: "health.last_check", Value: 1}}},
	}
}

func dashboardIndexes() []mongo.IndexModel {
	return []mongo.IndexModel{
		// Uniqueness is scoped to (namespace, name). Old name-only index
		// dropped by namespacing_v1 migration.
		{
			Keys:    bson.D{{Key: "namespace", Value: 1}, {Key: "name", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		// Namespace filter + recency — the default dashboards list query.
		{Keys: bson.D{{Key: "namespace", Value: 1}, {Key: "updated", Value: -1}}},
		// "Dashboards using chart X" lookups + newest-first sort.
		{Keys: bson.D{{Key: "panels.chart_id", Value: 1}, {Key: "updated", Value: -1}}},
		// Public-dashboard listing with newest-first sort.
		{Keys: bson.D{{Key: "settings.is_public", Value: 1}, {Key: "updated", Value: -1}}},
		// Tag filtering (Part 3) with newest-first sort.
		{Keys: bson.D{{Key: "tags", Value: 1}, {Key: "updated", Value: -1}}},
		// General recency sort.
		{Keys: bson.D{{Key: "updated", Value: -1}}},
		// Legacy: kept for queries that sort by created_at.
		{Keys: bson.D{{Key: "created_at", Value: -1}}},
	}
}

func chatSessionIndexes() []mongo.IndexModel {
	return []mongo.IndexModel{
		{
			Keys: bson.D{
				{Key: "user_id", Value: 1},
				{Key: "created_at", Value: -1},
			},
		},
	}
}
