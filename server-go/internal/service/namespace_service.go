// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/authz"
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

// NamespaceGrantHolder is the user-side dependency for namespace
// lifecycle (#4). A rename must rewrite the slug inside every
// restricted user's allowed_namespaces (otherwise the rename silently
// revokes their access), a delete must pull it, and the detail page
// needs the reverse lookup. Satisfied by *repository.UserRepository.
type NamespaceGrantHolder interface {
	NamespaceRenamer
	FindByAllowedNamespace(ctx context.Context, namespace string) ([]models.User, error)
	PullNamespaceGrant(ctx context.Context, namespace string) (int64, error)
}

// NamespaceService handles namespace CRUD plus the cross-entity checks
// (delete-guard, rename-cascade) that pure repo code can't own.
type NamespaceService struct {
	repo        *repository.NamespaceRepository
	connections namespaceEntity
	components  namespaceEntity
	dashboards  namespaceEntity
	// users + grantsFlusher are the #4 grant-side dependencies, wired
	// after construction (SetGrantDependencies) to keep the existing
	// constructor signature and its early-bootstrap callers intact.
	users         NamespaceGrantHolder
	grantsFlusher GrantsFlusher
}

// GrantsFlusher drops the whole namespace-grants cache. A rename or
// delete invalidates cached Allowed sets for potentially every user,
// so it's a flush rather than a per-user invalidate.
type GrantsFlusher interface {
	Flush()
}

// SetGrantDependencies wires the #4 user-grant cascade + reverse
// lookup. Both are optional (nil = skip), which keeps tests and
// early-bootstrap wiring working.
func (s *NamespaceService) SetGrantDependencies(users NamespaceGrantHolder, flusher GrantsFlusher) {
	s.users = users
	s.grantsFlusher = flusher
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

// List returns the namespaces visible to the caller. Restricted
// callers (issue #4) see only their granted namespaces — this single
// filter keeps every picker/filter in the SPA granted-only, since they
// all read from GET /api/namespaces via NamespaceContext. Admin
// surfaces that need the full catalog use ListAll (?scope=all,
// manage-gated at the handler).
func (s *NamespaceService) List(ctx context.Context) (*models.NamespaceListResponse, error) {
	items, total, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	if allowed, restricted := authz.AllowedList(ctx); restricted {
		allowedSet := make(map[string]struct{}, len(allowed))
		for _, ns := range allowed {
			allowedSet[ns] = struct{}{}
		}
		granted := make([]models.Namespace, 0, len(items))
		for _, item := range items {
			if _, ok := allowedSet[item.Name]; ok {
				granted = append(granted, item)
			}
		}
		items = granted
		total = int64(len(granted))
	}
	return &models.NamespaceListResponse{Namespaces: items, Total: total}, nil
}

// ListAll returns every namespace regardless of the caller's grants.
// ADMIN-plane surfaces only (grant assignment, namespace management).
func (s *NamespaceService) ListAll(ctx context.Context) (*models.NamespaceListResponse, error) {
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
		// Users are the FOURTH cascade target (#4): a restricted user's
		// allowed_namespaces holds the slug too. Skipping this would
		// silently revoke every grant on the renamed namespace.
		if s.users != nil {
			if _, err := s.users.RenameNamespace(ctx, oldName, newName); err != nil {
				return nil, fmt.Errorf("renaming user namespace grants: %w", err)
			}
		}
		// Cached Allowed sets still hold the old slug — flush (a rename
		// can touch any user, so per-user invalidation isn't enough).
		if s.grantsFlusher != nil {
			s.grantsFlusher.Flush()
		}
	}

	if err := s.repo.Update(ctx, id, req); err != nil {
		return nil, err
	}
	return s.repo.FindByID(ctx, id)
}

// UsersWithAccess returns every user who can see this namespace (#4):
// those with an explicit grant AND those who are unrestricted (implicit
// access to everything). The caller distinguishes them by each user's
// NamespacesRestricted flag — only the explicitly-granted are revocable
// from the namespace page; narrowing an unrestricted user is a per-user
// decision (see FindByAllowedNamespace). Returns an empty slice when
// the user dependency isn't wired.
func (s *NamespaceService) UsersWithAccess(ctx context.Context, id string) ([]models.User, error) {
	ns, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if ns == nil {
		return nil, mongo.ErrNoDocuments
	}
	if s.users == nil {
		return []models.User{}, nil
	}
	return s.users.FindByAllowedNamespace(ctx, ns.Name)
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

	// Pull the now-dead slug from every user's grants (#4) so nobody
	// carries a dangling grant, then flush cached Allowed sets. The
	// namespace row is already gone, so a failure here is logged-and-
	// tolerated rather than fatal: a stale grant on a nonexistent
	// namespace grants access to nothing.
	if s.users != nil {
		if _, err := s.users.PullNamespaceGrant(ctx, ns.Name); err != nil {
			log.Printf("warning: failed to pull namespace grant %q from users: %v", ns.Name, err)
		}
	}
	if s.grantsFlusher != nil {
		s.grantsFlusher.Flush()
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
