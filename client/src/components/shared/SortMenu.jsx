// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@carbon/react';
import { SortAscending, SortDescending, Checkmark } from '@carbon/icons-react';
import './SortMenu.scss';

/**
 * Sort dropdown for tile views. Each option is a {key, label, defaultDir}
 * tuple. Clicking an option that's already selected toggles its direction;
 * clicking a different option switches to that key with the option's
 * default direction.
 *
 * Special case: option key "manual" disables sorting and surfaces the
 * page's manual ordering instead. Used by the View-mode dashboard tile
 * page where users can drag-reorder.
 *
 * Props:
 * - sortKey:        string  current sort key
 * - sortDirection:  'asc' | 'desc'
 * - onChange:       (sortKey, sortDirection) => void
 * - options:        Array<{ key, label, defaultDir? }>
 */
function SortMenu({ sortKey, sortDirection, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (option) => {
    if (option.key === 'manual') {
      onChange('manual', 'asc');
    } else if (option.key === sortKey) {
      onChange(option.key, sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      onChange(option.key, option.defaultDir || 'asc');
    }
    setOpen(false);
  };

  // Pick an icon that reflects current direction so the toolbar gives a
  // visual cue without forcing the user to open the menu.
  const Icon = sortKey === 'manual' || sortDirection === 'asc'
    ? SortAscending
    : SortDescending;

  return (
    <div ref={ref} className="sort-menu">
      <IconButton
        kind="ghost"
        size="md"
        label="Sort"
        align="bottom"
        onClick={() => setOpen(!open)}
      >
        <Icon />
      </IconButton>
      {open && (
        <div className="sort-menu-popover">
          {options.map((opt) => {
            const isActive = opt.key === sortKey;
            const showArrow = isActive && opt.key !== 'manual';
            return (
              <button
                key={opt.key}
                type="button"
                className={`sort-menu-item${isActive ? ' sort-menu-item--active' : ''}`}
                onClick={() => handleSelect(opt)}
              >
                <span className="sort-menu-check">
                  {isActive && <Checkmark size={16} />}
                </span>
                <span className="sort-menu-label">{opt.label}</span>
                {showArrow && (
                  <span className="sort-menu-direction">
                    {sortDirection === 'asc'
                      ? <SortAscending size={16} />
                      : <SortDescending size={16} />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default SortMenu;
