// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Two bugs met in one symptom: a WHITE tooltip on a dark dashboard, clipped at
// the panel edge and overlapping the neighbouring panel.
//
// 1. The dark and light themes' `tooltip` blocks were SWAPPED — the dark theme
//    carried a near-white surface with near-black text.
// 2. `echarts.registerTheme` ran only inside DynamicComponentLoader's effect,
//    keyed on `code`, so it fired only when a CUSTOM-CODE chart mounted.
//    Spec-driven charts (ChartShell) request `theme="carbon-dark"` by name and
//    never registered it. ECharts does NOT warn on an unknown theme name — it
//    silently uses its built-in light theme, which also meant losing
//    `tooltip.appendToBody` and so getting clipped by the panel.
//
// A canvas-free test: jsdom can't init a real ECharts instance, so assert the
// theme OBJECTS and the registration module's contract instead.

import { describe, it, expect, vi } from 'vitest';
import { carbonDarkTheme, carbonLightTheme } from './carbonEchartsTheme';

describe('carbon ECharts themes — tooltip', () => {
  it('gives the DARK theme a dark surface with light text', () => {
    // The swap: this used to be rgba(244,244,244,.95) on #161616 text.
    expect(carbonDarkTheme.tooltip.backgroundColor).toBe('rgba(22, 22, 22, 0.9)');
    expect(carbonDarkTheme.tooltip.textStyle.color).toBe('#ffffff');
  });

  it('gives the LIGHT theme a light surface with dark text', () => {
    expect(carbonLightTheme.tooltip.backgroundColor).toBe('rgba(244, 244, 244, 0.95)');
    expect(carbonLightTheme.tooltip.textStyle.color).toBe('#161616');
  });

  it('keeps the two themes from sharing a tooltip surface', () => {
    // The failure mode was them being identical-but-wrong; a future edit that
    // copies one block over the other should fail here.
    expect(carbonDarkTheme.tooltip.backgroundColor)
      .not.toBe(carbonLightTheme.tooltip.backgroundColor);
  });

  it('sets appendToBody on BOTH themes', () => {
    // This is what lets a tooltip escape the panel's overflow:hidden instead
    // of being clipped and shoved off the viewport edge.
    expect(carbonDarkTheme.tooltip.appendToBody).toBe(true);
    expect(carbonLightTheme.tooltip.appendToBody).toBe(true);
  });
});

describe('registerEchartsThemes', () => {
  it('registers BOTH theme names with ECharts at module load', async () => {
    // echarts' ESM exports are frozen (can't spyOn), so mock the module and
    // assert what the side-effect import calls. Registration must not be
    // conditional or deferred — ChartShell resolves the name synchronously
    // when it mounts, which is exactly what the old effect-scoped
    // registration failed to guarantee.
    const calls = [];
    vi.doMock('echarts', () => ({
      registerTheme: (name, theme) => calls.push([name, theme]),
    }));
    vi.resetModules();
    await import('./registerEchartsThemes');
    const names = calls.map((c) => c[0]);
    expect(names).toContain('carbon-dark');
    expect(names).toContain('carbon-light');
    // The registered object must be the real theme, not a placeholder.
    const dark = calls.find((c) => c[0] === 'carbon-dark')[1];
    expect(dark.tooltip.appendToBody).toBe(true);
    vi.doUnmock('echarts');
    vi.resetModules();
  });

  it('exports the exact names components hardcode', async () => {
    // ChartShell writes theme="carbon-dark" as a literal; a drifted constant
    // would silently fall back to ECharts' default theme.
    const m = await import('./registerEchartsThemes');
    expect(m.CARBON_DARK).toBe('carbon-dark');
    expect(m.CARBON_LIGHT).toBe('carbon-light');
  });
});
