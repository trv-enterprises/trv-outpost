// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// RevokedFamiliesRepository persists the set of refresh-token
// family_id values that should be rejected on next presentation. A
// family lands here for two reasons:
//
//  1. Explicit revocation (sign-out, admin force-logout-everywhere).
//  2. Replay detection — when /auth/refresh receives a refresh token
//     whose jti is older than the latest in its family, the family
//     is poisoned and added here. The standard stolen-refresh
//     mitigation.
//
// Stored as a tiny collection: one row per revoked family, TTL'd
// to the refresh-token max lifetime (no value in keeping families
// past the point where any descendant token could still verify).
type RevokedFamiliesRepository struct {
	collection *mongo.Collection
}

// RevokedFamily is the persisted record. ExpiresAt drives the TTL
// index — Mongo deletes the row once expires_at passes "now."
type RevokedFamily struct {
	FamilyID  string    `bson:"_id"`
	Reason    string    `bson:"reason"`
	RevokedAt time.Time `bson:"revoked_at"`
	ExpiresAt time.Time `bson:"expires_at"`
	UserGUID  string    `bson:"user_guid,omitempty"`
}

// NewRevokedFamiliesRepository constructs the repo against the
// dashboard DB.
func NewRevokedFamiliesRepository(db *mongo.Database) *RevokedFamiliesRepository {
	return &RevokedFamiliesRepository{collection: db.Collection("revoked_refresh_families")}
}

// CreateIndexes wires the TTL index. Idempotent; called once at
// server boot from main.go (same pattern as every other repo).
func (r *RevokedFamiliesRepository) CreateIndexes(ctx context.Context) error {
	_, err := r.collection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "expires_at", Value: 1}},
		Options: options.Index().SetExpireAfterSeconds(0),
	})
	return err
}

// Revoke adds a family to the revoked set. Idempotent — re-revoking
// is a no-op. The expiresAt argument should be set to "the latest
// refresh-token exp we could plausibly see for this family" so the
// TTL cleans the record up automatically.
func (r *RevokedFamiliesRepository) Revoke(ctx context.Context, familyID, reason, userGUID string, expiresAt time.Time) error {
	_, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": familyID},
		bson.M{"$set": RevokedFamily{
			FamilyID:  familyID,
			Reason:    reason,
			RevokedAt: time.Now(),
			ExpiresAt: expiresAt,
			UserGUID:  userGUID,
		}},
		options.Update().SetUpsert(true),
	)
	return err
}

// IsRevoked returns true if the family has been poisoned. The check
// is on the request hot path for /auth/refresh; the collection
// stays small (only revoked families, TTL'd to max-refresh-lifetime)
// so the lookup is cheap.
func (r *RevokedFamiliesRepository) IsRevoked(ctx context.Context, familyID string) (bool, error) {
	count, err := r.collection.CountDocuments(ctx, bson.M{"_id": familyID})
	if err != nil {
		return false, err
	}
	return count > 0, nil
}
