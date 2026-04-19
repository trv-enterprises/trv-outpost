// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Tag } from '@carbon/react';
import { useNamespaces } from '../../context/NamespaceContext';
import { namespaceChipStyle } from '../../utils/namespaceColor';

/**
 * NamespaceChip
 *
 * Uniform tag rendering for a namespace across list columns, pickers,
 * and the header. Color comes from the namespace record itself (via
 * NamespaceContext); the chip locks in background + foreground
 * regardless of Carbon's default tag coloring.
 *
 * Props:
 *   name    — namespace slug to render. If the slug doesn't resolve to
 *             a record (stale data), falls back to neutral gray.
 *   size    — 'sm' (default) | 'md'. Controls Carbon Tag size token.
 *   onClick — optional click handler; adds hover cursor.
 */
export default function NamespaceChip({ name, size = 'sm', onClick }) {
  const { getNamespace } = useNamespaces();
  if (!name) return null;
  const ns = getNamespace(name);
  const style = namespaceChipStyle(ns || name); // gray fallback if unknown

  return (
    <Tag
      size={size}
      type="gray" // Carbon needs *some* type; we override via style
      style={{
        ...style,
        cursor: onClick ? 'pointer' : 'default',
      }}
      onClick={onClick}
    >
      {name}
    </Tag>
  );
}
