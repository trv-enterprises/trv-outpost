// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Component } from 'react';

/**
 * PanelErrorBoundary
 *
 * A per-panel React error boundary for the dashboard grid. Dashboard
 * panels render eval'd component code (DynamicComponentLoader) plus
 * controls, displays, and text. Any of those can throw at RENDER time —
 * the classic case being eval'd component code that references a symbol
 * missing from the loader's injected scope (e.g. a stale bundle rendered
 * against newer component records). Without a boundary, a single such
 * throw unmounts the ENTIRE dashboard tree, leaving a black screen with
 * no indication of which panel failed.
 *
 * This boundary contains the blast radius to one panel: the rest of the
 * dashboard keeps rendering, and the failed panel shows an inline error
 * tile naming the failure. The viewer stays usable.
 *
 * Reset behavior: when `resetKey` changes (e.g. the component is
 * re-saved with a new version, or the dashboard reloads), the boundary
 * clears its error state and retries the render — so a fix recovers the
 * panel without a full page reload.
 */
class PanelErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || String(error) };
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: '' });
    }
  }

  componentDidCatch(error, info) {
    const label = this.props.label ? ` (${this.props.label})` : '';
    console.error(`[PanelErrorBoundary] Panel render failed${label}:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="panel-error">
          <div className="panel-error-title">{this.props.label || 'Component'} failed to render</div>
          <div className="panel-error-message">{this.state.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default PanelErrorBoundary;
