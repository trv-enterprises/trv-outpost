// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package middleware

import (
	"context"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/authz"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

type stubUsers struct {
	users map[string]*models.User
}

func (s *stubUsers) GetUserByGUID(ctx context.Context, guid string) (*models.User, error) {
	u, ok := s.users[guid]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return u, nil
}

// TestStampGrants asserts the issue-#4 invariant: every authenticated
// request gets namespace grants stamped onto its REQUEST context, for
// both the JWT-shim and full-record identity shapes. The authz
// package's fail-open rule for unstamped contexts is only safe because
// of this.
func TestStampGrants(t *testing.T) {
	gin.SetMode(gin.TestMode)

	restricted := &models.User{
		GUID:                 "r1",
		Active:               true,
		NamespacesRestricted: true,
		AllowedNamespaces:    []string{"home"},
		Created:              time.Now(),
	}
	m := &AuthMiddleware{
		grants: authz.NewResolver(&stubUsers{users: map[string]*models.User{"r1": restricted}}),
		rules:  buildRouteRules(),
	}

	t.Run("JWT shim resolves through the user source", func(t *testing.T) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/api/dashboards", nil)
		// The claims shim has no Created timestamp → resolver loads by GUID.
		shim := &models.User{GUID: "r1", Active: true}
		if ok := m.stampGrants(c, shim); !ok {
			t.Fatal("stampGrants aborted unexpectedly")
		}
		if authz.Allowed(c.Request.Context(), "prod") {
			t.Fatal("restricted user allowed into ungranted namespace")
		}
		if !authz.Allowed(c.Request.Context(), "home") {
			t.Fatal("restricted user denied their granted namespace")
		}
	})

	t.Run("full record (API-key path) uses its own grants", func(t *testing.T) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/api/dashboards", nil)
		if ok := m.stampGrants(c, restricted); !ok {
			t.Fatal("stampGrants aborted unexpectedly")
		}
		if authz.Allowed(c.Request.Context(), "prod") {
			t.Fatal("restricted API-key user allowed into ungranted namespace")
		}
	})

	t.Run("resolver failure aborts, never fails open", func(t *testing.T) {
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest("GET", "/api/dashboards", nil)
		unknown := &models.User{GUID: "missing", Active: true}
		if ok := m.stampGrants(c, unknown); ok {
			t.Fatal("stampGrants must abort when the resolver can't answer")
		}
		if rec.Code != 503 {
			t.Fatalf("expected 503, got %d", rec.Code)
		}
	})

	t.Run("nil resolver is unrestricted (test wiring)", func(t *testing.T) {
		bare := &AuthMiddleware{rules: buildRouteRules()}
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/api/dashboards", nil)
		if ok := bare.stampGrants(c, restricted); !ok {
			t.Fatal("nil resolver must pass through")
		}
		if !authz.Allowed(c.Request.Context(), "anything") {
			t.Fatal("nil resolver must behave unrestricted")
		}
	})
}
