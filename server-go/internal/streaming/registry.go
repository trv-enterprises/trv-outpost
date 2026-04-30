// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"log"
	"sync"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// AggregatorRegistry manages shared bucket aggregators
// Multiple subscribers with the same config share one aggregator
type AggregatorRegistry struct {
	aggregators map[string]*BucketAggregator // configKey -> aggregator
	mu          sync.RWMutex
}

// Global registry instance
var registry *AggregatorRegistry
var registryOnce sync.Once

// GetRegistry returns the singleton registry instance
func GetRegistry() *AggregatorRegistry {
	registryOnce.Do(func() {
		registry = &AggregatorRegistry{
			aggregators: make(map[string]*BucketAggregator),
		}
	})
	return registry
}

// Subscribe returns a channel for receiving aggregated records
// If an aggregator for this config already exists, it reuses it
// Otherwise, it creates a new one
func (r *AggregatorRegistry) Subscribe(config BucketConfig) (chan models.Record, string) {
	configKey := config.ConfigKey()

	r.mu.Lock()
	defer r.mu.Unlock()

	// Check if aggregator already exists
	agg, exists := r.aggregators[configKey]
	if exists {
		log.Printf("[AggregatorRegistry] Reusing existing aggregator %s (subscribers: %d -> %d)",
			configKey[:8], agg.SubscriberCount(), agg.SubscriberCount()+1)
		ch := agg.Subscribe()
		return ch, configKey
	}

	// Create new aggregator
	agg = NewBucketAggregator(config)
	r.aggregators[configKey] = agg
	agg.Start()

	log.Printf("[AggregatorRegistry] Created new aggregator %s for datasource %s (interval: %ds, func: %s)",
		configKey[:8], config.ConnectionID, config.Interval, config.Function)

	ch := agg.Subscribe()
	return ch, configKey
}

// Unsubscribe removes a subscriber from an aggregator
// If the aggregator has no more subscribers, it is stopped and removed
func (r *AggregatorRegistry) Unsubscribe(configKey string, ch chan models.Record) {
	r.mu.Lock()
	defer r.mu.Unlock()

	agg, exists := r.aggregators[configKey]
	if !exists {
		return
	}

	agg.Unsubscribe(ch)

	// Clean up aggregator if no subscribers remain
	if agg.SubscriberCount() == 0 {
		log.Printf("[AggregatorRegistry] Stopping aggregator %s (no subscribers)", configKey[:8])
		agg.Stop()
		delete(r.aggregators, configKey)
	}
}

// FeedRecord sends a record to all aggregators for a given datasource
// This is called by the StreamHandler when new data arrives
func (r *AggregatorRegistry) FeedRecord(connectionID string, record models.Record) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, agg := range r.aggregators {
		if agg.config.ConnectionID == connectionID {
			agg.ProcessRecord(record)
		}
	}
}

// GetAggregator returns an aggregator by config key (for testing/debugging)
func (r *AggregatorRegistry) GetAggregator(configKey string) *BucketAggregator {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.aggregators[configKey]
}

// GetAggregatorCount returns the number of active aggregators
func (r *AggregatorRegistry) GetAggregatorCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.aggregators)
}

// GetAggregatorsForDatasource returns all aggregators for a given datasource
func (r *AggregatorRegistry) GetAggregatorsForDatasource(connectionID string) []*BucketAggregator {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var result []*BucketAggregator
	for _, agg := range r.aggregators {
		if agg.config.ConnectionID == connectionID {
			result = append(result, agg)
		}
	}
	return result
}

// Stats returns statistics about the registry
func (r *AggregatorRegistry) Stats() map[string]interface{} {
	r.mu.RLock()
	defer r.mu.RUnlock()

	stats := map[string]interface{}{
		"aggregator_count": len(r.aggregators),
		"aggregators":      []map[string]interface{}{},
	}

	aggStats := []map[string]interface{}{}
	for key, agg := range r.aggregators {
		aggStats = append(aggStats, map[string]interface{}{
			"config_key":       key[:8],
			"connection_id":    agg.config.ConnectionID,
			"interval":         agg.config.Interval,
			"function":         agg.config.Function,
			"value_cols":       agg.config.ValueCols,
			"subscriber_count": agg.SubscriberCount(),
		})
	}
	stats["aggregators"] = aggStats

	return stats
}

// Shutdown stops all aggregators and clears the registry
func (r *AggregatorRegistry) Shutdown() {
	r.mu.Lock()
	defer r.mu.Unlock()

	log.Printf("[AggregatorRegistry] Shutting down %d aggregators", len(r.aggregators))

	for key, agg := range r.aggregators {
		agg.Stop()
		delete(r.aggregators, key)
	}
}
