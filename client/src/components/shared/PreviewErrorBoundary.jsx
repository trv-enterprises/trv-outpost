// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Component } from 'react';
import { InlineNotification } from '@carbon/react';

/**
 * PreviewErrorBoundary
 *
 * A scoped React error boundary for live-component preview surfaces
 * (AI Builder preview pane, ComponentEditor preview). Eval'd component
 * code — whether AI-generated or hand-written custom code — can throw at
 * RENDER time, not just at transform/eval time. DynamicComponentLoader
 * catches transform/eval errors itself, but a render-time throw escapes
 * it and, without a boundary, unmounts the entire surrounding subtree.
 *
 * That's exactly how a bad number-chart render used to take out the whole
 * AI Builder page including the chat prompt input — leaving the user
 * unable to ask the AI to fix the very component that broke. This
 * boundary contains the blast radius to the preview pane so the chat
 * stays usable.
 *
 * Reset behavior: when `resetKey` changes (e.g. the AI produces a new
 * component version), the boundary clears its error state and retries
 * the render. This lets a follow-up AI fix recover the preview without a
 * page reload.
 */
class PreviewErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || String(error) };
  }

  componentDidUpdate(prevProps) {
    // A new resetKey means the inputs changed (new component version,
    // re-run query, etc.) — clear the error and let the children retry.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: '' });
    }
  }

  componentDidCatch(error, info) {
    // Surface the failure to the console for debugging; the inline
    // notification carries the user-facing message.
    console.error('[PreviewErrorBoundary] Preview render failed:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '8px', height: '100%', display: 'flex', alignItems: 'center' }}>
          <InlineNotification
            kind="error"
            title="Preview failed to render"
            subtitle={this.state.message}
            lowContrast
            hideCloseButton
            style={{ maxWidth: '100%', minWidth: 'auto' }}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

export default PreviewErrorBoundary;
