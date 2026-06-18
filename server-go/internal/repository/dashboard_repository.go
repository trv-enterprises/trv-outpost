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

// DashboardRepository handles dashboard data operations
type DashboardRepository struct {
	collection *mongo.Collection
}

// NewDashboardRepository creates a new dashboard repository
func NewDashboardRepository(db *mongo.Database) *DashboardRepository {
	return &DashboardRepository{
		collection: db.Collection("dashboards"),
	}
}

// CreateIndexes creates necessary indexes for the dashboards collection
func (r *DashboardRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "name", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{
			Keys: bson.D{{Key: "panels.component_id", Value: 1}}, // For finding dashboards by component
		},
		{
			Keys: bson.D{{Key: "updated", Value: -1}},
		},
	}

	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Create creates a new dashboard
func (r *DashboardRepository) Create(ctx context.Context, req *models.CreateDashboardRequest) (*models.Dashboard, error) {
	// Initialize panels if nil
	panels := req.Panels
	if panels == nil {
		panels = []models.DashboardPanel{}
	}

	dashboard := &models.Dashboard{
		ID:          uuid.New().String(),
		Namespace:   req.Namespace,
		Name:        req.Name,
		Description: req.Description,
		Panels:      panels,
		Settings:    req.Settings,
		Tags:        req.Tags,
		Metadata:    req.Metadata,
		Created:     time.Now(),
		Updated:     time.Now(),
	}

	_, err := r.collection.InsertOne(ctx, dashboard)
	if err != nil {
		return nil, fmt.Errorf("failed to insert dashboard: %w", err)
	}

	return dashboard, nil
}

// FindByID retrieves a dashboard by ID
func (r *DashboardRepository) FindByID(ctx context.Context, id string) (*models.Dashboard, error) {
	var dashboard models.Dashboard
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&dashboard)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to find dashboard: %w", err)
	}
	return &dashboard, nil
}

// FindByName retrieves a dashboard by (namespace, name).
func (r *DashboardRepository) FindByName(ctx context.Context, namespace, name string) (*models.Dashboard, error) {
	var dashboard models.Dashboard
	err := r.collection.FindOne(ctx, bson.M{"namespace": namespace, "name": name}).Decode(&dashboard)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to find dashboard: %w", err)
	}
	return &dashboard, nil
}

// CountByNamespace returns the number of dashboards in a namespace.
// Implements service.NamespaceCounter.
func (r *DashboardRepository) CountByNamespace(ctx context.Context, namespace string) (int64, error) {
	return r.collection.CountDocuments(ctx, bson.M{"namespace": namespace})
}

// RenameNamespace updates every dashboard record currently in oldName
// to newName. Implements service.NamespaceRenamer.
func (r *DashboardRepository) RenameNamespace(ctx context.Context, oldName, newName string) (int64, error) {
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

// List retrieves dashboards with optional filtering and pagination
func (r *DashboardRepository) List(ctx context.Context, params models.DashboardQueryParams) ([]models.Dashboard, int64, error) {
	// Build filter
	filter := bson.M{}
	if params.Namespace != "" {
		filter["namespace"] = params.Namespace
	}
	if params.Name != "" {
		// $regex does NOT respect collection collation (MongoDB limitation),
		// so we must explicitly request case-insensitive matching.
		filter["name"] = bson.M{"$regex": params.Name, "$options": "i"}
	}
	if params.IsPublic != nil {
		filter["settings.is_public"] = *params.IsPublic
	}
	if params.ComponentID != "" {
		filter["panels.component_id"] = params.ComponentID
	}
	if len(params.Tags) > 0 {
		filter["tags"] = bson.M{"$in": params.Tags}
	}

	// Count total documents
	total, err := r.collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count dashboards: %w", err)
	}

	// Calculate pagination. The page-size CAP is owned by the service
	// (ClampPageSize); the repo only floors a non-positive value so direct
	// callers/tests still get a sane page.
	page := params.Page
	if page < 1 {
		page = 1
	}
	pageSize := params.PageSize
	if pageSize < 1 {
		pageSize = 20
	}

	skip := int64((page - 1) * pageSize)
	limit := int64(pageSize)

	// Find options with pagination and allowlisted sort (default name ASC).
	opts := options.Find().
		SetSkip(skip).
		SetLimit(limit).
		SetSort(models.ResolveSort(
			models.DashboardSortFields, params.Sort, params.Direction,
			models.DashboardDefaultSortField, models.DashboardDefaultSortDir,
		))

	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to find dashboards: %w", err)
	}
	defer cursor.Close(ctx)

	var dashboards []models.Dashboard
	if err := cursor.All(ctx, &dashboards); err != nil {
		return nil, 0, fmt.Errorf("failed to decode dashboards: %w", err)
	}

	return dashboards, total, nil
}

// Update updates a dashboard
func (r *DashboardRepository) Update(ctx context.Context, id string, req *models.UpdateDashboardRequest) (*models.Dashboard, error) {
	update := bson.M{
		"$set": bson.M{
			"updated": time.Now(),
		},
	}

	setFields := update["$set"].(bson.M)

	if req.Namespace != nil {
		setFields["namespace"] = *req.Namespace
	}
	if req.Name != nil {
		setFields["name"] = *req.Name
	}
	if req.Description != nil {
		setFields["description"] = *req.Description
	}
	if req.Panels != nil {
		setFields["panels"] = *req.Panels
	}
	if req.Settings != nil {
		setFields["settings"] = *req.Settings
	}
	if req.Tags != nil {
		setFields["tags"] = *req.Tags
	}
	if req.Metadata != nil {
		setFields["metadata"] = *req.Metadata
	}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var dashboard models.Dashboard
	err := r.collection.FindOneAndUpdate(
		ctx,
		bson.M{"_id": id},
		update,
		opts,
	).Decode(&dashboard)

	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to update dashboard: %w", err)
	}

	return &dashboard, nil
}

// Delete deletes a dashboard by ID
func (r *DashboardRepository) Delete(ctx context.Context, id string) error {
	result, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return fmt.Errorf("failed to delete dashboard: %w", err)
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("dashboard not found")
	}
	return nil
}

// AttachChartToPanel sets the chart_id on a specific panel within a dashboard
func (r *DashboardRepository) AttachChartToPanel(ctx context.Context, dashboardID, panelID, chartID string) error {
	filter := bson.M{
		"_id":       dashboardID,
		"panels.id": panelID,
	}
	update := bson.M{
		"$set": bson.M{
			"panels.$.chart_id": chartID,
			"updated":           time.Now(),
		},
	}
	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("failed to attach chart to panel: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("dashboard or panel not found")
	}
	return nil
}

// FindByComponentID retrieves all dashboards using a specific component
// Used for notifying dashboards when a component is updated
func (r *DashboardRepository) FindByComponentID(ctx context.Context, componentID string) ([]models.Dashboard, error) {
	filter := bson.M{"panels.component_id": componentID}

	cursor, err := r.collection.Find(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to find dashboards by component: %w", err)
	}
	defer cursor.Close(ctx)

	var dashboards []models.Dashboard
	if err := cursor.All(ctx, &dashboards); err != nil {
		return nil, fmt.Errorf("failed to decode dashboards: %w", err)
	}

	return dashboards, nil
}

// ListWithConnections retrieves dashboard summaries with data source names using aggregation
// This performs a multi-collection join: dashboards -> charts -> datasources
func (r *DashboardRepository) ListWithConnections(ctx context.Context, params models.DashboardQueryParams, db *mongo.Database) ([]models.DashboardSummary, int64, error) {
	// Build filter
	filter := bson.M{}
	if params.Namespace != "" {
		filter["namespace"] = params.Namespace
	}
	if params.Name != "" {
		// $regex does NOT respect collection collation (MongoDB limitation),
		// so we must explicitly request case-insensitive matching.
		filter["name"] = bson.M{"$regex": params.Name, "$options": "i"}
	}
	if params.IsPublic != nil {
		filter["settings.is_public"] = *params.IsPublic
	}
	if params.ComponentID != "" {
		filter["panels.component_id"] = params.ComponentID
	}
	if len(params.Tags) > 0 {
		filter["tags"] = bson.M{"$in": params.Tags}
	}

	// Count total documents (without aggregation for performance)
	total, err := r.collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count dashboards: %w", err)
	}

	// Calculate pagination. Cap is owned by the service (ClampPageSize); the
	// repo only floors a non-positive value.
	page := params.Page
	if page < 1 {
		page = 1
	}
	pageSize := params.PageSize
	if pageSize < 1 {
		pageSize = 20
	}

	skip := int64((page - 1) * pageSize)
	limit := int64(pageSize)

	// Aggregation pipeline to get dashboards with data source names
	pipeline := mongo.Pipeline{
		// Match filter
		{{Key: "$match", Value: filter}},
		// Allowlisted sort (default name ASC) — keep consistent with List().
		{{Key: "$sort", Value: models.ResolveSort(
			models.DashboardSortFields, params.Sort, params.Direction,
			models.DashboardDefaultSortField, models.DashboardDefaultSortDir,
		)}},
		// Pagination
		{{Key: "$skip", Value: skip}},
		{{Key: "$limit", Value: limit}},
		// Extract component_ids from panels
		{{Key: "$addFields", Value: bson.D{
			{Key: "component_ids", Value: bson.D{
				{Key: "$filter", Value: bson.D{
					{Key: "input", Value: "$panels.component_id"},
					{Key: "as", Value: "cid"},
					{Key: "cond", Value: bson.D{
						{Key: "$and", Value: bson.A{
							bson.D{{Key: "$ne", Value: bson.A{"$$cid", ""}}},
							bson.D{{Key: "$ne", Value: bson.A{"$$cid", nil}}},
						}},
					}},
				}},
			}},
		}}},
		// Lookup components by ID. Collection is `components` (this used to
		// say `charts` — pre-v0.11 drift that left panel_count/connection
		// names empty and forced a client-side workaround; fixed in #21).
		// Components are versioned, so reduce to the latest FINAL version per
		// id before matching, then project id+name (for component_usage) and
		// connection_id (for the connection-name lookup below).
		{{Key: "$lookup", Value: bson.D{
			{Key: "from", Value: "components"},
			{Key: "let", Value: bson.D{{Key: "componentIds", Value: "$component_ids"}}},
			{Key: "pipeline", Value: bson.A{
				bson.D{{Key: "$match", Value: bson.D{
					{Key: "$expr", Value: bson.D{
						{Key: "$and", Value: bson.A{
							bson.D{{Key: "$in", Value: bson.A{"$id", "$$componentIds"}}},
							bson.D{{Key: "$eq", Value: bson.A{"$status", "final"}}}, // Only final components
						}},
					}},
				}}},
				bson.D{{Key: "$sort", Value: bson.D{{Key: "id", Value: 1}, {Key: "version", Value: -1}}}},
				bson.D{{Key: "$group", Value: bson.M{
					"_id":           "$id",
					"id":            bson.M{"$first": "$id"},
					"name":          bson.M{"$first": "$name"},
					"connection_id": bson.M{"$first": "$connection_id"},
				}}},
			}},
			{Key: "as", Value: "matched_components"},
		}}},
		// Extract unique connection_ids from matched components
		{{Key: "$addFields", Value: bson.D{
			{Key: "connection_ids", Value: bson.D{
				{Key: "$setUnion", Value: bson.A{
					bson.D{{Key: "$filter", Value: bson.D{
						{Key: "input", Value: "$matched_components.connection_id"},
						{Key: "as", Value: "dsid"},
						{Key: "cond", Value: bson.D{
							{Key: "$and", Value: bson.A{
								bson.D{{Key: "$ne", Value: bson.A{"$$dsid", ""}}},
								bson.D{{Key: "$ne", Value: bson.A{"$$dsid", nil}}},
							}},
						}},
					}}},
				}},
			}},
		}}},
		// Lookup connections to get their names. Connection _id is a STRING
		// (UUID), so match the connection_ids directly — NOT via $toObjectId
		// (that failed on the 36-char UUIDs once the component lookup above
		// started returning real connection_ids, the second half of the
		// pre-v0.11 breakage fixed in #21). Compare with $toString defensively
		// in case any legacy connection has an ObjectId _id.
		{{Key: "$lookup", Value: bson.D{
			{Key: "from", Value: "connections"},
			{Key: "let", Value: bson.D{{Key: "dsIds", Value: "$connection_ids"}}},
			{Key: "pipeline", Value: bson.A{
				bson.D{{Key: "$match", Value: bson.D{
					{Key: "$expr", Value: bson.D{
						{Key: "$in", Value: bson.A{bson.D{{Key: "$toString", Value: "$_id"}}, "$$dsIds"}},
					}},
				}}},
				bson.D{{Key: "$project", Value: bson.D{
					{Key: "name", Value: 1},
				}}},
			}},
			{Key: "as", Value: "matched_datasources"},
		}}},
		// Project final shape
		{{Key: "$project", Value: bson.D{
			{Key: "id", Value: "$_id"},
			{Key: "name", Value: 1},
			{Key: "description", Value: 1},
			{Key: "settings", Value: 1},
			{Key: "tags", Value: 1},
			{Key: "panel_count", Value: bson.D{{Key: "$size", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$panels", bson.A{}}}}}}},
			{Key: "connection_names", Value: "$matched_datasources.name"},
			// {id,name} per referenced component → navigable component popover.
			{Key: "component_usage", Value: bson.D{{Key: "$map", Value: bson.D{
				{Key: "input", Value: "$matched_components"},
				{Key: "as", Value: "c"},
				{Key: "in", Value: bson.D{
					{Key: "id", Value: "$$c.id"},
					{Key: "name", Value: "$$c.name"},
				}},
			}}}},
			{Key: "created", Value: 1},
			{Key: "updated", Value: 1},
		}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to aggregate dashboards: %w", err)
	}
	defer cursor.Close(ctx)

	var summaries []models.DashboardSummary
	if err := cursor.All(ctx, &summaries); err != nil {
		return nil, 0, fmt.Errorf("failed to decode dashboard summaries: %w", err)
	}

	return summaries, total, nil
}
