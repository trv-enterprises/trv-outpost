// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import "testing"

func noopFactory(map[string]interface{}) (Adapter, error) { return nil, nil }

// TestRegisterQuerySurfaceAttachesToTypeInfo covers the ordinary case: an
// adapter declares its surface after registering, and the surface shows up on
// the TypeInfo the API serves.
func TestRegisterQuerySurfaceAttachesToTypeInfo(t *testing.T) {
	r := &Registry{
		factories:     make(map[string]AdapterFactory),
		metadata:      make(map[string]TypeInfo),
		querySurfaces: make(map[string]QuerySurface),
	}

	r.register("test.after", "After", Capabilities{CanRead: true}, nil, noopFactory)
	r.registerQuerySurface("test.after", QuerySurface{
		Kind:    QuerySurfaceCatalog,
		Label:   "Thing",
		Presets: []QueryPreset{{ID: "a", Label: "A", Raw: "RAW", Params: map[string]interface{}{"method": "get"}}},
	})

	info, ok := r.metadata["test.after"]
	if !ok {
		t.Fatal("type not registered")
	}
	if info.QuerySurface == nil {
		t.Fatal("query surface not attached to TypeInfo")
	}
	if info.QuerySurface.Kind != QuerySurfaceCatalog {
		t.Errorf("kind = %q, want %q", info.QuerySurface.Kind, QuerySurfaceCatalog)
	}
	if len(info.QuerySurface.Presets) != 1 || info.QuerySurface.Presets[0].Raw != "RAW" {
		t.Errorf("presets not carried through: %+v", info.QuerySurface.Presets)
	}
}

// TestRegisterQuerySurfaceBeforeRegister is the ordering guard. init() order
// across files is unspecified, so a surface declared before its Register must
// still land — otherwise the picker silently disappears depending on link
// order, which is the worst kind of intermittent.
func TestRegisterQuerySurfaceBeforeRegister(t *testing.T) {
	r := &Registry{
		factories:     make(map[string]AdapterFactory),
		metadata:      make(map[string]TypeInfo),
		querySurfaces: make(map[string]QuerySurface),
	}

	r.registerQuerySurface("test.before", QuerySurface{Kind: QuerySurfaceCatalog, Label: "Early"})
	r.register("test.before", "Before", Capabilities{CanRead: true}, nil, noopFactory)

	info := r.metadata["test.before"]
	if info.QuerySurface == nil {
		t.Fatal("surface declared before Register was dropped")
	}
	if info.QuerySurface.Label != "Early" {
		t.Errorf("label = %q, want %q", info.QuerySurface.Label, "Early")
	}
}

// TestTypesWithoutSurfaceStayNil — every pre-existing adapter declares no
// surface and must keep serving a nil field, so clients fall back to the raw
// query box exactly as they did before this field existed.
func TestTypesWithoutSurfaceStayNil(t *testing.T) {
	r := &Registry{
		factories:     make(map[string]AdapterFactory),
		metadata:      make(map[string]TypeInfo),
		querySurfaces: make(map[string]QuerySurface),
	}

	r.register("test.plain", "Plain", Capabilities{CanRead: true}, nil, noopFactory)

	if info := r.metadata["test.plain"]; info.QuerySurface != nil {
		t.Errorf("type with no declared surface got %+v, want nil", info.QuerySurface)
	}
}
