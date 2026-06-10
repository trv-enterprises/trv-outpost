// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// SINGLE ROOT SOURCE OF TRUTH for the app's active Carbon theme on the JS side.
// The SCSS side sets the theme in App.scss (`@use theme with ($theme: g100)`);
// this is the JS counterpart. Anything that needs to pick theme-specific values
// in JS (notably the chart categorical palette) keys off APP_THEME so a future
// theme switch is a ONE-LINE change here.
//
// To switch themes: change APP_THEME (and the SCSS `$theme` in App.scss to match).
export const APP_THEME = 'g100'; // 'white' | 'g10' | 'g90' | 'g100'

// True when the active theme is a dark one (g90/g100). Drives dark-vs-light
// palette selection below.
export const IS_DARK_THEME = APP_THEME === 'g90' || APP_THEME === 'g100';

// Carbon's CATEGORICAL (qualitative) data-viz palettes — there are TWO, tuned
// for light vs dark canvases. The sequence is curated to maximize contrast
// between neighboring colors; apply strictly in order. Source: IBM Carbon
// "Categorical palettes" (carbon-charts color tokens). Token names kept in the
// trailing comments so the mapping back to Carbon stays auditable.

// LIGHT canvas — darker, more saturated colors that read on white.
export const CATEGORICAL_COLORS_LIGHT = [
  '#6929c4', // 1  purple70
  '#1192e8', // 2  cyan50
  '#005d5d', // 3  teal70
  '#9f1853', // 4  magenta70
  '#fa4d56', // 5  red50
  '#520408', // 6  red90
  '#198038', // 7  green60
  '#002d9c', // 8  blue80
  '#ee5396', // 9  magenta50
  '#b28600', // 10 yellow50
  '#009d9a', // 11 teal50
  '#012749', // 12 cyan90
  '#8a3800', // 13 orange70
  '#a56eff', // 14 purple50
];

// DARK canvas — lighter variants that pop against a dark background.
export const CATEGORICAL_COLORS_DARK = [
  '#8a3ffc', // 1  purple60
  '#33b1ff', // 2  cyan40
  '#007d79', // 3  teal60
  '#ff7eb6', // 4  magenta40
  '#fa4d56', // 5  red50
  '#fff1f1', // 6  red10
  '#6fdc8c', // 7  green30
  '#4589ff', // 8  blue50
  '#d12771', // 9  magenta60
  '#d2a106', // 10 yellow40
  '#08bdba', // 11 teal40
  '#bae6ff', // 12 cyan20
  '#ba4e00', // 13 orange60
  '#d4bbff', // 14 purple30
];

// The active categorical palette for the current theme. Single seam: change
// APP_THEME above (and App.scss) to switch the whole app's series colors.
export const CATEGORICAL_PALETTE = IS_DARK_THEME ? CATEGORICAL_COLORS_DARK : CATEGORICAL_COLORS_LIGHT;

// Carbon names for the active palette, index-aligned to CATEGORICAL_PALETTE.
// Used by the per-series color picker + the agent's by-name vocabulary.
const PALETTE_NAMES_LIGHT = [
  'purple70', 'cyan50', 'teal70', 'magenta70', 'red50', 'red90', 'green60',
  'blue80', 'magenta50', 'yellow50', 'teal50', 'cyan90', 'orange70', 'purple50',
];
const PALETTE_NAMES_DARK = [
  'purple60', 'cyan40', 'teal60', 'magenta40', 'red50', 'red10', 'green30',
  'blue50', 'magenta60', 'yellow40', 'teal40', 'cyan20', 'orange60', 'purple30',
];
export const CATEGORICAL_NAMES = IS_DARK_THEME ? PALETTE_NAMES_DARK : PALETTE_NAMES_LIGHT;
