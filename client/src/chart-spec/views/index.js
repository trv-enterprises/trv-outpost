// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// View registry for spec-driven chart types whose render is NOT an
// ECharts option. Their buildOption returns a tagged descriptor
// `{ render: '<tag>', props }`; SpecDrivenChart looks the tag up here
// and renders the mapped React component with `props`, plus `config`
// and `dataCtx`.
//
// This is the open-ended extension point for non-ECharts component
// types: add a new type by writing specs/<type>.json (editor) +
// specs/<type>.js (returns { render, props }) + registering one
// component here. No SpecDrivenChart / ChartShell surgery needed.
//
// See docs/design-notes/spec-driven-non-echarts-views.md.

import NumberView from './NumberView';

const VIEWS = {
  number: NumberView,
};

/** React component for a descriptor's `render` tag, or null. */
export function getView(tag) {
  return VIEWS[tag] || null;
}

/** True when a value is a tagged non-ECharts view descriptor. */
export function isViewDescriptor(v) {
  return Boolean(v && typeof v === 'object' && typeof v.render === 'string');
}
