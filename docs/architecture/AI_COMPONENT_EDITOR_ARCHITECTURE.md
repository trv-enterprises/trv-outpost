# AI Chart Editor Architecture

This document describes the interfaces between the AI Chart Editor, the LLM (Claude), and the Dashboard services.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (React)                                       │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  AIBuilderPage.jsx                                                                  │
│       │                                                                             │
│       └── useAISession.js (hook)                                                    │
│              │  - manages session state                                             │
│              │  - WebSocket subscription                                            │
│              │  - optimistic message updates                                        │
│              │                                                                      │
│              └── apiClient.js                                                       │
│                     │  - createAISession()                                          │
│                     │  - sendAIMessage()                                            │
│                     │  - saveAISession()                                            │
│                     │  - cancelAISession()                                          │
│                     │  - getAISessionWebSocketURL()                                 │
└─────────────────────┼───────────────────────────────────────────────────────────────┘
                      │ HTTP/WebSocket
                      ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              BACKEND (Go)                                           │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  handlers/ai_session_handler.go                                                     │
│       │                                                                             │
│       ├── POST /api/ai/sessions          → CreateSession()                          │
│       ├── GET  /api/ai/sessions/:id      → GetSession()                             │
│       ├── POST /api/ai/sessions/:id/messages → SendMessage()                        │
│       ├── POST /api/ai/sessions/:id/save → SaveSession()                            │
│       ├── DELETE /api/ai/sessions/:id    → CancelSession()                          │
│       └── GET  /api/ai/sessions/:id/ws   → HandleWebSocket()                        │
│                                                                                     │
│  service/ai_session_service.go                                                      │
│       │  - Session lifecycle management                                             │
│       │  - Chart draft creation/management                                          │
│       │  - WebSocket client registry                                                │
│       │  - Event broadcasting                                                       │
│       │                                                                             │
│       └── ai/agent.go                                                               │
│              │  - Anthropic Claude SDK client                                       │
│              │  - Agentic loop (max 10 turns)                                       │
│              │  - Message history management                                        │
│              │  - Tool execution coordination                                       │
│              │                                                                      │
│              ├── ai/tools.go (Tool Definitions)                                     │
│              │      - GetAnthropicTools() returns tool schemas                      │
│              │                                                                      │
│              ├── ai/tool_executor.go (Tool Implementation)                          │
│              │      - ExecuteTool() dispatches to handlers                          │
│              │      - Updates charts in MongoDB                                     │
│              │      - Broadcasts updates via ComponentHub                               │
│              │                                                                      │
│              └── ai/system_prompt.go                                                │
│                     - ~500 lines of instructions                                    │
│                     - Chart templates (line, bar, gauge, pie)                       │
│                     - Data source workflow guidance                                 │
│                     - Carbon Design System colors                                   │
└─────────────────────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           ANTHROPIC CLAUDE API                                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  Model: claude-sonnet-4-20250514                                                    │
│  Max Tokens: 4096 per response                                                      │
│  Tool Choice: Forced on first turn (ToolChoiceAny)                                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Token Consumption Analysis

### Per-Request Token Breakdown

| Component | Estimated Tokens | Notes |
|-----------|-----------------|-------|
| **System Prompt** | ~4,000-5,000 | Sent with every API call |
| **Message History** | Variable | Grows with conversation |
| **Tool Definitions** | ~2,000 | 17 tools, sent with every call |
| **User Message** | ~50-200 | User's input |
| **Tool Results** | ~200-2,000 per tool | Returned data (e.g., query results) |
| **Assistant Response** | ~500-2,000 | Generated text + tool calls |

### Token Growth Pattern

```
Turn 1: system_prompt + tools + user_msg
        ~6,000-7,000 tokens input

Turn 2: system_prompt + tools + history(turn1) + tool_results + user_msg
        ~8,000-12,000 tokens input

Turn 3: system_prompt + tools + history(turn1-2) + tool_results + user_msg
        ~12,000-20,000 tokens input

...continues to grow with each turn
```

### Key Token Consumers

1. **System Prompt (4,000-5,000 tokens)** - Largest fixed cost
   - Chart templates with full React code examples
   - Prometheus/EdgeLake workflow documentation
   - Carbon Design System color tokens
   - Best practices and critical rules

2. **Tool Definitions (2,000 tokens)** - Sent every request
   - 17 tools with JSON schemas
   - Detailed descriptions

3. **Conversation History** - Unbounded growth
   - All previous user messages
   - All previous assistant responses
   - All tool calls with inputs AND outputs (stored in message)

4. **Tool Results** - Can be large
   - `query_datasource` returns row data
   - `get_chart_state` returns full chart object
   - Schema discovery returns table/column info

---

## Opportunities to Reduce Token Consumption

### 1. System Prompt Optimization

**Current State**: ~4,000-5,000 tokens of instructions, templates, and examples.

**Opportunities**:

| Strategy | Savings | Implementation |
|----------|---------|----------------|
| **Lazy-load templates** | ~1,500 tokens | Only include chart templates when `set_custom_code` is likely needed |
| **Conditional data source docs** | ~800 tokens | Only include Prometheus/EdgeLake docs if those data sources exist |
| **Remove redundant rules** | ~200 tokens | Several "CRITICAL" rules are repeated |
| **Compress color palette** | ~100 tokens | Use shorthand or reference instead of listing all colors |

**Implementation Approach**:
```go
// Dynamic system prompt based on available data sources
func BuildSystemPrompt(datasourceTypes []string) string {
    prompt := CoreRules + ChartBasics

    if contains(datasourceTypes, "prometheus") {
        prompt += PrometheusSection
    }
    if contains(datasourceTypes, "edgelake") {
        prompt += EdgeLakeSection
    }
    // Only include templates if chart_type not yet set
    if needsTemplates {
        prompt += ChartTemplates
    }
    return prompt
}
```

### 2. Conversation History Management

**Current State**: Full history sent every turn, including all tool inputs/outputs.

**Opportunities**:

| Strategy | Savings | Trade-off |
|----------|---------|-----------|
| **Sliding window** | 50-80% | Last N messages only; may lose early context |
| **Summarize old turns** | 40-60% | LLM summarizes early turns into condensed form |
| **Omit tool outputs from history** | 30-50% | Tool results often large; LLM may re-query |
| **Truncate large tool results** | 20-40% | Limit rows in query results stored in history |

**Implementation Approach**:
```go
// In buildMessages(), limit history
func (a *Agent) buildMessages(history []models.AIMessage, newUserContent string) []anthropic.MessageParam {
    // Keep only last 6 messages (3 turns)
    if len(history) > 6 {
        history = history[len(history)-6:]
    }

    // Truncate tool outputs in history
    for i := range history {
        for j := range history[i].ToolCalls {
            if len(history[i].ToolCalls[j].Output) > 1000 {
                history[i].ToolCalls[j].Output = truncateJSON(history[i].ToolCalls[j].Output, 1000)
            }
        }
    }
    // ... rest of conversion
}
```

### 3. Tool Result Optimization

**Current State**: Full query results returned to LLM.

**Opportunities**:

| Strategy | Savings | Implementation |
|----------|---------|----------------|
| **Limit query rows** | 50-80% of tool result | Already has `limit` param, enforce max |
| **Truncate column values** | 20-30% | Long strings (code, descriptions) truncated |
| **Schema caching** | Avoid repeat calls | Cache schema in session, don't re-fetch |
| **Smarter chart state** | 30-40% | Only return changed fields, not full chart |

**Implementation Approach**:
```go
// In executeQueryDatasource
const MaxRowsForAI = 5  // Reduced from 10
const MaxValueLength = 100

func (e *ToolExecutor) executeQueryDatasource(...) (*ToolResult, error) {
    // Enforce max rows
    if limit > MaxRowsForAI {
        limit = MaxRowsForAI
    }

    // Truncate long values
    for i, row := range response.ResultSet.Rows {
        for j, val := range row {
            if str, ok := val.(string); ok && len(str) > MaxValueLength {
                response.ResultSet.Rows[i][j] = str[:MaxValueLength] + "..."
            }
        }
    }
}
```

### 4. Tool Schema Optimization

**Current State**: All 17 tools sent with every request.

**Opportunities**:

| Strategy | Savings | Trade-off |
|----------|---------|-----------|
| **Phased tool availability** | 30-50% | Only chart-edit tools after data source selected |
| **Combine related tools** | 10-20% | Merge `update_*` tools into fewer with more params |

**Implementation Approach**:
```go
// Phase 1 tools: discovery
var DiscoveryTools = []string{
    "list_datasources",
    "get_datasource_schema",
    "get_prometheus_schema",
    "get_edgelake_schema",
    "query_datasource",
    "update_chart_config",
}

// Phase 2 tools: after data source set
var ConfigTools = []string{
    "update_data_mapping",
    "update_query_config",
    "update_filters",
    // ... etc
}

func GetAnthropicTools(phase int) []anthropic.ToolUnionParam {
    if phase == 1 {
        return filterTools(DiscoveryTools)
    }
    return allTools
}
```

### 5. Request-Level Optimizations

**Current State**: MaxTokens=4096 for every request.

**Opportunities**:

| Strategy | Savings | Implementation |
|----------|---------|----------------|
| **Dynamic max_tokens** | Output tokens | Lower for simple responses, higher for code |
| **Early stopping** | Prevent runaway | Stop after chart is configured, don't continue |
| **Batch tool calls** | Fewer turns | Encourage multiple tools per turn |

---

## Recommended Priority Order

1. **Sliding Window History (High Impact, Low Risk)**
   - Implement 6-message window
   - Keep first user message for context
   - Estimated savings: 40-60% on long conversations

2. **Truncate Tool Outputs (High Impact, Low Risk)**
   - Limit stored query results to 5 rows
   - Truncate long string values
   - Estimated savings: 20-40% per tool call

3. **Dynamic System Prompt (Medium Impact, Medium Risk)**
   - Conditional data source documentation
   - Lazy-load templates
   - Estimated savings: 20-30% on system prompt

4. **Phased Tool Availability (Medium Impact, Medium Risk)**
   - Reduce tool schema size per request
   - Estimated savings: 15-25%

---

## API Reference

### REST Endpoints

#### POST /api/ai/sessions
Create a new AI session.

**Request:**
```json
{
  "chart_id": "optional-existing-chart-uuid",
  "initial_message": "optional first message"
}
```

**Response:** `201 Created`
```json
{
  "session": {
    "id": "session-uuid",
    "chart_id": "chart-uuid",
    "chart_version": 1,
    "messages": [],
    "status": "active",
    "created": "2026-01-15T10:30:00Z",
    "updated": "2026-01-15T10:30:00Z"
  },
  "chart": {
    "id": "chart-uuid",
    "name": "",
    "version": 1,
    "status": "draft",
    ...
  }
}
```

#### POST /api/ai/sessions/:id/messages
Send a user message.

**Request:**
```json
{
  "content": "Create a line chart showing temperature over time"
}
```

**Response:** `202 Accepted`
```json
{
  "message_id": "msg-uuid",
  "status": "processing"
}
```

Processing happens asynchronously. Results delivered via WebSocket.

#### GET /api/ai/sessions/:id/ws
WebSocket connection for real-time updates.

**Events Received:**
```json
{"type": "connected", "data": {"session_id": "..."}, "timestamp": "..."}
{"type": "thinking", "data": {"thinking": true}, "timestamp": "..."}
{"type": "message", "data": {"message": {...}}, "timestamp": "..."}
{"type": "component_update", "data": {"chart": {...}}, "timestamp": "..."}
{"type": "error", "data": {"error": "...", "code": "..."}, "timestamp": "..."}
{"type": "ping", "data": {"timestamp": "..."}, "timestamp": "..."}
```

#### POST /api/ai/sessions/:id/save
Save the session (publish draft as final).

**Request:**
```json
{
  "name": "My Temperature Chart"
}
```

**Response:** `200 OK` - Returns the saved Chart object.

#### DELETE /api/ai/sessions/:id
Cancel session and discard draft.

**Response:** `204 No Content`

---

## Tool Definitions

The AI has access to 17 tools for chart manipulation and data discovery:

### Chart Configuration Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `update_chart_config` | Set chart type and description | `chart_type`, `description` |
| `update_data_mapping` | Configure axes and data source | `connection_id`, `x_axis`, `y_axis`, `group_by` |
| `update_query_config` | Set query and refresh interval | `query`, `query_type`, `refresh_interval` |
| `update_filters` | Add data filters | `filters[]` |
| `update_aggregation` | Configure aggregation | `type`, `field`, `sort_by` |
| `update_sliding_window` | Time window for streaming | `duration`, `timestamp_col` |
| `update_time_bucket` | Time-bucketed aggregation | `interval`, `function`, `value_cols` |
| `update_chart_options` | ECharts options | `title`, `show_legend`, `color_palette`, etc. |
| `set_custom_code` | Set React component code | `component_code` |

### Data Discovery Tools

| Tool | Description | Returns |
|------|-------------|---------|
| `list_datasources` | List all data sources | `[{id, name, type, description}]` |
| `get_datasource_schema` | SQL schema | `{tables: [{name, columns}]}` |
| `get_prometheus_schema` | Prometheus metrics/labels | `{metrics: [], labels: []}` |
| `get_edgelake_schema` | EdgeLake schema (cascading) | Databases → Tables → Columns |
| `query_datasource` | Execute test query | `{columns: [], rows: []}` |
| `preview_data` | Sample data for current config | `{columns: [], rows: []}` |
| `get_chart_state` | Current chart object | Full Chart model |

### Utility Tools

| Tool | Description |
|------|-------------|
| `suggest_missing_tools` | Explain unsupported features |

---

## Data Flow: User Message → Chart Update

```
1. User types message in AIBuilderPage
           │
2. useAISession.sendMessage()
   - Optimistically add to messages[]
   - POST /api/ai/sessions/:id/messages
           │
3. AISessionHandler.SendMessage()
   - Save user message to DB
   - Return 202 Accepted immediately
   - Spawn goroutine for AI processing
           │
4. Agent.ProcessMessage() [async goroutine]
   - Send "thinking" event via WebSocket
   - Build Anthropic message history
   - Loop (max 10 turns):
           │
     4a. Call Anthropic API with:
         - System prompt (~4K tokens)
         - Tools (17 definitions, ~2K tokens)
         - Message history (variable)
         - User message
           │
     4b. Parse response:
         - Extract text content
         - Extract tool_use blocks
           │
     4c. If tool calls:
         - Execute each tool via ToolExecutor
         - Update chart in MongoDB
         - Broadcast component_update via ComponentHub
         - Add tool results to conversation
         - Continue loop
           │
     4d. If no tool calls:
         - Save assistant message
         - Send message event via WebSocket
         - Exit loop
           │
5. WebSocket delivers events to frontend:
   - "thinking" → show spinner
   - "component_update" → update preview
   - "message" → add to chat history
           │
6. User sees updated chart preview and AI response
```

---

## Session Lifecycle

```
                 ┌─────────────────────┐
                 │   No Session        │
                 └──────────┬──────────┘
                            │ createAISession()
                            ▼
                 ┌─────────────────────┐
                 │   Active Session    │◄──────────────┐
                 │   - Draft chart     │               │
                 │   - WebSocket conn  │               │ sendMessage()
                 └──────────┬──────────┘───────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
    saveSession()                  cancelSession()
              │                           │
              ▼                           ▼
   ┌─────────────────────┐     ┌─────────────────────┐
   │   Completed         │     │   Cancelled         │
   │   - Chart published │     │   - Draft deleted   │
   │   - Session archived│     │   - Session deleted │
   └─────────────────────┘     └─────────────────────┘
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `client/src/pages/AIBuilderPage.jsx` | Main AI builder UI |
| `client/src/hooks/useAISession.js` | Session state management |
| `client/src/api/client.js` | API client methods |
| `server-go/internal/handlers/ai_session_handler.go` | HTTP/WebSocket handlers |
| `server-go/internal/service/ai_session_service.go` | Business logic |
| `server-go/internal/ai/agent.go` | Anthropic SDK integration |
| `server-go/internal/ai/tools.go` | Tool definitions |
| `server-go/internal/ai/tool_executor.go` | Tool implementations |
| `server-go/internal/ai/system_prompt.go` | LLM instructions |
| `server-go/internal/models/ai_session.go` | Data models |
| `server-go/internal/hub/component_hub.go` | Real-time chart updates |

---

*Last Updated: 2026-02-08*
