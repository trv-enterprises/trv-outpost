// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem } from '@carbon/react';
import { useNamespaces } from '../../context/NamespaceContext';

/**
 * NamespaceSelect
 *
 * A Carbon Select pre-populated with every namespace the system knows
 * about. Used in edit forms for connections / components / dashboards.
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
  return (
    <Select
      id={id}
      labelText={labelText}
      helperText={helperText}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {namespaces.map((ns) => (
        <SelectItem key={ns.id} value={ns.name} text={ns.name} />
      ))}
    </Select>
  );
}
