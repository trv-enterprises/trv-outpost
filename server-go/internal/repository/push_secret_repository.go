// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// PushSecretRepository persists URL-embedded secrets authorising
// ts-store inbound push channels (#260). See models/push_secret.go for
// the security model; it mirrors WebhookSecretRepository deliberately,
// since both solve "ts-store dials us and the URL is the only place a
// credential can ride".
type PushSecretRepository struct {
	collection *mongo.Collection
}

// NewPushSecretRepository constructs the repo against the dashboard DB.
func NewPushSecretRepository(db *mongo.Database) *PushSecretRepository {
	return &PushSecretRepository{collection: db.Collection("push_secrets")}
}

// CreateIndexes makes lookup-by-secret O(1) and per-stream/connection
// cleanup fast. Called once at boot from main.go. Idempotent.
func (r *PushSecretRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		// The accept path's hot lookup. Unique because two records
		// sharing a secret would make the authorised channel ambiguous.
		{Keys: bson.D{{Key: "secret", Value: 1}}, Options: options.Index().SetUnique(true)},
		// One live secret per channel: re-registering a push connection
		// replaces rather than accumulates.
		{Keys: bson.D{{Key: "stream_key", Value: 1}}, Options: options.Index().SetUnique(true)},
		// Revoke-all-for-a-connection.
		{Keys: bson.D{{Key: "connection_id", Value: 1}}},
	}
	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Upsert replaces the secret for a stream key, returning the stored
// record. Replace rather than insert because a push connection is
// re-registered on every stream (re)start: accumulating one secret per
// restart would leave an unbounded set of valid credentials for the
// same channel.
func (r *PushSecretRepository) Upsert(ctx context.Context, ps *models.PushSecret) error {
	if ps.CreatedAt.IsZero() {
		ps.CreatedAt = time.Now().UTC()
	}
	if ps.ID == "" {
		ps.ID = uuid.NewString()
	}
	opts := options.Replace().SetUpsert(true)
	_, err := r.collection.ReplaceOne(ctx, bson.M{"stream_key": ps.StreamKey}, ps, opts)
	return err
}

// FindBySecret returns the record matching `secret`, or
// mongo.ErrNoDocuments. The inbound accept path uses this for auth.
func (r *PushSecretRepository) FindBySecret(ctx context.Context, secret string) (*models.PushSecret, error) {
	var ps models.PushSecret
	if err := r.collection.FindOne(ctx, bson.M{"secret": secret}).Decode(&ps); err != nil {
		return nil, err
	}
	return &ps, nil
}

// TouchLastUsed bumps last_used_at. Best-effort: callers ignore the
// error, because failing to record an audit timestamp is not a reason
// to drop a live push connection.
func (r *PushSecretRepository) TouchLastUsed(ctx context.Context, id string) error {
	_, err := r.collection.UpdateByID(ctx, id, bson.M{"$set": bson.M{"last_used_at": time.Now().UTC()}})
	return err
}

// DeleteByConnection revokes every secret for a connection. Called when
// a connection is deleted so its channels cannot be re-entered.
func (r *PushSecretRepository) DeleteByConnection(ctx context.Context, connectionID string) error {
	_, err := r.collection.DeleteMany(ctx, bson.M{"connection_id": connectionID})
	return err
}
