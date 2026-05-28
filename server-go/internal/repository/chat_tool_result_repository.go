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

// chatToolResultTTL is how long an oversize tool result lives
// server-side. Chat sessions are ephemeral; 24 hours is the same
// posture the AISession record uses.
const chatToolResultTTL = 24 * time.Hour

// ChatToolResultRepository handles the chat_tool_results collection.
type ChatToolResultRepository struct {
	collection *mongo.Collection
}

func NewChatToolResultRepository(db *mongo.Database) *ChatToolResultRepository {
	return &ChatToolResultRepository{collection: db.Collection("chat_tool_results")}
}

// CreateIndexes wires the indexes the store needs:
//   - session_id: lets a Clear-chat action sweep results by session
//   - created with expireAfterSeconds: TTL cleanup (24h)
func (r *ChatToolResultRepository) CreateIndexes(ctx context.Context) error {
	ttlSeconds := int32(chatToolResultTTL.Seconds())
	indexes := []mongo.IndexModel{
		{Keys: bson.D{{Key: "session_id", Value: 1}}},
		{
			Keys:    bson.D{{Key: "created", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(ttlSeconds),
		},
	}
	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Create persists a tool result. Caller is responsible for setting
// the ID; we stamp Created if zero.
func (r *ChatToolResultRepository) Create(ctx context.Context, result *models.ChatToolResult) error {
	if result.Created.IsZero() {
		result.Created = time.Now()
	}
	_, err := r.collection.InsertOne(ctx, result)
	return err
}

// FindByID retrieves a result by ID. Returns (nil, nil) when not
// found (the TTL may have swept it) so callers can produce a clean
// "no longer available" message.
func (r *ChatToolResultRepository) FindByID(ctx context.Context, id string) (*models.ChatToolResult, error) {
	var result models.ChatToolResult
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&result)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// DeleteBySession removes every result tied to a session — used when
// the user clicks "Clear chat" so the storage doesn't outlive the
// conversation.
func (r *ChatToolResultRepository) DeleteBySession(ctx context.Context, sessionID string) error {
	_, err := r.collection.DeleteMany(ctx, bson.M{"session_id": sessionID})
	return err
}
