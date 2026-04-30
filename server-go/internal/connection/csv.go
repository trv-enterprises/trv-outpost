// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	// Register CSV adapter
	registry.Register(
		"file.csv",
		"CSV File",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: false},
		csvConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newCSVAdapterFromConfig(config)
		},
	)
}

// csvConfigSchema returns configuration fields for CSV adapter
func csvConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "path", Type: "string", Required: true, Description: "File path or HTTP URL"},
		{Name: "delimiter", Type: "string", Required: false, Default: ",", Description: "Field delimiter"},
		{Name: "has_header", Type: "bool", Required: false, Default: true, Description: "First row is header"},
		{Name: "columns", Type: "array", Required: false, Description: "Column names (if no header)"},
		{Name: "encoding", Type: "string", Required: false, Default: "utf-8", Description: "File encoding"},
	}
}

// CSVAdapter implements registry.Adapter for CSV files
type CSVAdapter struct {
	config  *models.CSVConfig
	columns []string
}

// newCSVAdapterFromConfig creates a CSV adapter from config map
func newCSVAdapterFromConfig(config map[string]interface{}) (*CSVAdapter, error) {
	csvConfig := &models.CSVConfig{
		HasHeader: true, // default
	}

	if path, ok := config["path"].(string); ok {
		csvConfig.Path = path
	}
	if delimiter, ok := config["delimiter"].(string); ok {
		csvConfig.Delimiter = delimiter
	}
	if hasHeader, ok := config["has_header"].(bool); ok {
		csvConfig.HasHeader = hasHeader
	}
	if columns, ok := config["columns"].([]interface{}); ok {
		for _, c := range columns {
			if cs, ok := c.(string); ok {
				csvConfig.Columns = append(csvConfig.Columns, cs)
			}
		}
	}
	if encoding, ok := config["encoding"].(string); ok {
		csvConfig.Encoding = encoding
	}

	return &CSVAdapter{
		config: csvConfig,
	}, nil
}

// TypeID returns the adapter type identifier
func (a *CSVAdapter) TypeID() string {
	return "file.csv"
}

// DisplayName returns a human-readable name
func (a *CSVAdapter) DisplayName() string {
	return "CSV File"
}

// Capabilities returns what this adapter can do
func (a *CSVAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: false}
}

// ConfigSchema returns configuration fields
func (a *CSVAdapter) ConfigSchema() []registry.ConfigField {
	return csvConfigSchema()
}

// Connect reads headers from the CSV file
func (a *CSVAdapter) Connect(ctx context.Context) error {
	reader, cleanup, err := a.getReader()
	if err != nil {
		return err
	}
	defer cleanup()

	if a.config.HasHeader {
		csvReader := csv.NewReader(reader)
		if a.config.Delimiter != "" {
			csvReader.Comma = rune(a.config.Delimiter[0])
		}

		header, err := csvReader.Read()
		if err != nil {
			return fmt.Errorf("failed to read CSV header: %w", err)
		}
		a.columns = header
	} else if len(a.config.Columns) > 0 {
		a.columns = a.config.Columns
	}

	return nil
}

// TestConnection verifies the file can be read
func (a *CSVAdapter) TestConnection(ctx context.Context) error {
	return a.Connect(ctx)
}

// Close is a no-op for CSV (no persistent connection)
func (a *CSVAdapter) Close() error {
	return nil
}

// Query executes a filter query on CSV data
func (a *CSVAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	if len(a.columns) == 0 {
		if err := a.Connect(ctx); err != nil {
			return nil, err
		}
	}

	reader, cleanup, err := a.getReader()
	if err != nil {
		return nil, err
	}
	defer cleanup()

	csvReader := csv.NewReader(reader)
	if a.config.Delimiter != "" {
		csvReader.Comma = rune(a.config.Delimiter[0])
	}

	// Skip header if present
	if a.config.HasHeader {
		if _, err := csvReader.Read(); err != nil {
			return nil, fmt.Errorf("failed to read header: %w", err)
		}
	}

	resultSet := &registry.ResultSet{
		Columns:  a.columns,
		Rows:     make([][]interface{}, 0),
		Metadata: make(map[string]interface{}),
	}

	rowCount := 0
	for {
		record, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("error reading CSV row: %w", err)
		}

		// Apply filter if provided
		if query.Raw != "" && !a.matchesFilter(record, query.Raw) {
			continue
		}

		row := make([]interface{}, len(record))
		for i, v := range record {
			row[i] = v
		}

		resultSet.Rows = append(resultSet.Rows, row)
		rowCount++

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
	}

	resultSet.Metadata["row_count"] = rowCount
	resultSet.Metadata["column_count"] = len(a.columns)
	resultSet.Metadata["file_path"] = a.config.Path
	resultSet.Metadata["is_url"] = isURL(a.config.Path)

	return resultSet, nil
}

// Stream reads CSV data and streams records
func (a *CSVAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	if len(a.columns) == 0 {
		if err := a.Connect(ctx); err != nil {
			return nil, err
		}
	}

	reader, cleanup, err := a.getReader()
	if err != nil {
		return nil, err
	}

	csvReader := csv.NewReader(reader)
	if a.config.Delimiter != "" {
		csvReader.Comma = rune(a.config.Delimiter[0])
	}

	// Skip header if present
	if a.config.HasHeader {
		if _, err := csvReader.Read(); err != nil {
			cleanup()
			return nil, fmt.Errorf("failed to read header: %w", err)
		}
	}

	recordChan := make(chan registry.Record, 100)

	go func() {
		defer close(recordChan)
		defer cleanup()

		for {
			csvRecord, err := csvReader.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				continue
			}

			if query.Raw != "" && !a.matchesFilter(csvRecord, query.Raw) {
				continue
			}

			record := make(registry.Record)
			for i, value := range csvRecord {
				var columnName string
				if i < len(a.columns) {
					columnName = a.columns[i]
				} else {
					columnName = fmt.Sprintf("column_%d", i)
				}
				record[columnName] = value
			}

			select {
			case recordChan <- record:
			case <-ctx.Done():
				return
			}
		}
	}()

	return recordChan, nil
}

// Write is not supported for CSV adapter
func (a *CSVAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("file.csv does not support write operations")
}

// getReader returns an io.Reader for the CSV data
func (a *CSVAdapter) getReader() (io.Reader, func(), error) {
	if isURL(a.config.Path) {
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Get(a.config.Path)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to fetch CSV from URL: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, nil, fmt.Errorf("failed to fetch CSV: HTTP %d %s", resp.StatusCode, resp.Status)
		}
		return resp.Body, func() { resp.Body.Close() }, nil
	}

	file, err := os.Open(a.config.Path)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open CSV file: %w", err)
	}
	return file, func() { file.Close() }, nil
}

// matchesFilter is a simple string-based filter
func (a *CSVAdapter) matchesFilter(record []string, filter string) bool {
	if strings.Contains(filter, ":") {
		parts := strings.SplitN(filter, ":", 2)
		columnName := strings.TrimSpace(parts[0])
		searchValue := strings.TrimSpace(parts[1])

		colIndex := -1
		for i, col := range a.columns {
			if col == columnName {
				colIndex = i
				break
			}
		}

		if colIndex >= 0 && colIndex < len(record) {
			return strings.Contains(strings.ToLower(record[colIndex]), strings.ToLower(searchValue))
		}
		return false
	}

	searchValue := strings.ToLower(filter)
	for _, value := range record {
		if strings.Contains(strings.ToLower(value), searchValue) {
			return true
		}
	}
	return false
}

// CSVDataSource implements the DataSource interface for CSV files
type CSVDataSource struct {
	config  *models.CSVConfig
	columns []string
}

// NewCSVDataSource creates a new CSV datasource
func NewCSVDataSource(config *models.CSVConfig) (*CSVDataSource, error) {
	ds := &CSVDataSource{
		config: config,
	}

	// Get a reader for the CSV data (supports both local files and HTTP URLs)
	reader, cleanup, err := ds.getReader()
	if err != nil {
		return nil, err
	}
	defer cleanup()

	// Read header if present
	if config.HasHeader {
		csvReader := csv.NewReader(reader)
		if config.Delimiter != "" {
			csvReader.Comma = rune(config.Delimiter[0])
		}

		header, err := csvReader.Read()
		if err != nil {
			return nil, fmt.Errorf("failed to read CSV header: %w", err)
		}
		ds.columns = header
	} else if len(config.Columns) > 0 {
		// Use explicitly provided column names
		ds.columns = config.Columns
	}

	return ds, nil
}

// isURL checks if the path is an HTTP/HTTPS URL
func isURL(path string) bool {
	return strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://")
}

// getReader returns an io.Reader for the CSV data, supporting both local files and HTTP URLs
// Returns the reader, a cleanup function, and any error
func (c *CSVDataSource) getReader() (io.Reader, func(), error) {
	if isURL(c.config.Path) {
		// Fetch from HTTP URL
		client := &http.Client{
			Timeout: 30 * time.Second,
		}

		resp, err := client.Get(c.config.Path)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to fetch CSV from URL: %w", err)
		}

		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, nil, fmt.Errorf("failed to fetch CSV: HTTP %d %s", resp.StatusCode, resp.Status)
		}

		cleanup := func() {
			resp.Body.Close()
		}

		return resp.Body, cleanup, nil
	}

	// Local file
	file, err := os.Open(c.config.Path)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open CSV file: %w", err)
	}

	cleanup := func() {
		file.Close()
	}

	return file, cleanup, nil
}

// Query executes a filter query on CSV data and returns normalized results
func (c *CSVDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	reader, cleanup, err := c.getReader()
	if err != nil {
		return nil, err
	}
	defer cleanup()

	csvReader := csv.NewReader(reader)
	if c.config.Delimiter != "" {
		csvReader.Comma = rune(c.config.Delimiter[0])
	}

	// Skip header if present
	if c.config.HasHeader {
		if _, err := csvReader.Read(); err != nil {
			return nil, fmt.Errorf("failed to read header: %w", err)
		}
	}

	resultSet := &models.ResultSet{
		Columns:  c.columns,
		Rows:     make([][]interface{}, 0),
		Metadata: make(map[string]interface{}),
	}

	// Read all records (filtering logic can be added based on query.Raw)
	rowCount := 0
	for {
		record, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("error reading CSV row: %w", err)
		}

		// Apply simple filter if query.Raw is provided
		if query.Raw != "" && !c.matchesFilter(record, query.Raw) {
			continue
		}

		// Convert string slice to interface{} slice
		row := make([]interface{}, len(record))
		for i, v := range record {
			row[i] = v
		}

		resultSet.Rows = append(resultSet.Rows, row)
		rowCount++

		// Check context cancellation
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
	}

	resultSet.Metadata["row_count"] = rowCount
	resultSet.Metadata["column_count"] = len(c.columns)
	resultSet.Metadata["file_path"] = c.config.Path
	resultSet.Metadata["is_url"] = isURL(c.config.Path)

	return resultSet, nil
}

// Stream reads CSV data and streams records as they're read
func (c *CSVDataSource) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	reader, cleanup, err := c.getReader()
	if err != nil {
		return nil, err
	}

	csvReader := csv.NewReader(reader)
	if c.config.Delimiter != "" {
		csvReader.Comma = rune(c.config.Delimiter[0])
	}

	// Skip header if present
	if c.config.HasHeader {
		if _, err := csvReader.Read(); err != nil {
			cleanup()
			return nil, fmt.Errorf("failed to read header: %w", err)
		}
	}

	recordChan := make(chan models.Record, 100) // Buffer for performance

	go func() {
		defer close(recordChan)
		defer cleanup()

		for {
			csvRecord, err := csvReader.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				// Log error but continue
				continue
			}

			// Apply simple filter if query.Raw is provided
			if query.Raw != "" && !c.matchesFilter(csvRecord, query.Raw) {
				continue
			}

			// Build record map
			record := make(models.Record)
			for i, value := range csvRecord {
				var columnName string
				if i < len(c.columns) {
					columnName = c.columns[i]
				} else {
					columnName = fmt.Sprintf("column_%d", i)
				}
				record[columnName] = value
			}

			select {
			case recordChan <- record:
			case <-ctx.Done():
				return
			}
		}
	}()

	return recordChan, nil
}

// matchesFilter is a simple string-based filter
// For production, you'd want a more sophisticated query language
func (c *CSVDataSource) matchesFilter(record []string, filter string) bool {
	// Simple contains-based filtering
	// Format: "column:value" or just "value" to match any column
	if strings.Contains(filter, ":") {
		parts := strings.SplitN(filter, ":", 2)
		columnName := strings.TrimSpace(parts[0])
		searchValue := strings.TrimSpace(parts[1])

		// Find column index
		colIndex := -1
		for i, col := range c.columns {
			if col == columnName {
				colIndex = i
				break
			}
		}

		if colIndex >= 0 && colIndex < len(record) {
			return strings.Contains(strings.ToLower(record[colIndex]), strings.ToLower(searchValue))
		}
		return false
	}

	// Search all columns
	searchValue := strings.ToLower(filter)
	for _, value := range record {
		if strings.Contains(strings.ToLower(value), searchValue) {
			return true
		}
	}
	return false
}

// Close closes any open resources
func (c *CSVDataSource) Close() error {
	// CSV datasource doesn't maintain persistent connections
	return nil
}
