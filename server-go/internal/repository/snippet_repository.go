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

// SnippetRepository handles the `snippets` collection.
type SnippetRepository struct {
	collection *mongo.Collection
}

// NewSnippetRepository constructs a repository against the given DB.
func NewSnippetRepository(db *mongo.Database) *SnippetRepository {
	return &SnippetRepository{collection: db.Collection("snippets")}
}

// CreateIndexes creates the indexes the GET list query depends on. The
// compound index covers the dominant access pattern (one user reading
// snippets for one host surface); the tags multikey index is for
// future tag-filtered queries.
func (r *SnippetRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys: bson.D{
				{Key: "context", Value: 1},
				{Key: "scope", Value: 1},
				{Key: "owner_user_id", Value: 1},
			},
		},
		{Keys: bson.D{{Key: "tags", Value: 1}}},
	}
	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Create inserts a new snippet. Timestamps are set here if absent.
func (r *SnippetRepository) Create(ctx context.Context, s *models.Snippet) error {
	now := time.Now()
	if s.Created.IsZero() {
		s.Created = now
	}
	if s.Updated.IsZero() {
		s.Updated = now
	}
	_, err := r.collection.InsertOne(ctx, s)
	return err
}

// FindByID returns a snippet by ID, or nil if not found.
func (r *SnippetRepository) FindByID(ctx context.Context, id string) (*models.Snippet, error) {
	var s models.Snippet
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&s)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// ListForUser returns every snippet visible to a user for the given
// context — both their own user-scoped snippets and every global
// snippet for that context. Sorted alphabetically by title because
// the panel renders alpha and avoiding a client-side sort keeps the
// hot path cheap.
func (r *SnippetRepository) ListForUser(ctx context.Context, callerGUID, contextKey string) ([]models.Snippet, error) {
	filter := bson.M{
		"context": contextKey,
		"$or": bson.A{
			bson.M{"scope": models.SnippetScopeGlobal},
			bson.M{"scope": models.SnippetScopeUser, "owner_user_id": callerGUID},
		},
	}
	opts := options.Find().SetSort(bson.D{{Key: "title", Value: 1}})
	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var out []models.Snippet
	if err := cursor.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Update applies the editable fields to an existing snippet.
func (r *SnippetRepository) Update(ctx context.Context, id string, title, command string, tags []string) error {
	if tags == nil {
		tags = []string{}
	}
	res, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": id},
		bson.M{"$set": bson.M{
			"title":   title,
			"command": command,
			"tags":    tags,
			"updated": time.Now(),
		}},
	)
	if err != nil {
		return err
	}
	if res.MatchedCount == 0 {
		return mongo.ErrNoDocuments
	}
	return nil
}

// Delete removes a snippet by ID.
func (r *SnippetRepository) Delete(ctx context.Context, id string) error {
	res, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return mongo.ErrNoDocuments
	}
	return nil
}

// CountGlobalForContext returns the number of global snippets for a
// given context. Used by the starter-pack migration to decide whether
// to seed.
func (r *SnippetRepository) CountGlobalForContext(ctx context.Context, contextKey string) (int64, error) {
	return r.collection.CountDocuments(ctx, bson.M{
		"context": contextKey,
		"scope":   models.SnippetScopeGlobal,
	})
}
