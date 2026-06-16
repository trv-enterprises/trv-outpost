// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// The tool-call row is now the shared AgentToolCallCard, used by both the
// Dashboard Assistant and the in-editor Component agent (issue #40 — UX
// parity). This file is a back-compat re-export so existing imports keep
// working; the implementation + styling live in shared/AgentToolCallCard.
export { default } from '../shared/AgentToolCallCard';
