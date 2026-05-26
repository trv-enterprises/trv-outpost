// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
	"go.mongodb.org/mongo-driver/mongo"
)

// Validation bounds — tight enough to keep storage and UI sane, loose
// enough that a determined user won't run into them in normal use.
const (
	maxSnippetTitleLen   = 100
	maxSnippetCommandLen = 8000
	maxSnippetTags       = 20
	maxSnippetTagLen     = 40
)

// SnippetService errors. The handler maps these to HTTP status codes.
var (
	ErrSnippetNotFound      = errors.New("snippet not found")
	ErrSnippetForbidden     = errors.New("snippet forbidden")
	ErrSnippetInvalidScope  = errors.New("snippet scope must be 'user' or 'global'")
	ErrSnippetGlobalManage  = errors.New("global snippets require manage capability")
	ErrSnippetInvalidField  = errors.New("invalid snippet field")
)

// SnippetService owns snippet validation, ownership/capability
// enforcement, and the `can_edit` decoration on list responses.
type SnippetService struct {
	repo *repository.SnippetRepository
}

// NewSnippetService wires the repository.
func NewSnippetService(repo *repository.SnippetRepository) *SnippetService {
	return &SnippetService{repo: repo}
}

// Repo exposes the underlying repository so other services (e.g. the
// starter-pack migration runner) can read counts without going through
// validation. Keep usage narrow.
func (s *SnippetService) Repo() *repository.SnippetRepository {
	return s.repo
}

// List returns every snippet visible to the caller for the given
// context, with `can_edit` stamped per row.
func (s *SnippetService) List(ctx context.Context, caller *models.User, contextKey string) ([]models.SnippetResponse, error) {
	snippets, err := s.repo.ListForUser(ctx, caller.GUID, contextKey)
	if err != nil {
		return nil, err
	}
	canManage := caller.HasCapability(models.CapabilityManage)
	out := make([]models.SnippetResponse, len(snippets))
	for i, sn := range snippets {
		out[i] = models.SnippetResponse{
			Snippet: sn,
			CanEdit: callerCanEdit(&sn, caller, canManage),
		}
	}
	return out, nil
}

// Create validates and persists a new snippet. The scope determines
// the capability gate.
func (s *SnippetService) Create(ctx context.Context, caller *models.User, req *models.CreateSnippetRequest) (*models.Snippet, error) {
	scope := strings.TrimSpace(req.Scope)
	if scope != models.SnippetScopeUser && scope != models.SnippetScopeGlobal {
		return nil, ErrSnippetInvalidScope
	}
	if scope == models.SnippetScopeGlobal && !caller.HasCapability(models.CapabilityManage) {
		return nil, ErrSnippetGlobalManage
	}

	title, command, tags, err := validateSnippetFields(req.Title, req.Command, req.Tags)
	if err != nil {
		return nil, err
	}
	contextKey := strings.TrimSpace(req.Context)
	if contextKey == "" {
		return nil, ErrSnippetInvalidField
	}

	now := time.Now()
	sn := models.Snippet{
		ID:      uuid.New().String(),
		Scope:   scope,
		Context: contextKey,
		Title:   title,
		Command: command,
		Tags:    tags,
		Created: now,
		Updated: now,
	}
	if scope == models.SnippetScopeUser {
		sn.OwnerUserID = caller.GUID
	}
	if err := s.repo.Create(ctx, &sn); err != nil {
		return nil, err
	}
	return &sn, nil
}

// Update validates and applies edits. Caller must be the owner (for
// user-scoped snippets) or have Manage capability (for globals).
func (s *SnippetService) Update(ctx context.Context, caller *models.User, id string, req *models.UpdateSnippetRequest) (*models.Snippet, error) {
	existing, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, ErrSnippetNotFound
	}
	canManage := caller.HasCapability(models.CapabilityManage)
	if !callerCanEdit(existing, caller, canManage) {
		return nil, ErrSnippetForbidden
	}

	title, command, tags, err := validateSnippetFields(req.Title, req.Command, req.Tags)
	if err != nil {
		return nil, err
	}
	if err := s.repo.Update(ctx, id, title, command, tags); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, ErrSnippetNotFound
		}
		return nil, err
	}
	existing.Title = title
	existing.Command = command
	existing.Tags = tags
	existing.Updated = time.Now()
	return existing, nil
}

// Delete removes a snippet. Same ownership / capability rules as
// Update.
func (s *SnippetService) Delete(ctx context.Context, caller *models.User, id string) error {
	existing, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if existing == nil {
		return ErrSnippetNotFound
	}
	canManage := caller.HasCapability(models.CapabilityManage)
	if !callerCanEdit(existing, caller, canManage) {
		return ErrSnippetForbidden
	}
	if err := s.repo.Delete(ctx, id); err != nil {
		if err == mongo.ErrNoDocuments {
			return ErrSnippetNotFound
		}
		return err
	}
	return nil
}

func callerCanEdit(sn *models.Snippet, caller *models.User, canManage bool) bool {
	switch sn.Scope {
	case models.SnippetScopeGlobal:
		return canManage
	case models.SnippetScopeUser:
		return sn.OwnerUserID == caller.GUID
	default:
		return false
	}
}

func validateSnippetFields(rawTitle, rawCommand string, rawTags []string) (string, string, []string, error) {
	title := strings.TrimSpace(rawTitle)
	if title == "" || len(title) > maxSnippetTitleLen {
		return "", "", nil, ErrSnippetInvalidField
	}
	command := strings.TrimRight(rawCommand, "\r\n")
	if strings.TrimSpace(command) == "" || len(command) > maxSnippetCommandLen {
		return "", "", nil, ErrSnippetInvalidField
	}

	tags := make([]string, 0, len(rawTags))
	seen := make(map[string]struct{}, len(rawTags))
	for _, t := range rawTags {
		tag := strings.TrimSpace(t)
		if tag == "" {
			continue
		}
		if len(tag) > maxSnippetTagLen {
			return "", "", nil, ErrSnippetInvalidField
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		tags = append(tags, tag)
	}
	if len(tags) > maxSnippetTags {
		return "", "", nil, ErrSnippetInvalidField
	}
	return title, command, tags, nil
}
