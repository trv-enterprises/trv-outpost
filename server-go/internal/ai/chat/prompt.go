// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"fmt"
	"strings"
)

// buildSystemPrompt assembles the per-turn system prompt by walking
// the prompt layers:
//
//   1. Role / behavior preamble — the same on every turn for every
//      caller. Encodes the assistant's purpose and the hard rules
//      (structured config before custom code, confirm before
//      destructive ops, etc.).
//   2. Caller context — namespace, capabilities, date templated
//      from the per-message CallerCtx.
//   3. Tier-B catalog — names + one-line descriptions of every
//      Tier-B tool. Schemas load on demand via describe_tool.
//
// Tier-A tool *schemas* go in the request via the Tools field, not
// the system prompt — that's what the Anthropic SDK wants. This
// function only owns the textual portion.
//
// Step 7+ may add a "workspace" layer (pinned context) and a
// compaction layer for long conversations.
func buildSystemPrompt(reg *ToolRegistry, caller *CallerCtx) string {
	var b strings.Builder

	b.WriteString(rolePreamble())
	b.WriteString("\n\n")

	b.WriteString(callerContextSection(caller))
	b.WriteString("\n")

	tierB := reg.tierBCatalog()
	if len(tierB) > 0 {
		b.WriteString("## Additional tools available on request\n")
		b.WriteString("These tools exist but their full schemas are not loaded by default. To use one, call `describe_tool` with the tool name(s) to get the input schema. After describe_tool returns, you can invoke the tool normally in the same or any subsequent turn — don't describe a tool you don't intend to use.\n\n")
		for _, entry := range tierB {
			fmt.Fprintf(&b, "- **%s** — %s\n", entry.Name, entry.Description)
		}
		b.WriteString("\n")
	}

	return b.String()
}

// rolePreamble is the assistant-identity portion of the prompt. It
// doesn't change between callers, so we keep it in one place. The
// hard rules baked in here are the ones we don't want to re-litigate
// per conversation:
//
//   - Always prefer structured config over custom code (memory:
//     chat-agent-prefer-structured-config).
//   - Confirm before destructive ops.
//   - Never claim to have done something you didn't.
//
// Tone: terse, builder-focused. Mirrors the Component AI agent's
// system-prompt voice.
func rolePreamble() string {
	return `You are the TRVE Dashboard Assistant — a builder agent inside a self-hosted data dashboard product. Users come to you to create connections to data sources (SQL, API, MQTT, EdgeLake, etc.), build components (charts, controls, displays), and assemble those into dashboards. When the user asks for something buildable, build it. When they ask a question, answer it. Use the tools available rather than describing what you would do.

# Behavior rules

- **Prefer structured component config over custom code.** When creating a chart, set ` + "`component_type`, `chart_type`, `connection_id`, `data_mapping`, `query_config`" + ` and let the server's codegen produce the React component. Only set ` + "`use_custom_code=true`" + ` and write component_code by hand when the structured config genuinely cannot represent what the user asked for — and even then, mention it explicitly so the user can confirm.
- **Confirm before destructive operations.** Delete, drop, replace, overwrite — ask first. Read operations and additive create operations don't need confirmation.
- **Never claim you did something you didn't.** If a tool returned an error, surface it. If a tool isn't available to you (capability gate, or you'd need ` + "`describe_tool`" + ` first), say so.
- **Stay in the user's namespace.** Every create call should use the namespace below. Don't switch namespaces without being explicitly asked.
- **Don't fetch large results you don't need.** The result-store layer summarizes oversized tool returns; the summary usually has what you need. Only call ` + "`get_full_result`" + ` when the summary doesn't answer the question.`
}

// callerContextSection renders the per-caller block: who, where,
// when. Degrades gracefully when caller is nil or its fields are
// missing.
func callerContextSection(caller *CallerCtx) string {
	if caller == nil {
		return "# Caller context\n\nNo caller context available (anonymous request).\n"
	}

	var b strings.Builder
	b.WriteString("# Caller context\n\n")

	if caller.User != nil {
		// Display name falls back to the GUID when Name is empty so
		// pseudo-users (which have no display name) still show
		// something the model can reference.
		displayName := caller.User.Name
		if displayName == "" {
			displayName = caller.User.GUID
		}
		fmt.Fprintf(&b, "- **User:** %s", displayName)
		if caller.User.Email != "" {
			fmt.Fprintf(&b, " (%s)", caller.User.Email)
		}
		b.WriteString("\n")
		if len(caller.User.Capabilities) > 0 {
			caps := make([]string, 0, len(caller.User.Capabilities))
			for _, c := range caller.User.Capabilities {
				caps = append(caps, string(c))
			}
			fmt.Fprintf(&b, "- **Capabilities:** %s\n", strings.Join(caps, ", "))
		}
	} else {
		b.WriteString("- **User:** (identity not resolved)\n")
	}

	namespace := caller.Namespace
	if namespace == "" {
		namespace = "default"
	}
	fmt.Fprintf(&b, "- **Active namespace:** %s\n", namespace)

	if !caller.Now.IsZero() {
		fmt.Fprintf(&b, "- **Today:** %s\n", caller.Now.Format("2006-01-02 (Monday)"))
	}

	return b.String()
}
