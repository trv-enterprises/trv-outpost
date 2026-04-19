// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
	"go.mongodb.org/mongo-driver/mongo"
)

// DashboardService handles business logic for dashboards.
//
// Carries refs to the chart and datasource repos as well so the
// export/import flows can walk the dashboard → component → connection
// dependency graph without crossing service boundaries (which would
// either circular-import or duplicate the graph traversal in two
// services). Both extra repos are optional and will only be exercised
// by the export/import endpoints.
type DashboardService struct {
	repo            *repository.DashboardRepository
	db              *mongo.Database
	chartRepo       *repository.ChartRepository
	datasourceRepo  *repository.DatasourceRepository
}

// NewDashboardService creates a new dashboard service. Pass nil for
// chartRepo/datasourceRepo if export/import isn't needed (legacy
// callers); production main.go always passes the live repos.
func NewDashboardService(repo *repository.DashboardRepository, db *mongo.Database, chartRepo *repository.ChartRepository, datasourceRepo *repository.DatasourceRepository) *DashboardService {
	return &DashboardService{
		repo:           repo,
		db:             db,
		chartRepo:      chartRepo,
		datasourceRepo: datasourceRepo,
	}
}

// CreateDashboard creates a new dashboard. Namespace defaults to
// "default" when the request omits it.
func (s *DashboardService) CreateDashboard(ctx context.Context, req *models.CreateDashboardRequest) (*models.Dashboard, error) {
	if req.Namespace == "" {
		req.Namespace = models.DefaultNamespace
	}

	// Uniqueness is (namespace, name) — same name allowed across namespaces.
	existing, err := s.repo.FindByName(ctx, req.Namespace, req.Name)
	if err != nil {
		return nil, fmt.Errorf("error checking for existing dashboard: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("dashboard with name '%s' already exists in namespace '%s'", req.Name, req.Namespace)
	}

	// Normalize tags before persistence.
	req.Tags = models.NormalizeTags(req.Tags)

	dashboard, err := s.repo.Create(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("failed to create dashboard: %w", err)
	}

	return dashboard, nil
}

// GetDashboard retrieves a dashboard by ID
func (s *DashboardService) GetDashboard(ctx context.Context, id string) (*models.Dashboard, error) {
	dashboard, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get dashboard: %w", err)
	}
	if dashboard == nil {
		return nil, fmt.Errorf("dashboard not found")
	}
	return dashboard, nil
}

// ListDashboards retrieves dashboards with filtering and pagination
func (s *DashboardService) ListDashboards(ctx context.Context, params models.DashboardQueryParams) (*models.DashboardListResponse, error) {
	// Normalize filter tags to match how they're stored.
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}
	dashboards, total, err := s.repo.List(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("failed to list dashboards: %w", err)
	}

	// Default page values
	page := params.Page
	if page < 1 {
		page = 1
	}
	pageSize := params.PageSize
	if pageSize < 1 {
		pageSize = 20
	}

	return &models.DashboardListResponse{
		Dashboards: dashboards,
		Total:      total,
		Page:       page,
		PageSize:   pageSize,
	}, nil
}

// ListDashboardsWithDatasources retrieves dashboard summaries with data source names
func (s *DashboardService) ListDashboardsWithDatasources(ctx context.Context, params models.DashboardQueryParams) (*models.DashboardSummaryListResponse, error) {
	// Normalize filter tags to match how they're stored.
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}
	summaries, total, err := s.repo.ListWithDatasources(ctx, params, s.db)
	if err != nil {
		return nil, fmt.Errorf("failed to list dashboards with datasources: %w", err)
	}

	// Default page values
	page := params.Page
	if page < 1 {
		page = 1
	}
	pageSize := params.PageSize
	if pageSize < 1 {
		pageSize = 20
	}

	return &models.DashboardSummaryListResponse{
		Dashboards: summaries,
		Total:      total,
		Page:       page,
		PageSize:   pageSize,
	}, nil
}

// UpdateDashboard updates a dashboard
func (s *DashboardService) UpdateDashboard(ctx context.Context, id string, req *models.UpdateDashboardRequest) (*models.Dashboard, error) {
	// Check if dashboard exists
	existing, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error finding dashboard: %w", err)
	}
	if existing == nil {
		return nil, fmt.Errorf("dashboard not found")
	}

	// Resolve post-update (namespace, name) and check uniqueness if either
	// changed. Both can move in the same request.
	newNamespace := existing.Namespace
	if req.Namespace != nil && *req.Namespace != "" {
		newNamespace = *req.Namespace
	}
	newName := existing.Name
	if req.Name != nil {
		newName = *req.Name
	}
	if newNamespace != existing.Namespace || newName != existing.Name {
		duplicate, err := s.repo.FindByName(ctx, newNamespace, newName)
		if err != nil {
			return nil, fmt.Errorf("error checking for duplicate name: %w", err)
		}
		if duplicate != nil && duplicate.ID != existing.ID {
			return nil, fmt.Errorf("dashboard with name '%s' already exists in namespace '%s'", newName, newNamespace)
		}
	}

	// Normalize tags if provided.
	if req.Tags != nil {
		normalized := models.NormalizeTags(*req.Tags)
		req.Tags = &normalized
	}

	dashboard, err := s.repo.Update(ctx, id, req)
	if err != nil {
		return nil, fmt.Errorf("failed to update dashboard: %w", err)
	}

	return dashboard, nil
}

// DeleteDashboard deletes a dashboard
func (s *DashboardService) DeleteDashboard(ctx context.Context, id string) error {
	// Check if dashboard exists
	existing, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return fmt.Errorf("error finding dashboard: %w", err)
	}
	if existing == nil {
		return fmt.Errorf("dashboard not found")
	}

	err = s.repo.Delete(ctx, id)
	if err != nil {
		return fmt.Errorf("failed to delete dashboard: %w", err)
	}

	return nil
}
