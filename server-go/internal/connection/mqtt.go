// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"sync"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	registry.Register(
		"stream.mqtt",
		"MQTT Broker",
		registry.Capabilities{CanRead: true, CanWrite: true, CanStream: true},
		mqttConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newMQTTAdapterFromConfig(config)
		},
	)
}

// mqttConfigSchema returns configuration fields for MQTT adapters
func mqttConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "broker_url", Type: "string", Required: true, Description: "MQTT broker URL (mqtt://host:1883 or mqtts://host:8883)"},
		{Name: "client_id", Type: "string", Required: false, Description: "MQTT client ID (auto-generated if empty)"},
		{Name: "username", Type: "string", Required: false, Description: "Authentication username"},
		{Name: "password", Type: "password", Required: false, Description: "Authentication password"},
		{Name: "tls", Type: "bool", Required: false, Default: false, Description: "Use TLS encryption"},
		{Name: "keep_alive", Type: "int", Required: false, Default: 60, Description: "Keep-alive interval (seconds)"},
		{Name: "qos", Type: "int", Required: false, Default: 0, Description: "Default QoS level (0, 1, or 2)"},
		{Name: "clean_start", Type: "bool", Required: false, Default: true, Description: "Clean session on connect"},
		{Name: "buffer_size", Type: "int", Required: false, Default: 100, Description: "Message buffer size"},
	}
}

// MQTTAdapter implements registry.Adapter for MQTT broker connections
type MQTTAdapter struct {
	config     *models.MQTTConfig
	cm         *autopaho.ConnectionManager
	mu         sync.RWMutex
	cancelFunc context.CancelFunc
}

// newMQTTAdapterFromConfig creates an MQTT adapter from config map
func newMQTTAdapterFromConfig(config map[string]interface{}) (*MQTTAdapter, error) {
	mqttConfig := &models.MQTTConfig{
		KeepAlive:  60,
		QoS:        0,
		CleanStart: true,
		BufferSize: 100,
	}

	if brokerURL, ok := config["broker_url"].(string); ok {
		mqttConfig.BrokerURL = brokerURL
	}
	if clientID, ok := config["client_id"].(string); ok {
		mqttConfig.ClientID = clientID
	}
	if username, ok := config["username"].(string); ok {
		mqttConfig.Username = username
	}
	if password, ok := config["password"].(string); ok {
		mqttConfig.Password = password
	}
	if tls, ok := config["tls"].(bool); ok {
		mqttConfig.TLS = tls
	}
	if keepAlive, ok := config["keep_alive"].(float64); ok {
		mqttConfig.KeepAlive = int(keepAlive)
	} else if keepAlive, ok := config["keep_alive"].(int); ok {
		mqttConfig.KeepAlive = keepAlive
	}
	if qos, ok := config["qos"].(float64); ok {
		mqttConfig.QoS = int(qos)
	} else if qos, ok := config["qos"].(int); ok {
		mqttConfig.QoS = qos
	}
	if cleanStart, ok := config["clean_start"].(bool); ok {
		mqttConfig.CleanStart = cleanStart
	}
	if bufSize, ok := config["buffer_size"].(float64); ok {
		mqttConfig.BufferSize = int(bufSize)
	} else if bufSize, ok := config["buffer_size"].(int); ok {
		mqttConfig.BufferSize = bufSize
	}

	// Generate client ID if not provided
	if mqttConfig.ClientID == "" {
		mqttConfig.ClientID = fmt.Sprintf("dashboard-%d", time.Now().UnixNano()%1000000)
	}

	return &MQTTAdapter{
		config: mqttConfig,
	}, nil
}

// TypeID returns the adapter type identifier
func (a *MQTTAdapter) TypeID() string {
	return "stream.mqtt"
}

// DisplayName returns a human-readable name
func (a *MQTTAdapter) DisplayName() string {
	return "MQTT Broker"
}

// Capabilities returns what this adapter can do
func (a *MQTTAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: true, CanStream: true}
}

// ConfigSchema returns configuration fields
func (a *MQTTAdapter) ConfigSchema() []registry.ConfigField {
	return mqttConfigSchema()
}

// buildAutopahoConfig creates the autopaho connection manager configuration
func (a *MQTTAdapter) buildAutopahoConfig(ctx context.Context, onMessage func(m *paho.Publish)) (autopaho.ClientConfig, error) {
	brokerURL, err := url.Parse(a.config.BrokerURL)
	if err != nil {
		return autopaho.ClientConfig{}, fmt.Errorf("invalid broker URL: %w", err)
	}

	keepAlive := uint16(a.config.KeepAlive)
	if keepAlive == 0 {
		keepAlive = 60
	}

	cfg := autopaho.ClientConfig{
		ServerUrls:                    []*url.URL{brokerURL},
		KeepAlive:                     keepAlive,
		CleanStartOnInitialConnection: a.config.CleanStart,
		SessionExpiryInterval:         0,
		OnConnectionUp: func(cm *autopaho.ConnectionManager, connAck *paho.Connack) {
			log.Printf("[MQTT %s] Connected to broker %s", a.config.ClientID, a.config.BrokerURL)
		},
		OnConnectError: func(err error) {
			log.Printf("[MQTT %s] Connection error: %v", a.config.ClientID, err)
		},
		ClientConfig: paho.ClientConfig{
			ClientID: a.config.ClientID,
		},
	}

	// Set authentication if provided
	if a.config.Username != "" {
		cfg.ConnectUsername = a.config.Username
		cfg.ConnectPassword = []byte(a.config.Password)
	}

	// Set message handler if provided
	if onMessage != nil {
		cfg.ClientConfig.Router = paho.NewSingleHandlerRouter(onMessage)
	}

	return cfg, nil
}

// Connect establishes the MQTT connection
func (a *MQTTAdapter) Connect(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.cm != nil {
		return nil // Already connected
	}

	cfg, err := a.buildAutopahoConfig(ctx, nil)
	if err != nil {
		return err
	}

	connCtx, cancel := context.WithCancel(ctx)
	cm, err := autopaho.NewConnection(connCtx, cfg)
	if err != nil {
		cancel()
		return fmt.Errorf("failed to create MQTT connection: %w", err)
	}

	// Wait for connection to be established
	waitCtx, waitCancel := context.WithTimeout(ctx, 10*time.Second)
	defer waitCancel()

	if err := cm.AwaitConnection(waitCtx); err != nil {
		cancel()
		return fmt.Errorf("failed to connect to MQTT broker: %w", err)
	}

	a.cm = cm
	a.cancelFunc = cancel
	return nil
}

// TestConnection verifies the connection works
func (a *MQTTAdapter) TestConnection(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	cfg, err := a.buildAutopahoConfig(ctx, nil)
	if err != nil {
		return err
	}

	testCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	cm, err := autopaho.NewConnection(testCtx, cfg)
	if err != nil {
		return fmt.Errorf("failed to create MQTT connection: %w", err)
	}

	// Wait for connection
	waitCtx, waitCancel := context.WithTimeout(ctx, 10*time.Second)
	defer waitCancel()

	if err := cm.AwaitConnection(waitCtx); err != nil {
		return fmt.Errorf("failed to connect to MQTT broker: %w", err)
	}

	// Disconnect cleanly
	disconnectCtx, disconnectCancel := context.WithTimeout(ctx, 5*time.Second)
	defer disconnectCancel()
	_ = cm.Disconnect(disconnectCtx)

	return nil
}

// Close closes the MQTT connection
func (a *MQTTAdapter) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.cancelFunc != nil {
		a.cancelFunc()
		a.cancelFunc = nil
	}

	if a.cm != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = a.cm.Disconnect(ctx)
		a.cm = nil
	}

	return nil
}

// Query subscribes to topic(s), collects messages for a period, and returns as ResultSet
func (a *MQTTAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	recordChan, err := a.Stream(ctx, query)
	if err != nil {
		return nil, err
	}

	// Collect records for limited time
	timeout := 5 * time.Second
	collectCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var records []registry.Record
	for {
		select {
		case record, ok := <-recordChan:
			if !ok {
				goto processRecords
			}
			records = append(records, record)
		case <-collectCtx.Done():
			goto processRecords
		}
	}

processRecords:
	// Build column list from all records
	columnSet := make(map[string]bool)
	columnOrder := []string{"timestamp", "topic"}
	columnSet["timestamp"] = true
	columnSet["topic"] = true

	for _, record := range records {
		for key := range record {
			if !columnSet[key] {
				columnSet[key] = true
				columnOrder = append(columnOrder, key)
			}
		}
	}

	if len(records) == 0 {
		return &registry.ResultSet{
			Columns:  columnOrder,
			Rows:     make([][]interface{}, 0),
			Metadata: map[string]interface{}{"row_count": 0, "collection_timeout": timeout.String()},
		}, nil
	}

	// Build rows
	rows := make([][]interface{}, 0, len(records))
	for _, record := range records {
		row := make([]interface{}, len(columnOrder))
		for i, col := range columnOrder {
			if val, exists := record[col]; exists {
				row[i] = flattenValue(val)
			} else {
				row[i] = nil
			}
		}
		rows = append(rows, row)
	}

	return &registry.ResultSet{
		Columns:  columnOrder,
		Rows:     rows,
		Metadata: map[string]interface{}{"row_count": len(rows), "collection_timeout": timeout.String()},
	}, nil
}

// Stream subscribes to MQTT topic(s) and returns records as they arrive
// query.Raw contains the topic filter (supports MQTT wildcards + and #)
func (a *MQTTAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	topic := query.Raw
	if topic == "" {
		topic = "#" // Subscribe to all topics
	}

	qos := byte(a.config.QoS)
	if qos > 2 {
		qos = 0
	}

	bufferSize := a.config.BufferSize
	if bufferSize <= 0 {
		bufferSize = 100
	}

	recordChan := make(chan registry.Record, bufferSize)

	streamCtx, cancel := context.WithCancel(ctx)

	// Build config with message handler that sends to recordChan
	cfg, err := a.buildAutopahoConfig(streamCtx, func(m *paho.Publish) {
		record := a.parseMessageToRecord(m)
		select {
		case recordChan <- record:
		default:
			// Channel full, drop oldest behavior handled by caller
		}
	})
	if err != nil {
		cancel()
		return nil, err
	}

	// Subscribe on connection
	cfg.OnConnectionUp = func(cm *autopaho.ConnectionManager, connAck *paho.Connack) {
		log.Printf("[MQTT %s] Connected, subscribing to topic: %s (QoS %d)", a.config.ClientID, topic, qos)
		_, err := cm.Subscribe(streamCtx, &paho.Subscribe{
			Subscriptions: []paho.SubscribeOptions{
				{Topic: topic, QoS: qos},
			},
		})
		if err != nil {
			log.Printf("[MQTT %s] Subscribe error: %v", a.config.ClientID, err)
		}
	}

	cm, err := autopaho.NewConnection(streamCtx, cfg)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create MQTT stream connection: %w", err)
	}

	// Wait for initial connection
	waitCtx, waitCancel := context.WithTimeout(ctx, 10*time.Second)
	defer waitCancel()
	if err := cm.AwaitConnection(waitCtx); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to connect for streaming: %w", err)
	}

	// Cleanup goroutine
	go func() {
		defer close(recordChan)
		<-streamCtx.Done()
		disconnectCtx, disconnectCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer disconnectCancel()
		_ = cm.Disconnect(disconnectCtx)
	}()

	// Store cancel so Close() can stop it
	a.mu.Lock()
	a.cancelFunc = cancel
	a.mu.Unlock()

	return recordChan, nil
}

// Write publishes a message to an MQTT topic
// cmd.Target is the topic to publish to
// cmd.Payload is the message payload
func (a *MQTTAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	if err := a.Connect(ctx); err != nil {
		return nil, err
	}

	a.mu.RLock()
	cm := a.cm
	a.mu.RUnlock()

	if cm == nil {
		return nil, fmt.Errorf("not connected")
	}

	topic := cmd.Target
	if topic == "" {
		return &registry.WriteResult{
			Success:   false,
			Message:   "topic (target) is required for MQTT publish",
			Timestamp: time.Now(),
		}, fmt.Errorf("topic is required")
	}

	// Marshal payload to JSON
	payload, err := json.Marshal(cmd.Payload)
	if err != nil {
		return &registry.WriteResult{
			Success:   false,
			Message:   fmt.Sprintf("failed to marshal payload: %v", err),
			Timestamp: time.Now(),
		}, err
	}

	qos := byte(a.config.QoS)
	if qos > 2 {
		qos = 0
	}

	publishCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, err = cm.Publish(publishCtx, &paho.Publish{
		QoS:     qos,
		Topic:   topic,
		Payload: payload,
	})
	if err != nil {
		return &registry.WriteResult{
			Success:   false,
			Message:   err.Error(),
			Timestamp: time.Now(),
		}, err
	}

	return &registry.WriteResult{
		Success:   true,
		Message:   fmt.Sprintf("Published to %s", topic),
		Timestamp: time.Now(),
	}, nil
}

// parseMessageToRecord converts an MQTT message to a Record
func (a *MQTTAdapter) parseMessageToRecord(m *paho.Publish) registry.Record {
	serverTS := time.Now().Unix()
	record := registry.Record{
		"topic":     m.Topic,
		"timestamp": serverTS,
	}

	// Try to parse payload as JSON
	var payload map[string]interface{}
	if err := json.Unmarshal(m.Payload, &payload); err != nil {
		// Not JSON, store as raw string
		record["payload"] = string(m.Payload)
		return record
	}

	// Merge JSON fields into record
	for k, v := range payload {
		record[k] = v
	}

	// Always ensure timestamp is a valid Unix epoch.
	// If the payload had a "timestamp" field, validate it — if it doesn't look like
	// a Unix timestamp (too small), keep the server timestamp instead.
	if payloadTS, exists := payload["timestamp"]; exists {
		normalized := normalizeTimestamp(payloadTS)
		if ts, ok := normalized.(int64); ok && ts > 1000000000 {
			// Valid Unix timestamp (after ~2001)
			record["timestamp"] = ts
		} else {
			// Payload timestamp is not a valid epoch (e.g., just a year like 2026)
			// Keep as a separate field and use server time
			record["timestamp"] = serverTS
			record["payload_timestamp"] = payloadTS
		}
	}

	return record
}
