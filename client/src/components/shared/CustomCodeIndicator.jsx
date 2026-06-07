// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import { Tooltip, Tag } from '@carbon/react';
import './CustomCodeIndicator.scss';

/**
 * CustomCodeIndicator — a small "</>" badge marking a component that renders
 * from hand-written custom code (component.use_custom_code) rather than the
 * spec-driven config. Mirrors VariableIndicator's quiet outline-tag treatment
 * so the two indicators read as a consistent pair across surfaces (components
 * list, component picker; the dashboard panel header has its own icon variant).
 * Renders nothing when `active` is false.
 *
 * @param {boolean} active  whether the component uses custom code
 * @param {string}  size    Carbon Tag size ('sm' | 'md', default 'sm')
 */
function CustomCodeIndicator({ active = false, size = 'sm' }) {
  if (!active) return null;
  return (
    <Tooltip
      align="top"
      label="Uses custom code."
      className="custom-code-indicator-tooltip"
    >
      <span className="custom-code-indicator" aria-label="Uses custom code">
        <Tag type="outline" size={size}>&lt;/&gt;</Tag>
      </span>
    </Tooltip>
  );
}

CustomCodeIndicator.propTypes = {
  active: PropTypes.bool,
  size: PropTypes.oneOf(['sm', 'md']),
};

export default CustomCodeIndicator;
