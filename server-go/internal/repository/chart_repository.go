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

// ChartRepository handles chart database operations
// Charts use composite key (id, version) for versioning support
type ChartRepository struct {
	collection *mongo.Collection
}

// NewChartRepository creates a new chart repository
func NewChartRepository(db *mongo.Database) *ChartRepository {
	return &ChartRepository{
		collection: db.Collection("charts"),
	}
}

// CreateIndexes creates necessary indexes for the charts collection
func (r *ChartRepository) CreateIndexes(ctx context.Context) error {
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
		// Find drafts for a chart
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
		// Namespace-scoped list queries. No unique constraint — chart name
		// uniqueness across (namespace, name) is enforced in the service
		// layer, since the versioning scheme means multiple rows share a
		// (namespace, name) for the same logical chart.
		{Keys: bson.D{{Key: "namespace", Value: 1}, {Key: "updated", Value: -1}}},
		{Keys: bson.D{{Key: "namespace", Value: 1}, {Key: "name", Value: 1}}},
		// Covers "charts using connection X" queries with recency sort.
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

// Create inserts a new chart version
func (r *ChartRepository) Create(ctx context.Context, chart *models.Chart) error {
	if chart.ID == "" {
		chart.ID = uuid.New().String()
	}
	if chart.Version == 0 {
		chart.Version = 1
	}
	if chart.Status == "" {
		chart.Status = models.ChartStatusFinal
	}
	now := time.Now()
	chart.Created = now
	chart.Updated = now

	_, err := r.collection.InsertOne(ctx, chart)
	return err
}

// CreateVersion inserts a new version of an existing chart
func (r *ChartRepository) CreateVersion(ctx context.Context, chart *models.Chart) error {
	now := time.Now()
	chart.Created = now
	chart.Updated = now

	_, err := r.collection.InsertOne(ctx, chart)
	return err
}

// FindByID retrieves the latest version of a chart by ID
func (r *ChartRepository) FindByID(ctx context.Context, id string) (*models.Chart, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "version", Value: -1}})
	var chart models.Chart
	err := r.collection.FindOne(ctx, bson.M{"id": id}, opts).Decode(&chart)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &chart, nil
}

// FindByIDAndVersion retrieves a specific version of a chart
func (r *ChartRepository) FindByIDAndVersion(ctx context.Context, id string, version int) (*models.Chart, error) {
	var chart models.Chart
	err := r.collection.FindOne(ctx, bson.M{"id": id, "version": version}).Decode(&chart)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &chart, nil
}

// FindLatestFinal retrieves the latest final (non-draft) version of a chart
func (r *ChartRepository) FindLatestFinal(ctx context.Context, id string) (*models.Chart, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "version", Value: -1}})
	filter := bson.M{"id": id, "status": models.ChartStatusFinal}
	var chart models.Chart
	err := r.collection.FindOne(ctx, filter, opts).Decode(&chart)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &chart, nil
}

// FindDraft retrieves the draft version of a chart (if exists)
func (r *ChartRepository) FindDraft(ctx context.Context, id string) (*models.Chart, error) {
	var chart models.Chart
	err := r.collection.FindOne(ctx, bson.M{"id": id, "status": models.ChartStatusDraft}).Decode(&chart)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &chart, nil
}

// FindByName retrieves the latest version of a chart by (namespace, name).
// Returns (nil, nil) when no chart matches.
func (r *ChartRepository) FindByName(ctx context.Context, namespace, name string) (*models.Chart, error) {
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

	var charts []models.Chart
	if err := cursor.All(ctx, &charts); err != nil {
		return nil, err
	}

	if len(charts) == 0 {
		return nil, nil
	}
	return &charts[0], nil
}

// CountByNamespace returns the number of charts (counting unique chart
// IDs, not versions) in a namespace. Implements service.NamespaceCounter.
func (r *ChartRepository) CountByNamespace(ctx context.Context, namespace string) (int64, error) {
	// Distinct chart ids in this namespace — versioning means a single
	// logical chart has many rows, but the user-visible count is the id
	// count.
	ids, err := r.collection.Distinct(ctx, "id", bson.M{"namespace": namespace})
	if err != nil {
		return 0, err
	}
	return int64(len(ids)), nil
}

// RenameNamespace updates every chart row currently in oldName to
// newName. All versions of every chart in the namespace are touched.
// Implements service.NamespaceRenamer.
func (r *ChartRepository) RenameNamespace(ctx context.Context, oldName, newName string) (int64, error) {
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

// FindAllLatest retrieves the latest version of each chart with pagination
func (r *ChartRepository) FindAllLatest(ctx context.Context, params models.ChartQueryParams) ([]models.Chart, int64, error) {
	// Build match filter
	matchFilter := bson.M{}
	if params.Namespace != "" {
		matchFilter["namespace"] = params.Namespace
	}
	if params.Name != "" {
		// $regex does NOT respect collection collation (MongoDB limitation),
		// so we must explicitly request case-insensitive matching.
		matchFilter["name"] = bson.M{"$regex": params.Name, "$options": "i"}
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

	// Aggregation pipeline to get latest version of each chart
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

	// Count total unique charts (before pagination)
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

	var charts []models.Chart
	if err := cursor.All(ctx, &charts); err != nil {
		return nil, 0, err
	}

	return charts, total, nil
}

// FindAll is an alias for FindAllLatest for backward compatibility
func (r *ChartRepository) FindAll(ctx context.Context, params models.ChartQueryParams) ([]models.Chart, int64, error) {
	return r.FindAllLatest(ctx, params)
}

// FindSummaries returns lightweight chart summaries for the latest version of each chart
func (r *ChartRepository) FindSummaries(ctx context.Context, limit int64) ([]models.ChartSummary, error) {
	if limit <= 0 {
		limit = 50
	}

	// Aggregation to get latest version of each chart with projection
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

	var summaries []models.ChartSummary
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}

		summary := models.ChartSummary{
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

// Update updates a specific version of a chart
func (r *ChartRepository) Update(ctx context.Context, id string, version int, chart *models.Chart) error {
	chart.Updated = time.Now()
	_, err := r.collection.ReplaceOne(ctx, bson.M{"id": id, "version": version}, chart)
	return err
}

// UpdateLatest updates the latest version of a chart (for backward compatibility)
func (r *ChartRepository) UpdateLatest(ctx context.Context, id string, chart *models.Chart) error {
	// Find the latest version first
	latest, err := r.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if latest == nil {
		return mongo.ErrNoDocuments
	}
	return r.Update(ctx, id, latest.Version, chart)
}

// SetNamespaceForAllVersions stamps newNamespace onto every version row
// of a chart id. Used when a chart's namespace changes via the editor —
// all historical versions move with it so list/filter queries stay
// consistent regardless of which version they hit.
func (r *ChartRepository) SetNamespaceForAllVersions(ctx context.Context, id, newNamespace string) error {
	_, err := r.collection.UpdateMany(
		ctx,
		bson.M{"id": id},
		bson.M{"$set": bson.M{"namespace": newNamespace}},
	)
	return err
}

// DeleteVersion removes a specific version of a chart
func (r *ChartRepository) DeleteVersion(ctx context.Context, id string, version int) error {
	_, err := r.collection.DeleteOne(ctx, bson.M{"id": id, "version": version})
	return err
}

// DeleteAllVersions removes all versions of a chart
func (r *ChartRepository) DeleteAllVersions(ctx context.Context, id string) error {
	_, err := r.collection.DeleteMany(ctx, bson.M{"id": id})
	return err
}

// Delete removes the latest version of a chart (for backward compatibility)
// Returns error if trying to delete would leave orphaned references
func (r *ChartRepository) Delete(ctx context.Context, id string) error {
	// Delete all versions of the chart
	return r.DeleteAllVersions(ctx, id)
}

// GetVersionInfo returns version metadata for a chart (for delete dialogs)
func (r *ChartRepository) GetVersionInfo(ctx context.Context, id string) (*models.ChartVersionInfo, error) {
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

	return &models.ChartVersionInfo{
		ID:           latest.ID,
		Version:      latest.Version,
		Status:       latest.Status,
		VersionCount: int(count),
		HasDraft:     draft != nil,
	}, nil
}

// GetMaxVersion returns the highest version number for a chart
func (r *ChartRepository) GetMaxVersion(ctx context.Context, id string) (int, error) {
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

// Count returns total number of chart documents (all versions)
func (r *ChartRepository) Count(ctx context.Context) (int64, error) {
	return r.collection.CountDocuments(ctx, bson.M{})
}

// CountUnique returns number of unique charts (by id)
func (r *ChartRepository) CountUnique(ctx context.Context) (int64, error) {
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

// FindByDatasourceID retrieves the latest version of all charts using a specific data source
func (r *ChartRepository) FindByDatasourceID(ctx context.Context, datasourceID string) ([]models.Chart, error) {
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

	var charts []models.Chart
	if err := cursor.All(ctx, &charts); err != nil {
		return nil, err
	}
	return charts, nil
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
