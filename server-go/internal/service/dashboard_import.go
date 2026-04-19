// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

// PreflightImport classifies every object in the incoming bundle into
// identical / conflicts / new / blocked. Reads only — safe to call as
// often as the UI needs.
func (s *DashboardService) PreflightImport(ctx context.Context, req *models.ImportPreflightRequest) (*models.ImportPreflightResponse, error) {
	if err := s.requireImportRepos(); err != nil {
		return nil, err
	}
	if req.Bundle.FormatVersion != models.ExportFormatVersion {
		return nil, fmt.Errorf("unsupported bundle format_version %d (this build expects %d)", req.Bundle.FormatVersion, models.ExportFormatVersion)
	}

	targetNs, err := s.resolveTargetNamespace(ctx, req.TargetNamespace, req.Bundle.SourceNamespace)
	if err != nil {
		return nil, err
	}

	out := &models.ImportPreflightResponse{
		TargetNamespace: targetNs,
		Identical:       []models.ImportObjectRef{},
		Conflicts:       []models.ImportConflict{},
		New:             []models.ImportObjectRef{},
		Blocked:         []models.ImportBlocked{},
	}

	// Classify each object. We process connections/components/dashboards
	// with the same shape, just swapping the classify helpers.
	for _, inc := range req.Bundle.Objects.Connections {
		s.classifyConnection(ctx, inc, targetNs, out)
	}
	for _, inc := range req.Bundle.Objects.Components {
		s.classifyComponent(ctx, inc, targetNs, out)
	}
	for _, inc := range req.Bundle.Objects.Dashboards {
		s.classifyDashboard(ctx, inc, targetNs, out)
	}

	return out, nil
}

// ApplyImport executes the bundle after preflight. Processes in
// dependency order (connections → components → dashboards) so foreign-
// key targets exist by the time they're referenced. Respects
// OverwriteDecisions: for a conflict, absence of the key OR a true
// value means overwrite; false means skip. Identical objects are
// always skipped. Blocked entries cause the apply to refuse.
func (s *DashboardService) ApplyImport(ctx context.Context, req *models.ImportApplyRequest) (*models.ImportApplyResponse, error) {
	if err := s.requireImportRepos(); err != nil {
		return nil, err
	}

	// Rerun preflight so we can't be tricked into applying something
	// the client claimed was safe. Also gives us the categorization
	// without duplicating the classifier logic.
	preflight, err := s.PreflightImport(ctx, &models.ImportPreflightRequest{
		Bundle:          req.Bundle,
		TargetNamespace: req.TargetNamespace,
	})
	if err != nil {
		return nil, err
	}
	if len(preflight.Blocked) > 0 {
		return nil, fmt.Errorf("cannot apply: %d blocked object(s) — resolve name collisions and retry", len(preflight.Blocked))
	}

	targetNs := preflight.TargetNamespace
	decisions := req.OverwriteDecisions
	if decisions == nil {
		decisions = map[string]bool{}
	}

	resp := &models.ImportApplyResponse{}

	// Conflict fast-lookup by kind:id so we know whether each object is
	// a conflict (→ obey decision) or simply new (→ create).
	conflictKeys := make(map[string]struct{}, len(preflight.Conflicts))
	for _, c := range preflight.Conflicts {
		conflictKeys[c.Kind+":"+c.ID] = struct{}{}
	}
	identicalKeys := make(map[string]struct{}, len(preflight.Identical))
	for _, i := range preflight.Identical {
		identicalKeys[i.Kind+":"+i.ID] = struct{}{}
	}

	// Process connections first.
	for _, inc := range req.Bundle.Objects.Connections {
		idHex := inc.ID.Hex()
		key := models.ImportKindConnection + ":" + idHex
		if _, ok := identicalKeys[key]; ok {
			resp.Skipped++
			continue
		}
		if _, ok := conflictKeys[key]; ok {
			if ov, ok := decisions[key]; ok && !ov {
				resp.Skipped++
				continue
			}
			if err := s.applyConnection(ctx, inc, targetNs, true); err != nil {
				resp.Errors = append(resp.Errors, fmt.Sprintf("update connection %s (%s): %v", inc.Name, idHex, err))
				continue
			}
			resp.Updated++
			continue
		}
		// new
		if err := s.applyConnection(ctx, inc, targetNs, false); err != nil {
			resp.Errors = append(resp.Errors, fmt.Sprintf("create connection %s (%s): %v", inc.Name, idHex, err))
			continue
		}
		resp.Created++
	}

	// Components (charts) next.
	for _, inc := range req.Bundle.Objects.Components {
		key := models.ImportKindComponent + ":" + inc.ID
		if _, ok := identicalKeys[key]; ok {
			resp.Skipped++
			continue
		}
		if _, ok := conflictKeys[key]; ok {
			if ov, ok := decisions[key]; ok && !ov {
				resp.Skipped++
				continue
			}
			if err := s.applyComponent(ctx, inc, targetNs, true); err != nil {
				resp.Errors = append(resp.Errors, fmt.Sprintf("update component %s (%s): %v", inc.Name, inc.ID, err))
				continue
			}
			resp.Updated++
			continue
		}
		if err := s.applyComponent(ctx, inc, targetNs, false); err != nil {
			resp.Errors = append(resp.Errors, fmt.Sprintf("create component %s (%s): %v", inc.Name, inc.ID, err))
			continue
		}
		resp.Created++
	}

	// Dashboards last — by the time we get here, any components they
	// reference have been landed (or the user explicitly skipped them,
	// in which case the dashboard panel will render empty on the target
	// system, same as today's deleted-chart behavior).
	for _, inc := range req.Bundle.Objects.Dashboards {
		key := models.ImportKindDashboard + ":" + inc.ID
		if _, ok := identicalKeys[key]; ok {
			resp.Skipped++
			continue
		}
		if _, ok := conflictKeys[key]; ok {
			if ov, ok := decisions[key]; ok && !ov {
				resp.Skipped++
				continue
			}
			if err := s.applyDashboard(ctx, inc, targetNs, true); err != nil {
				resp.Errors = append(resp.Errors, fmt.Sprintf("update dashboard %s (%s): %v", inc.Name, inc.ID, err))
				continue
			}
			resp.Updated++
			continue
		}
		if err := s.applyDashboard(ctx, inc, targetNs, false); err != nil {
			resp.Errors = append(resp.Errors, fmt.Sprintf("create dashboard %s (%s): %v", inc.Name, inc.ID, err))
			continue
		}
		resp.Created++
	}

	return resp, nil
}

// ── preflight classifiers ───────────────────────────────────────────

func (s *DashboardService) classifyConnection(ctx context.Context, inc models.Datasource, targetNs string, out *models.ImportPreflightResponse) {
	idHex := inc.ID.Hex()
	ref := models.ImportObjectRef{
		Kind: models.ImportKindConnection, ID: idHex,
		Name: inc.Name, Namespace: inc.Namespace,
	}

	existing, err := s.datasourceRepo.FindByID(ctx, idHex)
	if err == nil && existing != nil {
		if equalBySanitizedJSON(&inc, existing.SanitizeForAPI(), connectionVolatileFields()) {
			out.Identical = append(out.Identical, ref)
			return
		}
		// Same id, different content.
		existingJSON, _ := json.Marshal(existing.SanitizeForAPI())
		incomingJSON, _ := json.Marshal(inc)
		out.Conflicts = append(out.Conflicts, models.ImportConflict{
			Kind: ref.Kind, ID: ref.ID, Name: ref.Name,
			Existing: string(existingJSON), Incoming: string(incomingJSON),
		})
		return
	}

	// ID not found → check for (target_namespace, name) collision.
	byName, err := s.datasourceRepo.FindByName(ctx, targetNs, inc.Name)
	if err == nil && byName != nil {
		out.Blocked = append(out.Blocked, models.ImportBlocked{
			Kind: ref.Kind, IncomingID: ref.ID, IncomingName: ref.Name,
			ExistingID: byName.ID.Hex(), TargetNamespace: targetNs,
			Reason: "a different connection with this name already exists in the target namespace",
		})
		return
	}
	out.New = append(out.New, ref)
}

func (s *DashboardService) classifyComponent(ctx context.Context, inc models.Chart, targetNs string, out *models.ImportPreflightResponse) {
	ref := models.ImportObjectRef{
		Kind: models.ImportKindComponent, ID: inc.ID,
		Name: inc.Name, Namespace: inc.Namespace,
	}

	existing, err := s.chartRepo.FindLatestFinal(ctx, inc.ID)
	if err == nil && existing != nil {
		if equalBySanitizedJSON(&inc, existing, chartVolatileFields()) {
			out.Identical = append(out.Identical, ref)
			return
		}
		existingJSON, _ := json.Marshal(existing)
		incomingJSON, _ := json.Marshal(inc)
		out.Conflicts = append(out.Conflicts, models.ImportConflict{
			Kind: ref.Kind, ID: ref.ID, Name: ref.Name,
			Existing: string(existingJSON), Incoming: string(incomingJSON),
		})
		return
	}

	byName, err := s.chartRepo.FindByName(ctx, targetNs, inc.Name)
	if err == nil && byName != nil {
		out.Blocked = append(out.Blocked, models.ImportBlocked{
			Kind: ref.Kind, IncomingID: ref.ID, IncomingName: ref.Name,
			ExistingID: byName.ID, TargetNamespace: targetNs,
			Reason: "a different component with this name already exists in the target namespace",
		})
		return
	}
	out.New = append(out.New, ref)
}

func (s *DashboardService) classifyDashboard(ctx context.Context, inc models.Dashboard, targetNs string, out *models.ImportPreflightResponse) {
	ref := models.ImportObjectRef{
		Kind: models.ImportKindDashboard, ID: inc.ID,
		Name: inc.Name, Namespace: inc.Namespace,
	}

	existing, err := s.repo.FindByID(ctx, inc.ID)
	if err == nil && existing != nil {
		if equalBySanitizedJSON(&inc, existing, dashboardVolatileFields()) {
			out.Identical = append(out.Identical, ref)
			return
		}
		existingJSON, _ := json.Marshal(existing)
		incomingJSON, _ := json.Marshal(inc)
		out.Conflicts = append(out.Conflicts, models.ImportConflict{
			Kind: ref.Kind, ID: ref.ID, Name: ref.Name,
			Existing: string(existingJSON), Incoming: string(incomingJSON),
		})
		return
	}

	byName, err := s.repo.FindByName(ctx, targetNs, inc.Name)
	if err == nil && byName != nil {
		out.Blocked = append(out.Blocked, models.ImportBlocked{
			Kind: ref.Kind, IncomingID: ref.ID, IncomingName: ref.Name,
			ExistingID: byName.ID, TargetNamespace: targetNs,
			Reason: "a different dashboard with this name already exists in the target namespace",
		})
		return
	}
	out.New = append(out.New, ref)
}

// ── apply writers ───────────────────────────────────────────────────

// applyConnection creates or overwrites a connection. The isUpdate flag
// tells us whether to delete-then-insert (preserving ID + timestamps)
// or just insert fresh. Masked password placeholders are handled here:
// on update we preserve the existing secret; on create we leave the
// placeholder literal for the user to fix.
func (s *DashboardService) applyConnection(ctx context.Context, inc models.Datasource, targetNs string, isUpdate bool) error {
	inc.Namespace = targetNs
	now := time.Now()
	coll := s.db.Collection("datasources")

	if isUpdate {
		existing, err := s.datasourceRepo.FindByID(ctx, inc.ID.Hex())
		if err != nil {
			return err
		}
		if existing != nil {
			preserveSecrets(&inc.Config, &existing.Config)
			// Keep the original created_at — overwrites shouldn't
			// appear younger than they really are.
			inc.CreatedAt = existing.CreatedAt
		}
		inc.UpdatedAt = now
		if _, err := coll.DeleteOne(ctx, bson.M{"_id": inc.ID}); err != nil {
			return err
		}
	} else {
		if inc.CreatedAt.IsZero() {
			inc.CreatedAt = now
		}
		inc.UpdatedAt = now
	}

	if inc.ID.IsZero() {
		inc.ID = primitive.NewObjectID()
	}
	_, err := coll.InsertOne(ctx, inc)
	return err
}

func (s *DashboardService) applyComponent(ctx context.Context, inc models.Chart, targetNs string, isUpdate bool) error {
	inc.Namespace = targetNs
	now := time.Now()
	coll := s.db.Collection("charts")

	if isUpdate {
		// Drop every version of this id; insert the incoming as v1 final.
		// Version history doesn't travel in bundles — the export emits the
		// latest final, the import lands it as the new baseline.
		if _, err := coll.DeleteMany(ctx, bson.M{"id": inc.ID}); err != nil {
			return err
		}
	}

	inc.Version = 1
	inc.Status = models.ChartStatusFinal
	inc.AISessionID = ""
	if inc.Created.IsZero() {
		inc.Created = now
	}
	inc.Updated = now
	_, err := coll.InsertOne(ctx, inc)
	return err
}

func (s *DashboardService) applyDashboard(ctx context.Context, inc models.Dashboard, targetNs string, isUpdate bool) error {
	inc.Namespace = targetNs
	now := time.Now()
	coll := s.db.Collection("dashboards")

	if isUpdate {
		if _, err := coll.DeleteOne(ctx, bson.M{"_id": inc.ID}); err != nil {
			return err
		}
	}

	if inc.Created.IsZero() {
		inc.Created = now
	}
	inc.Updated = now
	_, err := coll.InsertOne(ctx, inc)
	return err
}

// ── helpers ─────────────────────────────────────────────────────────

// requireImportRepos guards methods that need chartRepo + datasourceRepo
// wired in. Main always wires them; this is defensive for tests.
func (s *DashboardService) requireImportRepos() error {
	if s.chartRepo == nil || s.datasourceRepo == nil || s.db == nil {
		return fmt.Errorf("import requires chart/datasource repos and a database handle — service was constructed without them")
	}
	return nil
}

// resolveTargetNamespace implements the fallback cascade:
//  1. explicit target from the request, if non-empty
//  2. bundle.SourceNamespace if it exists locally as a namespace
//  3. "default"
// Returns the slug the importer will write into.
func (s *DashboardService) resolveTargetNamespace(ctx context.Context, requested, sourceNs string) (string, error) {
	if requested != "" {
		return requested, nil
	}
	if sourceNs != "" {
		var ns models.Namespace
		err := s.db.Collection("namespaces").FindOne(ctx, bson.M{"name": sourceNs}).Decode(&ns)
		if err == nil {
			return sourceNs, nil
		}
	}
	return models.DefaultNamespace, nil
}

// equalBySanitizedJSON compares two values after marshaling both to
// JSON and stripping a set of volatile fields (timestamps, health
// status). Used by the preflight to decide "same content" without
// getting tripped up on fields that routinely differ between export
// and local state.
func equalBySanitizedJSON(a, b interface{}, volatile map[string]bool) bool {
	aBytes, err := json.Marshal(a)
	if err != nil {
		return false
	}
	bBytes, err := json.Marshal(b)
	if err != nil {
		return false
	}
	var aMap, bMap map[string]interface{}
	if err := json.Unmarshal(aBytes, &aMap); err != nil {
		return false
	}
	if err := json.Unmarshal(bBytes, &bMap); err != nil {
		return false
	}
	for k := range volatile {
		delete(aMap, k)
		delete(bMap, k)
	}
	// Compare canonical-JSON re-encodings.
	aCanon, _ := json.Marshal(aMap)
	bCanon, _ := json.Marshal(bMap)
	return string(aCanon) == string(bCanon)
}

// Volatile-field sets — fields we ignore when comparing incoming vs
// existing. Timestamps and health telemetry change on every touch
// without the user intending a semantic difference.
func connectionVolatileFields() map[string]bool {
	return map[string]bool{"created_at": true, "updated_at": true, "health": true}
}
func chartVolatileFields() map[string]bool {
	return map[string]bool{"created": true, "updated": true, "version": true, "ai_session_id": true}
}
func dashboardVolatileFields() map[string]bool {
	return map[string]bool{"created": true, "updated": true, "thumbnail": true}
}
