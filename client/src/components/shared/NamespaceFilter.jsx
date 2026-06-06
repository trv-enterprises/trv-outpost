// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useMemo } from 'react';
import { MultiSelect } from '@carbon/react';
import { useNamespaces } from '../../context/NamespaceContext';
import { NAMESPACE_DEFAULT_COLOR } from '../../utils/namespaceColor';
import './NamespaceFilter.scss';

/**
 * Multi-select namespace filter for list pages. Mirrors TagFilter's
 * shape so the toolbar reads consistently across the three list views.
 *
 * Convention: empty selection = "All namespaces". This matches the
 * tag filter (no tags selected = no tag filter). The button label
 * collapses to "All namespaces" in that state and counts when one or
 * more namespaces are explicitly selected.
 *
 * Users may deselect every namespace including the active one — the
 * filter is independent from the header's active-namespace pill (which
 * answers a different question: "where do new things land?"). Letting
 * users peek at other namespaces without changing their working
 * context is the whole point.
 *
 * Props:
 *   selected  string[]   currently selected namespace slugs
 *   onChange  (string[]) => void
 *   id        string     field id
 *   label     string     label override (default "Filter by namespace")
 */
export default function NamespaceFilter({
  selected = [],
  onChange,
  id = 'namespace-filter',
  label: _label = 'Filter by namespace',
}) {
  const { namespaces } = useNamespaces();

  const items = useMemo(() => {
    return namespaces.map((ns) => ({
      id: ns.name,
      text: ns.name,
      color: ns.color || NAMESPACE_DEFAULT_COLOR,
    }));
  }, [namespaces]);

  const selectedItems = useMemo(() => {
    return selected
      .map((name) => items.find((i) => i.id === name))
      .filter(Boolean);
  }, [selected, items]);

  const handleChange = ({ selectedItems: next }) => {
    onChange((next || []).map((i) => i.id));
  };

  // Display label: "All namespaces" when nothing is filtering, count
  // when one or more are selected. The count communicates "list isn't
  // showing everything" at a glance.
  const displayLabel =
    selected.length === 0
      ? 'All namespaces'
      : `${selected.length} namespace${selected.length > 1 ? 's' : ''} selected`;

  return (
    <div className="namespace-filter">
      <MultiSelect
        id={id}
        titleText=""
        label={displayLabel}
        items={items}
        itemToString={(item) => (item ? item.text : '')}
        selectedItems={selectedItems}
        onChange={handleChange}
        hideLabel
        size="md"
        // Render a small color swatch next to each option so users can
        // recognize namespaces by their assigned color.
        itemToElement={(item) => (
          item ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: '0.75rem',
                  height: '0.75rem',
                  borderRadius: 2,
                  backgroundColor: item.color,
                  flexShrink: 0,
                }}
              />
              <span>{item.text}</span>
            </span>
          ) : null
        )}
      />
    </div>
  );
}
