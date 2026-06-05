// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { DISPLAY_CONTENT_FORMATS } from './controls/ControlTextLabel';
import { resolveTextTemplate } from '../utils/resolveTextTemplate';
import './PanelText.scss';

// Map legacy named sizes to pixel values
const LEGACY_SIZE_MAP = { sm: 14, md: 20, lg: 28, xl: 36 };

/**
 * PanelText — renders native text panel content.
 * Reuses DISPLAY_CONTENT_FORMATS for date/time formatting.
 *
 * Title content may embed {{variable:NAME}} tokens resolved at view time from
 * `variableValues`. The legacy `display_content: 'dashboard_variable'` type is
 * still honored (it predates the inline tokens) via `dashboardVariableText`.
 */
function PanelText({ config, dashboardVariableText = '', variableValues = {} }) {
  const displayContent = config?.display_content || 'title';
  const content = config?.content || '';
  const align = config?.align || 'center';
  const rawSize = config?.size || 20;
  const fontSize = typeof rawSize === 'string' ? (LEGACY_SIZE_MAP[rawSize] || 20) : rawSize;

  const formatDef = DISPLAY_CONTENT_FORMATS[displayContent];
  const isDateTime = formatDef?.isDateTime ?? false;

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!isDateTime) return;
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [isDateTime]);

  let displayText;
  if (formatDef?.dashboardVariable) {
    // Legacy: the whole panel shows the connection-swap variable's value
    // (selected connection label, or the baseline when nothing is selected).
    displayText = dashboardVariableText;
  } else if (isDateTime) {
    displayText = formatDef.format(now);
  } else {
    // Title content — resolve any embedded {{variable:NAME}} tokens.
    displayText = resolveTextTemplate(content, variableValues);
  }

  return (
    <div className={`panel-text panel-text--${align}`} style={{ fontSize: `${fontSize}px` }}>
      <div className="panel-text-content">{displayText || '\u00A0'}</div>
    </div>
  );
}

export default PanelText;
