// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { IconButton } from '@carbon/react';
import { FilterReset } from '@carbon/icons-react';

/**
 * Reset-filters icon button shared by all list pages and the component
 * picker modal. Disabled when nothing is active so a click is never a
 * silent no-op.
 *
 * Props:
 * - active:  boolean  any filter currently set?
 * - onReset: () => void  clears every filter input the parent owns
 * - label:   string  tooltip text (default "Reset filters")
 */
function ResetFiltersButton({ active, onReset, label = 'Reset filters' }) {
  return (
    <IconButton
      kind="ghost"
      size="md"
      label={label}
      onClick={onReset}
      disabled={!active}
    >
      <FilterReset />
    </IconButton>
  );
}

export default ResetFiltersButton;
