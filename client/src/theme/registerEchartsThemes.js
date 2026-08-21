// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import * as echarts from 'echarts';
import { carbonLightTheme, carbonDarkTheme } from './carbonEchartsTheme';

/**
 * Register the Carbon ECharts themes ONCE, at module load.
 *
 * `<ReactECharts theme="carbon-dark">` is a lookup by NAME against ECharts'
 * global theme registry. When the name isn't registered ECharts does not warn
 * — it silently falls back to its built-in LIGHT theme. So a chart that asks
 * for carbon-dark and gets nothing renders a light tooltip on a dark
 * dashboard, and loses everything else the theme carries (notably
 * `tooltip.appendToBody`, which is what keeps a tooltip from being clipped by
 * the panel's overflow:hidden and shoved off the viewport edge).
 *
 * Registration used to live inside DynamicComponentLoader's effect, keyed on
 * `code` — so it ran only when a CUSTOM-CODE chart mounted. Spec-driven charts
 * (ChartShell) ask for the same theme name but never registered it, so whether
 * they were themed at all depended on a custom-code chart having rendered
 * first on that page. On a dashboard of only spec-driven charts, none of them
 * were themed.
 *
 * Importing this module for its side effect fixes that for every consumer:
 * it's idempotent, has no React dependency, and runs before any chart mounts.
 */
echarts.registerTheme('carbon-light', carbonLightTheme);
echarts.registerTheme('carbon-dark', carbonDarkTheme);

export const CARBON_DARK = 'carbon-dark';
export const CARBON_LIGHT = 'carbon-light';
