// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import {
  Button,
  Tag,
  Loading,
  InlineNotification,
  Tile,
  Toggle
} from '@carbon/react';
import { Edit, TrashCan, Code, View } from '@carbon/icons-react';
import { useComponent } from '../hooks/useComponents';
import DynamicComponentLoader from './DynamicComponentLoader';
import './ComponentViewer.scss';

/**
 * Component Viewer
 * Displays a selected component with metadata
 */
export default function ComponentViewer({ componentId, onEdit, onDelete }) {
  const { component, loading, error } = useComponent(componentId);
  const [showCode, setShowCode] = useState(false);

  if (!componentId) {
    return (
      <div className="empty-viewer">
        <View size={48} />
        <h4>No Component Selected</h4>
        <p>Select a component from the list to view it</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="loading-viewer">
        <Loading description="Loading component..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-viewer">
        <InlineNotification
          kind="error"
          title="Error Loading Component"
          subtitle={error}
          hideCloseButton
        />
      </div>
    );
  }

  if (!component) {
    return null;
  }

  return (
    <div className="component-viewer">
      {/* Component Header */}
      <div className="viewer-header">
        <div className="header-info">
          <h3 className="component-title">{component.name}</h3>
          <div className="component-tags">
            <Tag type="blue">{component.system}</Tag>
            <span className="tag-separator">/</span>
            <Tag type="cyan">{component.source}</Tag>
          </div>
          {component.description && (
            <p className="component-description">{component.description}</p>
          )}
        </div>

        <div className="header-actions">
          <Button
            kind={showCode ? 'primary' : 'tertiary'}
            size="md"
            renderIcon={showCode ? View : Code}
            onClick={() => setShowCode(!showCode)}
            iconDescription={showCode ? 'Hide Code' : 'Show Code'}
          >
            {showCode ? 'Hide Code' : 'Show Code'}
          </Button>
          {onEdit && (
            <Button
              kind="tertiary"
              size="md"
              renderIcon={Edit}
              onClick={() => onEdit(component)}
              iconDescription="Edit component"
            >
              Edit
            </Button>
          )}
          {onDelete && (
            <Button
              kind="danger--tertiary"
              size="md"
              renderIcon={TrashCan}
              onClick={() => {
                if (confirm(`Delete component "${component.name}"?`)) {
                  onDelete(component);
                }
              }}
              iconDescription="Delete component"
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="viewer-divider" />

      {/* Code View */}
      {showCode && (
        <>
          <Tile className="code-tile">
            <pre className="code-block">{component.component_code}</pre>
          </Tile>
          <div className="viewer-divider" />
        </>
      )}

      {/* Component Render */}
      <Tile className="preview-tile">
        <h5 className="tile-title">Component Preview</h5>
        <div className="preview-content">
          <DynamicComponentLoader
            code={component.component_code}
            componentMeta={component}
            props={component.metadata?.props || {}}
          />
        </div>
      </Tile>

      {/* Metadata */}
      {component.metadata && Object.keys(component.metadata).length > 0 && (
        <>
          <div className="viewer-divider" />
          <Tile className="metadata-tile">
            <h5 className="tile-title">Metadata</h5>
            <pre className="metadata-block">
              {JSON.stringify(component.metadata, null, 2)}
            </pre>
          </Tile>
        </>
      )}
    </div>
  );
}
