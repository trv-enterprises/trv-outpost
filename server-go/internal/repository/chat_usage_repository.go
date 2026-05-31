// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// chatUsageRetention is how long we keep per-user-per-day rows
// around for auditing. 90 days is generous — admins can spot
// pattern abuse over a quarter without keeping rows forever.
const chatUsageRetention = 90 * 24 * time.Hour

// ChatUsageRepository owns the chat_usage collection. Rows are
// per-(user, UTC date), incremented atomically via $inc.
type ChatUsageRepository struct {
	collection *mongo.Collection
}

func NewChatUsageRepository(db *mongo.Database) *ChatUsageRepository {
	return &ChatUsageRepository{collection: db.Collection("chat_usage")}
}

// CreateIndexes wires the indexes we need:
//   - user_guid: list-by-user query
//   - created with TTL: 90-day sweep
func (r *ChatUsageRepository) CreateIndexes(ctx context.Context) error {
	ttlSeconds := int32(chatUsageRetention.Seconds())
	indexes := []mongo.IndexModel{
		{Keys: bson.D{{Key: "user_guid", Value: 1}}},
		{
			Keys:    bson.D{{Key: "created", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(ttlSeconds),
		},
	}
	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// dayKey returns the composite ID for a (user, day) pair. Uses
// UTC to avoid duplicate rows when the day boundary in the user's
// local timezone crosses midnight UTC.
func dayKey(userGUID string, t time.Time) string {
	return fmt.Sprintf("%s:%s", userGUID, t.UTC().Format("2006-01-02"))
}

// GetToday returns today's row for the given user, or nil if none
// exists yet. Used by the budget check to read the current totals.
func (r *ChatUsageRepository) GetToday(ctx context.Context, userGUID string, now time.Time) (*models.ChatUsageDay, error) {
	var doc models.ChatUsageDay
	err := r.collection.FindOne(ctx, bson.M{"_id": dayKey(userGUID, now)}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &doc, nil
}

// ListSince returns all usage rows on or after the given UTC date
// (format "2006-01-02"), newest day first, across every user. The AI
// API Usage admin page groups these per user for the today + 30-day
// view. Cap is generous; for a single-tenant homelab this is small.
func (r *ChatUsageRepository) ListSince(ctx context.Context, sinceUTCDate string) ([]models.ChatUsageDay, error) {
	cur, err := r.collection.Find(
		ctx,
		bson.M{"date_utc": bson.M{"$gte": sinceUTCDate}},
		options.Find().SetSort(bson.D{{Key: "date_utc", Value: -1}, {Key: "user_guid", Value: 1}}),
	)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var out []models.ChatUsageDay
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteForUserDay removes a single (user, UTC date) usage row. NOT
// exposed in the shipped UI — used only by the local dev/test reset
// path (a one-line Mongo command does the same; this exists for
// completeness/testing). Returns the number of rows deleted (0 or 1).
func (r *ChatUsageRepository) DeleteForUserDay(ctx context.Context, userGUID, utcDate string) (int64, error) {
	res, err := r.collection.DeleteOne(ctx, bson.M{"_id": fmt.Sprintf("%s:%s", userGUID, utcDate)})
	if err != nil {
		return 0, err
	}
	return res.DeletedCount, nil
}

// IncrementToday atomically adds the given input/output deltas to
// today's row, creating it if absent. Called once per successful
// Anthropic API response.
func (r *ChatUsageRepository) IncrementToday(ctx context.Context, userGUID string, now time.Time, inputDelta, outputDelta int64) error {
	id := dayKey(userGUID, now)
	dateStr := now.UTC().Format("2006-01-02")
	_, err := r.collection.UpdateByID(
		ctx,
		id,
		bson.M{
			"$inc": bson.M{
				"input_tokens":  inputDelta,
				"output_tokens": outputDelta,
			},
			"$setOnInsert": bson.M{
				"user_guid": userGUID,
				"date_utc":  dateStr,
				"created":   now,
			},
			"$set": bson.M{
				"updated": now,
			},
		},
		options.Update().SetUpsert(true),
	)
	return err
}
