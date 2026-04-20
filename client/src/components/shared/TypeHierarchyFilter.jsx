// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useRef, useState } from 'react';
import { Checkbox } from '@carbon/react';
import { ChevronDown, ChevronRight } from '@carbon/icons-react';
import { CONTROL_TYPE_INFO } from '../controls/controlTypes';
import './TypeHierarchyFilter.scss';

// Shared TYPE_HIERARCHY for component (chart/display/control) pickers.
// Keys map to component_type in DB; subtype ids match chart_type / control_type / display_type.
export const COMPONENT_TYPE_HIERARCHY = {
  chart: {
    label: 'Charts',
    subtypes: [
      { id: 'bar', label: 'Bar Chart' },
      { id: 'line', label: 'Line Chart' },
      { id: 'area', label: 'Area Chart' },
      { id: 'pie', label: 'Pie Chart' },
      { id: 'scatter', label: 'Scatter Plot' },
      { id: 'gauge', label: 'Gauge' },
      { id: 'dataview', label: 'Data Table' },
      { id: 'number', label: 'Number' },
      { id: 'custom', label: 'Custom' }
    ]
  },
  display: {
    label: 'Displays',
    subtypes: [
      { id: 'frigate_camera', label: 'Frigate Camera' },
      { id: 'weather', label: 'Weather' }
    ]
  },
  control: {
    label: 'Controls',
    subtypes: Object.entries(CONTROL_TYPE_INFO).map(([id, info]) => ({
      id,
      label: info.label
    }))
  }
};

// Returns the typed key (`parent:subtype`) for an item, used by matchesSelection.
// chart subtypes live on item.chart_type, control on item.control_config.control_type,
// display on item.display_config.display_type.
export function getItemTypeKey(item) {
  const parent = item.component_type || 'chart';
  if (parent === 'control') {
    return `control:${item.control_config?.control_type || ''}`;
  }
  if (parent === 'display') {
    return `display:${item.display_config?.display_type || ''}`;
  }
  return `chart:${item.chart_type || ''}`;
}

// True when item passes the selection (null = all selected).
export function matchesTypeSelection(item, selectedTypes) {
  if (selectedTypes === null) return true;
  if (selectedTypes.size === 0) return false;
  return selectedTypes.has(getItemTypeKey(item));
}

function getSubtypeKeys(hierarchy, parentType) {
  return hierarchy[parentType]?.subtypes.map(s => `${parentType}:${s.id}`) || [];
}

function allSubtypeKeys(hierarchy) {
  return Object.keys(hierarchy).flatMap(pt => getSubtypeKeys(hierarchy, pt));
}

/**
 * TypeHierarchyFilter
 *
 * Popover-style hierarchical type filter. Drives selection via `selectedTypes`
 * (Set of "parent:subtype" keys, or null for "all"). Initial collapsed state
 * defaults to display + control collapsed since charts is the most-used group.
 */
export default function TypeHierarchyFilter({
  selectedTypes,
  onChange,
  hierarchy = COMPONENT_TYPE_HIERARCHY,
  defaultCollapsed = ['display', 'control'],
  width = 240,
  label = 'Filter by Type'
}) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set(defaultCollapsed));
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isParentFullySelected = (parentType) => {
    if (selectedTypes === null) return true;
    const subs = getSubtypeKeys(hierarchy, parentType);
    return subs.length > 0 && subs.every(st => selectedTypes.has(st));
  };

  const isParentPartiallySelected = (parentType) => {
    if (selectedTypes === null) return false;
    const subs = getSubtypeKeys(hierarchy, parentType);
    const n = subs.filter(st => selectedTypes.has(st)).length;
    return n > 0 && n < subs.length;
  };

  const isSubtypeSelected = (parentType, subtypeId) => {
    if (selectedTypes === null) return true;
    return selectedTypes.has(`${parentType}:${subtypeId}`);
  };

  const toggleParent = (parentType) => {
    const subs = getSubtypeKeys(hierarchy, parentType);
    const allSelected = isParentFullySelected(parentType);
    if (selectedTypes === null) {
      const next = new Set();
      Object.keys(hierarchy).forEach(pt => {
        if (pt !== parentType) getSubtypeKeys(hierarchy, pt).forEach(st => next.add(st));
      });
      onChange(next);
      return;
    }
    const next = new Set(selectedTypes);
    if (allSelected) {
      subs.forEach(st => next.delete(st));
    } else {
      subs.forEach(st => next.add(st));
    }
    const all = allSubtypeKeys(hierarchy);
    onChange(all.every(st => next.has(st)) ? null : next);
  };

  const toggleSubtype = (parentType, subtypeId) => {
    const key = `${parentType}:${subtypeId}`;
    if (selectedTypes === null) {
      const next = new Set();
      Object.keys(hierarchy).forEach(pt => {
        getSubtypeKeys(hierarchy, pt).forEach(st => { if (st !== key) next.add(st); });
      });
      onChange(next);
      return;
    }
    const next = new Set(selectedTypes);
    if (next.has(key)) next.delete(key); else next.add(key);
    const all = allSubtypeKeys(hierarchy);
    onChange(all.every(st => next.has(st)) ? null : next);
  };

  const getLabel = () => {
    if (selectedTypes === null) return 'All Types';
    if (selectedTypes.size === 0) return 'None Selected';
    if (selectedTypes.size === 1) {
      const [type] = selectedTypes;
      const [parent, subtype] = type.split(':');
      const info = hierarchy[parent]?.subtypes.find(s => s.id === subtype);
      return info?.label || type;
    }
    return `${selectedTypes.size} types selected`;
  };

  const toggleCollapsed = (parentType) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(parentType)) next.delete(parentType); else next.add(parentType);
      return next;
    });
  };

  return (
    <div ref={ref} className="type-hierarchy-filter" style={{ width }}>
      <button
        type="button"
        className={`thf-button${open ? ' thf-button--open' : ''}`}
        onClick={() => setOpen(!open)}
        style={{ width }}
      >
        <span>{getLabel()}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="thf-content" style={{ width }}>
          <div className="thf-header">
            <span>{label}</span>
            {selectedTypes !== null && (
              <button
                type="button"
                className="thf-clear"
                onClick={() => onChange(null)}
              >
                Select All
              </button>
            )}
          </div>
          <div className="thf-list">
            {Object.entries(hierarchy).map(([parentType, config]) => {
              const isCollapsed = collapsed.has(parentType);
              return (
                <div key={parentType} className="thf-group">
                  <div className="thf-parent">
                    <button
                      type="button"
                      className="thf-collapse"
                      onClick={() => toggleCollapsed(parentType)}
                    >
                      {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    </button>
                    <Checkbox
                      id={`thf-${parentType}`}
                      labelText={config.label}
                      checked={isParentFullySelected(parentType)}
                      indeterminate={isParentPartiallySelected(parentType)}
                      onChange={() => toggleParent(parentType)}
                    />
                  </div>
                  {!isCollapsed && (
                    <div className="thf-subtypes">
                      {config.subtypes.map(subtype => (
                        <Checkbox
                          key={subtype.id}
                          id={`thf-${parentType}-${subtype.id}`}
                          labelText={subtype.label}
                          checked={isSubtypeSelected(parentType, subtype.id)}
                          onChange={() => toggleSubtype(parentType, subtype.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
