// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// ConnectionFactory converts a stored Connection into a live adapter. It is
// stateless: the generic register/pool/cache API it once carried was never
// adopted, so the live path uses only CreateFromConfig / CreateAdapterFromConfig.
type ConnectionFactory struct{}

// NewConnectionFactory creates a new connection factory.
func NewConnectionFactory() *ConnectionFactory {
	return &ConnectionFactory{}
}

// CreateFromConfig creates a datasource from configuration
// Uses the registry for new TypeID-based datasources, falls back to legacy switch for old Type-based
func (f *ConnectionFactory) CreateFromConfig(ds *models.Connection) (models.ConnectionAdapter, error) {
	// NEW: Use registry if TypeID is set
	if ds.TypeID != "" {
		adapter, err := registry.CreateAdapter(ds.TypeID, ds.GetEffectiveConfig())
		if err != nil {
			return nil, err
		}
		// Wrap registry.Adapter in a models.ConnectionAdapter compatible wrapper
		return &RegistryAdapterWrapper{adapter: adapter}, nil
	}

	// LEGACY: Fall back to old switch statement for backwards compatibility
	switch ds.Type {
	case models.ConnectionTypeSQL:
		if ds.Config.SQL == nil {
			return nil, fmt.Errorf("SQL configuration is required")
		}
		return NewSQLDataSource(ds.Config.SQL)

	case models.ConnectionTypeCSV:
		if ds.Config.CSV == nil {
			return nil, fmt.Errorf("CSV configuration is required")
		}
		return NewCSVDataSource(ds.Config.CSV)

	case models.ConnectionTypeSocket:
		if ds.Config.Socket == nil {
			return nil, fmt.Errorf("Socket configuration is required")
		}
		return NewSocketDataSource(ds.Config.Socket)

	case models.ConnectionTypeAPI:
		if ds.Config.API == nil {
			return nil, fmt.Errorf("API configuration is required")
		}
		return NewAPIDataSource(ds.Config.API)

	case models.ConnectionTypeTSStore:
		if ds.Config.TSStore == nil {
			return nil, fmt.Errorf("TSStore configuration is required")
		}
		return NewTSStoreDataSource(ds.Config.TSStore)

	case models.ConnectionTypePrometheus:
		if ds.Config.Prometheus == nil {
			return nil, fmt.Errorf("Prometheus configuration is required")
		}
		return NewPrometheusDataSource(ds.Config.Prometheus)

	case models.ConnectionTypeEdgeLake:
		if ds.Config.EdgeLake == nil {
			return nil, fmt.Errorf("EdgeLake configuration is required")
		}
		return NewEdgeLakeDataSource(ds.Config.EdgeLake)

	case models.ConnectionTypeMQTT:
		if ds.Config.MQTT == nil {
			return nil, fmt.Errorf("MQTT configuration is required")
		}
		// MQTT uses the registry adapter
		adapter, err := registry.CreateAdapter("stream.mqtt", ds.GetEffectiveConfig())
		if err != nil {
			return nil, err
		}
		return &RegistryAdapterWrapper{adapter: adapter}, nil

	default:
		return nil, fmt.Errorf("unsupported datasource type: %s", ds.Type)
	}
}

// CreateAdapterFromConfig creates a registry.Adapter from datasource configuration
// This is the preferred method for new code using the registry system
func (f *ConnectionFactory) CreateAdapterFromConfig(ds *models.Connection) (registry.Adapter, error) {
	typeID := ds.GetEffectiveTypeID()
	if typeID == "" {
		return nil, fmt.Errorf("unable to determine type ID for datasource")
	}

	return registry.CreateAdapter(typeID, ds.GetEffectiveConfig())
}

// ============================================================================
// RegistryAdapterWrapper wraps registry.Adapter to implement models.ConnectionAdapter
// This allows registry adapters to work with the legacy ConnectionFactory
// ============================================================================

// RegistryAdapterWrapper wraps a registry.Adapter to implement models.ConnectionAdapter
type RegistryAdapterWrapper struct {
	adapter registry.Adapter
}

// Query converts registry types and calls the adapter
func (w *RegistryAdapterWrapper) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	regQuery := registry.Query{
		Raw:    query.Raw,
		Params: query.Params,
	}

	result, err := w.adapter.Query(ctx, regQuery)
	if err != nil {
		return nil, err
	}

	return &models.ResultSet{
		Columns:  result.Columns,
		Rows:     result.Rows,
		Metadata: result.Metadata,
	}, nil
}

// Stream converts registry types and calls the adapter
func (w *RegistryAdapterWrapper) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	regQuery := registry.Query{
		Raw:    query.Raw,
		Params: query.Params,
	}

	regChan, err := w.adapter.Stream(ctx, regQuery)
	if err != nil {
		return nil, err
	}

	// Convert registry.Record channel to models.Record channel
	modelsChan := make(chan models.Record, 100)
	go func() {
		defer close(modelsChan)
		for record := range regChan {
			modelsChan <- models.Record(record)
		}
	}()

	return modelsChan, nil
}

// Close closes the adapter
func (w *RegistryAdapterWrapper) Close() error {
	return w.adapter.Close()
}

// GetAdapter returns the underlying registry.Adapter
func (w *RegistryAdapterWrapper) GetAdapter() registry.Adapter {
	return w.adapter
}
