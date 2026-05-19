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

// WebhookSecretRepository persists URL-embedded secrets for inbound
// tsstore webhook routing. See models/webhook_secret.go for the
// security model.
type WebhookSecretRepository struct {
	collection *mongo.Collection
}

// NewWebhookSecretRepository constructs the repo against the
// dashboard DB.
func NewWebhookSecretRepository(db *mongo.Database) *WebhookSecretRepository {
	return &WebhookSecretRepository{collection: db.Collection("webhook_secrets")}
}

// CreateIndexes ensures lookup by secret value is O(1) and the
// per-connection list is fast. Called once at server boot from
// main.go. Idempotent.
func (r *WebhookSecretRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		// Lookup-by-secret is the receive-path hot path. Unique
		// because two records sharing a secret would mean we can't
		// tell which connection the payload is for.
		{Keys: bson.D{{Key: "secret", Value: 1}}, Options: options.Index().SetUnique(true)},
		// Per-connection listing for the future "list/revoke
		// secrets" admin view.
		{Keys: bson.D{{Key: "connection_id", Value: 1}, {Key: "created_at", Value: -1}}},
	}
	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Create persists a new secret.
func (r *WebhookSecretRepository) Create(ctx context.Context, ws *models.WebhookSecret) error {
	if ws.CreatedAt.IsZero() {
		ws.CreatedAt = time.Now().UTC()
	}
	_, err := r.collection.InsertOne(ctx, ws)
	return err
}

// FindBySecret returns the record matching `secret` or
// mongo.ErrNoDocuments. The receive-path uses this for auth.
func (r *WebhookSecretRepository) FindBySecret(ctx context.Context, secret string) (*models.WebhookSecret, error) {
	var ws models.WebhookSecret
	if err := r.collection.FindOne(ctx, bson.M{"secret": secret}).Decode(&ws); err != nil {
		return nil, err
	}
	return &ws, nil
}

// TouchLastUsed updates last_used_at on a secret. Best-effort:
// errors are ignored by callers because failing to bump the audit
// trail is not worth dropping a valid webhook delivery.
func (r *WebhookSecretRepository) TouchLastUsed(ctx context.Context, id string) error {
	_, err := r.collection.UpdateByID(ctx, id, bson.M{"$set": bson.M{"last_used_at": time.Now().UTC()}})
	return err
}

// ListByConnection returns every secret bound to a connection. For
// the future admin view; not on a hot path.
func (r *WebhookSecretRepository) ListByConnection(ctx context.Context, connectionID string) ([]*models.WebhookSecret, error) {
	cursor, err := r.collection.Find(ctx, bson.M{"connection_id": connectionID})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var out []*models.WebhookSecret
	if err := cursor.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Delete removes a secret. Old ts-store rules using its URL start
// 404'ing on next fire; the user must edit the rule on the tsstore
// side (or recreate via the dashboard, generating a new secret).
func (r *WebhookSecretRepository) Delete(ctx context.Context, id string) error {
	_, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	return err
}
