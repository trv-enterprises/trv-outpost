// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"fmt"
	"strings"
)

// buildSystemPrompt assembles the per-turn system prompt by walking
// the prompt layers. Today's layers:
//
//   1. Role / behavior preamble (the same defaultSystemPrompt() text)
//   2. Caller context — step 6 will inject namespace + caps + date
//      here; today it's a placeholder.
//   3. Tier-B catalog — names + one-line descriptions of every
//      Tier-B tool the model can call describe_tool() on.
//
// Tier-A tool *schemas* go in the request via the Tools field, not
// the system prompt — that's how the Anthropic SDK wants them. This
// function only owns the textual portion.
//
// Step 6 reworks the preamble; step 7+ may add a "workspace" layer
// (pinned context) and a compaction layer.
func buildSystemPrompt(reg *ToolRegistry) string {
	var b strings.Builder

	b.WriteString(defaultSystemPrompt())
	b.WriteString("\n\n")

	// Caller context placeholder. Step 6 will template namespace,
	// capabilities, and date here.
	b.WriteString("## Caller context\n")
	b.WriteString("(Caller identity will be wired in step 11 alongside SSE auth.)\n\n")

	// Tier-B catalog — names + descriptions, no schemas. The model
	// calls describe_tool(name) to get the schema when it decides
	// to use one of these.
	tierB := reg.tierBCatalog()
	if len(tierB) > 0 {
		b.WriteString("## Additional tools available on request\n")
		b.WriteString("These tools exist but their full schemas are not loaded by default. To use one, call `describe_tool` with the tool name (or a list of names) to get the input schema. After describe_tool returns, you can invoke the tool normally in the same or any subsequent turn.\n\n")
		for _, entry := range tierB {
			fmt.Fprintf(&b, "- **%s** — %s\n", entry.Name, entry.Description)
		}
		b.WriteString("\n")
	}

	return b.String()
}
