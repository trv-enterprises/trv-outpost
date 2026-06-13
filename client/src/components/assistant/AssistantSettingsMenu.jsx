// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// The Assistant's cog menu is now the shared AgentSettingsMenu, used by both
// AI surfaces (issue #40 parity). This thin wrapper keeps the Assistant's call
// site unchanged and passes through "Show token usage" (live per-session
// counter — issue #55; the Component editor omits it).
import AgentSettingsMenu from '../shared/AgentSettingsMenu';

export default function AssistantSettingsMenu({
  onClearChat,
  onExportMarkdown,
  onExportJson,
  expandToolCalls,
  onToggleExpandToolCalls,
  showTokenUsage,
  onToggleShowTokenUsage,
}) {
  return (
    <AgentSettingsMenu
      label="Assistant settings"
      onClearChat={onClearChat}
      onExportMarkdown={onExportMarkdown}
      onExportJson={onExportJson}
      expandToolCalls={expandToolCalls}
      onToggleExpandToolCalls={onToggleExpandToolCalls}
      showTokenUsage={showTokenUsage}
      onToggleShowTokenUsage={onToggleShowTokenUsage}
    />
  );
}
