// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
import {
  Modal, Search, Tag, Tile, Loading
} from '@carbon/react';
import {
  ChartLineSmooth, ChartBar, ChartArea, ChartPie,
  Meter, TableSplit, Code
} from '@carbon/icons-react';
import MdiIcon from '@mdi/react';
import { CONTROL_TYPE_INFO } from './controls/controlTypes';
import apiClient from '../api/client';
import TagFilter from './shared/TagFilter';
import TypeHierarchyFilter, { matchesTypeSelection } from './shared/TypeHierarchyFilter';
import './ComponentPickerModal.scss';

// Chart type icon mapping
const CHART_ICONS = {
  bar: ChartBar,
  line: ChartLineSmooth,
  area: ChartArea,
  pie: ChartPie,
  gauge: Meter,
  number: Meter,
  dataview: TableSplit,
  custom: Code
};

// Chart type tag colors
const CHART_TYPE_COLORS = {
  bar: 'blue',
  line: 'green',
  area: 'teal',
  pie: 'purple',
  scatter: 'magenta',
  gauge: 'cyan',
  number: 'cyan',
  dataview: 'warm-gray',
  custom: 'gray'
};

// Map a legacy `category` prop ('chart' | 'control' | 'display' | 'all') to
// a Set of typed keys so the hierarchy filter starts pre-scoped to the parent.
function categoryToTypeSet(category) {
  if (!category || category === 'all') return null;
  // Build set of all subtype keys for this parent
  const keys = [];
  if (category === 'chart') {
    ['bar', 'line', 'area', 'pie', 'scatter', 'gauge', 'dataview', 'number', 'custom']
      .forEach(s => keys.push(`chart:${s}`));
  } else if (category === 'display') {
    ['frigate_camera', 'weather'].forEach(s => keys.push(`display:${s}`));
  } else if (category === 'control') {
    Object.keys(CONTROL_TYPE_INFO).forEach(s => keys.push(`control:${s}`));
  }
  return new Set(keys);
}

/**
 * ComponentPickerModal Component
 *
 * Modal for browsing and selecting existing components (charts, controls, displays).
 * Features hierarchical type filter, tag filter, search, and per-type icons.
 */
function ComponentPickerModal({ open, onClose, onSelect, category: initialCategory }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selected, setSelected] = useState(null);
  // null = all selected; Set of "parent:subtype" keys otherwise.
  const [selectedTypes, setSelectedTypes] = useState(() => categoryToTypeSet(initialCategory));
  const [tagFilter, setTagFilter] = useState([]);

  useEffect(() => {
    if (open) {
      fetchItems();
      setSelected(null);
      setSearchTerm('');
      setSelectedTypes(categoryToTypeSet(initialCategory));
      setTagFilter([]);
    }
  }, [open, initialCategory]);

  const fetchItems = async () => {
    setLoading(true);
    try {
      const data = await apiClient.getCharts();
      // Filter to final versions only
      const finals = (data.charts || []).filter(c => c.status === 'final');
      setItems(finals);
    } catch (err) {
      console.error('Failed to fetch components:', err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  // Filter and search
  const filtered = useMemo(() => {
    let result = items;

    // Hierarchical type filter
    result = result.filter(item => matchesTypeSelection(item, selectedTypes));

    // Tag filter (OR semantics — matches the behavior on the list pages)
    if (tagFilter.length > 0) {
      result = result.filter(item => {
        const itemTags = item.tags || [];
        return tagFilter.some(t => itemTags.includes(t));
      });
    }

    // Search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(item =>
        item.name?.toLowerCase().includes(term) ||
        item.description?.toLowerCase().includes(term) ||
        item.chart_type?.toLowerCase().includes(term) ||
        item.control_config?.control_type?.toLowerCase().includes(term)
      );
    }

    return result;
  }, [items, selectedTypes, tagFilter, searchTerm]);

  const handleSelect = () => {
    if (selected) onSelect(selected);
  };

  const renderIcon = (item) => {
    const componentType = item.component_type || 'chart';

    if (componentType === 'control') {
      const controlType = item.control_config?.control_type;
      const typeInfo = CONTROL_TYPE_INFO[controlType];
      if (typeInfo?.icon) {
        return <MdiIcon path={typeInfo.icon} size="24px" color="currentColor" />;
      }
    }

    // Chart icons
    const ChartIcon = CHART_ICONS[item.chart_type?.toLowerCase()] || ChartLineSmooth;
    return <ChartIcon size={24} />;
  };

  const getTypeLabel = (item) => {
    const componentType = item.component_type || 'chart';
    if (componentType === 'control') {
      const controlType = item.control_config?.control_type;
      const typeInfo = CONTROL_TYPE_INFO[controlType];
      return typeInfo?.label || controlType || 'Control';
    }
    if (componentType === 'display') {
      return item.display_config?.display_type || 'Display';
    }
    return item.chart_type || 'Chart';
  };

  const getTypeTagColor = (item) => {
    const componentType = item.component_type || 'chart';
    if (componentType === 'control') return 'purple';
    if (componentType === 'display') return 'teal';
    return CHART_TYPE_COLORS[item.chart_type?.toLowerCase()] || 'gray';
  };

  const getCategoryTagColor = (item) => {
    const componentType = item.component_type || 'chart';
    if (componentType === 'control') return 'purple';
    if (componentType === 'display') return 'teal';
    return 'blue';
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      onRequestSubmit={handleSelect}
      modalHeading="Select Component"
      primaryButtonText="Select"
      primaryButtonDisabled={!selected}
      secondaryButtonText="Cancel"
      size="lg"
      className="component-picker-modal"
    >
      <div className="picker-content">
        <div className="picker-toolbar">
          <TypeHierarchyFilter
            selectedTypes={selectedTypes}
            onChange={setSelectedTypes}
          />
          <TagFilter
            entityType="components"
            selected={tagFilter}
            onChange={setTagFilter}
          />
          <Search
            labelText="Search"
            placeholder="Search components..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            size="md"
          />
        </div>

        {loading ? (
          <div className="picker-loading">
            <Loading description="Loading..." withOverlay={false} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="picker-empty">
            <p>{items.length === 0 ? 'No components available. Create one first.' : 'No matching components found.'}</p>
          </div>
        ) : (
          <div className="picker-grid">
            {filtered.map(item => {
              const itemTags = item.tags || [];
              return (
                <Tile
                  key={item.id}
                  className={`picker-tile ${selected?.id === item.id ? 'selected' : ''}`}
                  onClick={() => setSelected(item)}
                >
                  <div className="picker-tile-header">
                    <div className={`picker-tile-icon picker-tile-icon--${getCategoryTagColor(item)}`}>
                      {renderIcon(item)}
                    </div>
                    <Tag size="sm" type={getTypeTagColor(item)}>
                      {getTypeLabel(item)}
                    </Tag>
                  </div>
                  <div className="picker-tile-content">
                    <h4>{item.title || item.name}</h4>
                    {item.description && <p>{item.description}</p>}
                    {itemTags.length > 0 && (
                      <div className="picker-tile-tags">
                        {itemTags.map(t => (
                          <Tag
                            key={t}
                            type="cyan"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!tagFilter.includes(t)) setTagFilter([...tagFilter, t]);
                            }}
                            title={`Filter by ${t}`}
                            style={{ cursor: 'pointer' }}
                          >
                            {t}
                          </Tag>
                        ))}
                      </div>
                    )}
                  </div>
                </Tile>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ComponentPickerModal;
