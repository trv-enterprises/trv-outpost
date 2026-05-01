// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"context"
	"net/http"
	"sort"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
)

// TagHandler exposes a merged view of tags across connections, components
// (charts), and dashboards.
type TagHandler struct {
	db *mongo.Database
}

// NewTagHandler creates a new TagHandler bound to the given database.
func NewTagHandler(db *mongo.Database) *TagHandler {
	return &TagHandler{db: db}
}

// ListTags handles GET /api/tags and returns all unique tags across the
// three tagged entity collections with per-type usage counts.
//
// @Summary List all tags with usage counts
// @Description Returns a merged list of tags across connections, components, and dashboards with per-entity-type counts
// @Tags tags
// @Produce json
// @Success 200 {object} models.TagListResponse
// @Router /tags [get]
func (h *TagHandler) ListTags(c *gin.Context) {
	ctx := c.Request.Context()
	merged := make(map[string]*models.TagUsage)

	// Connections: simple $unwind + $group.
	if err := h.aggregateTags(ctx, "connections", nil, merged, func(t *models.TagUsage, n int) {
		t.Connections += n
		t.Count += n
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Dashboards: simple $unwind + $group.
	if err := h.aggregateTags(ctx, "dashboards", nil, merged, func(t *models.TagUsage, n int) {
		t.Dashboards += n
		t.Count += n
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Components: mirror the FindAllLatest pattern so each logical component
	// is counted once, not once per version. Group by `id`, take first tags
	// (any version has the same id's current tags for the latest version).
	componentsPre := bson.A{
		bson.D{{Key: "$sort", Value: bson.D{{Key: "id", Value: 1}, {Key: "version", Value: -1}}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$id"},
			{Key: "tags", Value: bson.D{{Key: "$first", Value: "$tags"}}},
		}}},
	}
	if err := h.aggregateTags(ctx, "components", componentsPre, merged, func(t *models.TagUsage, n int) {
		t.Components += n
		t.Count += n
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Sort alphabetically.
	result := make([]models.TagUsage, 0, len(merged))
	for _, t := range merged {
		result = append(result, *t)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })

	c.JSON(http.StatusOK, models.TagListResponse{Tags: result})
}

// aggregateTags runs an $unwind + $group aggregation on a collection's
// `tags` field, merging the counts into the shared map via updateFn. If
// prePipeline is non-nil, it runs before the tag unwind (used by charts to
// deduplicate versions).
func (h *TagHandler) aggregateTags(
	ctx context.Context,
	collectionName string,
	prePipeline bson.A,
	merged map[string]*models.TagUsage,
	updateFn func(*models.TagUsage, int),
) error {
	pipeline := bson.A{}
	if len(prePipeline) > 0 {
		pipeline = append(pipeline, prePipeline...)
	}
	pipeline = append(pipeline,
		bson.D{{Key: "$unwind", Value: "$tags"}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$tags"},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
	)

	cursor, err := h.db.Collection(collectionName).Aggregate(ctx, pipeline)
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)

	for cursor.Next(ctx) {
		var row struct {
			ID    string `bson:"_id"`
			Count int    `bson:"count"`
		}
		if err := cursor.Decode(&row); err != nil {
			return err
		}
		if row.ID == "" {
			continue
		}
		t, ok := merged[row.ID]
		if !ok {
			t = &models.TagUsage{Name: row.ID}
			merged[row.ID] = t
		}
		updateFn(t, row.Count)
	}
	return cursor.Err()
}
