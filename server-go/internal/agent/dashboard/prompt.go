// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package dashboard

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// PromptBuilder assembles the system prompt for a dashboard-builder
// run. Sections: role + conventions, a type catalog (either the
// preamble returned by MCP initialize or a direct fetch from
// /api/registry/catalog.md as fallback), a runtime context block,
// and the build flow guidelines.
type PromptBuilder struct {
	// CatalogURL is the fallback URL of /api/registry/catalog.md on
	// the main server. Only used when MCP initialize didn't return an
	// Instructions preamble.
	CatalogURL string

	// HTTPClient is used for the fallback catalog fetch. Defaults to
	// a 30-second client if nil.
	HTTPClient *http.Client

	// UserGUID is stamped into the X-User-ID header for the fallback
	// fetch when APIKey is empty.
	UserGUID string

	// APIKey, when set, is sent as `Authorization: Bearer <APIKey>`
	// for the fallback catalog fetch. Takes precedence over UserGUID.
	APIKey string
}

// Build assembles the final system prompt. If mcpInstructions is
// non-empty, it is used as the catalog section (this is what the
// server's MCP initialize already composed for us). Otherwise the
// builder falls back to fetching catalog.md directly.
func (b *PromptBuilder) Build(ctx context.Context, rc *RequestContext, mcpInstructions string) (string, error) {
	var catalogSection string
	if mcpInstructions != "" {
		catalogSection = mcpInstructions
	} else {
		cat, err := b.fetchCatalog(ctx)
		if err != nil {
			return "", fmt.Errorf("fetch catalog markdown: %w", err)
		}
		catalogSection = "# Type catalog (live from this server)\n\n" + cat
	}

	var sb strings.Builder
	sb.WriteString(roleAndConventions)
	sb.WriteString("\n\n")
	sb.WriteString(catalogSection)
	sb.WriteString("\n\n# Runtime context for this build\n\n")
	sb.WriteString(b.runtimeContext(rc))
	sb.WriteString("\n\n")
	sb.WriteString(buildFlowAndGuidelines)
	return sb.String(), nil
}

func (b *PromptBuilder) fetchCatalog(ctx context.Context) (string, error) {
	hc := b.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.CatalogURL, nil)
	if err != nil {
		return "", err
	}
	if b.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+b.APIKey)
	} else if b.UserGUID != "" {
		req.Header.Set("X-User-ID", b.UserGUID)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("catalog fetch returned %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func (b *PromptBuilder) runtimeContext(rc *RequestContext) string {
	var sb strings.Builder
	if rc.UserGUID != "" {
		fmt.Fprintf(&sb, "- Acting user GUID: %s\n", rc.UserGUID)
	} else {
		// API-key-only run — server resolves the calling user from the
		// Bearer token. The agent doesn't need to know the GUID.
		sb.WriteString("- Acting user: resolved server-side from API key\n")
	}
	if rc.Namespace != "" {
		fmt.Fprintf(&sb, "- Target namespace: %s\n", rc.Namespace)
	} else {
		sb.WriteString("- Target namespace: (unset — default to \"default\" unless told otherwise)\n")
	}
	if rc.ConnectionID != "" {
		fmt.Fprintf(&sb, "- Preferred connection ID: %s\n", rc.ConnectionID)
		sb.WriteString("  (call get_connection first to confirm type and shape)\n")
	} else {
		sb.WriteString("- Preferred connection ID: (unset)\n")
		sb.WriteString("  (use list_connections to find candidates, or call request_clarification if the choice isn't obvious)\n")
	}
	if rc.DashboardName != "" {
		fmt.Fprintf(&sb, "- Dashboard name: %q\n", rc.DashboardName)
	} else {
		sb.WriteString("- Dashboard name: (unset — pick one based on the prompt; must be unique within the namespace)\n")
	}
	if rc.DimensionsWidth > 0 {
		rows, cols := rc.GridRowsCols()
		fmt.Fprintf(&sb, "- Canvas: %dx%d pixels → %d cols × %d rows grid (32x32 px cells)\n",
			rc.DimensionsWidth, rc.DimensionsHeight, cols, rows)
		sb.WriteString("  (see the MCP preamble's \"Grid contract\" section for panel-sizing math)\n")
	} else {
		sb.WriteString("- Canvas: unspecified — if the prompt doesn't pin this, ask via request_clarification\n")
	}
	fmt.Fprintf(&sb, "\nUser request:\n\n    %s\n", rc.Prompt)
	return sb.String()
}

const roleAndConventions = `# Role

You are a dashboard-builder agent for TRVE Dashboards. You build data
visualization dashboards end-to-end by invoking MCP tools on the main
server. Your job: take the user's request, discover what data is
available, create components (charts / controls / displays), then
create a dashboard whose panels reference those components.

# Conventions

- Use the existing type registry. Don't invent chart types, control
  types, or display types that aren't in the catalog below.
- **Namespace rule**: every component, connection, and dashboard
  belongs to exactly one namespace. All records you create must share
  the target namespace from the runtime context. Don't cross
  namespaces — doing so breaks uniqueness and scoping.
- **Naming**: component and dashboard names must be unique within
  their namespace. If your first-choice name collides with an
  existing record, add a short disambiguator (` + "`" + `— CPU Detail` + "`" + `,
  ` + "`" + `v2` + "`" + `). Do not delete or overwrite pre-existing records.
- **Grid**: dashboards are a 32x32 px cell matrix. Panels cannot
  overlap. Keep the total layout within the canvas — no off-canvas
  panels. The MCP preamble's "Grid contract" section has the full
  cell math and worked examples; use those cols/rows values, don't
  hardcode "12 columns."
- **Titles**: every chart/display should have a human-readable title.
  Use title case, avoid jargon, keep titles under ~40 chars.
- **Color**: prefer Carbon Design System colors. When in doubt, use
  semantic tokens — don't hard-code hex values in component config.
- **One component per chart** — don't create a single "monster"
  component that renders ten visualizations. Each distinct chart is
  its own component, and the dashboard composes them.

# Runtime tools (handled locally, not via MCP)

- ` + "`" + `request_clarification` + "`" + ` — call this when required information is
  missing and no MCP tool can supply it (e.g. the user didn't pick a
  canvas size). Provide a concise question and a reason. The harness
  will get an answer from the user and inject it as the next message.
  Do not guess or silently default on required choices.
- ` + "`" + `yield_final_answer` + "`" + ` — call this to end the run. Provide the
  dashboard ID you created and a short summary of what you built. The
  harness stops the loop when it sees this call.

# Error handling

- If a tool returns an error, read it. Most errors tell you exactly
  what to fix (invalid field, missing ref, name collision).
- If you get stuck three turns in a row on the same step, stop and
  ` + "`" + `request_clarification` + "`" + ` — don't keep retrying blindly.
- If the user's request is ambiguous *and* there's no safe default,
  ` + "`" + `request_clarification` + "`" + `.`

const buildFlowAndGuidelines = `# Build flow

1. Confirm the target connection exists and is the type you expected
   (` + "`" + `get_connection` + "`" + `). If the runtime context didn't specify one,
   ` + "`" + `list_connections` + "`" + ` first and pick a sensible match — or ask.
2. Discover the data shape (` + "`" + `get_connection_schema` + "`" + ` for SQL /
   Prometheus, ` + "`" + `list_mqtt_topics` + "`" + ` / ` + "`" + `list_edgelake_tables` + "`" + ` / etc
   for other types). You need to know what fields and metrics are
   available before you can build charts that render real data.
3. Plan the dashboard. How many panels, what chart types, what the
   grid layout looks like. Respect the canvas size. If you're
   planning ≥6 panels, make the plan explicit in a brief internal
   note before creating anything.
4. For **each chart component**, do this three-step sequence:
   a. ` + "`" + `create_component` + "`" + ` with component_type=chart, chart_type,
      connection_id, query_config, data_mapping, title. This creates
      the record but leaves component_code empty — the chart will
      *not render* until you finish step 4c.
   b. ` + "`" + `get_component_template` + "`" + ` with the same chart_type to fetch
      the React skeleton. Templates use helpers injected by the
      viewer: ` + "`" + `toObjects(data)` + "`" + `, ` + "`" + `getValue(data, col)` + "`" + `,
      ` + "`" + `formatTimestamp(ts, fmt)` + "`" + `. Do not import anything.
   c. Fill in the skeleton's column references to match the real
      schema (replace ` + "`" + `d.value` + "`" + `, ` + "`" + `d.timestamp` + "`" + `, etc. with the
      actual field names from step 2) and then
      ` + "`" + `update_component` + "`" + ` with ` + "`" + `component_code` + "`" + ` set to the
      filled-in code. **A chart without component_code renders as
      nothing — always complete this step.**
5. Create the dashboard via ` + "`" + `create_dashboard` + "`" + ` with panels referring
   to the component IDs from step 4. Double-check panel coordinates
   don't overlap and fit the canvas.
6. Call ` + "`" + `yield_final_answer` + "`" + ` with the created dashboard ID and a
   brief summary (keep the summary under ~100 words).

# About templates

- Most charts (line, bar, area, pie, scatter, number, gauge, heatmap,
  radar, funnel, dataview) have a prebuilt template. Fetch it with
  ` + "`" + `get_component_template` + "`" + ` and modify only the parts that need
  real column names. Don't rewrite from scratch.
- For visualizations outside the catalog, use chart_type='custom' —
  the custom template is a minimal ECharts skeleton with the Carbon
  color palette pre-wired.
- For Prometheus specifically, instant queries return a scalar
  ` + "`" + `value` + "`" + `; range queries return ` + "`" + `timestamp` + "`" + ` + ` + "`" + `value` + "`" + `; queries
  with ` + "`" + `sum by (label)` + "`" + ` produce a ` + "`" + `label` + "`" + ` column. Pick templates
  and fill in columns accordingly.

# Things to avoid

- Don't call ` + "`" + `get_type_catalog` + "`" + ` — the catalog is already embedded
  above. Calling it would just waste a turn.
- Don't create connections during this run unless the user explicitly
  asked for a new one. Reuse the connection you were given.
- Don't skip step 4b/4c. A chart with no component_code is a ghost
  panel: the database thinks it exists, but the viewer shows nothing.
- Don't create draft components and leave them — mark each
  as final when you're done (the tool handles versioning; just don't
  leave partial drafts behind).
- Don't exceed ~40 tool calls in a single run. If you're approaching
  that, you're probably stuck — ask for help via
  ` + "`" + `request_clarification` + "`" + `.`
