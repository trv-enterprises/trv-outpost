// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package componenttemplates

import "fmt"

// SpecDrivenOneLiner returns the canonical component_code for a
// spec-driven chart: a one-line React component that defers all
// rendering to the client-side <SpecDrivenChart>. The chart is drawn at
// runtime by the chart type's pure buildOption(config, data) function —
// nothing is generated here, and the stored code carries no column
// names, so the chart stays in sync with the saved data_mapping /
// options config.
//
// This is the EXACT string the React editor emits on save for a
// spec-driven chart (see client/src/components/ComponentEditor.jsx
// codegen dispatch, which renders `<SpecDrivenChart specName="..." />`).
// The server emits the same one-liner on create so agent-built charts
// (chat agent, component agent, MCP) render identically to
// editor-built ones — keep the two in sync if the JSX wrapper changes.
//
// Which chart types are spec-driven is decided server-side by the
// component registry (registry.GetComponentType: any canonical
// chart.<type> that is not chart.custom). The authoritative render-side
// list — the chart types that actually have a buildOption module — lives
// in the frontend at client/src/chart-spec/build-options.js
// (BUILD_OPTIONS). The two must agree; the registry is the contract the
// frontend list keeps in sync with.
func SpecDrivenOneLiner(chartType string) string {
	return fmt.Sprintf("const Component = () => {\n  return <SpecDrivenChart specName=%q />;\n};", chartType)
}
