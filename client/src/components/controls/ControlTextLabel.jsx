// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { registerControl } from './controlRegistry';
import './controls.scss';

// Date/time format definitions — shared with ControlEditor
export const DISPLAY_CONTENT_FORMATS = {
  title:          { label: 'Display Title',      isDateTime: false },
  date_short:     { label: 'Short Date',         isDateTime: true, format: (d) => d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' }) },
  date_long:      { label: 'Long Date',          isDateTime: true, format: (d) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) },
  date_medium:    { label: 'Medium Date',         isDateTime: true, format: (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) },
  time_12:        { label: '12-Hour Time',        isDateTime: true, format: (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) },
  time_24:        { label: '24-Hour Time',        isDateTime: true, format: (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) },
  datetime_short: { label: 'Short Date + Time',  isDateTime: true, format: (d) => `${d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })}` },
  datetime_long:  { label: 'Long Date + Time',   isDateTime: true, format: (d) => `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}` },
  // Dashboard-variable content: shows the currently-selected connection's name
  // (falls back to the baseline connection when nothing is selected). Only
  // meaningful in dashboard text PANELS (the viewer supplies the live value);
  // controls don't have a dashboard variable, so the control editor omits it.
  dashboard_variable: { label: 'Dashboard Variable (connection)', isDateTime: false, dashboardVariable: true },
};

function ControlTextLabel({ control }) {
  const uiConfig = control.control_config?.ui_config || {};
  const displayContent = uiConfig.display_content || 'title';
  const titleText = control.title || control.name || '';
  const align = uiConfig.align || 'center';
  const size = uiConfig.size || 'md';

  const formatDef = DISPLAY_CONTENT_FORMATS[displayContent];
  const isDateTime = formatDef?.isDateTime ?? false;

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!isDateTime) return;
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [isDateTime]);

  const displayText = isDateTime ? formatDef.format(now) : titleText;

  return (
    <div className={`control-text-label control-text-label--${size} control-text-label--${align}`}>
      <div className="text-label-text">{displayText}</div>
    </div>
  );
}

ControlTextLabel.propTypes = {
  control: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    title: PropTypes.string,
    control_config: PropTypes.shape({
      ui_config: PropTypes.object
    })
  }).isRequired
};

registerControl('text_label', ControlTextLabel);
export default ControlTextLabel;
