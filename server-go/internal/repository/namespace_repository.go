// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// NamespaceRepository handles namespace database operations.
type NamespaceRepository struct {
	collection *mongo.Collection
}

// NewNamespaceRepository creates a new namespace repository.
func NewNamespaceRepository(db *mongo.Database) *NamespaceRepository {
	return &NamespaceRepository{
		collection: db.Collection("namespaces"),
	}
}

// CreateIndexes creates indexes for the namespaces collection. Name is
// globally unique — namespaces themselves aren't namespaced.
func (r *NamespaceRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "name", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{Keys: bson.D{{Key: "updated", Value: -1}}},
	}
	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Create inserts a new namespace.
func (r *NamespaceRepository) Create(ctx context.Context, ns *models.Namespace) error {
	now := time.Now()
	ns.Created = now
	ns.Updated = now
	_, err := r.collection.InsertOne(ctx, ns)
	return err
}

// Upsert inserts or updates a namespace by ID. Used by startup seeding
// and by the migration so the default namespace is guaranteed present
// without blowing up on duplicate-key if it already exists.
func (r *NamespaceRepository) Upsert(ctx context.Context, ns *models.Namespace) error {
	now := time.Now()
	ns.Updated = now
	opts := options.Update().SetUpsert(true)
	update := bson.M{
		"$set": bson.M{
			"name":        ns.Name,
			"description": ns.Description,
			"color":       ns.Color,
			"updated":     now,
		},
		"$setOnInsert": bson.M{
			"created": now,
		},
	}
	_, err := r.collection.UpdateOne(ctx, bson.M{"_id": ns.ID}, update, opts)
	return err
}

// FindByID retrieves a namespace by ID.
func (r *NamespaceRepository) FindByID(ctx context.Context, id string) (*models.Namespace, error) {
	var ns models.Namespace
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&ns)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ns, nil
}

// FindByName retrieves a namespace by its slug name.
func (r *NamespaceRepository) FindByName(ctx context.Context, name string) (*models.Namespace, error) {
	var ns models.Namespace
	err := r.collection.FindOne(ctx, bson.M{"name": name}).Decode(&ns)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ns, nil
}

// List returns all namespaces ordered by name. No pagination — there
// will never be enough namespaces to need it, and every client (header
// picker, edit forms, list-page chips) wants the full list.
func (r *NamespaceRepository) List(ctx context.Context) ([]models.Namespace, int64, error) {
	total, err := r.collection.CountDocuments(ctx, bson.M{})
	if err != nil {
		return nil, 0, err
	}
	opts := options.Find().SetSort(bson.D{{Key: "name", Value: 1}})
	cursor, err := r.collection.Find(ctx, bson.M{}, opts)
	if err != nil {
		return nil, 0, err
	}
	defer cursor.Close(ctx)
	var out []models.Namespace
	if err := cursor.All(ctx, &out); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// Update applies partial updates to a namespace.
func (r *NamespaceRepository) Update(ctx context.Context, id string, req *models.UpdateNamespaceRequest) error {
	updateFields := bson.M{"updated": time.Now()}
	if req.Name != nil {
		updateFields["name"] = *req.Name
	}
	if req.Description != nil {
		updateFields["description"] = *req.Description
	}
	if req.Color != nil {
		updateFields["color"] = *req.Color
	}
	result, err := r.collection.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": updateFields})
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return mongo.ErrNoDocuments
	}
	return nil
}

// Delete removes a namespace by ID. Caller is responsible for the
// in-use check — the repo doesn't look across other collections.
func (r *NamespaceRepository) Delete(ctx context.Context, id string) error {
	result, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return err
	}
	if result.DeletedCount == 0 {
		return mongo.ErrNoDocuments
	}
	return nil
}
