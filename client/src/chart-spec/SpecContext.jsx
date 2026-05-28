// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useContext } from 'react';

/**
 * Shared context passed down to every spec-driven field renderer.
 *
 * @typedef {Object} SpecRenderContext
 * @property {string[]} availableColumns   columns from the current query result
 * @property {Object} formState            { [fieldId]: value } — current values keyed by spec field id
 * @property {function(string, *): void} onFieldChange   (fieldId, nextValue) => void
 */

/** @type {React.Context<SpecRenderContext>} */
export const SpecRenderContext = createContext({
  availableColumns: [],
  formState: {},
  onFieldChange: () => {},
});

export function useSpecRenderContext() {
  return useContext(SpecRenderContext);
}
