// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Dashboard Assistant conversation export. The implementation (and secret
// masking) is the shared exporter used by both AI surfaces — see
// shared/exportAgentConversation.js and issue #40. This thin wrapper just
// stamps the Assistant's title + filename prefix so existing call sites in
// AssistantSidecard keep working unchanged and now also get masked exports.

import {
  exportAsMarkdown as sharedExportAsMarkdown,
  exportAsJson as sharedExportAsJson,
} from '../shared/exportAgentConversation';

const IDENTITY = { title: 'Dashboard Assistant', filePrefix: 'dashboard-assistant' };

export function exportAsMarkdown(opts) {
  sharedExportAsMarkdown({ ...IDENTITY, ...opts });
}

export function exportAsJson(opts) {
  sharedExportAsJson({ ...IDENTITY, ...opts });
}
