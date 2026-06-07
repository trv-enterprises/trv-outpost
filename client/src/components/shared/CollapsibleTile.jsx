// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown } from '@carbon/icons-react';
import './CollapsibleTile.scss';

/**
 * CollapsibleTile — a `.mapping-section` editor card whose body can be
 * collapsed via a clickable header (title + chevron). Used in the chart
 * editor to compress the tall sections between the query and the results
 * (Client Side Processing, Data Mapping, Chart Options, and the other
 * spec-driven sections) so the form stays manageable.
 *
 * Open by default; collapse state is local + transient (resets when the
 * editor reopens) — no persistence by design.
 *
 * @param {string}   title             header label
 * @param {string}   [className]       extra classes on the section card
 * @param {boolean}  [defaultOpen]     start expanded (default true)
 * @param {React.ReactNode} children   the section body
 */
function CollapsibleTile({ title, className = '', defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`mapping-section collapsible-tile ${open ? 'is-open' : 'is-collapsed'} ${className}`}>
      <button
        type="button"
        className="collapsible-tile__header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <h4>{title}</h4>
        <ChevronDown
          size={20}
          className={`collapsible-tile__chevron ${open ? 'open' : ''}`}
        />
      </button>
      {open && <div className="collapsible-tile__body">{children}</div>}
    </div>
  );
}

CollapsibleTile.propTypes = {
  title: PropTypes.node.isRequired,
  className: PropTypes.string,
  defaultOpen: PropTypes.bool,
  children: PropTypes.node,
};

export default CollapsibleTile;
