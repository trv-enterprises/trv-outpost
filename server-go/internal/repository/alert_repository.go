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

// AlertRepository handles the persisted-alert collection that backs
// the in-app bell panel. The schema lives in models/alert.go; the
// canonical visibility predicate is `Seen=false OR Pinned=true`.
type AlertRepository struct {
	collection *mongo.Collection
}

// NewAlertRepository constructs the repo against the dashboard DB.
func NewAlertRepository(db *mongo.Database) *AlertRepository {
	return &AlertRepository{collection: db.Collection("alerts")}
}

// CreateIndexes wires the indexes the bell-load query and the TTL
// sweep depend on. Called once at server boot from main.go (same
// pattern as every other repo). Idempotent.
func (r *AlertRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		// Visibility predicate. `Seen=false OR Pinned=true` is the
		// bell-load filter — index both fields for predicate-pushdown
		// then sort by fired_at desc.
		{Keys: bson.D{{Key: "seen", Value: 1}, {Key: "pinned", Value: 1}, {Key: "fired_at", Value: -1}}},
		// Time-ordered scan (recent alerts first) for the manage-mode
		// "everything, including dismissed" view we haven't built yet
		// but will want soon.
		{Keys: bson.D{{Key: "fired_at", Value: -1}}},
		// TTL on expires_at — Mongo deletes the doc once expires_at
		// passes "now." ExpireAfterSeconds = 0 means "expire at the
		// stored time exactly," not "0 seconds after creation."
		{
			Keys:    bson.D{{Key: "expires_at", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(0),
		},
	}
	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Insert stores a freshly-received alert. Callers should populate
// FiredAt, ReceivedAt, ExpiresAt, plus the source fields; Seen and
// Pinned default to false.
func (r *AlertRepository) Insert(ctx context.Context, a *models.Alert) error {
	_, err := r.collection.InsertOne(ctx, a)
	return err
}

// ListVisible returns alerts the bell should render: Seen=false OR
// Pinned=true. Capped at `limit` (most-recent first). limit<=0
// defaults to 200, which is well past the practical bell-panel
// rendering ceiling but bounds payload size.
func (r *AlertRepository) ListVisible(ctx context.Context, limit int64) ([]models.Alert, int64, error) {
	if limit <= 0 {
		limit = 200
	}
	filter := bson.M{"$or": []bson.M{
		{"seen": false},
		{"pinned": true},
	}}
	opts := options.Find().
		SetSort(bson.D{{Key: "fired_at", Value: -1}}).
		SetLimit(limit)

	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, 0, err
	}
	defer cursor.Close(ctx)

	var alerts []models.Alert
	if err := cursor.All(ctx, &alerts); err != nil {
		return nil, 0, err
	}
	visible, err := r.collection.CountDocuments(ctx, filter)
	if err != nil {
		return alerts, int64(len(alerts)), nil
	}
	return alerts, visible, nil
}

// MarkSeen flips an alert's Seen flag to true. Idempotent —
// re-marking a seen alert is a no-op. Records the GUID of the user
// who acted so the audit trail isn't lost. Pinning is NOT cleared
// — a pinned alert stays visible to other users even after one user
// has personally dismissed it.
func (r *AlertRepository) MarkSeen(ctx context.Context, alertID, userGUID string) error {
	now := time.Now()
	_, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": alertID},
		bson.M{"$set": bson.M{
			"seen":     true,
			"seen_by":  userGUID,
			"seen_at":  now,
		}},
	)
	return err
}

// Pin flips Pinned=true and resets Seen=false so the alert reappears
// on every active bell. The caller's GUID is recorded for audit.
func (r *AlertRepository) Pin(ctx context.Context, alertID, userGUID string) error {
	now := time.Now()
	_, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": alertID},
		bson.M{"$set": bson.M{
			"pinned":     true,
			"pinned_by":  userGUID,
			"pinned_at":  now,
			"seen":       false,
		}},
	)
	return err
}

// Unpin flips Pinned=false. Doesn't touch Seen — if the user wants
// the alert to drop off bells immediately after unpinning, they
// should mark it seen too (the UI does this for the "Dismiss"
// affordance; unpin alone just re-enables seen-tracking).
func (r *AlertRepository) Unpin(ctx context.Context, alertID string) error {
	_, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": alertID},
		bson.M{"$set": bson.M{"pinned": false}},
	)
	return err
}
