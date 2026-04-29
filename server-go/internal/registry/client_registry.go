// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import (
	"sync"
	"sync/atomic"
	"time"
)

// ConnectionType identifies the type of WebSocket connection
type ConnectionType string

const (
	ConnectionTypeAISession             ConnectionType = "ai_session"
	ConnectionTypeComponentSubscription ConnectionType = "component_subscription"
	ConnectionTypeStream                ConnectionType = "stream"
	ConnectionTypeInbound           ConnectionType = "inbound"
	ConnectionTypeStatusMonitor     ConnectionType = "status_monitor"
	ConnectionTypeDebug             ConnectionType = "debug"
)

// ClientConnection represents a tracked WebSocket connection
type ClientConnection struct {
	ID          uint64                 `json:"id"`
	Type        ConnectionType         `json:"type"`
	ConnectedAt time.Time              `json:"connected_at"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

// ClientConnectionInfo is a read-only snapshot of a connection
type ClientConnectionInfo struct {
	ID           uint64                 `json:"id"`
	Type         ConnectionType         `json:"type"`
	ConnectedAt  time.Time              `json:"connected_at"`
	DurationSecs float64                `json:"duration_secs"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
}

// ConnectionStats provides aggregate statistics
type ConnectionStats struct {
	TotalClients int            `json:"total_clients"`
	ByType       map[string]int `json:"by_type"`
}

// ClientRegistry tracks all WebSocket connections
type ClientRegistry struct {
	connections map[uint64]*ClientConnection
	nextID      uint64
	mu          sync.RWMutex
}

var (
	clientRegistry     *ClientRegistry
	clientRegistryOnce sync.Once
)

// GetClientRegistry returns the singleton client registry
func GetClientRegistry() *ClientRegistry {
	clientRegistryOnce.Do(func() {
		clientRegistry = &ClientRegistry{
			connections: make(map[uint64]*ClientConnection),
		}
	})
	return clientRegistry
}

// Register adds a new connection and returns its unique ID
func (r *ClientRegistry) Register(connType ConnectionType, metadata map[string]interface{}) uint64 {
	id := atomic.AddUint64(&r.nextID, 1)

	conn := &ClientConnection{
		ID:          id,
		Type:        connType,
		ConnectedAt: time.Now(),
		Metadata:    metadata,
	}

	r.mu.Lock()
	r.connections[id] = conn
	r.mu.Unlock()

	return id
}

// Unregister removes a connection by ID
func (r *ClientRegistry) Unregister(id uint64) {
	r.mu.Lock()
	delete(r.connections, id)
	r.mu.Unlock()
}

// GetAllConnections returns a snapshot of all connections
func (r *ClientRegistry) GetAllConnections() []ClientConnectionInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()

	now := time.Now()
	result := make([]ClientConnectionInfo, 0, len(r.connections))

	for _, conn := range r.connections {
		result = append(result, ClientConnectionInfo{
			ID:           conn.ID,
			Type:         conn.Type,
			ConnectedAt:  conn.ConnectedAt,
			DurationSecs: now.Sub(conn.ConnectedAt).Seconds(),
			Metadata:     conn.Metadata,
		})
	}

	return result
}

// GetStats returns aggregate connection statistics
func (r *ClientRegistry) GetStats() ConnectionStats {
	r.mu.RLock()
	defer r.mu.RUnlock()

	byType := make(map[string]int)
	for _, conn := range r.connections {
		byType[string(conn.Type)]++
	}

	return ConnectionStats{
		TotalClients: len(r.connections),
		ByType:       byType,
	}
}

// GetConnectionsByType returns connections of a specific type
func (r *ClientRegistry) GetConnectionsByType(connType ConnectionType) []ClientConnectionInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()

	now := time.Now()
	var result []ClientConnectionInfo

	for _, conn := range r.connections {
		if conn.Type == connType {
			result = append(result, ClientConnectionInfo{
				ID:           conn.ID,
				Type:         conn.Type,
				ConnectedAt:  conn.ConnectedAt,
				DurationSecs: now.Sub(conn.ConnectedAt).Seconds(),
				Metadata:     conn.Metadata,
			})
		}
	}

	return result
}
