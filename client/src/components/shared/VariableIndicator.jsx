// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import { Tooltip, Tag } from '@carbon/react';
import './VariableIndicator.scss';

/**
 * VariableIndicator — a small "var" badge marking a component whose query or
 * filter uses the `{{dashboard-variable}}` token (component.uses_dashboard_variable).
 * Such a component won't render meaningful data until a dashboard variable
 * value is supplied, so authors should recognize it when picking one.
 *
 * Rendered as a Carbon Tag (same chip treatment as the surrounding type /
 * namespace / user-tag badges) so it reads consistently across surfaces
 * (components list, component picker, dashboard panel header). Renders nothing
 * when `active` is false, so callers can drop it in unconditionally.
 *
 * @param {boolean} active  whether the component uses a dashboard variable
 * @param {string}  size    Carbon Tag size ('sm' | 'md', default 'sm')
 */
function VariableIndicator({ active = false, size = 'sm' }) {
  if (!active) return null;
  return (
    <Tooltip
      align="top"
      label="Uses a dashboard variable — needs a value to render."
      className="variable-indicator-tooltip"
    >
      <span className="variable-indicator" aria-label="Uses a dashboard variable">
        <Tag type="outline" size={size}>var</Tag>
      </span>
    </Tooltip>
  );
}

VariableIndicator.propTypes = {
  active: PropTypes.bool,
  size: PropTypes.oneOf(['sm', 'md']),
};

export default VariableIndicator;
