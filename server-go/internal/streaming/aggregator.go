// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// BucketConfig defines the configuration for time-bucketed aggregation
type BucketConfig struct {
	ConnectionID string   // Source datasource
	Interval     int      // Bucket interval in seconds
	Function     string   // Aggregation function: avg, min, max, sum, count
	ValueCols    []string // Columns to aggregate
	TimestampCol string   // Timestamp column for bucket alignment
	SeriesCol    string   // Column that identifies series (e.g., "location") - maintains separate buckets per series value
}

// ConfigKey generates a unique key for this bucket configuration
func (c BucketConfig) ConfigKey() string {
	// Sort value columns for consistent hashing
	cols := make([]string, len(c.ValueCols))
	copy(cols, c.ValueCols)
	sort.Strings(cols)

	// Create a deterministic string (include SeriesCol)
	data := fmt.Sprintf("%s|%d|%s|%s|%s|%v", c.ConnectionID, c.Interval, c.Function, c.TimestampCol, c.SeriesCol, cols)

	// Hash it for a shorter key
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:8]) // First 8 bytes = 16 hex chars
}

// bucketKey represents a composite key of timestamp and series value
type bucketKey struct {
	timestamp   int64
	seriesValue string
}

// BucketAggregator aggregates streaming data into time buckets
type BucketAggregator struct {
	config      BucketConfig
	configKey   string
	subscribers map[chan models.Record]struct{}
	subMu       sync.RWMutex
	buckets     map[bucketKey]*bucketState // (timestamp, seriesValue) -> state
	bucketMu    sync.Mutex
	inputCh     chan models.Record
	stopCh      chan struct{}
	stopped     bool
	stopMu      sync.Mutex
}

// bucketState holds the state for a single time bucket (per series)
type bucketState struct {
	timestamp   time.Time
	seriesValue string                     // Value of the series column (e.g., "Los Angeles")
	values      map[string]*aggregateValue // column -> aggregate state
}

// aggregateValue holds the running aggregate for a single column
type aggregateValue struct {
	sum   float64
	count int
	min   float64
	max   float64
}

// NewBucketAggregator creates a new bucket aggregator
func NewBucketAggregator(config BucketConfig) *BucketAggregator {
	return &BucketAggregator{
		config:      config,
		configKey:   config.ConfigKey(),
		subscribers: make(map[chan models.Record]struct{}),
		buckets:     make(map[bucketKey]*bucketState),
		inputCh:     make(chan models.Record, 100),
		stopCh:      make(chan struct{}),
	}
}

// Start begins processing incoming records
func (ba *BucketAggregator) Start() {
	go ba.processLoop()
	go ba.emitLoop()
}

// Stop stops the aggregator
func (ba *BucketAggregator) Stop() {
	ba.stopMu.Lock()
	defer ba.stopMu.Unlock()

	if ba.stopped {
		return
	}
	ba.stopped = true
	close(ba.stopCh)

	// Close all subscriber channels
	ba.subMu.Lock()
	for ch := range ba.subscribers {
		close(ch)
		delete(ba.subscribers, ch)
	}
	ba.subMu.Unlock()
}

// Subscribe adds a subscriber and returns a channel for receiving aggregated records
func (ba *BucketAggregator) Subscribe() chan models.Record {
	// Buffer size 100 to match raw stream subscriber buffers
	// Prevents silent drops when frontend processing is slow
	ch := make(chan models.Record, 100)

	ba.subMu.Lock()
	ba.subscribers[ch] = struct{}{}
	ba.subMu.Unlock()

	log.Printf("[BucketAggregator:%s] New subscriber (total: %d)", ba.configKey[:8], ba.SubscriberCount())
	return ch
}

// Unsubscribe removes a subscriber
func (ba *BucketAggregator) Unsubscribe(ch chan models.Record) {
	ba.subMu.Lock()
	if _, exists := ba.subscribers[ch]; exists {
		close(ch)
		delete(ba.subscribers, ch)
	}
	ba.subMu.Unlock()

	log.Printf("[BucketAggregator:%s] Subscriber removed (remaining: %d)", ba.configKey[:8], ba.SubscriberCount())
}

// SubscriberCount returns the number of active subscribers
func (ba *BucketAggregator) SubscriberCount() int {
	ba.subMu.RLock()
	defer ba.subMu.RUnlock()
	return len(ba.subscribers)
}

// ProcessRecord adds a record to be aggregated
func (ba *BucketAggregator) ProcessRecord(record models.Record) {
	select {
	case ba.inputCh <- record:
	default:
		log.Printf("[BucketAggregator:%s] Input channel full, dropping record", ba.configKey[:8])
	}
}

// processLoop handles incoming records
func (ba *BucketAggregator) processLoop() {
	for {
		select {
		case <-ba.stopCh:
			return
		case record := <-ba.inputCh:
			ba.addToBucket(record)
		}
	}
}

// emitLoop periodically emits completed buckets
func (ba *BucketAggregator) emitLoop() {
	// Emit on interval boundaries (e.g., every minute at :00)
	interval := time.Duration(ba.config.Interval) * time.Second

	// Calculate next emit time (aligned to interval)
	now := time.Now()
	nextEmit := now.Truncate(interval).Add(interval)
	timer := time.NewTimer(time.Until(nextEmit))

	for {
		select {
		case <-ba.stopCh:
			timer.Stop()
			return
		case <-timer.C:
			ba.emitCompletedBuckets()
			// Schedule next emit
			nextEmit = nextEmit.Add(interval)
			timer.Reset(time.Until(nextEmit))
		}
	}
}

// addToBucket adds a record to the appropriate bucket
func (ba *BucketAggregator) addToBucket(record models.Record) {
	// Get timestamp from record
	ts := ba.extractTimestamp(record)
	if ts.IsZero() {
		ts = time.Now() // Use current time if no timestamp column
	}

	// Extract series value (e.g., location name)
	seriesValue := ba.extractSeriesValue(record)

	// Align to bucket boundary
	interval := time.Duration(ba.config.Interval) * time.Second
	bucketTime := ts.Truncate(interval)

	// Create composite bucket key (timestamp + series value)
	bKey := bucketKey{
		timestamp:   bucketTime.Unix(),
		seriesValue: seriesValue,
	}

	ba.bucketMu.Lock()
	defer ba.bucketMu.Unlock()

	// Get or create bucket
	bucket, exists := ba.buckets[bKey]
	if !exists {
		bucket = &bucketState{
			timestamp:   bucketTime,
			seriesValue: seriesValue,
			values:      make(map[string]*aggregateValue),
		}
		ba.buckets[bKey] = bucket
	}

	// Add values to bucket for each configured column
	for _, col := range ba.config.ValueCols {
		rawVal, ok := record[col]
		if !ok {
			continue
		}

		val := toFloat64(rawVal)

		agg, exists := bucket.values[col]
		if !exists {
			agg = &aggregateValue{
				min: val,
				max: val,
			}
			bucket.values[col] = agg
		}

		agg.sum += val
		agg.count++
		if val < agg.min {
			agg.min = val
		}
		if val > agg.max {
			agg.max = val
		}
	}
}

// extractSeriesValue extracts the series column value from a record
func (ba *BucketAggregator) extractSeriesValue(record models.Record) string {
	if ba.config.SeriesCol == "" {
		return "" // No series partitioning - all records go to same bucket
	}

	val, ok := record[ba.config.SeriesCol]
	if !ok {
		return ""
	}

	// Convert to string
	switch v := val.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	default:
		return fmt.Sprintf("%v", v)
	}
}

// extractTimestamp extracts the timestamp from a record
func (ba *BucketAggregator) extractTimestamp(record models.Record) time.Time {
	if ba.config.TimestampCol == "" {
		return time.Time{}
	}

	val, ok := record[ba.config.TimestampCol]
	if !ok {
		return time.Time{}
	}

	return parseTimestamp(val)
}

// emitCompletedBuckets emits buckets that are complete (older than current interval)
func (ba *BucketAggregator) emitCompletedBuckets() {
	interval := time.Duration(ba.config.Interval) * time.Second
	cutoff := time.Now().Truncate(interval).Unix() // Don't emit current bucket

	ba.bucketMu.Lock()
	bucketsToEmit := make([]*bucketState, 0)
	keysToDelete := make([]bucketKey, 0)

	for key, bucket := range ba.buckets {
		if key.timestamp < cutoff {
			bucketsToEmit = append(bucketsToEmit, bucket)
			keysToDelete = append(keysToDelete, key)
		}
	}

	// Delete emitted buckets
	for _, key := range keysToDelete {
		delete(ba.buckets, key)
	}
	ba.bucketMu.Unlock()

	// Sort buckets by timestamp, then by series value for deterministic order
	sort.Slice(bucketsToEmit, func(i, j int) bool {
		if bucketsToEmit[i].timestamp.Equal(bucketsToEmit[j].timestamp) {
			return bucketsToEmit[i].seriesValue < bucketsToEmit[j].seriesValue
		}
		return bucketsToEmit[i].timestamp.Before(bucketsToEmit[j].timestamp)
	})

	// Emit to subscribers
	for _, bucket := range bucketsToEmit {
		record := ba.bucketToRecord(bucket)
		ba.broadcast(record)
	}
}

// bucketToRecord converts a bucket to a models.Record (map)
func (ba *BucketAggregator) bucketToRecord(bucket *bucketState) models.Record {
	record := make(models.Record)

	// Add timestamp
	record[ba.config.TimestampCol] = bucket.timestamp.Unix()
	record["_bucket_timestamp"] = bucket.timestamp.Format(time.RFC3339)
	record["_bucket_interval"] = ba.config.Interval
	record["_bucket_function"] = ba.config.Function

	// Add series column value (e.g., location name) so chart can group by it
	if ba.config.SeriesCol != "" {
		record[ba.config.SeriesCol] = bucket.seriesValue
	}

	// Add aggregated values for each column
	for _, col := range ba.config.ValueCols {
		agg, exists := bucket.values[col]
		if !exists {
			record[col] = nil
			continue
		}

		var val float64
		switch ba.config.Function {
		case "avg":
			if agg.count > 0 {
				val = agg.sum / float64(agg.count)
			}
		case "sum":
			val = agg.sum
		case "min":
			val = agg.min
		case "max":
			val = agg.max
		case "count":
			val = float64(agg.count)
		default:
			if agg.count > 0 {
				val = agg.sum / float64(agg.count) // Default to avg
			}
		}

		record[col] = val
	}

	return record
}

// broadcast sends a record to all subscribers
func (ba *BucketAggregator) broadcast(record models.Record) {
	ba.subMu.RLock()
	defer ba.subMu.RUnlock()

	for ch := range ba.subscribers {
		select {
		case ch <- record:
		default:
			log.Printf("[BucketAggregator:%s] Subscriber channel full, dropping", ba.configKey[:8])
		}
	}
}

// Helper functions

func toFloat64(v interface{}) float64 {
	switch val := v.(type) {
	case float64:
		return val
	case float32:
		return float64(val)
	case int:
		return float64(val)
	case int64:
		return float64(val)
	case int32:
		return float64(val)
	case string:
		f, _ := strconv.ParseFloat(val, 64)
		return f
	default:
		return 0
	}
}

func parseTimestamp(v interface{}) time.Time {
	switch val := v.(type) {
	case time.Time:
		return val
	case int64:
		// Detect seconds vs milliseconds
		if val > 1e12 {
			return time.UnixMilli(val)
		}
		return time.Unix(val, 0)
	case float64:
		if val > 1e12 {
			return time.UnixMilli(int64(val))
		}
		return time.Unix(int64(val), 0)
	case string:
		// Try parsing as RFC3339
		if t, err := time.Parse(time.RFC3339, val); err == nil {
			return t
		}
		// Try parsing as Unix timestamp
		if i, err := strconv.ParseInt(val, 10, 64); err == nil {
			if i > 1e12 {
				return time.UnixMilli(i)
			}
			return time.Unix(i, 0)
		}
	}
	return time.Time{}
}
