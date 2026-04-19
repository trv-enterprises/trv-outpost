// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
	"go.mongodb.org/mongo-driver/mongo"
)

// DefaultNamespaceColor is the fallback color applied when a create
// request omits one. Gray-ish; safe on g100 dark theme.
const DefaultNamespaceColor = "#6f6f6f"

// ErrNamespaceInUse is returned when a delete is blocked because one or
// more records still reference the namespace. The handler maps this to
// HTTP 409 and returns the usage counts in the response body.
var ErrNamespaceInUse = errors.New("namespace is in use")

// ErrDefaultNamespaceImmutable is returned when callers try to rename or
// delete the `default` namespace. Existence of `default` is an invariant
// the migration + startup seeding depend on; allowing mutation would
// break the uniqueness-constraint migration on next boot.
var ErrDefaultNamespaceImmutable = errors.New("the default namespace cannot be renamed or deleted")

// NamespaceCounter is the narrow dependency the namespace service needs
// to compute usage before a delete. Repos that own entities with a
// namespace field implement this. Using an interface lets us avoid
// importing the whole datasource/chart/dashboard repo types here.
type NamespaceCounter interface {
	CountByNamespace(ctx context.Context, namespace string) (int64, error)
}

// NamespaceRenamer is the narrow dependency used when a namespace is
// renamed. All three entity repos implement this so a rename cascades
// into their records in one pass per collection.
type NamespaceRenamer interface {
	RenameNamespace(ctx context.Context, oldName, newName string) (int64, error)
}

// NamespaceService handles namespace CRUD plus the cross-entity checks
// (delete-guard, rename-cascade) that pure repo code can't own.
type NamespaceService struct {
	repo           *repository.NamespaceRepository
	connections    namespaceEntity
	components     namespaceEntity
	dashboards     namespaceEntity
}

// namespaceEntity is the composite dependency shape: the service needs
// both counting (delete guard) and rename-cascade from each entity repo.
type namespaceEntity interface {
	NamespaceCounter
	NamespaceRenamer
}

// NewNamespaceService wires the repos. Entity params can be nil during
// early bootstrap (e.g., when the service is instantiated for the initial
// seed before other repos exist), though in production main.go always
// passes live repos.
func NewNamespaceService(
	repo *repository.NamespaceRepository,
	connections namespaceEntity,
	components namespaceEntity,
	dashboards namespaceEntity,
) *NamespaceService {
	return &NamespaceService{
		repo:        repo,
		connections: connections,
		components:  components,
		dashboards:  dashboards,
	}
}

// SeedDefault ensures the default namespace exists. Safe to call
// unconditionally on every startup — Upsert is idempotent.
func (s *NamespaceService) SeedDefault(ctx context.Context) error {
	return s.repo.Upsert(ctx, &models.Namespace{
		ID:          models.DefaultNamespace,
		Name:        models.DefaultNamespace,
		Description: "Default namespace — legacy records migrate here and new records land here unless an active namespace is selected.",
		Color:       DefaultNamespaceColor,
	})
}

// Create validates + persists a new namespace.
func (s *NamespaceService) Create(ctx context.Context, req *models.CreateNamespaceRequest) (*models.Namespace, error) {
	if err := models.ValidateNamespaceSlug(req.Name); err != nil {
		return nil, err
	}
	existing, err := s.repo.FindByName(ctx, req.Name)
	if err != nil {
		return nil, fmt.Errorf("checking name uniqueness: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("namespace '%s' already exists", req.Name)
	}
	color := req.Color
	if color == "" {
		color = DefaultNamespaceColor
	}
	ns := &models.Namespace{
		ID:          uuid.New().String(),
		Name:        req.Name,
		Description: req.Description,
		Color:       color,
	}
	if err := s.repo.Create(ctx, ns); err != nil {
		return nil, fmt.Errorf("creating namespace: %w", err)
	}
	return ns, nil
}

// GetByID returns a namespace by ID, or (nil, nil) if missing.
func (s *NamespaceService) GetByID(ctx context.Context, id string) (*models.Namespace, error) {
	return s.repo.FindByID(ctx, id)
}

// GetByName returns a namespace by slug name, or (nil, nil) if missing.
func (s *NamespaceService) GetByName(ctx context.Context, name string) (*models.Namespace, error) {
	return s.repo.FindByName(ctx, name)
}

// List returns all namespaces.
func (s *NamespaceService) List(ctx context.Context) (*models.NamespaceListResponse, error) {
	items, total, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	return &models.NamespaceListResponse{Namespaces: items, Total: total}, nil
}

// Update applies changes. Renaming cascades the new slug into every
// connection/component/dashboard tagged with the old slug — without that,
// references would go stale and the UI would render orphan chips.
func (s *NamespaceService) Update(ctx context.Context, id string, req *models.UpdateNamespaceRequest) (*models.Namespace, error) {
	current, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, mongo.ErrNoDocuments
	}

	if req.Name != nil && *req.Name != current.Name {
		if current.Name == models.DefaultNamespace {
			return nil, ErrDefaultNamespaceImmutable
		}
		if err := models.ValidateNamespaceSlug(*req.Name); err != nil {
			return nil, err
		}
		// Slug must still be globally unique after rename.
		collision, err := s.repo.FindByName(ctx, *req.Name)
		if err != nil {
			return nil, fmt.Errorf("checking rename uniqueness: %w", err)
		}
		if collision != nil && collision.ID != id {
			return nil, fmt.Errorf("namespace '%s' already exists", *req.Name)
		}
		// Cascade into referring records before the namespace row itself
		// changes. If the cascade fails, the namespace stays as-is — no
		// partial rename that would leave records pointing at a missing
		// slug. (Per-collection failures are best-effort; we accept that
		// total transactional consistency across collections needs
		// MongoDB sessions, which is future work.)
		oldName := current.Name
		newName := *req.Name
		if s.connections != nil {
			if _, err := s.connections.RenameNamespace(ctx, oldName, newName); err != nil {
				return nil, fmt.Errorf("renaming connections: %w", err)
			}
		}
		if s.components != nil {
			if _, err := s.components.RenameNamespace(ctx, oldName, newName); err != nil {
				return nil, fmt.Errorf("renaming components: %w", err)
			}
		}
		if s.dashboards != nil {
			if _, err := s.dashboards.RenameNamespace(ctx, oldName, newName); err != nil {
				return nil, fmt.Errorf("renaming dashboards: %w", err)
			}
		}
	}

	if err := s.repo.Update(ctx, id, req); err != nil {
		return nil, err
	}
	return s.repo.FindByID(ctx, id)
}

// Delete removes a namespace after verifying no records still reference
// it. Callers should map ErrNamespaceInUse to 409. The default namespace
// can never be deleted — it's an invariant of the migration.
func (s *NamespaceService) Delete(ctx context.Context, id string) (*models.NamespaceUsage, error) {
	ns, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if ns == nil {
		return nil, mongo.ErrNoDocuments
	}
	if ns.Name == models.DefaultNamespace {
		return nil, ErrDefaultNamespaceImmutable
	}

	usage, err := s.Usage(ctx, ns.Name)
	if err != nil {
		return nil, err
	}
	if usage.Connections > 0 || usage.Components > 0 || usage.Dashboards > 0 {
		return usage, ErrNamespaceInUse
	}

	if err := s.repo.Delete(ctx, id); err != nil {
		return nil, err
	}
	return nil, nil
}

// Usage returns per-entity-type counts for records in a namespace.
// Zero for any repo not yet wired (defensive — early bootstrap case).
func (s *NamespaceService) Usage(ctx context.Context, name string) (*models.NamespaceUsage, error) {
	usage := &models.NamespaceUsage{}
	if s.connections != nil {
		n, err := s.connections.CountByNamespace(ctx, name)
		if err != nil {
			return nil, fmt.Errorf("counting connections: %w", err)
		}
		usage.Connections = n
	}
	if s.components != nil {
		n, err := s.components.CountByNamespace(ctx, name)
		if err != nil {
			return nil, fmt.Errorf("counting components: %w", err)
		}
		usage.Components = n
	}
	if s.dashboards != nil {
		n, err := s.dashboards.CountByNamespace(ctx, name)
		if err != nil {
			return nil, fmt.Errorf("counting dashboards: %w", err)
		}
		usage.Dashboards = n
	}
	return usage, nil
}
