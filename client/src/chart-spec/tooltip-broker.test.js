// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pins the one-tooltip-at-a-time broker.
//
// Every ECharts instance owns its own tooltip div, and with appendToBody they
// all float over the page with nothing coordinating them — so chart A's
// readout stayed up while the pointer was over chart B ("cannot switch to
// another chart's point"). Per-chart pointerleave alone races: a fast move
// between panels can skip the leave, or B can render before A's leave runs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerTooltipOwner,
  claimTooltip,
  releaseTooltip,
  hideAllTooltips,
  __resetTooltipBroker,
} from './tooltip-broker';

beforeEach(() => __resetTooltipBroker());

describe('tooltip broker', () => {
  it('hides every OTHER chart when one claims', () => {
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    [a, b, c].forEach(registerTooltipOwner);
    claimTooltip(b);
    expect(a).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled(); // never hide the claimant
  });

  it('is idempotent while the same chart keeps claiming', () => {
    // claim() runs on every pointermove; re-hiding the others on each one
    // would be wasteful and could fight the owner's own render.
    const a = vi.fn(); const b = vi.fn();
    [a, b].forEach(registerTooltipOwner);
    claimTooltip(b);
    a.mockClear();
    claimTooltip(b);
    claimTooltip(b);
    expect(a).not.toHaveBeenCalled();
  });

  it('hands ownership over on A -> B -> A', () => {
    const a = vi.fn(); const b = vi.fn();
    [a, b].forEach(registerTooltipOwner);
    claimTooltip(a);
    claimTooltip(b);
    expect(a).toHaveBeenCalledTimes(1);
    a.mockClear(); b.mockClear();
    claimTooltip(a);
    expect(b).toHaveBeenCalledTimes(1); // B told to hide on the way back
  });

  it('ignores a LATE release from a chart that no longer owns it', () => {
    // The race that matters: pointer moves A -> B, B claims, then A's
    // delayed pointerleave arrives. It must not blank B.
    const a = vi.fn(); const b = vi.fn();
    [a, b].forEach(registerTooltipOwner);
    claimTooltip(a);
    claimTooltip(b);
    b.mockClear();
    releaseTooltip(a); // late leave from A
    expect(b).not.toHaveBeenCalled();
    // ...and B still owns it, so a re-claim by B stays a no-op.
    const other = vi.fn();
    registerTooltipOwner(other);
    claimTooltip(b);
    expect(other).not.toHaveBeenCalled();
  });

  it('hides everything on a page-level event', () => {
    const a = vi.fn(); const b = vi.fn();
    [a, b].forEach(registerTooltipOwner);
    claimTooltip(a);
    hideAllTooltips();
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('stops calling a chart after it unregisters', () => {
    // A hider outliving its component would dispatch into a disposed ECharts
    // instance on the next claim.
    const a = vi.fn(); const b = vi.fn();
    const offA = registerTooltipOwner(a);
    registerTooltipOwner(b);
    offA();
    claimTooltip(b);
    expect(a).not.toHaveBeenCalled();
  });

  it('clears ownership when the OWNER unmounts', () => {
    // Otherwise `owner` points at a dead chart and the next claim by a new
    // chart would be treated as a no-op re-claim.
    const a = vi.fn(); const b = vi.fn();
    const c = vi.fn();
    const offA = registerTooltipOwner(a);
    registerTooltipOwner(b);
    registerTooltipOwner(c);
    claimTooltip(a);      // hides b and c
    offA();               // the OWNER unmounts
    b.mockClear(); c.mockClear();
    claimTooltip(b);      // must be treated as a REAL claim, not a no-op
    expect(c).toHaveBeenCalledTimes(1); // so c is told to hide
    expect(b).not.toHaveBeenCalled();   // and the claimant is never hidden
  });
});
