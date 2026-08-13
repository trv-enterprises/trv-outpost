// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// storeTestServer spins an httptest ts-store that answers the store listing,
// per-store stats, and data endpoints, capturing the last data-request URL.
// dataTypes maps store name → data_type served by /stats.
func storeTestServer(t *testing.T, dataTypes map[string]string) (*models.TSStoreConfig, *http.Client, *url.URL) {
	t.Helper()
	var lastDataURL url.URL
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		switch {
		case path == "/api/stores":
			if r.Header.Get("X-API-Key") == "" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"API key required"}`))
				return
			}
			entries := make([]string, 0, len(dataTypes))
			for name, dt := range dataTypes {
				entries = append(entries,
					`{"name":"`+name+`","data_type":"`+dt+`","role":"store","access":["read","write","manage"]}`)
			}
			_, _ = w.Write([]byte(`{"stores":[` + strings.Join(entries, ",") + `]}`))
		case strings.HasSuffix(path, "/stats"):
			parts := strings.Split(path, "/")
			store := parts[3]
			dt, ok := dataTypes[store]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write([]byte(`{"name":"` + store + `","data_type":"` + dt + `"}`))
		case strings.HasSuffix(path, "/schema"):
			_, _ = w.Write([]byte(`{"version":1,"fields":[{"index":1,"name":"temp","type":"float"}]}`))
		default: // data endpoints
			lastDataURL = *r.URL
			_, _ = w.Write([]byte(`{"objects":[{"timestamp":1700000000000000000,"data":{"temp":21.5}}],"count":1}`))
		}
	}))
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	cfg := &models.TSStoreConfig{
		Protocol: "http",
		Host:     u.Hostname(),
		Port:     port,
		APIKey:   "tsstore_testkey",
	}
	return cfg, srv.Client(), &lastDataURL
}

func TestResolveEffectiveStore(t *testing.T) {
	t.Run("pin wins over params.store", func(t *testing.T) {
		cfg := &models.TSStoreConfig{StoreName: "pinned"}
		got, err := resolveEffectiveStore(cfg, map[string]interface{}{"store": "other"})
		if err != nil || got != "pinned" {
			t.Fatalf("got (%q, %v), want (pinned, nil) — a pinned connection must not be overridable", got, err)
		}
	})
	t.Run("endpoint-scoped uses params.store", func(t *testing.T) {
		cfg := &models.TSStoreConfig{}
		got, err := resolveEffectiveStore(cfg, map[string]interface{}{"store": " home-env "})
		if err != nil || got != "home-env" {
			t.Fatalf("got (%q, %v), want (home-env, nil)", got, err)
		}
	})
	t.Run("endpoint-scoped with no store errors", func(t *testing.T) {
		cfg := &models.TSStoreConfig{}
		if _, err := resolveEffectiveStore(cfg, map[string]interface{}{}); err == nil {
			t.Fatal("want error when neither pin nor params.store is set")
		}
	})
}

// TestAdapterEndpointScopedStoreThreading locks the core #248 behavior on the
// registry adapter: the component's params.store lands in every data URL, and
// the store's own data type (schema → compact format) is resolved per store.
func TestAdapterEndpointScopedStoreThreading(t *testing.T) {
	cfg, client, lastDataURL := storeTestServer(t, map[string]string{
		"jsonstore":   "json",
		"schemastore": "schema",
	})
	a := &TSStoreAdapter{config: cfg, httpClient: client}

	rs, err := a.Query(context.Background(), registry.Query{Raw: "newest", Params: map[string]interface{}{
		"store": "jsonstore",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if lastDataURL.Path != "/api/stores/jsonstore/data/newest" {
		t.Fatalf("path = %q, want /api/stores/jsonstore/data/newest", lastDataURL.Path)
	}
	if lastDataURL.Query().Get("format") == "compact" {
		t.Error("json store must not request compact format")
	}
	if rs.Metadata["store_name"] != "jsonstore" {
		t.Errorf("metadata store_name = %v, want the EFFECTIVE store jsonstore", rs.Metadata["store_name"])
	}

	// Same adapter instance, different store: schema store must flip to
	// compact format via the per-store data-type lookup.
	if _, err := a.Query(context.Background(), registry.Query{Raw: "newest", Params: map[string]interface{}{
		"store": "schemastore",
	}}); err != nil {
		t.Fatal(err)
	}
	if lastDataURL.Path != "/api/stores/schemastore/data/newest" {
		t.Fatalf("path = %q, want /api/stores/schemastore/data/newest", lastDataURL.Path)
	}
	if lastDataURL.Query().Get("format") != "compact" {
		t.Error("schema store must request compact format (per-store data_type resolution)")
	}

	// No store at all → clear error, no request.
	if _, err := a.Query(context.Background(), registry.Query{Raw: "newest"}); err == nil {
		t.Fatal("endpoint-scoped query with no store must error")
	}
}

// TestAdapterPinnedIgnoresStoreParam: a stray params.store on a pinned
// connection is ignored (pin wins) — same-type swaps onto a pinned
// connection stay coherent instead of erroring or rerouting.
func TestAdapterPinnedIgnoresStoreParam(t *testing.T) {
	cfg, client, lastDataURL := storeTestServer(t, map[string]string{"pinned": "json"})
	cfg.StoreName = "pinned"
	a := &TSStoreAdapter{config: cfg, httpClient: client, store: cfg.StoreName}

	if _, err := a.Query(context.Background(), registry.Query{Raw: "newest", Params: map[string]interface{}{
		"store": "other",
	}}); err != nil {
		t.Fatal(err)
	}
	if lastDataURL.Path != "/api/stores/pinned/data/newest" {
		t.Fatalf("path = %q, want the PINNED store, not params.store", lastDataURL.Path)
	}
}

// TestLegacyDataSourceStoreThreading: the legacy TSStoreDataSource (the live
// factory path for stored connections) gets identical store semantics.
func TestLegacyDataSourceStoreThreading(t *testing.T) {
	cfg, client, lastDataURL := storeTestServer(t, map[string]string{
		"jsonstore": "json",
		"pinned":    "json",
	})

	t.Run("endpoint-scoped range hits params.store", func(t *testing.T) {
		ds := &TSStoreDataSource{config: cfg, httpClient: client}
		_, err := ds.Query(context.Background(), models.Query{Raw: "range:1700000000:1700003600", Params: map[string]interface{}{
			"store": "jsonstore",
		}})
		if err != nil {
			t.Fatal(err)
		}
		if lastDataURL.Path != "/api/stores/jsonstore/data/range" {
			t.Fatalf("path = %q, want /api/stores/jsonstore/data/range", lastDataURL.Path)
		}
	})

	t.Run("pin wins", func(t *testing.T) {
		pinnedCfg := *cfg
		pinnedCfg.StoreName = "pinned"
		ds := &TSStoreDataSource{config: &pinnedCfg, httpClient: client, store: "pinned"}
		if _, err := ds.Query(context.Background(), models.Query{Raw: "oldest", Params: map[string]interface{}{
			"store": "other",
		}}); err != nil {
			t.Fatal(err)
		}
		if lastDataURL.Path != "/api/stores/pinned/data/oldest" {
			t.Fatalf("path = %q, want the PINNED store", lastDataURL.Path)
		}
	})

	t.Run("no store errors", func(t *testing.T) {
		ds := &TSStoreDataSource{config: cfg, httpClient: client}
		if _, err := ds.Query(context.Background(), models.Query{Raw: "newest"}); err == nil {
			t.Fatal("endpoint-scoped query with no store must error")
		}
	})
}

func TestListStores(t *testing.T) {
	cfg, client, _ := storeTestServer(t, map[string]string{"home-env": "json"})

	ds := &TSStoreDataSource{config: cfg, httpClient: client}
	stores, err := ds.ListStores(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(stores) != 1 || stores[0].Name != "home-env" {
		t.Fatalf("stores = %+v, want one entry home-env", stores)
	}
	if len(stores[0].Access) != 3 {
		t.Errorf("access = %v, want the caller's access classes carried through", stores[0].Access)
	}

	t.Run("missing key is a clear auth error", func(t *testing.T) {
		noKey := *cfg
		noKey.APIKey = ""
		ds := &TSStoreDataSource{config: &noKey, httpClient: client}
		if _, err := ds.ListStores(context.Background()); err == nil {
			t.Fatal("keyless listing must error (endpoint is authenticated)")
		}
	})
}

// TestEndpointScopedTestConnection: no pin → one keyed store listing is the
// whole test; an empty listing (key with no grants) is a failure.
func TestEndpointScopedTestConnection(t *testing.T) {
	t.Run("stores visible → ok", func(t *testing.T) {
		cfg, client, _ := storeTestServer(t, map[string]string{"home-env": "json"})
		a := &TSStoreAdapter{config: cfg, httpClient: client}
		if err := a.TestConnection(context.Background()); err != nil {
			t.Fatal(err)
		}
		ds := &TSStoreDataSource{config: cfg, httpClient: client}
		if err := ds.TestConnection(context.Background()); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("empty listing → failure", func(t *testing.T) {
		cfg, client, _ := storeTestServer(t, map[string]string{})
		a := &TSStoreAdapter{config: cfg, httpClient: client}
		if err := a.TestConnection(context.Background()); err == nil {
			t.Fatal("a key with no grants must fail the endpoint-scoped test")
		}
	})
}

// TestQuerySurfaceStoreListDeclared: the tsstore type advertises the
// store_list surface so the editor knows to render a store picker.
func TestQuerySurfaceStoreListDeclared(t *testing.T) {
	info, ok := registry.GetTypeInfo("store.tsstore")
	if !ok {
		t.Fatal("store.tsstore not registered")
	}
	if info.QuerySurface == nil || info.QuerySurface.Kind != registry.QuerySurfaceStoreList {
		t.Fatalf("query surface = %+v, want kind store_list", info.QuerySurface)
	}
}
