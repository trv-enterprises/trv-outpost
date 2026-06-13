// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import './AgentWelcome.scss';

/**
 * AgentWelcome — the empty-state shown by an AI surface before any message:
 * a centered icon, heading, description, and a column of clickable suggestion
 * chips that pre-fill the composer. Shared by BOTH AI surfaces (the Component
 * agent / "Edit with AI" and the Dashboard Assistant) so they present the same
 * polished welcome — see issue #40 (UX parity).
 *
 * Props:
 *   icon        — a rendered icon node (e.g. <AiIcon size={48} />)
 *   heading     — short title string
 *   description — one-line explainer string
 *   suggestionsLabel — label above the chips (default "Try one of these:")
 *   suggestions — array of { label, prompt } | string. Clicking a chip calls
 *                 onSuggestion(prompt). A bare string is used as both.
 *   onSuggestion — (prompt) => void; fills the composer with the prompt.
 */
export default function AgentWelcome({
  icon,
  heading,
  description,
  suggestionsLabel = 'Try one of these:',
  suggestions = [],
  onSuggestion,
}) {
  return (
    <div className="agent-welcome">
      {icon && <div className="agent-welcome__icon">{icon}</div>}
      {heading && <h3 className="agent-welcome__heading">{heading}</h3>}
      {description && <p className="agent-welcome__description">{description}</p>}
      {suggestions.length > 0 && (
        <div className="agent-welcome__suggestions">
          {suggestionsLabel && (
            <p className="agent-welcome__suggestions-label">{suggestionsLabel}</p>
          )}
          <div className="agent-welcome__suggestion-buttons">
            {suggestions.map((s, i) => {
              const label = typeof s === 'string' ? s : s.label;
              const prompt = typeof s === 'string' ? s : s.prompt;
              return (
                <button
                  key={i}
                  type="button"
                  className="agent-welcome__suggestion-btn"
                  onClick={() => onSuggestion?.(prompt)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
