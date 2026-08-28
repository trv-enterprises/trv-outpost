// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * The reported symptom: "when the color of the light is a light color and the
 * light is on, the light name and the lever % are not very visible."
 *
 * The tile hardcoded #ffffff for its text whenever the light was on, but the
 * fill behind that text is the bulb's own color — so Candle (#FFF6E5) or Cool
 * white gave white-on-near-white.
 *
 * The fix picks the text color from the fill's measured contrast, and decides
 * per element WHICH background to measure against: the fill rises from the
 * bottom, so at a given brightness the name and the bottom row can sit on
 * different backgrounds. That decision has to come from each element's own
 * measured box — the first attempt compared the fill to the tile's 50% line,
 * but `.tile-name` centres its text lower than that, so a nearly-covered name
 * still tested as uncovered and stayed white.
 *
 * Known and accepted: while the fill line crosses the glyphs, the text spans
 * two backgrounds at once (pale fill below, #393939 tile above) and NO single
 * colour clears 1.57:1 against both. The title's 600 weight plus the halo that
 * flips with the text colour carry it in practice — verified on the worst case
 * (Candle, two-line name, mid brightness). Don't "fix" this with a backing
 * plate behind the name; that was prototyped and rejected as too intrusive.
 */

let record = {};
vi.mock('../../utils/streamConnectionManager', () => ({
  default: {
    getInstance: () => ({
      subscribe: (_c, cb) => { cb({ topic: 'zigbee2mqtt/lamp', ...record }); return () => {}; },
    }),
  },
}));
vi.mock('../../context/NotificationContext', () => ({
  useNotifications: () => ({ addNotification: () => {} }),
}));
vi.mock('../../api/client', () => ({
  default: {
    executeControlCommand: vi.fn(),
    getSetting: vi.fn().mockResolvedValue({ value: 'sm' }),
  },
}));

import ControlRenderer from './ControlRenderer';
import './index';
import { isTextMostlyOnFill } from './controlUtils';

const mk = (ui = {}) => ({
  id: 'c1', name: 'Lamp', title: 'Lamp', connection_id: 'conn1',
  control_config: { control_type: 'tile_light', target: 'zigbee2mqtt/lamp/set', ui_config: ui },
});

// xy as the real bulb reports it. Candle is the pale end of the palette and
// the color that made the bug obvious.
const CANDLE = { x: 0.3805, y: 0.3576 };

/** Inline colors React wrote, normalised to hex for comparison. */
const colorOf = (el) => {
  const c = el?.style.color || '';
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(c);
  if (!m) return c;
  return `#${[1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('')}`;
};

/**
 * The coverage decision, tested on its own.
 *
 * jsdom performs no layout — every getBoundingClientRect is 0×0 — so the
 * component test below cannot exercise this. These numbers come from the
 * compiled stylesheet: a 100px tile with `padding: 8px 4px 4px`, a 19.2px
 * icon, a 17px bottom row, and `.tile-name` as a `flex: 1` box holding one
 * line of text, vertically centred.
 */
describe('which background the text mostly sits on', () => {
  const TILE_H = 100;
  const ICON_H = 19.2;
  const ROW_H = 17;

  const NAME_TOP = 8 + ICON_H;
  const NAME_H = TILE_H - 8 - 4 - ICON_H - ROW_H;
  const nameRect = { top: NAME_TOP, height: NAME_H, bottom: NAME_TOP + NAME_H };

  /** Top edge of a fill of the given percent, in the same coord space. */
  const fillTopAt = (pct) => TILE_H - (TILE_H * pct) / 100;

  it('darkens the name at the brightness that showed the bug', () => {
    // The screenshot: ~55% fill, the name almost entirely on yellow, still
    // rendered white. The name box spans y=27–79, so a 55% fill (top edge at
    // y=45) covers 34 of its 52px.
    expect(isTextMostlyOnFill(nameRect, fillTopAt(55))).toBe(true);
  });

  it('does not split two tiles that are a hair apart', () => {
    // The old `fillPercent > 50` put the flip point INSIDE the text, so two
    // similar tiles landed on opposite sides of it — the reported symptom of
    // one tile white and its neighbour dark. The real crossover has to sit at
    // the text's own midpoint (~47% here), well clear of this pair.
    expect(isTextMostlyOnFill(nameRect, fillTopAt(51)))
      .toBe(isTextMostlyOnFill(nameRect, fillTopAt(55)));
  });

  it('leaves the name light while the fill is genuinely below it', () => {
    expect(isTextMostlyOnFill(nameRect, fillTopAt(30))).toBe(false);
    expect(isTextMostlyOnFill(nameRect, fillTopAt(0))).toBe(false);
  });

  it('crosses at the name text, not at the tile midpoint', () => {
    // The distinction the bug turned on: the name's own midpoint is ~47% of
    // tile height, NOT 50%. Anything between the two was mis-colored.
    expect(isTextMostlyOnFill(nameRect, fillTopAt(48))).toBe(true);
    expect(isTextMostlyOnFill(nameRect, fillTopAt(46))).toBe(false);
  });

  it('flips the bottom row much earlier, since it sits at the bottom', () => {
    const rowTop = TILE_H - 4 - ROW_H;
    const rowRect = { top: rowTop, height: ROW_H, bottom: rowTop + ROW_H };
    expect(isTextMostlyOnFill(rowRect, fillTopAt(25))).toBe(true);
    expect(isTextMostlyOnFill(rowRect, fillTopAt(5))).toBe(false);
  });

  it('reports nothing covered for an unlaid-out element', () => {
    expect(isTextMostlyOnFill({ top: 0, height: 0, bottom: 0 }, 0)).toBe(false);
  });
});

describe('tile_light text over a pale bulb color', () => {
  it('leaves an off light alone', () => {
    record = { state: 'OFF', brightness: 200, color: CANDLE };
    const { container } = render(<ControlRenderer control={mk()} />);
    expect(container.querySelector('.tile-light-off')).toBeTruthy();
    expect(colorOf(container.querySelector('.tile-name'))).toBe('');
    expect(colorOf(container.querySelector('.tile-bottom-row'))).toBe('');
  });

  it('leaves the text alone when the device reports no color', () => {
    // Nothing to measure contrast against — the stylesheet's white is right
    // for the default fill.
    record = { state: 'ON', brightness: 254 };
    const { container } = render(<ControlRenderer control={mk()} />);
    expect(colorOf(container.querySelector('.tile-name'))).toBe('');
    expect(colorOf(container.querySelector('.tile-bottom-row'))).toBe('');
  });
});
