// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import { Tooltip } from '@carbon/react';
import { StringText } from '@carbon/icons-react';
import './VariableIndicator.scss';

/**
 * VariableIndicator — a small inline badge marking a component whose query or
 * filter uses the `{{dashboard-variable}}` token (component.uses_dashboard_variable).
 * Such a component won't render meaningful data until a dashboard variable
 * value is supplied, so authors should recognize it when picking one.
 *
 * Rendered identically across surfaces (components list, component picker,
 * dashboard panel header) so the meaning reads the same everywhere. Renders
 * nothing when `active` is false, so callers can drop it in unconditionally.
 *
 * @param {boolean} active  whether the component uses a dashboard variable
 * @param {number}  size    icon size in px (default 16)
 */
function VariableIndicator({ active = false, size = 16 }) {
  if (!active) return null;
  return (
    <Tooltip
      align="top"
      label="Uses a dashboard variable — needs a value to render."
      className="variable-indicator-tooltip"
    >
      <span
        className="variable-indicator"
        aria-label="Uses a dashboard variable"
      >
        <StringText size={size} />
      </span>
    </Tooltip>
  );
}

VariableIndicator.propTypes = {
  active: PropTypes.bool,
  size: PropTypes.number,
};

export default VariableIndicator;
