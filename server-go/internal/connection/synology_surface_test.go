// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// TestSynologyDeclaresCatalogSurface verifies the adapter's init() actually
// declared a usable catalog on the real global registry. Lives in this package
// so the adapter's init() is linked in — the assertion is meaningless from a
// package that never imports the adapter.
//
// Every preset needs a raw API name and a method: a preset missing either
// produces exactly the bare-dispatch failure (DSM error 120) that the query
// surface exists to prevent, which is the bug this whole feature fixes.
func TestSynologyDeclaresCatalogSurface(t *testing.T) {
	info, ok := registry.GetTypeInfo("api.synology")
	if !ok {
		t.Fatal("api.synology not registered")
	}
	if info.QuerySurface == nil {
		t.Fatal("api.synology declares no query surface — components cannot be built from scratch")
	}
	if info.QuerySurface.Kind != registry.QuerySurfaceCatalog {
		t.Errorf("kind = %q, want %q", info.QuerySurface.Kind, registry.QuerySurfaceCatalog)
	}
	if len(info.QuerySurface.Presets) != len(SynologyCatalog) {
		t.Errorf("surface has %d presets, catalog has %d — they must stay in lockstep",
			len(info.QuerySurface.Presets), len(SynologyCatalog))
	}
	for _, p := range info.QuerySurface.Presets {
		if p.Raw == "" {
			t.Errorf("preset %q has no raw API name", p.ID)
		}
		if m, _ := p.Params["method"].(string); m == "" {
			t.Errorf("preset %q has no method param — DSM answers error 120 without one", p.ID)
		}
		if _, ok := p.Params["version"]; !ok {
			t.Errorf("preset %q has no version param", p.ID)
		}
	}
}
