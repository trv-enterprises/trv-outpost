// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useState } from 'react';
import { FilterableMultiSelect } from '@carbon/react';
import apiClient from '../../api/client';
import { getAllTagsCached } from './tagsApi';
import './TagFilter.scss';

/**
 * Multi-select tag filter for list pages. Shows tags filtered to the
 * current entity type with usage counts; selections use OR semantics.
 *
 * Props:
 * - entityType:  'connections' | 'components' | 'dashboards'
 * - selected:    string[]   currently selected tags
 * - onChange:    (string[]) => void
 * - label:       string     label (default "Filter by tag")
 * - id:          string     field id
 */
function TagFilter({
  entityType,
  selected = [],
  onChange,
  label = 'Filter by tag',
  id = 'tag-filter',
}) {
  const [allTags, setAllTags] = useState([]);

  // Refetch on every mount so newly-created tags show up after navigation.
  // The shared cache still prevents duplicate fetches within the same
  // mount/render cycle.
  useEffect(() => {
    let cancelled = false;
    getAllTagsCached(apiClient)
      .then((res) => {
        if (cancelled) return;
        setAllTags(res?.tags || []);
      })
      .catch(() => {
        setAllTags([]);
      });
    return () => { cancelled = true; };
  }, []);

  // Pick the count field that matches entityType.
  const countField = useMemo(() => {
    switch (entityType) {
      case 'connections': return 'connections';
      case 'components':  return 'components';
      case 'dashboards':  return 'dashboards';
      default:            return 'count';
    }
  }, [entityType]);

  // Items the select renders: only tags used by this entity type,
  // shaped as `{ id, text }` with the count inline.
  const items = useMemo(() => {
    return allTags
      .filter((t) => (t[countField] || 0) > 0)
      .map((t) => ({
        id: t.name,
        text: `${t.name} (${t[countField]})`,
      }));
  }, [allTags, countField]);

  // The select wants selectedItems as objects matching items[].
  const selectedItems = useMemo(() => {
    return selected
      .map((name) => items.find((i) => i.id === name))
      .filter(Boolean);
  }, [selected, items]);

  const handleChange = ({ selectedItems: next }) => {
    onChange((next || []).map((i) => i.id));
  };

  // Collapsed label: the search input shows this as its placeholder when
  // nothing is selected, and a count once tags are chosen. FilterableMultiSelect
  // adds a type-to-search box that filters `items` by `itemToString` — so long
  // tag lists are searchable instead of scroll-only.
  const placeholder = selected.length > 0
    ? `${selected.length} tag${selected.length > 1 ? 's' : ''} selected`
    : label;

  return (
    <div className="tag-filter">
      <FilterableMultiSelect
        id={id}
        titleText=""
        placeholder={placeholder}
        items={items}
        itemToString={(item) => (item ? item.text : '')}
        selectedItems={selectedItems}
        onChange={handleChange}
        hideLabel
        size="md"
      />
    </div>
  );
}

export default TagFilter;
