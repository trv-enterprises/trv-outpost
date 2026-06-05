---
sidebar_position: 2
---

# AI API Usage

The **AI API Usage** page (Manage mode) reports per-user AI token consumption so
an administrator can see who is using the AI features and keep spend in check.
For each user it shows today's input/output tokens against that user's daily
cap, plus a 30-day history.

## What you see

- **Global daily caps** — the default input and output token caps applied per
  user, per day. Usage resets at **UTC midnight**.
- **Per-user usage** — today's input and output tokens for each user, shown as a
  bar against their effective cap.
- **History** — the last 30 days of daily usage per user.
- **Per-user override** — an administrator can raise or lower an individual
  user's cap; the override replaces the global cap for that user.

## Current limitations

These are the things to know about how metering works today:

- **Only the Dashboard Assistant is metered.** The chat-style Dashboard
  Assistant is the only surface whose token usage is counted toward caps.
- **The Component AI agent is *not* metered.** "Create with AI" / "Edit with AI"
  in the component editor does not record usage and is not capped here.
- **The MCP bridge is *not* metered.** External agents talking to the dashboard
  over MCP do not record usage on this page.
- **Caps are per-user, per-day, and reset at UTC midnight.** There is no manual
  reset — usage rolls over automatically at the start of the next UTC day.
- **History is fixed at 30 days.** Older daily totals are not shown here.

Because only the Assistant is metered, the totals on this page are a lower bound
on overall AI activity — component-agent and MCP usage happen outside this
accounting.

## Related

- [AI Component Builder](ai-builder.md) — the (unmetered) Create/Edit-with-AI
  workflow.
- [MCP](mcp.md) — the (unmetered) external-agent bridge.
- [System Settings](system-settings.md) — where AI is enabled/disabled globally.
