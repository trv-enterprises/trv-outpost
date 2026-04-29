// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// ComponentRepository handles component database operations.
// Components use composite key (id, version) for versioning support.
type ComponentRepository struct {
	collection *mongo.Collection
}

// NewComponentRepository creates a new component repository
func NewComponentRepository(db *mongo.Database) *ComponentRepository {
	return &ComponentRepository{
		collection: db.Collection("components"),
	}
}

// CreateIndexes creates necessary indexes for the components collection
func (r *ComponentRepository) CreateIndexes(ctx context.Context) error {
	// First, drop old unique index on name if it exists
	// This is needed because versioning now allows same name across versions
	r.collection.Indexes().DropOne(ctx, "name_1")

	indexes := []mongo.IndexModel{
		// Composite primary key: (id, version) - unique
		{
			Keys:    bson.D{{Key: "id", Value: 1}, {Key: "version", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		// Efficient "latest version" queries: id + version descending
		{
			Keys: bson.D{{Key: "id", Value: 1}, {Key: "version", Value: -1}},
		},
		// Find drafts for a component
		{
			Keys: bson.D{{Key: "id", Value: 1}, {Key: "status", Value: 1}},
		},
		// Name index for search (NOT unique - same name allowed across versions)
		{
			Keys: bson.D{{Key: "name", Value: 1}},
		},
		{
			Keys: bson.D{{Key: "chart_type", Value: 1}},
		},
		{
			Keys: bson.D{{Key: "datasource_id", Value: 1}},
		},
		{
			Keys: bson.D{{Key: "tags", Value: 1}},
		},
		{
			Keys: bson.D{{Key: "updated", Value: -1}},
		},
		{
			Keys: bson.D{{Key: "status", Value: 1}},
		},
		// Compound filter+sort indexes for FindAllLatest list-page queries.
		// Covers the common "filter by component+chart type, sort by updated"
		// pattern used by the components list page.
		{
			Keys: bson.D{
				{Key: "component_type", Value: 1},
				{Key: "chart_type", Value: 1},
				{Key: "updated", Value: -1},
			},
		},
		// Namespace-scoped list queries. No unique constraint — component name
		// uniqueness across (namespace, name) is enforced in the service
		// layer, since the versioning scheme means multiple rows share a
		// (namespace, name) for the same logical component.
		{Keys: bson.D{{Key: "namespace", Value: 1}, {Key: "updated", Value: -1}}},
		{Keys: bson.D{{Key: "namespace", Value: 1}, {Key: "name", Value: 1}}},
		// Covers "components using connection X" queries with recency sort.
		{
			Keys: bson.D{
				{Key: "datasource_id", Value: 1},
				{Key: "updated", Value: -1},
			},
		},
	}

	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Create inserts a new component version
func (r *ComponentRepository) Create(ctx context.Context, component *models.Component) error {
	if component.ID == "" {
		component.ID = uuid.New().String()
	}
	if component.Version == 0 {
		component.Version = 1
	}
	if component.Status == "" {
		component.Status = models.ComponentStatusFinal
	}
	now := time.Now()
	component.Created = now
	component.Updated = now

	_, err := r.collection.InsertOne(ctx, component)
	return err
}

// CreateVersion inserts a new version of an existing component
func (r *ComponentRepository) CreateVersion(ctx context.Context, component *models.Component) error {
	now := time.Now()
	component.Created = now
	component.Updated = now

	_, err := r.collection.InsertOne(ctx, component)
	return err
}

// FindByID retrieves the latest version of a component by ID
func (r *ComponentRepository) FindByID(ctx context.Context, id string) (*models.Component, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "version", Value: -1}})
	var component models.Component
	err := r.collection.FindOne(ctx, bson.M{"id": id}, opts).Decode(&component)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &component, nil
}

// FindByIDAndVersion retrieves a specific version of a component
func (r *ComponentRepository) FindByIDAndVersion(ctx context.Context, id string, version int) (*models.Component, error) {
	var component models.Component
	err := r.collection.FindOne(ctx, bson.M{"id": id, "version": version}).Decode(&component)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &component, nil
}

// FindLatestFinal retrieves the latest final (non-draft) version of a component
func (r *ComponentRepository) FindLatestFinal(ctx context.Context, id string) (*models.Component, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "version", Value: -1}})
	filter := bson.M{"id": id, "status": models.ComponentStatusFinal}
	var component models.Component
	err := r.collection.FindOne(ctx, filter, opts).Decode(&component)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &component, nil
}

// FindDraft retrieves the draft version of a component (if exists)
func (r *ComponentRepository) FindDraft(ctx context.Context, id string) (*models.Component, error) {
	var component models.Component
	err := r.collection.FindOne(ctx, bson.M{"id": id, "status": models.ComponentStatusDraft}).Decode(&component)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &component, nil
}

// FindByName retrieves the latest version of a component by (namespace, name).
// Returns (nil, nil) when no component matches.
func (r *ComponentRepository) FindByName(ctx context.Context, namespace, name string) (*models.Component, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.M{"namespace": namespace, "name": name}}},
		{{Key: "$sort", Value: bson.D{{Key: "version", Value: -1}}}},
		{{Key: "$limit", Value: 1}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var components []models.Component
	if err := cursor.All(ctx, &components); err != nil {
		return nil, err
	}

	if len(components) == 0 {
		return nil, nil
	}
	return &components[0], nil
}

// CountByNamespace returns the number of components (counting unique component
// IDs, not versions) in a namespace. Implements service.NamespaceCounter.
func (r *ComponentRepository) CountByNamespace(ctx context.Context, namespace string) (int64, error) {
	// Distinct component ids in this namespace — versioning means a single
	// logical component has many rows, but the user-visible count is the id
	// count.
	ids, err := r.collection.Distinct(ctx, "id", bson.M{"namespace": namespace})
	if err != nil {
		return 0, err
	}
	return int64(len(ids)), nil
}

// RenameNamespace updates every component row currently in oldName to
// newName. All versions of every component in the namespace are touched.
// Implements service.NamespaceRenamer.
func (r *ComponentRepository) RenameNamespace(ctx context.Context, oldName, newName string) (int64, error) {
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

// FindAllLatest retrieves the latest version of each component with pagination
func (r *ComponentRepository) FindAllLatest(ctx context.Context, params models.ComponentQueryParams) ([]models.Component, int64, error) {
	// Build match filter
	matchFilter := bson.M{}
	if params.Namespace != "" {
		matchFilter["namespace"] = params.Namespace
	}
	if params.Name != "" {
		// Word-prefix match: anchor at \b so a search for "ts" hits
		// "TS-Store" but not "Lights" / "Alerts". QuoteMeta escapes
		// regex metacharacters so a name with `.` or `(` doesn't blow
		// up the query. $regex doesn't respect collection collation
		// (MongoDB limitation), so case-insensitivity is requested
		// explicitly via $options.
		matchFilter["name"] = bson.M{
			"$regex":   `\b` + regexp.QuoteMeta(params.Name),
			"$options": "i",
		}
	}
	if params.ChartType != "" {
		matchFilter["chart_type"] = params.ChartType
	}
	if params.DatasourceID != "" {
		matchFilter["datasource_id"] = params.DatasourceID
	}
	// Tags filter (OR semantics). The service layer backfills params.Tags
	// from the deprecated single-value params.Tag for back-compat.
	if len(params.Tags) > 0 {
		matchFilter["tags"] = bson.M{"$in": params.Tags}
	}
	if params.ComponentType != "" {
		matchFilter["component_type"] = params.ComponentType
	}
	if params.Status != "" {
		matchFilter["status"] = params.Status
	}

	// Aggregation pipeline to get latest version of each component
	pipeline := mongo.Pipeline{
		// Match initial filters
		{{Key: "$match", Value: matchFilter}},
		// Sort by id and version descending
		{{Key: "$sort", Value: bson.D{{Key: "id", Value: 1}, {Key: "version", Value: -1}}}},
		// Group by id, taking the first (latest version)
		{{Key: "$group", Value: bson.M{
			"_id":            "$id",
			"doc":            bson.M{"$first": "$$ROOT"},
			"latest_version": bson.M{"$first": "$version"},
		}}},
		// Replace root with the full document
		{{Key: "$replaceRoot", Value: bson.M{"newRoot": "$doc"}}},
		// Sort by updated time for display
		{{Key: "$sort", Value: bson.D{{Key: "updated", Value: -1}}}},
	}

	// Count total unique components (before pagination)
	countPipeline := append(pipeline, bson.D{{Key: "$count", Value: "total"}})
	countCursor, err := r.collection.Aggregate(ctx, countPipeline)
	if err != nil {
		return nil, 0, err
	}
	defer countCursor.Close(ctx)

	var countResult []bson.M
	if err := countCursor.All(ctx, &countResult); err != nil {
		return nil, 0, err
	}
	var total int64 = 0
	if len(countResult) > 0 {
		if t, ok := countResult[0]["total"].(int32); ok {
			total = int64(t)
		} else if t, ok := countResult[0]["total"].(int64); ok {
			total = t
		}
	}

	// Set pagination defaults
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

	// Add pagination to pipeline
	paginatedPipeline := append(pipeline,
		bson.D{{Key: "$skip", Value: skip}},
		bson.D{{Key: "$limit", Value: limit}},
	)

	cursor, err := r.collection.Aggregate(ctx, paginatedPipeline)
	if err != nil {
		return nil, 0, err
	}
	defer cursor.Close(ctx)

	var components []models.Component
	if err := cursor.All(ctx, &components); err != nil {
		return nil, 0, err
	}

	return components, total, nil
}

// FindAll is an alias for FindAllLatest for backward compatibility
func (r *ComponentRepository) FindAll(ctx context.Context, params models.ComponentQueryParams) ([]models.Component, int64, error) {
	return r.FindAllLatest(ctx, params)
}

// FindSummaries returns lightweight component summaries for the latest version of each component
func (r *ComponentRepository) FindSummaries(ctx context.Context, limit int64) ([]models.ComponentSummary, error) {
	if limit <= 0 {
		limit = 50
	}

	// Aggregation to get latest version of each component with projection
	pipeline := mongo.Pipeline{
		// Sort by id and version descending
		{{Key: "$sort", Value: bson.D{{Key: "id", Value: 1}, {Key: "version", Value: -1}}}},
		// Group by id, taking the first (latest version)
		{{Key: "$group", Value: bson.M{
			"_id": "$id",
			"doc": bson.M{"$first": "$$ROOT"},
		}}},
		// Replace root with the full document
		{{Key: "$replaceRoot", Value: bson.M{"newRoot": "$doc"}}},
		// Sort by updated time for display
		{{Key: "$sort", Value: bson.D{{Key: "updated", Value: -1}}}},
		// Limit results
		{{Key: "$limit", Value: limit}},
		// Project only needed fields
		{{Key: "$project", Value: bson.M{
			"id":            1,
			"version":       1,
			"status":        1,
			"name":          1,
			"description":   1,
			"chart_type":    1,
			"datasource_id": 1,
			"tags":          1,
		}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var summaries []models.ComponentSummary
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}

		summary := models.ComponentSummary{
			ID:           getString(doc, "id"),
			Version:      getInt(doc, "version"),
			Status:       getString(doc, "status"),
			Name:         getString(doc, "name"),
			Description:  getString(doc, "description"),
			ChartType:    getString(doc, "chart_type"),
			DatasourceID: getString(doc, "datasource_id"),
		}

		if tags, ok := doc["tags"].(bson.A); ok {
			for _, t := range tags {
				if s, ok := t.(string); ok {
					summary.Tags = append(summary.Tags, s)
				}
			}
		}

		summaries = append(summaries, summary)
	}

	return summaries, nil
}

// Update updates a specific version of a component
func (r *ComponentRepository) Update(ctx context.Context, id string, version int, component *models.Component) error {
	component.Updated = time.Now()
	_, err := r.collection.ReplaceOne(ctx, bson.M{"id": id, "version": version}, component)
	return err
}

// UpdateLatest updates the latest version of a component (for backward compatibility)
func (r *ComponentRepository) UpdateLatest(ctx context.Context, id string, component *models.Component) error {
	// Find the latest version first
	latest, err := r.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if latest == nil {
		return mongo.ErrNoDocuments
	}
	return r.Update(ctx, id, latest.Version, component)
}

// SetNamespaceForAllVersions stamps newNamespace onto every version row
// of a component id. Used when a component's namespace changes via the editor —
// all historical versions move with it so list/filter queries stay
// consistent regardless of which version they hit.
func (r *ComponentRepository) SetNamespaceForAllVersions(ctx context.Context, id, newNamespace string) error {
	_, err := r.collection.UpdateMany(
		ctx,
		bson.M{"id": id},
		bson.M{"$set": bson.M{"namespace": newNamespace}},
	)
	return err
}

// DeleteVersion removes a specific version of a component
func (r *ComponentRepository) DeleteVersion(ctx context.Context, id string, version int) error {
	_, err := r.collection.DeleteOne(ctx, bson.M{"id": id, "version": version})
	return err
}

// DeleteAllVersions removes all versions of a component
func (r *ComponentRepository) DeleteAllVersions(ctx context.Context, id string) error {
	_, err := r.collection.DeleteMany(ctx, bson.M{"id": id})
	return err
}

// Delete removes the latest version of a component (for backward compatibility)
// Returns error if trying to delete would leave orphaned references
func (r *ComponentRepository) Delete(ctx context.Context, id string) error {
	// Delete all versions of the component
	return r.DeleteAllVersions(ctx, id)
}

// GetVersionInfo returns version metadata for a component (for delete dialogs)
func (r *ComponentRepository) GetVersionInfo(ctx context.Context, id string) (*models.ComponentVersionInfo, error) {
	latest, err := r.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if latest == nil {
		return nil, nil
	}

	// Count total versions
	count, err := r.collection.CountDocuments(ctx, bson.M{"id": id})
	if err != nil {
		return nil, err
	}

	// Check if there's a draft
	draft, err := r.FindDraft(ctx, id)
	if err != nil {
		return nil, err
	}

	return &models.ComponentVersionInfo{
		ID:           latest.ID,
		Version:      latest.Version,
		Status:       latest.Status,
		VersionCount: int(count),
		HasDraft:     draft != nil,
	}, nil
}

// GetMaxVersion returns the highest version number for a component
func (r *ComponentRepository) GetMaxVersion(ctx context.Context, id string) (int, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "version", Value: -1}}).SetProjection(bson.M{"version": 1})
	var result bson.M
	err := r.collection.FindOne(ctx, bson.M{"id": id}, opts).Decode(&result)
	if err == mongo.ErrNoDocuments {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return getInt(result, "version"), nil
}

// Count returns total number of component documents (all versions)
func (r *ComponentRepository) Count(ctx context.Context) (int64, error) {
	return r.collection.CountDocuments(ctx, bson.M{})
}

// CountUnique returns number of unique components (by id)
func (r *ComponentRepository) CountUnique(ctx context.Context) (int64, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{"_id": "$id"}}},
		{{Key: "$count", Value: "total"}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return 0, err
	}
	defer cursor.Close(ctx)

	var result []bson.M
	if err := cursor.All(ctx, &result); err != nil {
		return 0, err
	}

	if len(result) == 0 {
		return 0, nil
	}

	if t, ok := result[0]["total"].(int32); ok {
		return int64(t), nil
	}
	return 0, nil
}

// FindByDatasourceID retrieves the latest version of all components using a specific data source
func (r *ComponentRepository) FindByDatasourceID(ctx context.Context, datasourceID string) ([]models.Component, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.M{"datasource_id": datasourceID}}},
		{{Key: "$sort", Value: bson.D{{Key: "id", Value: 1}, {Key: "version", Value: -1}}}},
		{{Key: "$group", Value: bson.M{
			"_id": "$id",
			"doc": bson.M{"$first": "$$ROOT"},
		}}},
		{{Key: "$replaceRoot", Value: bson.M{"newRoot": "$doc"}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var components []models.Component
	if err := cursor.All(ctx, &components); err != nil {
		return nil, err
	}
	return components, nil
}

// Helper to get string from bson.M
func getString(doc bson.M, key string) string {
	if v, ok := doc[key].(string); ok {
		return v
	}
	return ""
}

// Helper to get int from bson.M
func getInt(doc bson.M, key string) int {
	if v, ok := doc[key].(int32); ok {
		return int(v)
	}
	if v, ok := doc[key].(int64); ok {
		return int(v)
	}
	if v, ok := doc[key].(int); ok {
		return v
	}
	return 0
}
