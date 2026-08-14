// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Shared vitest setup: jest-dom matchers + the browser APIs jsdom lacks
// that Carbon components touch at render time.
import '@testing-library/jest-dom/vitest';

// Carbon components read matchMedia for breakpoint behavior; jsdom has none.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom has no ResizeObserver; ECharts wrappers and some Carbon components
// construct one.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom has no scrollIntoView on elements; Downshift-based Carbon pickers
// call it when opening.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
