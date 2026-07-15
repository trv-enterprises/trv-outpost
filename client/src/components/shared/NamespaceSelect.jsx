// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Dropdown } from '@carbon/react';
import { useNamespaces } from '../../context/NamespaceContext';
import { namespaceChipStyle } from '../../utils/namespaceColor';
import './NamespaceSelect.scss';

/**
 * NamespaceSelect
 *
 * A namespace picker for edit forms (connections / components /
 * dashboards / import). Each row shows the namespace's color swatch
 * next to its name, matching the header NamespacePicker so the color
 * reads as the same key everywhere in the app.
 *
 * Carbon `Dropdown`, not `Select`: a native <select> renders real
 * <option> elements, and browsers won't render markup inside an
 * <option> — a swatch is impossible there. Dropdown renders a custom
 * listbox, which is what the header picker uses too.
 *
 * Props:
 *   id         — required; Carbon needs unique input IDs per page.
 *   value      — current namespace slug; empty string means "inherit
 *                active namespace on save" (only useful in create mode).
 *   onChange   — (slug) => void. Fires with the new slug.
 *   labelText  — overridable label. Defaults to "Namespace".
 *   helperText — small line below the select. Defaults to explaining
 *                the uniqueness rule.
 *   disabled   — passthrough.
 */
export default function NamespaceSelect({
  id,
  value,
  onChange,
  labelText = 'Namespace',
  helperText = 'Uniqueness is scoped to (namespace, name).',
  disabled = false,
}) {
  const { namespaces } = useNamespaces();

  // Dropdown selects by item object, not raw value. Resolve the current
  // slug to its record so the trigger renders the right swatch; an
  // empty/unknown slug selects nothing (create-mode "inherit active").
  const selectedItem = namespaces.find((ns) => ns.name === value) || null;

  const renderNamespace = (ns) => {
    if (!ns) return '';
    return (
      <span className="namespace-select__item">
        <span
          className="namespace-select__swatch"
          // Match the chip exactly: the mapped Carbon tag-background
          // color, NOT the raw hex — so this dropdown is a true key for
          // the chips it represents (same rule as the header picker).
          style={{ backgroundColor: namespaceChipStyle(ns).backgroundColor }}
        />
        <span className="namespace-select__name">{ns.name}</span>
      </span>
    );
  };

  return (
    <Dropdown
      id={id}
      titleText={labelText}
      helperText={helperText}
      label="Select a namespace"
      items={namespaces}
      selectedItem={selectedItem}
      // itemToString drives a11y + type-ahead, so it stays the plain
      // slug even though the row itself renders rich.
      itemToString={(ns) => (ns ? ns.name : '')}
      itemToElement={renderNamespace}
      renderSelectedItem={renderNamespace}
      onChange={({ selectedItem: next }) => onChange(next ? next.name : '')}
      disabled={disabled}
    />
  );
}
