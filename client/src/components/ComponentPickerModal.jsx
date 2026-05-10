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
import TypeHierarchyFilter, { matchesTypeSelection, COMPONENT_TYPE_HIERARCHY } from './shared/TypeHierarchyFilter';
import ResetFiltersButton from './shared/ResetFiltersButton';
import NamespaceFilter from './shared/NamespaceFilter';
import NamespaceChip from './shared/NamespaceChip';
import SortMenu from './shared/SortMenu';
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

// Compare two TypeHierarchyFilter values (Set | null). Used by the reset
// button to decide whether the type filter is at its open-state default.
function sameTypeSet(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

// Map a legacy `category` prop ('chart' | 'control' | 'display' | 'all') to
// a Set of typed keys so the hierarchy filter starts pre-scoped to the parent.
function categoryToTypeSet(category) {
  if (!category || category === 'all') return null;
  // Source the subtype list from the shared hierarchy so adding a new
  // subtype in one place (TypeHierarchyFilter.jsx) automatically flows
  // through to picker pre-scoping, instead of needing matched edits in
  // multiple files.
  const parent = COMPONENT_TYPE_HIERARCHY[category];
  if (!parent) return null;
  return new Set(parent.subtypes.map((s) => `${category}:${s.id}`));
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
  const [namespaceFilter, setNamespaceFilter] = useState([]);
  const [sortKey, setSortKey] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');

  useEffect(() => {
    if (open) {
      fetchItems();
      setSelected(null);
      setSearchTerm('');
      setSelectedTypes(categoryToTypeSet(initialCategory));
      setTagFilter([]);
      setNamespaceFilter([]);
      setSortKey('name');
      setSortDirection('asc');
    }
  }, [open, initialCategory]);

  const fetchItems = async () => {
    setLoading(true);
    try {
      const data = await apiClient.getComponents();
      // Filter to final versions only
      const finals = (data.components || []).filter(c => c.status === 'final');
      setItems(finals);
    } catch (err) {
      console.error('Failed to fetch components:', err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  // Filter, search, and sort
  const filtered = useMemo(() => {
    let result = items;

    // Namespace filter (OR within selection; missing namespace stays visible
    // — same defensive behaviour as the list pages).
    if (namespaceFilter.length > 0) {
      const wanted = new Set(namespaceFilter);
      result = result.filter(item => !item.namespace || wanted.has(item.namespace));
    }

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

    // Sort — by name / last modified / namespace
    const sorted = [...result].sort((a, b) => {
      let aVal = a[sortKey];
      let bVal = b[sortKey];
      if (sortKey === 'updated') {
        aVal = new Date(aVal).getTime() || 0;
        bVal = new Date(bVal).getTime() || 0;
      } else {
        aVal = String(aVal || '').toLowerCase();
        bVal = String(bVal || '').toLowerCase();
      }
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [items, namespaceFilter, selectedTypes, tagFilter, searchTerm, sortKey, sortDirection]);

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
          <div className="picker-search">
            <Search
              labelText="Search"
              placeholder="Search components..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              size="md"
            />
          </div>
          <NamespaceFilter
            id="namespace-filter-component-picker"
            selected={namespaceFilter}
            onChange={setNamespaceFilter}
          />
          <TypeHierarchyFilter
            selectedTypes={selectedTypes}
            onChange={setSelectedTypes}
          />
          <TagFilter
            entityType="components"
            selected={tagFilter}
            onChange={setTagFilter}
          />
          <ResetFiltersButton
            active={
              !!searchTerm ||
              namespaceFilter.length > 0 ||
              tagFilter.length > 0 ||
              !sameTypeSet(selectedTypes, categoryToTypeSet(initialCategory))
            }
            onReset={() => {
              setSearchTerm('');
              setNamespaceFilter([]);
              setTagFilter([]);
              setSelectedTypes(categoryToTypeSet(initialCategory));
            }}
          />
          <SortMenu
            sortKey={sortKey}
            sortDirection={sortDirection}
            onChange={(k, d) => { setSortKey(k); setSortDirection(d); }}
            options={[
              { key: 'name', label: 'Name', defaultDir: 'asc' },
              { key: 'updated', label: 'Last modified', defaultDir: 'desc' },
              { key: 'namespace', label: 'Namespace', defaultDir: 'asc' },
            ]}
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
                  onDoubleClick={() => onSelect(item)}
                >
                  <div className="picker-tile-header">
                    <div className={`picker-tile-icon picker-tile-icon--${getCategoryTagColor(item)}`}>
                      {renderIcon(item)}
                    </div>
                    <Tag size="sm" type={getTypeTagColor(item)}>
                      {getTypeLabel(item)}
                    </Tag>
                    {item.namespace && (
                      <NamespaceChip name={item.namespace} />
                    )}
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
