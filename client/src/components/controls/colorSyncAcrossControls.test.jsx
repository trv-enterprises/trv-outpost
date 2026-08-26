import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const executeControlCommand = vi.fn().mockResolvedValue({ message: 'ok' });

// A broker whose subscribers persist, so we can push a device update AFTER a
// command the way a real broker does.
let subs = [];
let subscribeCount = 0;
let retained = { topic: 'zigbee2mqtt/lamp', state: 'ON', brightness: 100, color: { x: 0.4995, y: 0.4697 } };
vi.mock('../../utils/streamConnectionManager', () => ({
  default: {
    getInstance: () => ({
      subscribe: (_c, cb) => {
        subscribeCount++;
        subs.push(cb);
        cb({ ...retained });
        return () => { subs = subs.filter((s) => s !== cb); };
      },
    }),
  },
}));
vi.mock('../../context/NotificationContext', () => ({ useNotifications: () => ({ addNotification: () => {} }) }));
vi.mock('../../api/client', () => ({
  default: {
    executeControlCommand: (...a) => executeControlCommand(...a),
    getSetting: vi.fn().mockResolvedValue({ value: 'sm' }),
  },
}));

import ControlRenderer from './ControlRenderer';
import './index';

const push = (rec) => act(() => { subs.forEach((cb) => cb({ topic: 'zigbee2mqtt/lamp', ...rec })); });

const mk = (type) => ({
  id: 'c1', name: 'Night Light', title: 'Night Light', connection_id: 'conn1',
  control_config: { control_type: type, target: 'zigbee2mqtt/lamp/set', ui_config: {} },
});

const swatchColor = (container) =>
  container.querySelector('.color-swatch-picker__trigger')?.style.backgroundColor;

describe('color stays in sync with the device', () => {
  beforeEach(() => { executeControlCommand.mockClear(); subs = []; subscribeCount = 0; vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  // The reported bug: pick a color anywhere and the light + tile update, but
  // the control that did the writing keeps showing its OLD color.
  it('the writing control catches up to the device', async () => {
    const { container } = render(<ControlRenderer control={mk('light')} />);

    // Device is amber; a green arrives (set from the tile, or by anything else).
    push({ color: { x: 0.2, y: 0.6 } });
    const green = swatchColor(container);
    expect(green).toBeTruthy();

    // Now a different color arrives again — the swatch must follow, not stick.
    push({ color: { x: 0.15, y: 0.06 } });
    expect(swatchColor(container)).not.toBe(green);
  });

  it('a locally-written color does not stick forever', async () => {
    const { container } = render(<ControlRenderer control={mk('light')} />);
    const initial = swatchColor(container);

    // The device reports a color we did NOT write; the swatch must show it.
    push({ color: { x: 0.15, y: 0.06 } });
    expect(swatchColor(container)).not.toBe(initial);
  });

  // Root cause: `transform` was an inline arrow in the effect's dependency
  // array, so the subscription tore down and re-subscribed on every render.
  // Messages arriving mid-teardown landed on a callback about to be discarded
  // and the value silently stopped updating.
  it('does not re-subscribe on every render', async () => {
    render(<ControlRenderer control={mk('light')} />);
    const afterMount = subscribeCount;

    push({ color: { x: 0.2, y: 0.6 }, brightness: 120 });
    push({ color: { x: 0.15, y: 0.06 }, brightness: 130 });

    expect(subscribeCount, 'subscription churned on re-render').toBe(afterMount);
  });

  it('the tile tracks device color too', async () => {
    const { container } = render(<ControlRenderer control={mk('tile_light')} />);
    const before = container.querySelector('.tile-light-swatch')?.style.backgroundColor;
    push({ color: { x: 0.15, y: 0.06 } });
    const after = container.querySelector('.tile-light-swatch')?.style.backgroundColor;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});
