// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/componenttemplates"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// ErrComponentInUse is returned by DeleteComponent when one or more
// dashboards still have a panel pointing at the component. The handler
// maps this to HTTP 409 Conflict and returns the offender list in the
// response body so the frontend can render a clear "cannot delete —
// referenced by ..." dialog.
var ErrComponentInUse = errors.New("component is in use")

// ComponentUsage describes the entities referencing a component. Empty
// slice means no dashboards reference it. The handler serializes this
// struct under "usage" in the 409 response.
type ComponentUsage struct {
	Dashboards []EntityRef `json:"dashboards"`
}

// ComponentService handles component business logic
type ComponentService struct {
	repo          *repository.ComponentRepository
	dashboardRepo *repository.DashboardRepository
}

// NewComponentService creates a new component service. The dashboard
// repo is used only for the delete-guard cross-collection lookup; it
// may be nil during early bootstrap (delete will then proceed without
// checking references). Production main.go always passes a live repo.
func NewComponentService(
	repo *repository.ComponentRepository,
	dashboardRepo *repository.DashboardRepository,
) *ComponentService {
	return &ComponentService{
		repo:          repo,
		dashboardRepo: dashboardRepo,
	}
}

// CreateComponent creates a new component with validation. Creates as version 1
// with status "final". Namespace defaults to "default" — clients should
// pass the user's active namespace.
func (s *ComponentService) CreateComponent(ctx context.Context, req *models.CreateComponentRequest) (*models.Component, error) {
	namespace := req.Namespace
	if namespace == "" {
		namespace = models.DefaultNamespace
	}

	// Check (namespace, name) uniqueness — same name allowed across namespaces.
	existing, err := s.repo.FindByName(ctx, namespace, req.Name)
	if err != nil {
		return nil, fmt.Errorf("error checking name uniqueness: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("component with name '%s' already exists in namespace '%s'", req.Name, namespace)
	}

	// Default title to name if not provided
	title := req.Title
	if title == "" {
		title = req.Name
	}

	// Default component type to "chart" if not specified
	componentType := req.ComponentType
	if componentType == "" {
		componentType = models.ComponentTypeChart
	}

	// Reject type-incomplete components at the source. Each sub-type needs
	// its discriminator; without it the component is a blank shell that
	// renders as nothing (this is how agents' mistaken "text_config on a
	// display component" headers slipped in — empty display_type, no
	// content). Validating here covers all three AI surfaces + the editor,
	// since they all funnel through this service method.
	switch componentType {
	case models.ComponentTypeDisplay:
		if req.DisplayConfig == nil || req.DisplayConfig.DisplayType == "" {
			return nil, fmt.Errorf("display component requires display_config.display_type (a blank display renders nothing). For a section header or text label, use a panel-level text_config on the dashboard instead of a component")
		}
	case models.ComponentTypeControl:
		if req.ControlConfig == nil || req.ControlConfig.ControlType == "" {
			return nil, fmt.Errorf("control component requires control_config.control_type")
		}
	case models.ComponentTypeChart:
		if req.ChartType == "" {
			return nil, fmt.Errorf("chart component requires chart_type (e.g. line, bar, gauge, dataview, banded_bar; or custom with use_custom_code)")
		}
	}

	// Auto-codegen for structured charts: when the caller asks for a
	// canonical chart_type with use_custom_code=false and didn't supply
	// component_code, emit the spec-driven one-liner so the component
	// renders identically to one built in the editor.
	//
	// Spec-driven charts carry NO render code in component_code — just
	// `<SpecDrivenChart specName="..." />`. The client draws them at
	// runtime from the saved data_mapping / options config via the chart
	// type's buildOption function, so the chart stays in sync with the
	// config and never hardcodes column names. This is the SAME string
	// the React editor emits on save, so charts created by the agents
	// (chat agent, component agent, MCP) match editor-built ones.
	//
	// (Pre-v0.24 this injected a legacy hardcoded-column ECharts template
	// here, which rendered "No data" for any schema whose columns weren't
	// the template's literals — the regression this replaces.)
	componentCode := req.ComponentCode
	if !req.UseCustomCode && componentType == models.ComponentTypeChart && componentCode == "" && registry.IsSpecDrivenChart(req.ChartType) {
		componentCode = componenttemplates.SpecDrivenOneLiner(req.ChartType)
	}

	component := &models.Component{
		Version:               1,
		Status:                models.ComponentStatusFinal,
		ComponentType:         componentType,
		Namespace:             namespace,
		Name:                  req.Name,
		Title:                 title,
		Description:           req.Description,
		ChartType:             req.ChartType,
		ConnectionID:          req.ConnectionID,
		QueryConfig:           req.QueryConfig,
		DataMapping:           req.DataMapping,
		ControlConfig:         req.ControlConfig,
		DisplayConfig:         req.DisplayConfig,
		ComponentCode:         componentCode,
		UseCustomCode:         req.UseCustomCode,
		UsesDashboardVariable: req.UsesDashboardVariable,
		Options:               req.Options,
		Tags:                  models.NormalizeTags(req.Tags),
	}

	if err := s.repo.Create(ctx, component); err != nil {
		return nil, fmt.Errorf("error creating component: %w", err)
	}

	return component, nil
}

// GetComponent retrieves the latest version of a component by ID
func (s *ComponentService) GetComponent(ctx context.Context, id string) (*models.Component, error) {
	component, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving component: %w", err)
	}
	if component == nil {
		return nil, fmt.Errorf("component not found")
	}
	return component, nil
}

// GetComponentVersion retrieves a specific version of a component
func (s *ComponentService) GetComponentVersion(ctx context.Context, id string, version int) (*models.Component, error) {
	component, err := s.repo.FindByIDAndVersion(ctx, id, version)
	if err != nil {
		return nil, fmt.Errorf("error retrieving component version: %w", err)
	}
	if component == nil {
		return nil, fmt.Errorf("component version not found")
	}
	return component, nil
}

// GetComponentDraft retrieves the draft version of a component (if exists)
func (s *ComponentService) GetComponentDraft(ctx context.Context, id string) (*models.Component, error) {
	component, err := s.repo.FindDraft(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving component draft: %w", err)
	}
	if component == nil {
		return nil, fmt.Errorf("no draft found for component")
	}
	return component, nil
}

// GetVersionInfo returns version metadata for delete dialogs
func (s *ComponentService) GetVersionInfo(ctx context.Context, id string) (*models.ComponentVersionInfo, error) {
	info, err := s.repo.GetVersionInfo(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving version info: %w", err)
	}
	if info == nil {
		return nil, fmt.Errorf("component not found")
	}
	return info, nil
}

// ListComponentVersions retrieves all versions of a component
func (s *ComponentService) ListComponentVersions(ctx context.Context, id string) ([]models.Component, error) {
	// First check if component exists
	latest, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error checking component: %w", err)
	}
	if latest == nil {
		return nil, fmt.Errorf("component not found")
	}

	// Get all versions - we need to add this method to repository
	// For now, we can use aggregation or iterate
	var versions []models.Component
	for v := 1; v <= latest.Version; v++ {
		component, err := s.repo.FindByIDAndVersion(ctx, id, v)
		if err != nil {
			return nil, fmt.Errorf("error retrieving version %d: %w", v, err)
		}
		if component != nil {
			versions = append(versions, *component)
		}
	}

	// Check for draft (version higher than latest final)
	draft, _ := s.repo.FindDraft(ctx, id)
	if draft != nil {
		versions = append(versions, *draft)
	}

	return versions, nil
}

// ListComponents retrieves latest version of each component with pagination and filtering
func (s *ComponentService) ListComponents(ctx context.Context, params models.ComponentQueryParams) (*models.ComponentListResponse, error) {
	if params.Page < 1 {
		params.Page = 1
	}
	// Single page-size authority: 0 → all (capped), >cap → cap, <0 → default.
	params.PageSize, _ = models.ClampPageSize(params.PageSize, 20)

	// Back-compat: backfill the deprecated single-value Tag param into Tags
	// so the repository only deals with the slice form.
	if len(params.Tags) == 0 && params.Tag != "" {
		params.Tags = []string{params.Tag}
	}
	// Normalize filter tags to match how they're stored.
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}

	components, total, err := s.repo.FindAllLatest(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("error listing components: %w", err)
	}

	return &models.ComponentListResponse{
		Components: components,
		Total:      total,
		Page:       params.Page,
		PageSize:   params.PageSize,
		HasMore:    models.ComputeHasMore(params.Page, params.PageSize, len(components), total),
	}, nil
}

// ListComponentsWithUsage is ListComponents plus the denormalized
// dashboard-usage join (#21, ?include_usage=true): each row carries the
// dashboards that reference it + the count, computed server-side for the
// current page only.
func (s *ComponentService) ListComponentsWithUsage(ctx context.Context, params models.ComponentQueryParams) (*models.ComponentUsageListResponse, error) {
	if params.Page < 1 {
		params.Page = 1
	}
	params.PageSize, _ = models.ClampPageSize(params.PageSize, 20)

	if len(params.Tags) == 0 && params.Tag != "" {
		params.Tags = []string{params.Tag}
	}
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}

	rows, total, err := s.repo.FindAllLatestWithUsage(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("error listing components with usage: %w", err)
	}

	return &models.ComponentUsageListResponse{
		Components: rows,
		Total:      total,
		Page:       params.Page,
		PageSize:   params.PageSize,
		HasMore:    models.ComputeHasMore(params.Page, params.PageSize, len(rows), total),
	}, nil
}

// GetComponentSummaries returns lightweight component summaries for card display
func (s *ComponentService) GetComponentSummaries(ctx context.Context, limit int64) ([]models.ComponentSummary, error) {
	return s.repo.FindSummaries(ctx, limit)
}

// UpdateComponent updates the latest version of a component in-place.
// Used for manual edits (non-AI).
func (s *ComponentService) UpdateComponent(ctx context.Context, id string, req *models.UpdateComponentRequest) (*models.Component, error) {
	// Get existing component (latest version)
	component, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving component: %w", err)
	}
	if component == nil {
		return nil, fmt.Errorf("component not found")
	}

	// Resolve post-update (namespace, name) and check uniqueness if either
	// changed. Both can change in the same request. Capture the original
	// namespace before mutating so we can detect a real move below.
	originalNamespace := component.Namespace
	newNamespace := component.Namespace
	if req.Namespace != nil && *req.Namespace != "" {
		newNamespace = *req.Namespace
	}
	newName := component.Name
	if req.Name != nil {
		newName = *req.Name
	}
	if newNamespace != component.Namespace || newName != component.Name {
		existing, err := s.repo.FindByName(ctx, newNamespace, newName)
		if err != nil {
			return nil, fmt.Errorf("error checking name uniqueness: %w", err)
		}
		if existing != nil && existing.ID != component.ID {
			return nil, fmt.Errorf("component with name '%s' already exists in namespace '%s'", newName, newNamespace)
		}
		component.Namespace = newNamespace
		component.Name = newName
	}

	// Update fields if provided
	if req.ComponentType != nil {
		component.ComponentType = *req.ComponentType
	}
	if req.Title != nil {
		component.Title = *req.Title
	}
	if req.Description != nil {
		component.Description = *req.Description
	}
	if req.ChartType != nil {
		component.ChartType = *req.ChartType
	}
	if req.ConnectionID != nil {
		component.ConnectionID = *req.ConnectionID
	}
	if req.QueryConfig != nil {
		component.QueryConfig = req.QueryConfig
	}
	if req.DataMapping != nil {
		component.DataMapping = req.DataMapping
	}
	if req.ControlConfig != nil {
		component.ControlConfig = req.ControlConfig
	}
	if req.DisplayConfig != nil {
		component.DisplayConfig = req.DisplayConfig
	}
	if req.ComponentCode != nil {
		component.ComponentCode = *req.ComponentCode
	}
	if req.UseCustomCode != nil {
		component.UseCustomCode = *req.UseCustomCode
	}
	if req.UsesDashboardVariable != nil {
		component.UsesDashboardVariable = *req.UsesDashboardVariable
	}
	if req.Options != nil {
		component.Options = *req.Options
	}
	if req.Tags != nil {
		component.Tags = models.NormalizeTags(*req.Tags)
	}

	// Keep the spec-driven one-liner in sync with chart_type. The stored
	// code pins specName (e.g. <SpecDrivenChart specName="line" />), so a
	// chart_type change must rewrite it or the chart renders as the old
	// type. A spec-driven (non-custom) chart must ALWAYS carry this stub —
	// an empty component_code is un-renderable (blank panel + the editor
	// treats the panel as empty). So regenerate when the component is a
	// spec-driven chart not in custom-code mode AND either the caller
	// didn't send its own code OR the resulting code is empty. The empty
	// case matters: clearing custom code via component_code:"" (e.g. when
	// converting a custom chart back to a native type) used to leave the
	// stub blank because the request value was non-nil. Backfilling here
	// makes "spec-driven chart with empty code" an impossible end state.
	// A non-empty explicit component_code (a real custom edit) is left
	// untouched.
	if component.ComponentType == models.ComponentTypeChart &&
		!component.UseCustomCode &&
		registry.IsSpecDrivenChart(component.ChartType) &&
		(req.ComponentCode == nil || component.ComponentCode == "") {
		component.ComponentCode = componenttemplates.SpecDrivenOneLiner(component.ChartType)
	}

	// Update in place (same version)
	if err := s.repo.Update(ctx, id, component.Version, component); err != nil {
		return nil, fmt.Errorf("error updating component: %w", err)
	}

	// If namespace actually changed, stamp the new value onto every other
	// version row of this component so list/filter queries are consistent
	// regardless of which version row they hit.
	if component.Namespace != originalNamespace {
		if err := s.repo.SetNamespaceForAllVersions(ctx, id, component.Namespace); err != nil {
			return nil, fmt.Errorf("error syncing namespace across component versions: %w", err)
		}
	}

	return component, nil
}

// DeleteComponent deletes all versions of a component by ID, blocking
// the delete if any dashboard panels still reference it. Callers should
// detect ErrComponentInUse via errors.Is and use the returned
// ComponentUsage to render a useful error message.
func (s *ComponentService) DeleteComponent(ctx context.Context, id string) (*ComponentUsage, error) {
	// Check if component exists
	component, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving component: %w", err)
	}
	if component == nil {
		return nil, fmt.Errorf("component not found")
	}

	usage, err := s.componentUsage(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error checking component usage: %w", err)
	}
	if usage != nil && len(usage.Dashboards) > 0 {
		return usage, ErrComponentInUse
	}

	if err := s.repo.DeleteAllVersions(ctx, id); err != nil {
		return nil, fmt.Errorf("error deleting component: %w", err)
	}

	return nil, nil
}

// componentUsage returns a non-nil *ComponentUsage describing every
// dashboard whose panels reference the given component. If the
// dashboard repo is unavailable (nil), reports an empty list rather
// than failing.
func (s *ComponentService) componentUsage(ctx context.Context, id string) (*ComponentUsage, error) {
	usage := &ComponentUsage{}
	if s.dashboardRepo == nil {
		return usage, nil
	}
	dashes, err := s.dashboardRepo.FindByComponentID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("listing dashboards: %w", err)
	}
	for _, d := range dashes {
		usage.Dashboards = append(usage.Dashboards, EntityRef{ID: d.ID, Name: d.Name})
	}
	return usage, nil
}

// DeleteComponentVersion deletes a specific version of a component
func (s *ComponentService) DeleteComponentVersion(ctx context.Context, id string, version int) error {
	// Check if version exists
	component, err := s.repo.FindByIDAndVersion(ctx, id, version)
	if err != nil {
		return fmt.Errorf("error retrieving component version: %w", err)
	}
	if component == nil {
		return fmt.Errorf("component version not found")
	}

	if err := s.repo.DeleteVersion(ctx, id, version); err != nil {
		return fmt.Errorf("error deleting component version: %w", err)
	}

	return nil
}

// DeleteComponentDraft deletes only the draft version of a component
func (s *ComponentService) DeleteComponentDraft(ctx context.Context, id string) error {
	// Check if draft exists
	draft, err := s.repo.FindDraft(ctx, id)
	if err != nil {
		return fmt.Errorf("error retrieving draft: %w", err)
	}
	if draft == nil {
		return fmt.Errorf("no draft found for component")
	}

	if err := s.repo.DeleteVersion(ctx, id, draft.Version); err != nil {
		return fmt.Errorf("error deleting draft: %w", err)
	}

	return nil
}

// GetComponentsByConnection retrieves latest version of all components using a specific connection
func (s *ComponentService) GetComponentsByConnection(ctx context.Context, connectionID string) ([]models.Component, error) {
	return s.repo.FindByConnectionID(ctx, connectionID)
}
