// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// FrigateHandler handles proxied requests to Frigate NVR instances.
// Requests are routed through the Go backend so the browser doesn't need
// direct access to the Frigate host (CORS, network segmentation).
type FrigateHandler struct {
	connectionService *service.ConnectionService
	httpClient        *http.Client
}

// NewFrigateHandler creates a new FrigateHandler
func NewFrigateHandler(connectionService *service.ConnectionService) *FrigateHandler {
	return &FrigateHandler{
		connectionService: connectionService,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// getFrigateBaseURL looks up the connection by ID and extracts the Frigate base URL
func (h *FrigateHandler) getFrigateBaseURL(c *gin.Context) (string, error) {
	connectionID := c.Param("connection_id")
	if connectionID == "" {
		return "", fmt.Errorf("connection_id is required")
	}

	ds, err := h.connectionService.GetConnection(c.Request.Context(), connectionID)
	if err != nil {
		return "", fmt.Errorf("connection not found: %w", err)
	}

	// Dedicated Frigate connection type
	if ds.Type == "frigate" {
		if ds.Config.Frigate == nil {
			return "", fmt.Errorf("connection has no Frigate configuration")
		}
		return ds.Config.Frigate.BaseURL(), nil
	}

	// Legacy: API connection type (backwards compatibility)
	if ds.Type == "api" {
		if ds.Config.API == nil || ds.Config.API.URL == "" {
			return "", fmt.Errorf("connection has no API URL configured")
		}
		return strings.TrimRight(ds.Config.API.URL, "/"), nil
	}

	return "", fmt.Errorf("connection type %s is not a Frigate connection", ds.Type)
}

// getFrigateGo2RTCURL returns the go2rtc base URL for live streaming
func (h *FrigateHandler) getFrigateGo2RTCURL(c *gin.Context) (string, error) {
	connectionID := c.Param("connection_id")
	if connectionID == "" {
		return "", fmt.Errorf("connection_id is required")
	}

	ds, err := h.connectionService.GetConnection(c.Request.Context(), connectionID)
	if err != nil {
		return "", fmt.Errorf("connection not found: %w", err)
	}

	if ds.Type == "frigate" && ds.Config.Frigate != nil {
		return ds.Config.Frigate.Go2RTCURL(), nil
	}

	// Legacy API connections don't have go2rtc info — fall back to base URL with default port
	return "", fmt.Errorf("go2rtc URL not available for connection type %s", ds.Type)
}

// proxyBinary streams a binary response (JPEG, MP4) from Frigate to the client
func (h *FrigateHandler) proxyBinary(c *gin.Context, frigateURL string, contentType string) {
	req, err := http.NewRequestWithContext(c.Request.Context(), "GET", frigateURL, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to create request: %v", err)})
		return
	}

	// Forward Range headers for video scrubbing
	if rangeHeader := c.GetHeader("Range"); rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}

	resp, err := h.httpClient.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("failed to reach Frigate: %v", err)})
		return
	}
	defer resp.Body.Close()

	// Forward status code and content headers
	c.Status(resp.StatusCode)
	c.Header("Content-Type", contentType)
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		c.Header("Content-Length", cl)
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		c.Header("Content-Range", cr)
	}
	if ar := resp.Header.Get("Accept-Ranges"); ar != "" {
		c.Header("Accept-Ranges", ar)
	}

	// Stream body directly — no buffering
	io.Copy(c.Writer, resp.Body)
}

// GetCameras returns the list of camera names from Frigate config
// @Summary Get Frigate camera list
// @Description Returns camera names from a Frigate NVR connection
// @Tags Frigate
// @Produce json
// @Param connection_id path string true "Connection ID"
// @Success 200 {object} map[string]interface{}
// @Router /frigate/{connection_id}/cameras [get]
func (h *FrigateHandler) GetCameras(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	resp, err := h.httpClient.Get(baseURL + "/api/config")
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("failed to reach Frigate: %v", err)})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("Frigate returned %d", resp.StatusCode)})
		return
	}

	// Parse Frigate config to extract camera names
	var config map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&config); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to parse Frigate config: %v", err)})
		return
	}

	cameras := []string{}
	if camsMap, ok := config["cameras"].(map[string]interface{}); ok {
		for name := range camsMap {
			cameras = append(cameras, name)
		}
	}

	c.JSON(http.StatusOK, gin.H{"cameras": cameras})
}

// GetSnapshot proxies the latest camera snapshot JPEG from Frigate
// @Summary Get camera snapshot
// @Description Returns the latest JPEG snapshot for a camera
// @Tags Frigate
// @Produce image/jpeg
// @Param connection_id path string true "Connection ID"
// @Param camera path string true "Camera name"
// @Success 200 {file} binary
// @Router /frigate/{connection_id}/snapshot/{camera} [get]
func (h *FrigateHandler) GetSnapshot(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	camera := c.Param("camera")
	if camera == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "camera name is required"})
		return
	}

	frigateURL := fmt.Sprintf("%s/api/%s/latest.jpg", baseURL, camera)
	h.proxyBinary(c, frigateURL, "image/jpeg")
}

// GetEvents returns recent events for a camera
// @Summary Get camera events
// @Description Returns recent detection events for a camera
// @Tags Frigate
// @Produce json
// @Param connection_id path string true "Connection ID"
// @Param camera path string true "Camera name"
// @Param limit query int false "Max events to return" default(10)
// @Success 200 {array} map[string]interface{}
// @Router /frigate/{connection_id}/events/{camera} [get]
func (h *FrigateHandler) GetEvents(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	camera := c.Param("camera")
	if camera == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "camera name is required"})
		return
	}

	limit := c.DefaultQuery("limit", "10")
	frigateURL := fmt.Sprintf("%s/api/events?camera=%s&limit=%s", baseURL, camera, limit)

	resp, err := h.httpClient.Get(frigateURL)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("failed to reach Frigate: %v", err)})
		return
	}
	defer resp.Body.Close()

	// Stream JSON response directly
	c.Status(resp.StatusCode)
	c.Header("Content-Type", "application/json")
	io.Copy(c.Writer, resp.Body)
}

// GetReviews returns recent review segments filtered to unreviewed items by default.
// Frigate's /api/review endpoint returns review segments — the per-camera "alert"
// and "detection" groupings that the Frigate UI uses as the review queue. The
// `reviewed` query param maps directly to the upstream Frigate parameter:
//
//	reviewed=0 (default here) → only items not yet marked as reviewed
//	reviewed=1                → include reviewed items too
//
// @Summary Get camera review segments
// @Description Returns Frigate review segments, defaulted to unreviewed alerts. Used by the Frigate Alerts widget.
// @Tags Frigate
// @Produce json
// @Param connection_id path string true "Connection ID"
// @Param limit query int false "Max reviews to return" default(20)
// @Param camera query string false "Filter by camera name"
// @Param severity query string false "Filter by severity (alert, detection)"
// @Param reviewed query int false "Include reviewed (1) or only unreviewed (0)" default(0)
// @Success 200 {array} map[string]interface{}
// @Router /frigate/{connection_id}/reviews [get]
func (h *FrigateHandler) GetReviews(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Build the upstream query string. Only forward params the Frigate
	// review API actually understands to avoid confusing the upstream.
	params := []string{}
	params = append(params, "limit="+c.DefaultQuery("limit", "20"))
	params = append(params, "reviewed="+c.DefaultQuery("reviewed", "0"))
	if camera := c.Query("camera"); camera != "" {
		params = append(params, "cameras="+camera)
	}
	if severity := c.Query("severity"); severity != "" {
		params = append(params, "severity="+severity)
	}

	frigateURL := fmt.Sprintf("%s/api/review?%s", baseURL, strings.Join(params, "&"))

	resp, err := h.httpClient.Get(frigateURL)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("failed to reach Frigate: %v", err)})
		return
	}
	defer resp.Body.Close()

	c.Status(resp.StatusCode)
	c.Header("Content-Type", "application/json")
	io.Copy(c.Writer, resp.Body)
}

// GetReviewThumbnail proxies a WebP thumbnail for a review segment.
//
// Frigate stores review thumbnails under /clips/review/thumb-{camera}-{id}.webp
// (served by Frigate's built-in nginx at `/clips/*`, not via its `/api/*`
// routes). The review JSON returned by /api/review includes a `thumb_path`
// field like "/media/frigate/clips/review/thumb-{camera}-{id}.webp" but
// that's the container filesystem path, not an HTTP URL. We reconstruct
// the HTTP URL from the camera + review ID the client sends.
//
// @Summary Get review thumbnail
// @Description Returns the WebP thumbnail for a review segment
// @Tags Frigate
// @Produce image/webp
// @Param connection_id path string true "Connection ID"
// @Param review_id path string true "Review segment ID"
// @Param camera query string true "Camera name (required — encoded into the thumbnail filename)"
// @Success 200 {file} binary
// @Router /frigate/{connection_id}/review/{review_id}/thumbnail [get]
func (h *FrigateHandler) GetReviewThumbnail(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	reviewID := c.Param("review_id")
	if reviewID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "review_id is required"})
		return
	}

	camera := c.Query("camera")
	if camera == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "camera query param is required"})
		return
	}

	frigateURL := fmt.Sprintf("%s/clips/review/thumb-%s-%s.webp", baseURL, camera, reviewID)
	h.proxyBinary(c, frigateURL, "image/webp")
}

// MarkReviewsViewed marks one or more review segments as reviewed (viewed)
// in Frigate. Proxies POST /api/reviews/viewed with the body:
//
//	{ "ids": ["review_id_1", "review_id_2", ...] }
//
// Frigate responds with { "success": true, "message": ... } on success or
// a 422 validation error if the body is malformed.
//
// @Summary Mark review segments as reviewed
// @Description Marks one or more Frigate review segments as reviewed (viewed), removing them from unreviewed listings
// @Tags Frigate
// @Accept json
// @Produce json
// @Param connection_id path string true "Connection ID"
// @Param body body object true "Review IDs to mark: { ids: string[] }"
// @Success 200 {object} map[string]interface{}
// @Router /frigate/{connection_id}/reviews/viewed [post]
func (h *FrigateHandler) MarkReviewsViewed(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Read and re-encode the body so we control exactly what hits Frigate
	// (and so a malformed client request surfaces as a 400 here instead of
	// a confusing 422 from upstream).
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request body: %v", err)})
		return
	}
	if len(req.IDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ids must be a non-empty array"})
		return
	}

	bodyBytes, err := json.Marshal(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to encode request: %v", err)})
		return
	}

	frigateURL := fmt.Sprintf("%s/api/reviews/viewed", baseURL)
	upstreamReq, err := http.NewRequestWithContext(c.Request.Context(), "POST", frigateURL, strings.NewReader(string(bodyBytes)))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to build upstream request: %v", err)})
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")

	resp, err := h.httpClient.Do(upstreamReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("failed to reach Frigate: %v", err)})
		return
	}
	defer resp.Body.Close()

	c.Status(resp.StatusCode)
	c.Header("Content-Type", "application/json")
	io.Copy(c.Writer, resp.Body)
}

// GetEventClip proxies an event clip MP4 from Frigate
// @Summary Get event clip
// @Description Returns the MP4 clip for a detection event (supports Range headers)
// @Tags Frigate
// @Produce video/mp4
// @Param connection_id path string true "Connection ID"
// @Param event_id path string true "Event ID"
// @Success 200 {file} binary
// @Router /frigate/{connection_id}/event/{event_id}/clip [get]
func (h *FrigateHandler) GetEventClip(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	eventID := c.Param("event_id")
	if eventID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "event_id is required"})
		return
	}

	frigateURL := fmt.Sprintf("%s/api/events/%s/clip.mp4", baseURL, eventID)
	h.proxyBinary(c, frigateURL, "video/mp4")
}

// GetEventSnapshot proxies an event snapshot JPEG from Frigate
// @Summary Get event snapshot
// @Description Returns the JPEG snapshot for a detection event
// @Tags Frigate
// @Produce image/jpeg
// @Param connection_id path string true "Connection ID"
// @Param event_id path string true "Event ID"
// @Success 200 {file} binary
// @Router /frigate/{connection_id}/event/{event_id}/snapshot [get]
func (h *FrigateHandler) GetEventSnapshot(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	eventID := c.Param("event_id")
	if eventID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "event_id is required"})
		return
	}

	frigateURL := fmt.Sprintf("%s/api/events/%s/snapshot.jpg", baseURL, eventID)
	h.proxyBinary(c, frigateURL, "image/jpeg")
}

// GetInfo returns the Frigate connection info (base URL for go2rtc WebSocket)
// @Summary Get Frigate connection info
// @Description Returns connection metadata needed for direct WebSocket access (go2rtc MSE)
// @Tags Frigate
// @Produce json
// @Param connection_id path string true "Connection ID"
// @Success 200 {object} map[string]interface{}
// @Router /frigate/{connection_id}/info [get]
func (h *FrigateHandler) GetInfo(c *gin.Context) {
	baseURL, err := h.getFrigateBaseURL(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	info := gin.H{
		"base_url": baseURL,
	}

	// Include go2rtc URL if available (Frigate connection type)
	if go2rtcURL, err := h.getFrigateGo2RTCURL(c); err == nil {
		info["go2rtc_url"] = go2rtcURL
	}

	c.JSON(http.StatusOK, info)
}

// WebSocket upgrader for live stream proxy
// Subprotocols includes "null" and "binary" to satisfy JSMPEG's Sec-WebSocket-Protocol
// header — Chromium 147+ strictly enforces RFC 6455 and rejects the handshake if the
// server doesn't echo back a matching subprotocol.
var frigateWSUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
	Subprotocols:    []string{"null", "binary"},
}

// ProxyLiveStream proxies a JSMPEG WebSocket stream from Frigate to the browser
// @Summary Proxy Frigate JSMPEG live stream
// @Description Proxies the JSMPEG WebSocket stream for a camera through the backend
// @Tags Frigate
// @Param connection_id path string true "Connection ID"
// @Param camera path string true "Camera name"
// @Router /frigate/{connection_id}/live/{camera} [get]
func (h *FrigateHandler) ProxyLiveStream(c *gin.Context) {
	connectionID := c.Param("connection_id")
	camera := c.Param("camera")

	if connectionID == "" || camera == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "connection_id and camera are required"})
		return
	}

	// Look up the Frigate connection to get the JSMPEG WebSocket URL
	ds, err := h.connectionService.GetConnection(c.Request.Context(), connectionID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("connection not found: %v", err)})
		return
	}

	var frigateWSURL string
	if ds.Type == "frigate" && ds.Config.Frigate != nil {
		frigateWSURL = fmt.Sprintf("%s/live/jsmpeg/%s", ds.Config.Frigate.JSMPEGURL(), camera)
	} else if ds.Type == "api" && ds.Config.API != nil {
		// Legacy API connection — derive WebSocket URL from HTTP URL
		baseURL := strings.TrimRight(ds.Config.API.URL, "/")
		wsURL := strings.Replace(baseURL, "http://", "ws://", 1)
		wsURL = strings.Replace(wsURL, "https://", "wss://", 1)
		frigateWSURL = fmt.Sprintf("%s/live/jsmpeg/%s", wsURL, camera)
	} else {
		c.JSON(http.StatusBadRequest, gin.H{"error": "not a Frigate connection"})
		return
	}

	log.Printf("[FrigateProxy] Connecting to Frigate JSMPEG: %s", frigateWSURL)

	// Upgrade the browser connection to WebSocket
	browserConn, err := frigateWSUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[FrigateProxy] Failed to upgrade browser WebSocket: %v", err)
		return
	}
	defer browserConn.Close()

	// Connect to Frigate's JSMPEG WebSocket
	frigateConn, _, err := websocket.DefaultDialer.Dial(frigateWSURL, nil)
	if err != nil {
		log.Printf("[FrigateProxy] Failed to connect to Frigate: %v", err)
		browserConn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "Failed to connect to Frigate"))
		return
	}
	defer frigateConn.Close()

	log.Printf("[FrigateProxy] Connected, proxying %s", camera)

	var once sync.Once
	done := make(chan struct{})

	// Frigate -> Browser
	go func() {
		defer once.Do(func() { close(done) })
		for {
			msgType, data, err := frigateConn.ReadMessage()
			if err != nil {
				return
			}
			if err := browserConn.WriteMessage(msgType, data); err != nil {
				return
			}
		}
	}()

	// Browser -> Frigate (for pings/control)
	go func() {
		defer once.Do(func() { close(done) })
		for {
			msgType, data, err := browserConn.ReadMessage()
			if err != nil {
				return
			}
			if err := frigateConn.WriteMessage(msgType, data); err != nil {
				return
			}
		}
	}()

	<-done
	log.Printf("[FrigateProxy] Stream ended for %s", camera)
}
