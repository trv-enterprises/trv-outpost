// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package hub

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// ComponentSubscriber represents a WebSocket connection subscribed to component updates
type ComponentSubscriber struct {
	ID               string          // Unique subscriber ID (e.g., session ID or connection ID)
	Conn             *websocket.Conn // WebSocket connection
	ComponentIDs     map[string]bool // Set of component IDs this subscriber is interested in
	ClientRegistryID uint64          // ID from client registry for status tracking
	mu               sync.Mutex      // Protects Conn writes
}

// Send sends a message to the subscriber (thread-safe)
func (s *ComponentSubscriber) Send(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Conn.WriteMessage(websocket.TextMessage, data)
}

// ComponentHub manages component update subscriptions and broadcasts.
// Uses channel-based communication for thread safety.
type ComponentHub struct {
	// Subscribers indexed by their ID
	subscribers map[string]*ComponentSubscriber

	// Component subscriptions: componentID -> set of subscriber IDs
	componentSubscriptions map[string]map[string]bool

	// Channels for thread-safe operations
	subscribe   chan *subscribeRequest
	unsubscribe chan *unsubscribeRequest
	broadcast   chan *broadcastRequest
	stop        chan struct{}

	mu sync.RWMutex
}

type subscribeRequest struct {
	subscriber  *ComponentSubscriber
	componentID string
}

type unsubscribeRequest struct {
	subscriberID string
	componentID  string // empty means unsubscribe from all
}

type broadcastRequest struct {
	componentID string
	component   *models.Component
}

// Global hub instance
var globalComponentHub *ComponentHub
var hubOnce sync.Once

// GetComponentHub returns the global ComponentHub instance
func GetComponentHub() *ComponentHub {
	hubOnce.Do(func() {
		globalComponentHub = NewComponentHub()
		go globalComponentHub.Run()
	})
	return globalComponentHub
}

// NewComponentHub creates a new ComponentHub
func NewComponentHub() *ComponentHub {
	return &ComponentHub{
		subscribers:            make(map[string]*ComponentSubscriber),
		componentSubscriptions: make(map[string]map[string]bool),
		subscribe:              make(chan *subscribeRequest, 100),
		unsubscribe:            make(chan *unsubscribeRequest, 100),
		broadcast:              make(chan *broadcastRequest, 100),
		stop:                   make(chan struct{}),
	}
}

// Run starts the hub's main loop (run as goroutine)
func (h *ComponentHub) Run() {
	fmt.Println("[ComponentHub] Starting component subscription hub")
	for {
		select {
		case req := <-h.subscribe:
			h.handleSubscribe(req)

		case req := <-h.unsubscribe:
			h.handleUnsubscribe(req)

		case req := <-h.broadcast:
			h.handleBroadcast(req)

		case <-h.stop:
			fmt.Println("[ComponentHub] Stopping component subscription hub")
			return
		}
	}
}

// Stop stops the hub
func (h *ComponentHub) Stop() {
	close(h.stop)
}

// Subscribe adds a subscriber for a specific component
func (h *ComponentHub) Subscribe(subscriber *ComponentSubscriber, componentID string) {
	h.subscribe <- &subscribeRequest{
		subscriber:  subscriber,
		componentID: componentID,
	}
}

// Unsubscribe removes a subscriber from a specific component (or all if componentID is empty)
func (h *ComponentHub) Unsubscribe(subscriberID string, componentID string) {
	h.unsubscribe <- &unsubscribeRequest{
		subscriberID: subscriberID,
		componentID:  componentID,
	}
}

// UnsubscribeAll removes a subscriber from all components
func (h *ComponentHub) UnsubscribeAll(subscriberID string) {
	h.Unsubscribe(subscriberID, "")
}

// BroadcastComponentUpdate sends a component update to all subscribers of that component
func (h *ComponentHub) BroadcastComponentUpdate(componentID string, component *models.Component) {
	h.broadcast <- &broadcastRequest{
		componentID: componentID,
		component:   component,
	}
}

// handleSubscribe processes a subscribe request
func (h *ComponentHub) handleSubscribe(req *subscribeRequest) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Add/update subscriber
	existing, ok := h.subscribers[req.subscriber.ID]
	if ok {
		// Subscriber exists, add component to their list
		existing.ComponentIDs[req.componentID] = true
	} else {
		// New subscriber - register with client registry
		clientRegistry := registry.GetClientRegistry()
		req.subscriber.ClientRegistryID = clientRegistry.Register(registry.ConnectionTypeComponentSubscription, map[string]interface{}{
			"subscriber_id": req.subscriber.ID,
			"component_id":  req.componentID,
		})

		req.subscriber.ComponentIDs = make(map[string]bool)
		req.subscriber.ComponentIDs[req.componentID] = true
		h.subscribers[req.subscriber.ID] = req.subscriber
	}

	// Add to component subscriptions
	if h.componentSubscriptions[req.componentID] == nil {
		h.componentSubscriptions[req.componentID] = make(map[string]bool)
	}
	h.componentSubscriptions[req.componentID][req.subscriber.ID] = true

	fmt.Printf("[ComponentHub] Subscriber %s subscribed to component %s (total subscribers for component: %d)\n",
		req.subscriber.ID, req.componentID, len(h.componentSubscriptions[req.componentID]))
}

// handleUnsubscribe processes an unsubscribe request
func (h *ComponentHub) handleUnsubscribe(req *unsubscribeRequest) {
	h.mu.Lock()
	defer h.mu.Unlock()

	subscriber, ok := h.subscribers[req.subscriberID]
	if !ok {
		return
	}

	if req.componentID == "" {
		// Unsubscribe from all components
		for componentID := range subscriber.ComponentIDs {
			if subs := h.componentSubscriptions[componentID]; subs != nil {
				delete(subs, req.subscriberID)
				if len(subs) == 0 {
					delete(h.componentSubscriptions, componentID)
				}
			}
		}
		// Unregister from client registry
		if subscriber.ClientRegistryID > 0 {
			clientRegistry := registry.GetClientRegistry()
			clientRegistry.Unregister(subscriber.ClientRegistryID)
		}
		delete(h.subscribers, req.subscriberID)
		fmt.Printf("[ComponentHub] Subscriber %s unsubscribed from all components\n", req.subscriberID)
	} else {
		// Unsubscribe from specific component
		delete(subscriber.ComponentIDs, req.componentID)
		if subs := h.componentSubscriptions[req.componentID]; subs != nil {
			delete(subs, req.subscriberID)
			if len(subs) == 0 {
				delete(h.componentSubscriptions, req.componentID)
			}
		}
		// If subscriber has no more subscriptions, remove them
		if len(subscriber.ComponentIDs) == 0 {
			// Unregister from client registry
			if subscriber.ClientRegistryID > 0 {
				clientRegistry := registry.GetClientRegistry()
				clientRegistry.Unregister(subscriber.ClientRegistryID)
			}
			delete(h.subscribers, req.subscriberID)
		}
		fmt.Printf("[ComponentHub] Subscriber %s unsubscribed from component %s\n", req.subscriberID, req.componentID)
	}
}

// handleBroadcast processes a broadcast request
func (h *ComponentHub) handleBroadcast(req *broadcastRequest) {
	h.mu.RLock()
	subscriberIDs := make([]string, 0)
	if subs := h.componentSubscriptions[req.componentID]; subs != nil {
		for subID := range subs {
			subscriberIDs = append(subscriberIDs, subID)
		}
	}
	h.mu.RUnlock()

	if len(subscriberIDs) == 0 {
		fmt.Printf("[ComponentHub] No subscribers for component %s\n", req.componentID)
		return
	}

	// Build the event message
	event := &models.AIEvent{
		Type: models.AIEventTypeComponentUpdate,
		Data: models.AIComponentUpdateEvent{
			Component: req.component,
		},
		Timestamp: time.Now(),
	}

	data, err := json.Marshal(event)
	if err != nil {
		fmt.Printf("[ComponentHub] Error marshaling component update: %v\n", err)
		return
	}

	fmt.Printf("[ComponentHub] Broadcasting component %s update to %d subscribers\n", req.componentID, len(subscriberIDs))

	// Send to all subscribers
	h.mu.RLock()
	for _, subID := range subscriberIDs {
		if subscriber, ok := h.subscribers[subID]; ok {
			if err := subscriber.Send(data); err != nil {
				fmt.Printf("[ComponentHub] Error sending to subscriber %s: %v\n", subID, err)
				// Queue unsubscribe for failed connection
				go h.UnsubscribeAll(subID)
			}
		}
	}
	h.mu.RUnlock()
}

// GetSubscriberCount returns the number of subscribers for a component
func (h *ComponentHub) GetSubscriberCount(componentID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if subs := h.componentSubscriptions[componentID]; subs != nil {
		return len(subs)
	}
	return 0
}

// GetTotalSubscribers returns the total number of unique subscribers
func (h *ComponentHub) GetTotalSubscribers() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subscribers)
}
