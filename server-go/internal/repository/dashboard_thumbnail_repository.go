// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// DashboardThumbnailRepository stores dashboard thumbnail blobs in a
// dedicated collection (`dashboard_thumbnails`), keyed by dashboard ID.
// Thumbnails are base64 data URLs (often 50–200 KB) that used to live
// embedded in the dashboard document, bloating every list/read payload.
// Splitting them out lets list endpoints stay lean and tiles lazy-load
// the blob on demand (see #19).
type DashboardThumbnailRepository struct {
	collection *mongo.Collection
}

// NewDashboardThumbnailRepository creates a new thumbnail repository.
func NewDashboardThumbnailRepository(db *mongo.Database) *DashboardThumbnailRepository {
	return &DashboardThumbnailRepository{
		collection: db.Collection("dashboard_thumbnails"),
	}
}

// dashboardThumbnail is the on-disk shape: _id is the dashboard ID, data
// holds the base64 data URL.
type dashboardThumbnail struct {
	ID      string    `bson:"_id"`
	Data    string    `bson:"data"`
	Updated time.Time `bson:"updated"`
}

// Get returns the stored thumbnail data URL for a dashboard, or "" (no
// error) when none has been captured yet.
func (r *DashboardThumbnailRepository) Get(ctx context.Context, dashboardID string) (string, error) {
	var doc dashboardThumbnail
	err := r.collection.FindOne(ctx, bson.M{"_id": dashboardID}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return "", nil
		}
		return "", fmt.Errorf("failed to get thumbnail: %w", err)
	}
	return doc.Data, nil
}

// Put upserts the thumbnail blob for a dashboard.
func (r *DashboardThumbnailRepository) Put(ctx context.Context, dashboardID, data string) error {
	_, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": dashboardID},
		bson.M{"$set": bson.M{"data": data, "updated": time.Now()}},
		options.Update().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("failed to put thumbnail: %w", err)
	}
	return nil
}

// Delete removes a dashboard's thumbnail blob. No-op when none exists.
func (r *DashboardThumbnailRepository) Delete(ctx context.Context, dashboardID string) error {
	_, err := r.collection.DeleteOne(ctx, bson.M{"_id": dashboardID})
	if err != nil {
		return fmt.Errorf("failed to delete thumbnail: %w", err)
	}
	return nil
}
