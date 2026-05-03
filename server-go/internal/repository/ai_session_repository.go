// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const (
	aiSessionCollection = "ai_sessions"

	// Default TTL for sessions (24 hours)
	defaultSessionTTL = 24 * time.Hour
)

// AISessionRepository handles AI session storage in MongoDB
type AISessionRepository struct {
	collection *mongo.Collection
}

// NewAISessionRepository creates a new AI session repository
func NewAISessionRepository(db *mongo.Database) *AISessionRepository {
	return &AISessionRepository{
		collection: db.Collection(aiSessionCollection),
	}
}

// CreateIndexes creates indexes for the ai_sessions collection
func (r *AISessionRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			// TTL index: MongoDB automatically deletes documents when expires_at is in the past
			Keys:    bson.D{{Key: "expires_at", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(0),
		},
		{
			// Lookup sessions by component_id
			Keys: bson.D{{Key: "component_id", Value: 1}},
		},
		{
			// Filter by status
			Keys: bson.D{{Key: "status", Value: 1}},
		},
		{
			// Compound: FindByComponentID filters on (component_id + status) together.
			Keys: bson.D{{Key: "component_id", Value: 1}, {Key: "status", Value: 1}},
		},
	}

	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	if err != nil {
		return fmt.Errorf("failed to create ai_sessions indexes: %w", err)
	}
	return nil
}

// Create creates a new AI session
func (r *AISessionRepository) Create(ctx context.Context, session *models.AISession) error {
	if session.ID == "" {
		session.ID = uuid.New().String()
	}
	now := time.Now()
	session.Created = now
	session.Updated = now
	if session.Status == "" {
		session.Status = models.AISessionStatusActive
	}
	if session.Messages == nil {
		session.Messages = []models.AIMessage{}
	}
	session.ExpiresAt = now.Add(defaultSessionTTL)

	_, err := r.collection.InsertOne(ctx, session)
	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}

	return nil
}

// FindByID retrieves a session by ID
func (r *AISessionRepository) FindByID(ctx context.Context, id string) (*models.AISession, error) {
	var session models.AISession
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&session)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	return &session, nil
}

// FindByComponentID retrieves the active session for a component
func (r *AISessionRepository) FindByComponentID(ctx context.Context, componentID string) (*models.AISession, error) {
	var session models.AISession
	err := r.collection.FindOne(ctx, bson.M{
		"component_id": componentID,
		"status":       models.AISessionStatusActive,
	}).Decode(&session)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get session for chart: %w", err)
	}

	return &session, nil
}

// Update updates an existing session
func (r *AISessionRepository) Update(ctx context.Context, session *models.AISession) error {
	session.Updated = time.Now()

	_, err := r.collection.ReplaceOne(ctx, bson.M{"_id": session.ID}, session)
	if err != nil {
		return fmt.Errorf("failed to update session: %w", err)
	}

	return nil
}

// Delete removes a session
func (r *AISessionRepository) Delete(ctx context.Context, id string) error {
	_, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return fmt.Errorf("failed to delete session: %w", err)
	}

	return nil
}

// AddMessage adds a message to a session
func (r *AISessionRepository) AddMessage(ctx context.Context, sessionID string, message *models.AIMessage) error {
	if message.ID == "" {
		message.ID = uuid.New().String()
	}
	if message.Timestamp.IsZero() {
		message.Timestamp = time.Now()
	}

	_, err := r.collection.UpdateOne(ctx,
		bson.M{"_id": sessionID},
		bson.M{
			"$push": bson.M{"messages": message},
			"$set":  bson.M{"updated": time.Now()},
		},
	)
	if err != nil {
		return fmt.Errorf("failed to add message: %w", err)
	}

	return nil
}

// UpdateStatus updates the session status
func (r *AISessionRepository) UpdateStatus(ctx context.Context, sessionID string, status string) error {
	_, err := r.collection.UpdateOne(ctx,
		bson.M{"_id": sessionID},
		bson.M{"$set": bson.M{
			"status":  status,
			"updated": time.Now(),
		}},
	)
	if err != nil {
		return fmt.Errorf("failed to update session status: %w", err)
	}

	return nil
}

// RefreshTTL extends the session TTL
func (r *AISessionRepository) RefreshTTL(ctx context.Context, sessionID string) error {
	_, err := r.collection.UpdateOne(ctx,
		bson.M{"_id": sessionID},
		bson.M{"$set": bson.M{
			"expires_at": time.Now().Add(defaultSessionTTL),
		}},
	)
	if err != nil {
		return fmt.Errorf("failed to refresh TTL: %w", err)
	}

	return nil
}

// ListActive returns all active sessions (for admin/monitoring)
func (r *AISessionRepository) ListActive(ctx context.Context) ([]models.AISession, error) {
	cursor, err := r.collection.Find(ctx, bson.M{"status": models.AISessionStatusActive})
	if err != nil {
		return nil, fmt.Errorf("failed to list active sessions: %w", err)
	}
	defer cursor.Close(ctx)

	var sessions []models.AISession
	if err := cursor.All(ctx, &sessions); err != nil {
		return nil, fmt.Errorf("failed to decode sessions: %w", err)
	}

	return sessions, nil
}
