// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Horizontal-bar category-label fitting. A horizontal bar chart stacks its
// category labels down the y-axis, so whether all of them fit — and at what
// font — depends on the PANEL HEIGHT, which buildOption can't know. ECharts
// otherwise thins labels (drops every other, unreadable) or, if forced,
// packs them at the top (off their bars). ChartShell measures the plot
// height and uses these to size the label font so every category fits on its
// own row, centered on its bar. Pure functions, node-testable (see
// scripts/verify-chartshell-labelfit.mjs).

export const LABEL_FONT_MIN = 8;
export const LABEL_FONT_MAX = 12;
// px-per-row / fontSize needed before ECharts thins the labels. Calibrated
// against headless ECharts 6 renders: a 156px plot fits 9 labels at 10px
// (17.3px/row ÷ 10 ≈ 1.7); a 126px plot fits them at 8px (14px/row ÷ 8 ≈
// 1.75). 1.7 reproduces "all shown, centered" at the heights tested and
// thins only when a panel genuinely can't fit them at the 8px floor.
export const LABEL_ROW_RATIO = 1.7;

// Detect the horizontal-bar shape from a built ECharts option: a category
// y-axis (label column) with bar series. Returns the category count, or 0
// when this isn't that shape (leave the option untouched).
export function horizontalBarCategoryCount(option) {
  if (!option) return 0;
  const yAxis = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
  if (!yAxis || yAxis.type !== 'category' || !Array.isArray(yAxis.data)) return 0;
  const series = Array.isArray(option.series) ? option.series : [];
  const hasBar = series.some((s) => s?.type === 'bar');
  return hasBar ? yAxis.data.length : 0;
}

// Font that lets `count` labels fit in `plotPx` vertical pixels, one per
// row. Returns { fontSize, fits }: `fits` is true when every label fits at
// >= the floor (so the caller can force interval:0 to show them all without
// overlap); false when even the floor font can't fit them all (leave ECharts
// to thin — the honest outcome for a too-short panel). null for degenerate
// input (no count / no height).
export function fitLabelFont(count, plotPx) {
  if (count <= 0 || !(plotPx > 0)) return null;
  const rowPx = plotPx / count;
  const raw = Math.floor(rowPx / LABEL_ROW_RATIO);
  const fits = raw >= LABEL_FONT_MIN;
  const fontSize = Math.max(LABEL_FONT_MIN, Math.min(LABEL_FONT_MAX, raw));
  return { fontSize, fits };
}
