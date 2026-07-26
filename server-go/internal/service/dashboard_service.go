// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"fmt"
	"log"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/authz"
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
	thumbnailRepo  *repository.DashboardThumbnailRepository
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
		thumbnailRepo:  repository.NewDashboardThumbnailRepository(db),
		db:             db,
		chartRepo:      chartRepo,
		connectionRepo: connectionRepo,
	}
}

// GetThumbnail returns the stored thumbnail data URL for a dashboard, or
// "" when none has been captured. Enforces namespace grants (issue #4) —
// a thumbnail is a rendering of the dashboard's content.
func (s *DashboardService) GetThumbnail(ctx context.Context, id string) (string, error) {
	if _, err := s.findAuthorized(ctx, id); err != nil {
		return "", err
	}
	return s.thumbnailRepo.Get(ctx, id)
}

// SetThumbnail upserts a dashboard's thumbnail blob.
func (s *DashboardService) SetThumbnail(ctx context.Context, id, data string) error {
	if _, err := s.findAuthorized(ctx, id); err != nil {
		return err
	}
	return s.thumbnailRepo.Put(ctx, id, data)
}

// findAuthorized fetches a dashboard by id and enforces the caller's
// namespace grants (issue #4). The uniform fetch for every external
// by-id entry point in this service. Returns
// authz.ErrNamespaceForbidden on a grant miss.
func (s *DashboardService) findAuthorized(ctx context.Context, id string) (*models.Dashboard, error) {
	dashboard, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get dashboard: %w", err)
	}
	if dashboard == nil {
		return nil, fmt.Errorf("dashboard not found")
	}
	if err := authz.CheckNamespace(ctx, dashboard.Namespace); err != nil {
		return nil, err
	}
	return dashboard, nil
}

// CreateDashboard creates a new dashboard. Namespace defaults to
// "default" when the request omits it.
func (s *DashboardService) CreateDashboard(ctx context.Context, req *models.CreateDashboardRequest) (*models.Dashboard, error) {
	if req.Namespace == "" {
		req.Namespace = models.DefaultNamespace
	}
	// Namespace grants (issue #4): creating INTO an ungranted namespace
	// is forbidden.
	if err := authz.CheckNamespace(ctx, req.Namespace); err != nil {
		return nil, err
	}

	// Uniqueness is (namespace, name) — same name allowed across namespaces.
	existing, err := s.repo.FindByName(ctx, req.Namespace, req.Name)
	if err != nil {
		return nil, fmt.Errorf("error checking for existing dashboard: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("dashboard with name '%s' already exists in namespace '%s'", req.Name, req.Namespace)
	}

	// v1 allows at most one filter-mode variable (single fixed token).
	if err := models.ValidateVariables(req.Settings.Variables); err != nil {
		return nil, err
	}

	// Normalize tags before persistence.
	req.Tags = models.NormalizeTags(req.Tags)

	// Assign an id to every panel that lacks one. The editor generates panel
	// ids client-side, but the AI surfaces send panels with id:"" — and the
	// editor identifies panels BY id (drag/resize/edit target, React keys).
	// Empty ids collide ("" == ""), so every panel resolves to the first one:
	// editing one changed all, saves landed on the wrong panel, delete went
	// flaky. Backfill server-side so all surfaces get unique panel ids.
	ensurePanelIDs(req.Panels)
	sanitizeAdornments(req.Adornments)
	req.Adornments = pruneOrphanAdornments(req.Adornments, req.Panels)

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
	return s.findAuthorized(ctx, id)
}

// GetDashboardComponents returns the latest FINAL version of every component a
// dashboard's panels reference — both each panel's default component and every
// component named by a component-swap override — in ONE query. This collapses
// the viewer's per-panel getComponent N+1 (one round-trip per unique
// component) into a single batch fetch (#60). Drafts are excluded: a viewer
// should never render a mid-edit draft.
//
// Missing components (id with no final version) are simply absent from the
// result; the viewer treats an unresolved panel component the same as a failed
// single fetch (renders as a panel with no chart).
func (s *DashboardService) GetDashboardComponents(ctx context.Context, id string) ([]models.Component, error) {
	components, _, err := s.GetDashboardComponentsAuthorized(ctx, id)
	return components, err
}

// GetDashboardComponentsAuthorized is GetDashboardComponents plus the
// #4 authorization partition. The dashboard's OWN namespace gates the
// call (findAuthorized). Each referenced component is then classified:
//
//   - visible → returned in `components`
//   - the component itself is in an ungranted namespace →
//     {id, reason:"component"} placeholder
//   - the component is visible but its connection is in an ungranted
//     namespace → {id, reason:"connection"} placeholder
//
// Placeholders keep only the id so the viewer can map the panel and
// render an "unauthorized" error panel — no name/namespace leaks.
func (s *DashboardService) GetDashboardComponentsAuthorized(ctx context.Context, id string) ([]models.Component, []models.UnauthorizedRef, error) {
	dashboard, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	ids := panelComponentIDs(dashboard)
	if len(ids) == 0 {
		return []models.Component{}, nil, nil
	}
	if s.chartRepo == nil {
		return nil, nil, fmt.Errorf("component repository not configured")
	}
	// Fetch WITHOUT grant filtering (internal ctx) so we can classify
	// every referenced component, then partition by the caller's grants.
	all, err := s.chartRepo.FindLatestFinalByIDs(context.Background(), ids)
	if err != nil {
		return nil, nil, err
	}

	_, grants, ok := authz.FromContext(ctx)
	if !ok || !grants.Restricted {
		return all, nil, nil
	}

	visible := make([]models.Component, 0, len(all))
	var unauthorized []models.UnauthorizedRef
	for _, comp := range all {
		if !grants.Can(comp.Namespace) {
			unauthorized = append(unauthorized, models.UnauthorizedRef{ID: comp.ID, Reason: "component"})
			continue
		}
		// Component is visible; check its connection's namespace. Use a
		// background context so the lookup itself isn't grant-blocked —
		// we're classifying, not serving the connection.
		if comp.ConnectionID != "" && s.connectionRepo != nil {
			if conn, cErr := s.connectionRepo.FindByID(context.Background(), comp.ConnectionID); cErr == nil && conn != nil && !grants.Can(conn.Namespace) {
				unauthorized = append(unauthorized, models.UnauthorizedRef{ID: comp.ID, Reason: "connection"})
				continue
			}
		}
		visible = append(visible, comp)
	}
	return visible, unauthorized, nil
}

// resolveConnectionFilter expands a ConnectionID filter into the set of
// component ids bound to that connection (by connection_id or a display's
// frigate/mqtt connection id), stamping params.ComponentIDs for the repo's
// panels.component_id $in. An empty set is left as-is (matches no dashboard).
// No-op when ConnectionID is unset or the component repo isn't wired.
func (s *DashboardService) resolveConnectionFilter(ctx context.Context, params *models.DashboardQueryParams) error {
	if params.ConnectionID == "" || s.chartRepo == nil {
		return nil
	}
	ids, err := s.chartRepo.FindIDsByConnectionAnyRef(ctx, params.ConnectionID)
	if err != nil {
		return fmt.Errorf("resolving connection filter: %w", err)
	}
	if ids == nil {
		ids = []string{} // non-nil empty → $in matches nothing, not "field absent"
	}
	params.ComponentIDs = ids
	return nil
}

// ListDashboards retrieves dashboards with filtering and pagination
func (s *DashboardService) ListDashboards(ctx context.Context, params models.DashboardQueryParams) (*models.DashboardListResponse, error) {
	// Normalize filter tags to match how they're stored.
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}
	if err := s.resolveConnectionFilter(ctx, &params); err != nil {
		return nil, err
	}
	// Namespace grants (issue #4): restrict to the caller's allowed set;
	// an explicit namespace filter outside the grants → empty page.
	var filterAllowed bool
	params.AllowedNamespaces, params.NamespacesRestricted, filterAllowed = namespaceGrantsForList(ctx, params.Namespace)
	if !filterAllowed {
		return &models.DashboardListResponse{Dashboards: []models.Dashboard{}, Page: 1, PageSize: params.PageSize}, nil
	}
	if params.Page < 1 {
		params.Page = 1
	}
	// Clamp BEFORE the repo call so 0=all (capped) reaches the query.
	params.PageSize, _ = models.ClampPageSize(params.PageSize, 20)

	dashboards, total, err := s.repo.List(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("failed to list dashboards: %w", err)
	}

	return &models.DashboardListResponse{
		Dashboards: dashboards,
		Total:      total,
		Page:       params.Page,
		PageSize:   params.PageSize,
		HasMore:    models.ComputeHasMore(params.Page, params.PageSize, len(dashboards), total),
	}, nil
}

// ListDashboardNavRefs returns the full matching set as lightweight nav
// refs (id + sort fields) for viewer prev/next ordering (#114). Same
// filter semantics as the other list shapes; pagination params are
// ignored (the repo caps at PageSizeAllCap).
func (s *DashboardService) ListDashboardNavRefs(ctx context.Context, params models.DashboardQueryParams) (*models.DashboardNavListResponse, error) {
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}
	if err := s.resolveConnectionFilter(ctx, &params); err != nil {
		return nil, err
	}
	// Namespace grants (issue #4).
	var filterAllowed bool
	params.AllowedNamespaces, params.NamespacesRestricted, filterAllowed = namespaceGrantsForList(ctx, params.Namespace)
	if !filterAllowed {
		return &models.DashboardNavListResponse{Dashboards: []models.DashboardNavRef{}}, nil
	}

	refs, total, err := s.repo.ListNavRefs(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("failed to list dashboard nav refs: %w", err)
	}

	return &models.DashboardNavListResponse{
		Dashboards: refs,
		Total:      total,
	}, nil
}

// ListDashboardsWithDatasources retrieves dashboard summaries with data source names
func (s *DashboardService) ListDashboardsWithDatasources(ctx context.Context, params models.DashboardQueryParams) (*models.DashboardSummaryListResponse, error) {
	// Normalize filter tags to match how they're stored.
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}
	if err := s.resolveConnectionFilter(ctx, &params); err != nil {
		return nil, err
	}
	// Namespace grants (issue #4).
	var filterAllowed bool
	params.AllowedNamespaces, params.NamespacesRestricted, filterAllowed = namespaceGrantsForList(ctx, params.Namespace)
	if !filterAllowed {
		return &models.DashboardSummaryListResponse{Dashboards: []models.DashboardSummary{}, Page: 1, PageSize: params.PageSize}, nil
	}
	if params.Page < 1 {
		params.Page = 1
	}
	params.PageSize, _ = models.ClampPageSize(params.PageSize, 20)

	summaries, total, err := s.repo.ListWithConnections(ctx, params, s.db)
	if err != nil {
		return nil, fmt.Errorf("failed to list dashboards with datasources: %w", err)
	}

	// Redact ungranted component/connection refs (#4). The dashboard
	// itself is visible (its own namespace passed the list filter), but
	// it may reference components/connections in namespaces the caller
	// can't see — those become opaque "Unauthorized" placeholders and
	// flip the dashboard's warning badge.
	for i := range summaries {
		var compRedacted, connRedacted bool
		summaries[i].ComponentUsage, compRedacted = redactUsageRefs(ctx, summaries[i].ComponentUsage, "component")
		summaries[i].ConnectionUsage, connRedacted = redactUsageRefs(ctx, summaries[i].ConnectionUsage, "connection")
		summaries[i].HasUnauthorizedDeps = compRedacted || connRedacted
		// connection_names is the deprecated names-only field — drop it
		// entirely for restricted callers so it can't leak an ungranted
		// connection's name alongside the redacted connection_usage.
		if _, g, ok := authz.FromContext(ctx); ok && g.Restricted {
			summaries[i].ConnectionNames = nil
		}
	}

	return &models.DashboardSummaryListResponse{
		Dashboards: summaries,
		Total:      total,
		Page:       params.Page,
		PageSize:   params.PageSize,
		HasMore:    models.ComputeHasMore(params.Page, params.PageSize, len(summaries), total),
	}, nil
}

// UpdateDashboard updates a dashboard
func (s *DashboardService) UpdateDashboard(ctx context.Context, id string, req *models.UpdateDashboardRequest) (*models.Dashboard, error) {
	// Check the dashboard exists and the caller may touch it (issue #4).
	existing, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	// Resolve post-update (namespace, name) and check uniqueness if either
	// changed. Both can move in the same request.
	newNamespace := existing.Namespace
	if req.Namespace != nil && *req.Namespace != "" {
		newNamespace = *req.Namespace
	}
	// Moving into an ungranted namespace is forbidden (issue #4).
	if err := authz.CheckNamespace(ctx, newNamespace); err != nil {
		return nil, err
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

	// v1 allows at most one filter-mode variable (single fixed token).
	if req.Settings != nil {
		if err := models.ValidateVariables(req.Settings.Variables); err != nil {
			return nil, err
		}
	}

	// Normalize tags if provided.
	if req.Tags != nil {
		normalized := models.NormalizeTags(*req.Tags)
		req.Tags = &normalized
	}

	// Backfill ids on any panel that lacks one (see CreateDashboard) — the
	// AI surfaces send id:"" panels and empty ids collide in the editor.
	if req.Panels != nil {
		ensurePanelIDs(*req.Panels)
	}
	if req.Adornments != nil {
		sanitizeAdornments(*req.Adornments)
		// Prune orphans only when the caller also sent panels — otherwise we
		// have no authoritative panel list to check against, and a partial
		// update (adornments only) would delete every panel_border.
		if req.Panels != nil {
			pruned := pruneOrphanAdornments(*req.Adornments, *req.Panels)
			req.Adornments = &pruned
		}
	}

	dashboard, err := s.repo.Update(ctx, id, req)
	if err != nil {
		return nil, fmt.Errorf("failed to update dashboard: %w", err)
	}

	return dashboard, nil
}

// DeleteDashboard deletes a dashboard
func (s *DashboardService) DeleteDashboard(ctx context.Context, id string) error {
	_, err := s.DeleteDashboardCascade(ctx, id, nil)
	return err
}

// panelComponentIDs returns every component a dashboard references — the
// panels' default ComponentID plus every ComponentOverride rule's ComponentID
// (component-swap-by-variable). De-duplicated. Both kinds count as references
// for orphan detection.
func panelComponentIDs(d *models.Dashboard) []string {
	if d == nil {
		return nil
	}
	seen := map[string]bool{}
	var ids []string
	add := func(cid string) {
		if cid == "" || seen[cid] {
			return
		}
		seen[cid] = true
		ids = append(ids, cid)
	}
	for _, p := range d.Panels {
		add(p.ComponentID)
		for _, ov := range p.ComponentOverrides {
			add(ov.ComponentID)
		}
	}
	return ids
}

// DashboardOrphanPreview returns the components that would be left orphaned if
// the given dashboard were deleted — i.e. components this dashboard references
// (direct or via override) that NO OTHER dashboard references. These are the
// components safe to offer for cascade deletion. A component still used by any
// other dashboard is excluded.
//
// Correctness note: it scans ALL dashboards rather than the narrow
// `panels.component_id` repo filter, because that filter misses
// ComponentOverrides refs — a component used only via an override rule on
// another dashboard must still count as "in use".
func (s *DashboardService) DashboardOrphanPreview(ctx context.Context, id string) ([]EntityRef, error) {
	target, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	candidateIDs := panelComponentIDs(target)
	if len(candidateIDs) == 0 {
		return nil, nil
	}

	// Component IDs referenced by every OTHER dashboard (direct + override).
	usedElsewhere, err := s.componentRefsExcluding(ctx, id)
	if err != nil {
		return nil, err
	}

	orphans := make([]EntityRef, 0)
	for _, cid := range candidateIDs {
		if usedElsewhere[cid] {
			continue // still referenced by another dashboard — not orphaned
		}
		name := cid
		if s.chartRepo != nil {
			if comp, e := s.chartRepo.FindByID(ctx, cid); e == nil && comp != nil {
				if comp.Title != "" {
					name = comp.Title
				} else if comp.Name != "" {
					name = comp.Name
				}
			}
		}
		orphans = append(orphans, EntityRef{ID: cid, Name: name})
	}
	return orphans, nil
}

// componentRefsExcluding builds the set of component IDs referenced (direct or
// via override) by all dashboards EXCEPT the one with excludeID.
func (s *DashboardService) componentRefsExcluding(ctx context.Context, excludeID string) (map[string]bool, error) {
	all, _, err := s.repo.List(ctx, models.DashboardQueryParams{Page: 1, PageSize: 1000})
	if err != nil {
		return nil, fmt.Errorf("error listing dashboards for orphan scan: %w", err)
	}
	used := map[string]bool{}
	for i := range all {
		if all[i].ID == excludeID {
			continue
		}
		for _, cid := range panelComponentIDs(&all[i]) {
			used[cid] = true
		}
	}
	return used, nil
}

// DeleteDashboardCascade deletes a dashboard and, optionally, components it
// referenced. deleteComponentIDs is the caller's chosen subset to also delete;
// each is RE-VALIDATED as genuinely orphaned (referenced by no other dashboard)
// before deletion, so a stale/tampered client list can never delete a
// still-in-use component. Returns the IDs actually deleted.
func (s *DashboardService) DeleteDashboardCascade(ctx context.Context, id string, deleteComponentIDs []string) ([]string, error) {
	if _, err := s.findAuthorized(ctx, id); err != nil {
		return nil, err
	}

	// Resolve the true orphan set BEFORE deleting the dashboard (the scan
	// excludes this dashboard, so its own refs don't keep a component alive).
	var deleted []string
	if len(deleteComponentIDs) > 0 && s.chartRepo != nil {
		orphans, perr := s.DashboardOrphanPreview(ctx, id)
		if perr != nil {
			return nil, perr
		}
		orphanSet := map[string]bool{}
		for _, o := range orphans {
			orphanSet[o.ID] = true
		}
		for _, cid := range deleteComponentIDs {
			if !orphanSet[cid] {
				continue // not actually orphaned — refuse to delete it
			}
			if e := s.chartRepo.Delete(ctx, cid); e != nil {
				return deleted, fmt.Errorf("failed to delete orphaned component %s: %w", cid, e)
			}
			deleted = append(deleted, cid)
		}
	}

	if err := s.repo.Delete(ctx, id); err != nil {
		return deleted, fmt.Errorf("failed to delete dashboard: %w", err)
	}

	// Best-effort thumbnail cleanup so blobs don't orphan in the
	// dashboard_thumbnails collection. Non-fatal: the dashboard is
	// already gone, a leftover blob is harmless and re-deletable.
	if err := s.thumbnailRepo.Delete(ctx, id); err != nil {
		log.Printf("warning: failed to delete thumbnail for dashboard %s: %v", id, err)
	}
	return deleted, nil
}

// discoverSwapConnections resolves the connections a connection_swap variable
// selects between: connections whose tag set contains ALL of the variable's
// discovery tags. SameNamespace (default false) restricts discovery to the
// given dashboard namespace; otherwise it's cross-namespace.
//
// The underlying repo query (connByTags) matches tags with OR ($in), so this
// narrows to AND semantics — a variable's tags are a conjunction (e.g. both
// "system-stats" AND "ts-store"). Shared by GetVariableCandidates (viewer
// dropdown) and BuildExport (bundle the swap targets); keep it the single
// source of truth so the two can't drift on discovery semantics.
//
// Returns an error only when the discovery helper isn't wired or the query
// fails; an empty result (no match) is not an error.
func (s *DashboardService) discoverSwapConnections(ctx context.Context, dashboardNamespace string, cfg *models.ConnectionSwapConfig) ([]*models.Connection, error) {
	if s.connByTags == nil {
		return nil, fmt.Errorf("connection discovery not available: connection helpers not wired")
	}
	discoverNS := ""
	if cfg.SameNamespace {
		discoverNS = dashboardNamespace
	}
	candidates, err := s.connByTags(ctx, discoverNS, cfg.Tags)
	if err != nil {
		return nil, fmt.Errorf("error discovering connections: %w", err)
	}
	required := models.NormalizeTags(cfg.Tags)
	if len(required) == 0 {
		return candidates, nil
	}
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
	return filtered, nil
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

	dashboard, err := s.findAuthorized(ctx, dashboardID)
	if err != nil {
		return nil, err
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

	// Discover the connections whose tag set matches the variable's filter.
	candidates, err := s.discoverSwapConnections(ctx, dashboard.Namespace, cfg)
	if err != nil {
		return nil, err
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
			Tags:      c.Tags, // carried so the client can derive a label from a prefixed tag
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

// columnSetUnified returns the lowercased set of every column/field name a
// connection exposes, across ALL schema shapes: SQL/EdgeLake tables, the
// synthetic single-table ts-store/API/CSV/socket schema, and Prometheus
// metric+label names. Broader than columnSet (which only reads Tables) so the
// swap-compatibility check works for flat stores like ts-store. Returns nil
// when the schema is unavailable/empty so callers can distinguish "unknown"
// from "no matching columns".
func (s *DashboardService) columnSetUnified(ctx context.Context, connectionID string) map[string]struct{} {
	if s.schemaOf == nil {
		return nil
	}
	res, err := s.schemaOf(ctx, connectionID)
	if err != nil || res == nil || !res.Success {
		return nil
	}
	cols := map[string]struct{}{}
	if res.Schema != nil {
		for _, t := range res.Schema.Tables {
			for _, col := range t.Columns {
				cols[strings.ToLower(col.Name)] = struct{}{}
			}
		}
	}
	if res.PrometheusSchema != nil {
		for _, m := range res.PrometheusSchema.Metrics {
			cols[strings.ToLower(m.Name)] = struct{}{}
		}
		for _, l := range res.PrometheusSchema.Labels {
			cols[strings.ToLower(l)] = struct{}{}
		}
	}
	if len(cols) == 0 {
		return nil
	}
	return cols
}

// requiredColumns collects the columns a component's data_mapping references —
// the set that must exist on its connection for the component to render as
// authored. Union of visible_columns (dataview), x_axis, y_axis, series,
// group_by, sort_by, label_col. Returns an ordered, de-duped list (declaration
// order, first occurrence wins) so a UI message reads naturally. Components
// with no data_mapping (custom code, static placeholders like "NA") return
// nothing — nothing to check, so they never warn.
func requiredColumns(comp *models.Component) []string {
	if comp == nil || comp.DataMapping == nil {
		return nil
	}
	dm := comp.DataMapping
	seen := map[string]struct{}{}
	var out []string
	add := func(c string) {
		c = strings.TrimSpace(c)
		if c == "" {
			return
		}
		key := strings.ToLower(c)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, c)
	}
	// visible_columns is the load-bearing one for data tables; list it first.
	for _, c := range dm.VisibleColumns {
		add(c)
	}
	add(dm.XAxis)
	for _, c := range dm.YAxis {
		add(c)
	}
	add(dm.Series)
	add(dm.GroupBy)
	add(dm.SortBy)
	add(dm.LabelCol)
	return out
}

// GetSwapCompatibility checks, for a connection_swap variable and a target
// connection, which of the supplied panels' components would be missing
// required columns on that connection. The caller passes the EFFECTIVE
// panel→component pairs it is about to render (post component-override), so a
// panel the author has already substituted (e.g. swapped to an NA placeholder
// or a variable-free chart for hosts that lack columns) is checked as that
// substitute — not the original — and won't false-warn.
//
// Detection only: the result annotates the UI; it never blocks a swap.
func (s *DashboardService) GetSwapCompatibility(ctx context.Context, dashboardID, variableName, connectionID string, panelComponents map[string]string) (*models.SwapCompatibilityResponse, error) {
	if connectionID == "" {
		return nil, fmt.Errorf("connection id is required")
	}
	dashboard, err := s.findAuthorized(ctx, dashboardID)
	if err != nil {
		return nil, err
	}

	resp := &models.SwapCompatibilityResponse{Variable: variableName, ConnectionID: connectionID}

	cols := s.columnSetUnified(ctx, connectionID)
	if cols == nil {
		// Can't read the target schema → report "unknown" rather than a false
		// all-clear. No per-panel issues (we can't compute them).
		resp.SchemaUnavailable = true
		return resp, nil
	}

	// When the caller didn't supply the effective components, fall back to each
	// panel's default component_id from the dashboard.
	if len(panelComponents) == 0 {
		panelComponents = map[string]string{}
		for _, p := range dashboard.Panels {
			if p.ID != "" && p.ComponentID != "" {
				panelComponents[p.ID] = p.ComponentID
			}
		}
	}

	if s.chartRepo == nil {
		return resp, nil
	}
	for panelID, componentID := range panelComponents {
		if componentID == "" {
			continue
		}
		comp, cerr := s.chartRepo.FindByID(ctx, componentID)
		if cerr != nil || comp == nil {
			continue
		}
		req := requiredColumns(comp)
		if len(req) == 0 {
			continue
		}
		var missing []string
		for _, c := range req {
			if _, ok := cols[strings.ToLower(c)]; !ok {
				missing = append(missing, c)
			}
		}
		if len(missing) > 0 {
			resp.Issues = append(resp.Issues, models.PanelSwapIssue{
				PanelID:        panelID,
				ComponentID:    comp.ID,
				ComponentName:  comp.Name,
				MissingColumns: missing,
			})
		}
	}
	return resp, nil
}

// ensurePanelIDs assigns a unique id to every panel that lacks one, and
// regenerates any id that duplicates an earlier panel's. The editor keys
// all per-panel operations (drag, resize, edit-target, delete, React keys)
// on panel.id; empty or duplicate ids collide so every op resolves to the
// first matching panel — which is how an AI-built dashboard (panels sent
// with id:"") got "edit one chart changes all" and "save lands on the
// wrong panel." Mutates the slice in place.
func ensurePanelIDs(panels []models.DashboardPanel) {
	seen := make(map[string]bool, len(panels))
	for i := range panels {
		id := panels[i].ID
		if id == "" || seen[id] {
			id = uuid.New().String()
			panels[i].ID = id
		}
		seen[id] = true
	}
}

// sanitizeAdornments backfills ids (same collision reasoning as
// ensurePanelIDs) and clamps the style fields to the supported set.
// Adornments are decoration, so an out-of-range value is coerced to a sane
// default rather than failing the whole dashboard save — a bad color must
// never cost the user their panel edits. Geometry is clamped to non-negative
// with a minimum 1x1 extent; the client clamps to the grid budget, and the
// grid itself tolerates an over-wide rect by extending its extent.
// Mutates the slice in place.
func sanitizeAdornments(adornments []models.DashboardAdornment) {
	seen := make(map[string]bool, len(adornments))
	for i := range adornments {
		a := &adornments[i]

		if a.ID == "" || seen[a.ID] {
			a.ID = uuid.New().String()
		}
		seen[a.ID] = true

		if a.Kind == "" {
			a.Kind = models.AdornmentKindBorder
		}

		if a.Kind == models.AdornmentKindPanelBorder {
			// Geometry comes from the bound panel, so any rect that rode along
			// is meaningless — clear it rather than persist a stale copy that
			// a future reader might trust.
			a.X, a.Y, a.W, a.H = 0, 0, 0, 0
		} else {
			if a.X < 0 {
				a.X = 0
			}
			if a.Y < 0 {
				a.Y = 0
			}
			if a.W < 1 {
				a.W = 1
			}
			if a.H < 1 {
				a.H = 1
			}
			// A rect-positioned border has no panel to bind to.
			a.PanelID = ""
		}

		// Legal widths differ by kind: a gutter border is centered in the 4px
		// gap so it must be even, while a panel border grows inward from a
		// real edge and may be odd. See models.WidthsForAdornmentKind.
		legal := models.WidthsForAdornmentKind(a.Kind)
		if !slices.Contains(legal, a.Width) {
			a.Width = legal[0]
		}

		switch a.LineStyle {
		case models.AdornmentLineSolid, models.AdornmentLineDashed, models.AdornmentLineDotted:
			// ok
		default:
			a.LineStyle = models.AdornmentLineSolid
		}
	}
}

// pruneOrphanAdornments drops panel_border adornments whose panel no longer
// exists. Without this, deleting a panel would leave a border bound to a
// missing id — invisible in the UI but still in the record, and liable to
// resurrect if a future panel reused the id. Returns the filtered slice.
//
// Only called when the caller supplies BOTH panels and adornments, so a
// partial update that omits panels can never prune against an empty set.
func pruneOrphanAdornments(adornments []models.DashboardAdornment, panels []models.DashboardPanel) []models.DashboardAdornment {
	if len(adornments) == 0 {
		return adornments
	}
	live := make(map[string]bool, len(panels))
	for _, p := range panels {
		live[p.ID] = true
	}
	kept := adornments[:0]
	for _, a := range adornments {
		if a.Kind == models.AdornmentKindPanelBorder && !live[a.PanelID] {
			continue
		}
		kept = append(kept, a)
	}
	return kept
}
