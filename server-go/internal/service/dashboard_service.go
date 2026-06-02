// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"fmt"
	"strings"

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
	repo           *repository.DashboardRepository
	db             *mongo.Database
	chartRepo      *repository.ComponentRepository
	connectionRepo *repository.ConnectionRepository
	// scaleLookup resolves a layout-dimension's default scale % by name,
	// used to SEED a new dashboard's scale_percent when the request
	// doesn't set one. Optional (nil → no seeding); wired from
	// ConfigService via SetScaleLookup to avoid a hard dependency / cycle.
	scaleLookup func(ctx context.Context, dimensionName string) int

	// connByTags + schemaOf are injected from ConnectionService (which owns
	// the adapters) via SetVariableHelpers, mirroring scaleLookup — keeps the
	// dashboard→connection dependency a closure, not a hard import cycle.
	// Used only by GetVariableCandidates; nil when not wired.
	connByTags func(ctx context.Context, namespace string, tags []string) ([]*models.Connection, error)
	connByID   func(ctx context.Context, connectionID string) (*models.Connection, error)
	schemaOf   func(ctx context.Context, connectionID string) (*models.SchemaResponse, error)
}

// SetVariableHelpers wires the connection-discovery + schema closures used by
// GetVariableCandidates. Called once at startup after ConnectionService exists.
func (s *DashboardService) SetVariableHelpers(
	connByTags func(ctx context.Context, namespace string, tags []string) ([]*models.Connection, error),
	connByID func(ctx context.Context, connectionID string) (*models.Connection, error),
	schemaOf func(ctx context.Context, connectionID string) (*models.SchemaResponse, error),
) {
	s.connByTags = connByTags
	s.connByID = connByID
	s.schemaOf = schemaOf
}

// SetScaleLookup wires the per-dimension default-scale resolver. Called
// once at startup after both services exist.
func (s *DashboardService) SetScaleLookup(fn func(ctx context.Context, dimensionName string) int) {
	s.scaleLookup = fn
}

// NewDashboardService creates a new dashboard service. Pass nil for
// chartRepo/connectionRepo if export/import isn't needed (legacy
// callers); production main.go always passes the live repos.
func NewDashboardService(repo *repository.DashboardRepository, db *mongo.Database, chartRepo *repository.ComponentRepository, connectionRepo *repository.ConnectionRepository) *DashboardService {
	return &DashboardService{
		repo:           repo,
		db:             db,
		chartRepo:      chartRepo,
		connectionRepo: connectionRepo,
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

	// Seed scale_percent from the chosen dimension's default scale when
	// the caller didn't set one (designer/AI override wins). Seeded once
	// at create; the dashboard then owns its value independent of later
	// changes to the dimension's default.
	if s.scaleLookup != nil && req.Settings.ScalePercent == 0 && req.Settings.LayoutDimension != "" {
		if def := s.scaleLookup(ctx, req.Settings.LayoutDimension); def > 0 {
			req.Settings.ScalePercent = def
		}
	}

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
	summaries, total, err := s.repo.ListWithConnections(ctx, params, s.db)
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

// GetVariableCandidates returns the selectable connections for a dashboard's
// connection_swap variable. Candidates are connections in the dashboard's
// namespace matching the variable's discovery tags; each is annotated as
// schema-compatible (or not) with the dashboard's reference connection per the
// variable's SchemaStrict mode. The reference connection (the one most panels
// currently point at) is always included and trivially compatible.
//
// SchemaStrict modes:
//   - "type_only" (default): compatible if the candidate's effective type_id
//     matches the reference. Cheap; correct for the common "one ts-store per
//     site" shape. No per-candidate schema fetch.
//   - "superset": candidate must contain every (table, column) the reference
//     has (case-insensitive, name-only). Extra columns are fine.
//   - "exact": candidate's table+column name set must equal the reference's.
//
// An idle store may report an empty schema; rather than hard-excluding it we
// mark it compatible=false with a clear reason so the designer/viewer can see
// why, instead of silently dropping a valid site.
func (s *DashboardService) GetVariableCandidates(ctx context.Context, dashboardID, variableName string) (*models.VariableCandidatesResponse, error) {
	if s.connByTags == nil {
		return nil, fmt.Errorf("variable candidates not available: connection helpers not wired")
	}

	dashboard, err := s.repo.FindByID(ctx, dashboardID)
	if err != nil {
		return nil, fmt.Errorf("error retrieving dashboard: %w", err)
	}
	if dashboard == nil {
		return nil, fmt.Errorf("dashboard not found")
	}

	// Find the named connection_swap variable.
	var variable *models.DashboardVariable
	for i := range dashboard.Settings.Variables {
		if dashboard.Settings.Variables[i].Name == variableName {
			variable = &dashboard.Settings.Variables[i]
			break
		}
	}
	if variable == nil {
		return nil, fmt.Errorf("variable '%s' not found on dashboard", variableName)
	}
	if variable.Mode != "connection_swap" || variable.ConnectionSwap == nil {
		return nil, fmt.Errorf("variable '%s' is not a connection_swap variable", variableName)
	}

	cfg := variable.ConnectionSwap
	strict := cfg.SchemaStrict
	if strict == "" {
		strict = "type_only"
	}

	// Discover candidates by tag. SameNamespace (default false) restricts to
	// the dashboard's namespace; otherwise discovery is cross-namespace (empty
	// namespace = no namespace filter in the repo).
	discoverNS := ""
	if cfg.SameNamespace {
		discoverNS = dashboard.Namespace
	}
	candidates, err := s.connByTags(ctx, discoverNS, cfg.Tags)
	if err != nil {
		return nil, fmt.Errorf("error discovering connections: %w", err)
	}

	// AND semantics: the underlying repo matches tags with OR ($in), but a
	// variable's tags are a conjunction — a candidate must carry ALL of them
	// (e.g. both "system-stats" AND "ts-store"). Filter the OR results down to
	// connections whose tag set is a superset of the (normalized) required set.
	required := models.NormalizeTags(cfg.Tags)
	if len(required) > 0 {
		filtered := candidates[:0]
		for _, c := range candidates {
			have := make(map[string]struct{}, len(c.Tags))
			for _, t := range models.NormalizeTags(c.Tags) {
				have[t] = struct{}{}
			}
			all := true
			for _, want := range required {
				if _, ok := have[want]; !ok {
					all = false
					break
				}
			}
			if all {
				filtered = append(filtered, c)
			}
		}
		candidates = filtered
	}

	// Resolve the reference connection (the one most panels currently point at).
	refID := s.referenceConnectionID(ctx, dashboard)
	var refConn *models.Connection
	for _, c := range candidates {
		if c.ID == refID {
			refConn = c
			break
		}
	}

	// Always include the reference connection as a selectable option, even when
	// it doesn't match the discovery tags/namespace — it's the source the panels
	// already use, so the viewer must be able to pick it. Fetch + prepend it when
	// it wasn't discovered.
	if refID != "" && refConn == nil && s.connByID != nil {
		if rc, rerr := s.connByID(ctx, refID); rerr == nil && rc != nil {
			refConn = rc
			candidates = append([]*models.Connection{rc}, candidates...)
		}
	}

	// Reference column set is only needed for superset/exact.
	var refColumns map[string]struct{}
	if (strict == "superset" || strict == "exact") && refID != "" && s.schemaOf != nil {
		refColumns = s.columnSet(ctx, refID)
	}

	resp := &models.VariableCandidatesResponse{Variable: variableName}
	for _, c := range candidates {
		cand := models.VariableCandidate{
			ID:        c.ID,
			Name:      c.Name,
			Namespace: c.Namespace,
			TypeID:    c.GetEffectiveTypeID(),
			Reference: c.ID == refID,
		}

		switch {
		case c.ID == refID:
			cand.Compatible = true // reference is trivially compatible
		case strict == "type_only":
			if refConn != nil && c.GetEffectiveTypeID() != refConn.GetEffectiveTypeID() {
				cand.Compatible = false
				cand.Reason = fmt.Sprintf("type %s does not match reference type %s", c.GetEffectiveTypeID(), refConn.GetEffectiveTypeID())
			} else {
				cand.Compatible = true
			}
		case strict == "superset" || strict == "exact":
			cand.Compatible, cand.Reason = s.schemaCompatible(ctx, c.ID, refColumns, strict)
		default:
			cand.Compatible = true
		}

		resp.Candidates = append(resp.Candidates, cand)
	}

	return resp, nil
}

// referenceConnectionID returns the connection_id that the most panels'
// components currently use, falling back to the first panel's component
// connection. Empty when nothing resolvable.
func (s *DashboardService) referenceConnectionID(ctx context.Context, dashboard *models.Dashboard) string {
	if s.chartRepo == nil {
		return ""
	}
	counts := map[string]int{}
	var first string
	for _, p := range dashboard.Panels {
		if p.ComponentID == "" {
			continue
		}
		comp, err := s.chartRepo.FindByID(ctx, p.ComponentID)
		if err != nil || comp == nil || comp.ConnectionID == "" {
			continue
		}
		if first == "" {
			first = comp.ConnectionID
		}
		counts[comp.ConnectionID]++
	}
	best, bestN := first, 0
	for id, n := range counts {
		if n > bestN {
			best, bestN = id, n
		}
	}
	return best
}

// columnSet returns the lowercased set of column names across all tables of a
// connection's schema, or nil if the schema is empty/unavailable.
func (s *DashboardService) columnSet(ctx context.Context, connectionID string) map[string]struct{} {
	if s.schemaOf == nil {
		return nil
	}
	res, err := s.schemaOf(ctx, connectionID)
	if err != nil || res == nil || !res.Success || res.Schema == nil {
		return nil
	}
	cols := map[string]struct{}{}
	for _, t := range res.Schema.Tables {
		for _, col := range t.Columns {
			cols[strings.ToLower(col.Name)] = struct{}{}
		}
	}
	return cols
}

// schemaCompatible compares a candidate's columns against the reference set
// per the strictness mode. Empty schemas are reported incompatible with a
// reason rather than silently dropped.
func (s *DashboardService) schemaCompatible(ctx context.Context, candidateID string, refColumns map[string]struct{}, strict string) (bool, string) {
	if len(refColumns) == 0 {
		// No reference schema to compare against → can't verify; treat as
		// compatible (type-level discovery already matched the tag).
		return true, ""
	}
	candCols := s.columnSet(ctx, candidateID)
	if len(candCols) == 0 {
		return false, "schema unavailable or empty (idle store?) — could not verify columns"
	}
	// superset: candidate must contain every reference column.
	for col := range refColumns {
		if _, ok := candCols[col]; !ok {
			return false, fmt.Sprintf("missing column %q present in reference", col)
		}
	}
	if strict == "exact" {
		// also: candidate must have no columns beyond the reference set.
		for col := range candCols {
			if _, ok := refColumns[col]; !ok {
				return false, fmt.Sprintf("has extra column %q not in reference", col)
			}
		}
	}
	return true, ""
}
