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

// APIKeyRepository handles api_keys collection operations.
type APIKeyRepository struct {
	collection *mongo.Collection
}

// NewAPIKeyRepository creates a new API key repository.
func NewAPIKeyRepository(db *mongo.Database) *APIKeyRepository {
	return &APIKeyRepository{
		collection: db.Collection("api_keys"),
	}
}

// CreateIndexes creates indexes for the api_keys collection.
//
//   - (user_guid, name) is unique so a single user can't have two keys
//     sharing the same human label.
//   - prefix is the hot-path index used by the auth middleware to narrow
//     candidate rows before bcrypt-comparing the full token.
//   - user_guid alone covers the "list my keys" query.
func (r *APIKeyRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys: bson.D{
				{Key: "user_guid", Value: 1},
				{Key: "name", Value: 1},
			},
			Options: options.Index().SetUnique(true),
		},
		{Keys: bson.D{{Key: "user_guid", Value: 1}}},
		{Keys: bson.D{{Key: "prefix", Value: 1}}},
	}
	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Create inserts a new API key record. Caller is responsible for
// generating the ID, hashing the token, and setting Prefix.
func (r *APIKeyRepository) Create(ctx context.Context, key *models.APIKey) error {
	if key.Created.IsZero() {
		key.Created = time.Now()
	}
	_, err := r.collection.InsertOne(ctx, key)
	return err
}

// FindByID retrieves an API key by its UUID.
func (r *APIKeyRepository) FindByID(ctx context.Context, id string) (*models.APIKey, error) {
	var key models.APIKey
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&key)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &key, nil
}

// FindByPrefix returns all non-revoked candidate keys for a given
// plaintext prefix. The auth middleware then bcrypt-compares each
// candidate against the presented token. In practice prefixes are
// random enough that this returns 0 or 1 rows.
func (r *APIKeyRepository) FindByPrefix(ctx context.Context, prefix string) ([]models.APIKey, error) {
	cursor, err := r.collection.Find(ctx, bson.M{
		"prefix":  prefix,
		"revoked": false,
	})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var out []models.APIKey
	if err := cursor.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// FindByUserGUID lists all keys (active + revoked) belonging to a
// user, sorted by creation time descending. Revoked keys stay in the
// list so the user can see their history.
func (r *APIKeyRepository) FindByUserGUID(ctx context.Context, userGUID string) ([]models.APIKey, error) {
	opts := options.Find().SetSort(bson.D{{Key: "created", Value: -1}})
	cursor, err := r.collection.Find(ctx, bson.M{"user_guid": userGUID}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var out []models.APIKey
	if err := cursor.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// List returns every key in the system, sorted newest-first. Used by
// the Manage Mode admin view to audit deployment-wide key inventory.
func (r *APIKeyRepository) List(ctx context.Context) ([]models.APIKey, error) {
	opts := options.Find().SetSort(bson.D{{Key: "created", Value: -1}})
	cursor, err := r.collection.Find(ctx, bson.M{}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var out []models.APIKey
	if err := cursor.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// TouchLastUsed records the current time as the last successful auth
// for a given key. Best-effort — failures here should never block a
// real request, so callers should ignore the error.
func (r *APIKeyRepository) TouchLastUsed(ctx context.Context, id string) error {
	now := time.Now()
	_, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": id},
		bson.M{"$set": bson.M{"last_used": now}},
	)
	return err
}

// Revoke marks a key as revoked. Revoked keys stay in the database
// (so the user sees them in their list) but never validate.
func (r *APIKeyRepository) Revoke(ctx context.Context, id string) error {
	now := time.Now()
	result, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": id},
		bson.M{"$set": bson.M{
			"revoked":    true,
			"revoked_at": now,
		}},
	)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return mongo.ErrNoDocuments
	}
	return nil
}

// Delete removes a key permanently. Prefer Revoke() for normal use —
// Delete is for admin cleanup of long-revoked keys.
func (r *APIKeyRepository) Delete(ctx context.Context, id string) error {
	result, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return err
	}
	if result.DeletedCount == 0 {
		return mongo.ErrNoDocuments
	}
	return nil
}
