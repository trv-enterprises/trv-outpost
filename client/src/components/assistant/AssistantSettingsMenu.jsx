// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { OverflowMenu, OverflowMenuItem } from '@carbon/react';
import {
  Settings,
  TrashCan,
  Download,
  DocumentExport,
  Checkmark,
} from '@carbon/icons-react';

/**
 * AssistantSettingsMenu — the cog popover inside the sidecard
 * header. OverflowMenu mirrors the same pattern AccountMenu uses
 * elsewhere in the header so the visual language stays consistent.
 *
 * Props:
 *   - onClearChat()        — drops the current session.
 *   - onExportMarkdown()   — wires in step 13; passing undefined
 *                            hides the item.
 *   - onExportJson()       — same.
 *   - expandToolCalls       — current pref value (bool).
 *   - onToggleExpandToolCalls()
 *   - showTokenUsage        — current pref value (bool).
 *   - onToggleShowTokenUsage()
 *
 * The two toggle items use a left-side checkmark to indicate
 * current state — Carbon's OverflowMenuItem doesn't ship a true
 * "menu checkbox" so we mimic it with an inline icon column. The
 * empty space when not checked is intentional — keeps every row
 * the same horizontal layout so the eye can scan vertically.
 */
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
    <OverflowMenu
      aria-label="Assistant settings"
      renderIcon={() => <Settings size={16} />}
      // direction="bottom" tells Carbon to open the menu downward
      // from the trigger. The `flipped` prop is intentionally
      // omitted — it interacts with direction in a way that
      // overrode our request and made the menu render upward
      // (clipped by the app header above the sidecard).
      direction="bottom"
      size="sm"
      menuOptionsClass="assistant-settings-menu"
    >
      <OverflowMenuItem
        itemText={(
          <span className="assistant-settings-menu__row">
            <TrashCan size={16} />
            <span>Clear chat</span>
          </span>
        )}
        onClick={onClearChat}
      />

      <OverflowMenuItem
        itemText={(
          <span className="assistant-settings-menu__row">
            <Download size={16} />
            <span>Export as Markdown</span>
          </span>
        )}
        onClick={onExportMarkdown}
        disabled={!onExportMarkdown}
        hasDivider
      />
      <OverflowMenuItem
        itemText={(
          <span className="assistant-settings-menu__row">
            <DocumentExport size={16} />
            <span>Export as JSON</span>
          </span>
        )}
        onClick={onExportJson}
        disabled={!onExportJson}
      />

      <OverflowMenuItem
        itemText={(
          <span className="assistant-settings-menu__row assistant-settings-menu__row--toggle">
            <span className="assistant-settings-menu__check">
              {expandToolCalls && <Checkmark size={16} />}
            </span>
            <span>Expand tool calls by default</span>
          </span>
        )}
        onClick={onToggleExpandToolCalls}
        hasDivider
      />
      <OverflowMenuItem
        itemText={(
          <span className="assistant-settings-menu__row assistant-settings-menu__row--toggle">
            <span className="assistant-settings-menu__check">
              {showTokenUsage && <Checkmark size={16} />}
            </span>
            <span>Show token usage</span>
          </span>
        )}
        onClick={onToggleShowTokenUsage}
      />
    </OverflowMenu>
  );
}
