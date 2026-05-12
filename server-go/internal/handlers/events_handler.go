// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// EventsHandler exposes the in-process event hub as an SSE stream.
// Each logged-in browser tab opens this once at app load and
// dispatches incoming events (today: alerts) onto the notification
// surfaces. The hub does the fan-out; this handler is the
// per-subscriber transport.
type EventsHandler struct {
	hub *service.EventHub
}

// NewEventsHandler wires the SSE endpoint to the event hub.
func NewEventsHandler(hub *service.EventHub) *EventsHandler {
	return &EventsHandler{hub: hub}
}

// Stream opens an SSE connection and pumps events from the hub
// until the client disconnects. Mirrors the long-lived-stream
// boilerplate in stream_handler.go (no-cache headers, deadline
// disable, connected event, heartbeat ticker).
// @Summary Subscribe to dashboard events (SSE)
// @Description Open a Server-Sent-Events stream of dashboard events (alerts, etc.). One stream per browser tab. EventSource compatible.
// @Tags Events
// @Produce text/event-stream
// @Success 200 {string} string "SSE stream"
// @Failure 401 {object} map[string]string
// @Router /events/stream [get]
func (h *EventsHandler) Stream(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}

	sub := h.hub.Subscribe(user.ID)
	defer sub.Close()

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	// SSE is intentionally long-lived; disable the server's global
	// WriteTimeout for this response.
	if rc := http.NewResponseController(c.Writer); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	fmt.Fprintf(c.Writer, "event: connected\ndata: {\"timestamp\":%d}\n\n", time.Now().Unix())
	c.Writer.Flush()
	log.Printf("events: SSE opened user=%s subscriber=%s total=%d", user.ID, sub.ID, h.hub.SubscriberCount())

	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	clientGone := c.Request.Context().Done()
	for {
		select {
		case <-clientGone:
			log.Printf("events: SSE closed user=%s subscriber=%s", user.ID, sub.ID)
			return

		case ev, ok := <-sub.Events:
			if !ok {
				return
			}
			data, err := json.Marshal(ev.Payload)
			if err != nil {
				log.Printf("events: marshal failed kind=%s err=%v", ev.Kind, err)
				continue
			}
			// Use the event kind as the SSE event name so the client
			// can dispatch on it (`source.addEventListener('alert', ...)`).
			fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", ev.Kind, data)
			c.Writer.Flush()

		case <-heartbeat.C:
			fmt.Fprintf(c.Writer, ": heartbeat %d\n\n", time.Now().Unix())
			c.Writer.Flush()
		}
	}
}
