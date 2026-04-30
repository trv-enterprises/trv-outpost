// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import {
  Select,
  SelectItem,
  StructuredListWrapper,
  StructuredListHead,
  StructuredListRow,
  StructuredListCell,
  StructuredListBody,
  Loading,
  Tag
} from '@carbon/react';
import { Application, DataBase, Time } from '@carbon/icons-react';
import { useComponents } from '../hooks/useComponents';
import { useSystems } from '../hooks/useDataSources';
import './ComponentSelector.scss';

/**
 * Component Selector
 * Allows users to browse and select components by system/source
 */
export default function ComponentSelector({ onSelect, selectedId }) {
  const [selectedSystem, setSelectedSystem] = useState('');
  const [selectedSource, setSelectedSource] = useState('');

  const { systems } = useSystems();
  const { components, loading: componentsLoading } = useComponents({
    system: selectedSystem || undefined,
    source: selectedSource || undefined,
  });

  const handleSystemChange = (e) => {
    const value = e.target.value;
    setSelectedSystem(value);
    setSelectedSource('');
  };

  const handleSourceChange = (e) => {
    const value = e.target.value;
    setSelectedSource(value);
  };

  const handleComponentSelect = (component) => {
    onSelect(component);
  };

  const sources = selectedSystem
    ? systems.find((s) => s.name === selectedSystem)?.sources || []
    : [];

  return (
    <div className="component-selector">
      <div className="selector-header">
        <h4 className="selector-title">
          <Application size={20} />
          <span>Select Component</span>
        </h4>

        <div className="selector-filters">
          {/* System Selector */}
          <div className="filter-group">
            <label className="filter-label">System:</label>
            <Select
              id="system-select"
              value={selectedSystem}
              onChange={handleSystemChange}
              labelText=""
              hideLabel
            >
              <SelectItem value="" text="All Systems" />
              {systems.map((system) => (
                <SelectItem
                  key={system.name}
                  value={system.name}
                  text={`${system.name} (${system.sources.length})`}
                />
              ))}
            </Select>
          </div>

          {/* Source Selector */}
          {selectedSystem && (
            <div className="filter-group">
              <label className="filter-label">Source:</label>
              <Select
                id="source-select"
                value={selectedSource}
                onChange={handleSourceChange}
                labelText=""
                hideLabel
              >
                <SelectItem value="" text="All Sources" />
                {sources.map((source) => (
                  <SelectItem key={source} value={source} text={source} />
                ))}
              </Select>
            </div>
          )}
        </div>
      </div>

      {/* Component List */}
      <div className="component-list">
        {componentsLoading ? (
          <div className="loading-container">
            <Loading description="Loading components..." withOverlay={false} />
          </div>
        ) : components.length === 0 ? (
          <div className="empty-state">
            <Application size={48} />
            <p>No components found</p>
          </div>
        ) : (
          <StructuredListWrapper selection>
            <StructuredListBody>
              {components.map((component) => (
                <StructuredListRow
                  key={component.id}
                  onClick={() => handleComponentSelect(component)}
                  className={`component-list-item ${
                    selectedId === component.id ? 'selected' : ''
                  }`}
                >
                  <StructuredListCell>
                    <div className="component-item">
                      <div className="component-icon">
                        <Application size={20} />
                      </div>
                      <div className="component-details">
                        <div className="component-name">{component.name}</div>
                        <div className="component-meta">
                          <span className="component-path">
                            <DataBase size={12} />
                            {component.system} / {component.source}
                          </span>
                          <span className="component-time">
                            <Time size={12} />
                            {new Date(component.updated).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </div>
                  </StructuredListCell>
                </StructuredListRow>
              ))}
            </StructuredListBody>
          </StructuredListWrapper>
        )}
      </div>
    </div>
  );
}
