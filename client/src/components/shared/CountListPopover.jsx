// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useEffect } from 'react';
import PropTypes from 'prop-types';
import { Popover, PopoverContent } from '@carbon/react';
import './CountListPopover.scss';

/**
 * CountListPopover — a list-page count cell that, on click, opens a popover
 * with a clickable list of the related items. Clicking an item calls that
 * section's onItemClick(item) so the caller can navigate to the item's editor.
 *
 * Replaces the old hover-Tooltip-of-names pattern: a Carbon Tooltip can't hold
 * clickable content (it dismisses when you move toward it), so the cell becomes
 * a click-triggered Popover instead.
 *
 * Two ways to supply content:
 *   - Single list: `items` + `heading` + `onItemClick` (one column).
 *   - Multiple sections: `sections` = [{ heading, items, onItemClick,
 *     emptyLabel }]. Each section is its own column, laid out side by side, so
 *     a long list (e.g. 41 components) and a short one (e.g. 1 connection) sit
 *     next to each other instead of the short one scrolling way down.
 *
 * @param {number}   count        the count to display as the trigger
 * @param {Array}    items        [{ id, label }] — single-section items
 * @param {Function} onItemClick  (item) => void — single-section navigation
 * @param {string}   heading      single-section heading
 * @param {Array}    sections     [{ heading, items, onItemClick, emptyLabel }]
 * @param {string}   emptyLabel   shown when a section has no items
 * @param {string}   className    extra class on the trigger (keeps *-count styling)
 */
export default function CountListPopover({
  count,
  items,
  onItemClick,
  heading = '',
  sections,
  emptyLabel = 'None',
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Normalize to a list of sections regardless of which API the caller used.
  const allSections = sections && sections.length
    ? sections
    : [{ heading, items: items || [], onItemClick, emptyLabel }];

  const hasAny = allSections.some((s) => (s.items || []).length > 0);
  const multi = allSections.length > 1;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleTriggerClick = (e) => {
    e.stopPropagation(); // don't trigger the table row's own click handler
    if (hasAny) setOpen((o) => !o);
  };

  return (
    <span ref={ref} className="count-list-popover">
      {/* autoAlign lets Carbon flip/shift the popover when the preferred
          "bottom" placement would overflow the viewport — without it, a tile
          near the left (or right) edge clips the content off-screen. */}
      <Popover open={open} align="bottom" autoAlign onRequestClose={() => setOpen(false)} dropShadow>
        <button
          type="button"
          className={`count-list-popover__trigger ${className} ${hasAny ? '' : 'count-list-popover__trigger--empty'}`}
          onClick={handleTriggerClick}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={hasAny ? `${count} — click for list` : emptyLabel}
        >
          {count}
        </button>
        <PopoverContent className="count-list-popover__content">
          <div className={`count-list-popover__columns ${multi ? 'count-list-popover__columns--multi' : ''}`}>
          {allSections.map((section, i) => {
            const secItems = section.items || [];
            const secEmpty = section.emptyLabel || emptyLabel;
            return (
              <div className="count-list-popover__section" key={section.heading || i}>
                {section.heading && (
                  <div className="count-list-popover__heading">{section.heading}</div>
                )}
                {secItems.length > 0 ? (
                  <ul className="count-list-popover__list">
                    {secItems.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="count-list-popover__item"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(false);
                            section.onItemClick?.(item);
                          }}
                        >
                          {item.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="count-list-popover__empty">{secEmpty}</div>
                )}
              </div>
            );
          })}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

const itemShape = PropTypes.arrayOf(PropTypes.shape({
  id: PropTypes.string,
  label: PropTypes.string,
}));

CountListPopover.propTypes = {
  count: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  items: itemShape,
  onItemClick: PropTypes.func,
  heading: PropTypes.string,
  sections: PropTypes.arrayOf(PropTypes.shape({
    heading: PropTypes.string,
    items: itemShape,
    onItemClick: PropTypes.func,
    emptyLabel: PropTypes.string,
  })),
  emptyLabel: PropTypes.string,
  className: PropTypes.string,
};
