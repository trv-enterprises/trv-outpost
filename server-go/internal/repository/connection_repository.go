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

// ConnectionRepository handles connection data access
type ConnectionRepository struct {
	collection *mongo.Collection
}

// NewConnectionRepository creates a new connection repository
func NewConnectionRepository(db *mongo.Database) *ConnectionRepository {
	return &ConnectionRepository{
		collection: db.Collection("connections"),
	}
}

// Create creates a new connection. The ID is a UUID; if the caller
// has already set one (e.g., during a bundle import where the ID needs
// to round-trip), it is preserved.
func (r *ConnectionRepository) Create(ctx context.Context, connection *models.Connection) error {
	if connection.ID == "" {
		connection.ID = uuid.NewString()
	}
	connection.CreatedAt = time.Now()
	connection.UpdatedAt = time.Now()

	// Initialize health status as unknown
	if connection.Health.Status == "" {
		connection.Health.Status = models.HealthStatusUnknown
	}

	_, err := r.collection.InsertOne(ctx, connection)
	return err
}

// FindByID retrieves a connection by ID
func (r *ConnectionRepository) FindByID(ctx context.Context, id string) (*models.Connection, error) {
	var connection models.Connection
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&connection)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}

	return &connection, nil
}

// FindAll retrieves all connections with pagination
func (r *ConnectionRepository) FindAll(ctx context.Context, limit, offset int64) ([]*models.Connection, error) {
	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}}).
		SetLimit(limit).
		SetSkip(offset)

	cursor, err := r.collection.Find(ctx, bson.M{}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var connections []*models.Connection
	if err := cursor.All(ctx, &connections); err != nil {
		return nil, err
	}

	return connections, nil
}

// FindByType retrieves connections by type with pagination
func (r *ConnectionRepository) FindByType(ctx context.Context, dsType models.ConnectionType, limit, offset int64) ([]*models.Connection, error) {
	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}}).
		SetLimit(limit).
		SetSkip(offset)

	cursor, err := r.collection.Find(ctx, bson.M{"type": dsType}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var connections []*models.Connection
	if err := cursor.All(ctx, &connections); err != nil {
		return nil, err
	}

	return connections, nil
}

// List retrieves connections with optional namespace, type, and tag
// filters, sorted by created_at descending, with pagination. Tags are
// matched with OR semantics via $in. Pass empty namespace ("") to get
// records across all namespaces (cross-namespace toggle). Empty
// typeFilter and nil/empty tags = no filter on those dimensions.
//
// This is the preferred list method for UI-driven filtering. FindAll,
// FindByType, and FindByTags are kept for back-compat with existing call
// sites that pass a single filter.
func (r *ConnectionRepository) List(ctx context.Context, namespace, typeFilter string, tags []string, limit, offset int64) ([]*models.Connection, int64, error) {
	filter := bson.M{}
	if namespace != "" {
		filter["namespace"] = namespace
	}
	if typeFilter != "" {
		filter["type"] = typeFilter
	}
	if len(tags) > 0 {
		filter["tags"] = bson.M{"$in": tags}
	}

	total, err := r.collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, err
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}}).
		SetLimit(limit).
		SetSkip(offset)

	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, 0, err
	}
	defer cursor.Close(ctx)

	var connections []*models.Connection
	if err := cursor.All(ctx, &connections); err != nil {
		return nil, 0, err
	}

	return connections, total, nil
}

// FindByTags retrieves connections with any of the given tags
func (r *ConnectionRepository) FindByTags(ctx context.Context, tags []string, limit, offset int64) ([]*models.Connection, error) {
	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}}).
		SetLimit(limit).
		SetSkip(offset)

	filter := bson.M{"tags": bson.M{"$in": tags}}
	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var connections []*models.Connection
	if err := cursor.All(ctx, &connections); err != nil {
		return nil, err
	}

	return connections, nil
}

// Update updates an existing connection
func (r *ConnectionRepository) Update(ctx context.Context, id string, connection *models.Connection) error {
	connection.UpdatedAt = time.Now()

	filter := bson.M{"_id": id}
	update := bson.M{"$set": connection}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return err
	}

	if result.MatchedCount == 0 {
		return mongo.ErrNoDocuments
	}

	return nil
}

// UpdateHealth updates only the health information of a connection
func (r *ConnectionRepository) UpdateHealth(ctx context.Context, id string, health models.HealthInfo) error {
	filter := bson.M{"_id": id}
	update := bson.M{
		"$set": bson.M{
			"health":     health,
			"updated_at": time.Now(),
		},
	}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return err
	}

	if result.MatchedCount == 0 {
		return mongo.ErrNoDocuments
	}

	return nil
}

// Delete deletes a connection by ID
func (r *ConnectionRepository) Delete(ctx context.Context, id string) error {
	result, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return err
	}

	if result.DeletedCount == 0 {
		return mongo.ErrNoDocuments
	}

	return nil
}

// Count returns the total number of connections
func (r *ConnectionRepository) Count(ctx context.Context) (int64, error) {
	return r.collection.CountDocuments(ctx, bson.M{})
}

// CountByType returns the number of connections of a specific type
func (r *ConnectionRepository) CountByType(ctx context.Context, dsType models.ConnectionType) (int64, error) {
	return r.collection.CountDocuments(ctx, bson.M{"type": dsType})
}

// FindByName retrieves a connection by (namespace, name) — the compound
// uniqueness key. Returns (nil, nil) if not found.
func (r *ConnectionRepository) FindByName(ctx context.Context, namespace, name string) (*models.Connection, error) {
	var connection models.Connection
	err := r.collection.FindOne(ctx, bson.M{"namespace": namespace, "name": name}).Decode(&connection)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}

	return &connection, nil
}

// CountByNamespace returns the number of connections in a namespace.
// Used by the namespace-delete guard. Implements service.NamespaceCounter.
func (r *ConnectionRepository) CountByNamespace(ctx context.Context, namespace string) (int64, error) {
	return r.collection.CountDocuments(ctx, bson.M{"namespace": namespace})
}

// RenameNamespace updates every connection record currently in oldName
// to newName. Used by the namespace rename cascade. Implements
// service.NamespaceRenamer.
func (r *ConnectionRepository) RenameNamespace(ctx context.Context, oldName, newName string) (int64, error) {
	res, err := r.collection.UpdateMany(
		ctx,
		bson.M{"namespace": oldName},
		bson.M{"$set": bson.M{"namespace": newName}},
	)
	if err != nil {
		return 0, err
	}
	return res.ModifiedCount, nil
}

// FindUnhealthy retrieves all connections with unhealthy status
func (r *ConnectionRepository) FindUnhealthy(ctx context.Context) ([]*models.Connection, error) {
	filter := bson.M{
		"health.status": bson.M{
			"$in": []models.HealthStatus{
				models.HealthStatusUnhealthy,
				models.HealthStatusDegraded,
			},
		},
	}

	cursor, err := r.collection.Find(ctx, filter)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var connections []*models.Connection
	if err := cursor.All(ctx, &connections); err != nil {
		return nil, err
	}

	return connections, nil
}

// FindStale retrieves connections that haven't been checked recently
func (r *ConnectionRepository) FindStale(ctx context.Context, threshold time.Duration) ([]*models.Connection, error) {
	cutoffTime := time.Now().Add(-threshold)
	filter := bson.M{
		"$or": []bson.M{
			{"health.last_check": bson.M{"$lt": cutoffTime}},
			{"health.last_check": bson.M{"$exists": false}},
		},
	}

	cursor, err := r.collection.Find(ctx, filter)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var connections []*models.Connection
	if err := cursor.All(ctx, &connections); err != nil {
		return nil, err
	}

	return connections, nil
}
