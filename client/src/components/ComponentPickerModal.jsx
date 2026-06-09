// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
import {
  Modal, Search, Tag, Tile, Loading, Dropdown, OverflowMenu, OverflowMenuItem
} from '@carbon/react';
import {
  ChartLineSmooth, ChartBar, ChartArea, ChartPie,
  Meter, TableSplit, Code, OverflowMenuVertical, Checkmark
} from '@carbon/icons-react';
import MdiIcon from '@mdi/react';
import { CONTROL_TYPE_INFO } from './controls/controlTypes';
import apiClient from '../api/client';
import TagFilter from './shared/TagFilter';
import TypeHierarchyFilter, { matchesTypeSelection, COMPONENT_TYPE_HIERARCHY } from './shared/TypeHierarchyFilter';
import ResetFiltersButton from './shared/ResetFiltersButton';
import NamespaceFilter from './shared/NamespaceFilter';
import NamespaceChip from './shared/NamespaceChip';
import VariableIndicator from './shared/VariableIndicator';
import CustomCodeIndicator from './shared/CustomCodeIndicator';
import SortMenu from './shared/SortMenu';
import './ComponentPickerModal.scss';
import './shared/FilterOverflowMenu.scss';

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
  const [connectionFilter, setConnectionFilter] = useState('all'); // 'all' or connection id
  const [variableOnly, setVariableOnly] = useState(false); // show only variable-driven components
  const [customCodeOnly, setCustomCodeOnly] = useState(false); // show only custom-code components
  // Connection map (id → name) used to populate the connection dropdown
  // and label the selected item. Fetched in parallel with components on
  // open. Same shape as the connection map on the list pages.
  const [connections, setConnections] = useState({});
  const [sortKey, setSortKey] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');

  useEffect(() => {
    if (open) {
      fetchItems();
      fetchConnections();
      setSelected(null);
      setSearchTerm('');
      setSelectedTypes(categoryToTypeSet(initialCategory));
      setTagFilter([]);
      setNamespaceFilter([]);
      setConnectionFilter('all');
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

  const fetchConnections = async () => {
    try {
      const data = await apiClient.getConnections();
      const list = data.connections || data.items || data || [];
      const map = {};
      (Array.isArray(list) ? list : []).forEach(c => {
        if (c?.id) map[c.id] = c.name || c.id;
      });
      setConnections(map);
    } catch (err) {
      console.error('Failed to fetch connections:', err);
      setConnections({});
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

    // Variable-driven only: keep components using the {{dashboard-variable}}
    // token (uses_dashboard_variable).
    if (variableOnly) {
      result = result.filter(item => !!item.uses_dashboard_variable);
    }

    // Custom-code only: keep components that render from hand-written code.
    if (customCodeOnly) {
      result = result.filter(item => !!item.use_custom_code);
    }

    // Connection filter. Components reference connections through one of
    // three fields: connection_id (charts/controls), or for displays
    // display_config.frigate_connection_id / mqtt_connection_id. Mirrors
    // the same fan-out used by ComponentsListPage.
    if (connectionFilter !== 'all') {
      result = result.filter(item => {
        if (item.connection_id === connectionFilter) return true;
        const dc = item.display_config;
        if (dc?.frigate_connection_id === connectionFilter) return true;
        if (dc?.mqtt_connection_id === connectionFilter) return true;
        return false;
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
  }, [items, namespaceFilter, selectedTypes, tagFilter, connectionFilter, variableOnly, customCodeOnly, searchTerm, sortKey, sortDirection]);

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
            width={170}
          />
          <TagFilter
            entityType="components"
            selected={tagFilter}
            onChange={setTagFilter}
          />
          <Dropdown
            id="connection-filter-component-picker"
            className="connection-filter-dropdown"
            label="Filter by connection"
            titleText=""
            items={[
              { id: 'all', text: 'All Connections' },
              ...Object.entries(connections).map(([id, name]) => ({ id, text: name }))
            ]}
            itemToString={(item) => item?.text || ''}
            selectedItem={{
              id: connectionFilter,
              text: connectionFilter === 'all'
                ? 'All Connections'
                : (connections[connectionFilter] || 'Unknown')
            }}
            onChange={({ selectedItem }) => {
              setConnectionFilter(selectedItem?.id || 'all');
            }}
            size="md"
          />
          {/* Overflow (⋮) menu for facet toggles — same as the components list.
              Sits BEFORE the reset button so reset stays rightmost. */}
          <OverflowMenu
            renderIcon={() => <OverflowMenuVertical size={20} />}
            flipped
            direction="bottom"
            align="bottom-end"
            iconDescription="Filter options"
            menuOptionsClass="filter-overflow-options"
            className={`filter-overflow-trigger${(variableOnly || customCodeOnly) ? ' filter-overflow-trigger--active' : ''}`}
          >
            <OverflowMenuItem
              itemText={
                <span className="filter-overflow-item">
                  {variableOnly
                    ? <Checkmark size={16} />
                    : <span style={{ width: 16, display: 'inline-block' }} />}
                  <span>Variable-driven only</span>
                </span>
              }
              onClick={() => setVariableOnly((v) => !v)}
            />
            <OverflowMenuItem
              itemText={
                <span className="filter-overflow-item">
                  {customCodeOnly
                    ? <Checkmark size={16} />
                    : <span style={{ width: 16, display: 'inline-block' }} />}
                  <span>Custom code only</span>
                </span>
              }
              onClick={() => setCustomCodeOnly((v) => !v)}
            />
          </OverflowMenu>
          <ResetFiltersButton
            active={
              !!searchTerm ||
              namespaceFilter.length > 0 ||
              tagFilter.length > 0 ||
              connectionFilter !== 'all' ||
              variableOnly ||
              customCodeOnly ||
              !sameTypeSet(selectedTypes, categoryToTypeSet(initialCategory))
            }
            onReset={() => {
              setSearchTerm('');
              setNamespaceFilter([]);
              setTagFilter([]);
              setConnectionFilter('all');
              setSelectedTypes(categoryToTypeSet(initialCategory));
              setVariableOnly(false);
              setCustomCodeOnly(false);
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
                    <VariableIndicator active={!!item.uses_dashboard_variable} />
                    <CustomCodeIndicator active={!!item.use_custom_code} />
                  </div>
                  <div className="picker-tile-content">
                    <h4>{item.title || item.name}</h4>
                    {item.description && <p>{item.description}</p>}
                    {itemTags.length > 0 && (
                      <div className="picker-tile-tags">
                        {itemTags.map(t => (
                          <Tag
                            key={t}
                            type="blue"
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
