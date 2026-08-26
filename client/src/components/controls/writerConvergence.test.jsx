import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const executeControlCommand = vi.fn().mockResolvedValue({ message: 'ok' });
let subs = [];
let retained = { topic: 'zigbee2mqtt/lamp', state: 'ON', brightness: 100, color: { x: 0.4995, y: 0.4697 } };

vi.mock('../../utils/streamConnectionManager', () => ({
  default: {
    getInstance: () => ({
      subscribe: (_c, cb) => { subs.push(cb); cb({ ...retained }); return () => { subs = subs.filter((s) => s !== cb); }; },
    }),
  },
}));
vi.mock('../../context/NotificationContext', () => ({ useNotifications: () => ({ addNotification: () => {} }) }));
vi.mock('../../api/client', () => ({
  default: { executeControlCommand: (...a) => executeControlCommand(...a), getSetting: vi.fn().mockResolvedValue({ value: 'sm' }) },
}));

import ControlRenderer from './ControlRenderer';
import './index';

const push = (rec) => act(() => { subs.forEach((cb) => cb({ topic: 'zigbee2mqtt/lamp', ...rec })); });
const mk = (type) => ({
  id: 'c1', name: 'Night Light', title: 'Night Light', connection_id: 'conn1',
  control_config: { control_type: type, target: 'zigbee2mqtt/lamp/set', ui_config: {} },
});
const swatch = (c) => c.querySelector('.color-swatch-picker__trigger')?.style.backgroundColor;

// The reported asymmetry: the control the user just used lagged behind a
// passive tile watching the same device. Suppression DROPPED messages for 3s
// after a write, so the writer went blind and only recovered on the next
// message; the tile never writes, so it never suppressed.
describe('the control that wrote converges as fast as one that did not', () => {
  beforeEach(() => { executeControlCommand.mockClear(); subs = []; vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('applies a device update that arrives during the suppression window', async () => {
    const { container } = render(<ControlRenderer control={mk('light')} />);

    // Write a color, which opens the suppression window.
    fireEvent.click(container.querySelector('.color-swatch-picker__trigger'));
    const amber = document.querySelector('[aria-label="Amber"]');
    fireEvent.click(amber);
    await waitFor(() => expect(executeControlCommand).toHaveBeenCalled());

    // The device reports a DIFFERENT color while we are still suppressing —
    // someone else changed it, or the bulb clamped to something else.
    push({ color: { x: 0.15, y: 0.06 } });

    // Once the window closes the deferred value must be applied, without
    // needing another message to arrive.
    await act(async () => { vi.advanceTimersByTime(5000); });
    await waitFor(() => {
      expect(swatch(container), 'writer never converged to the device color').toBeTruthy();
    });
  });

  it('a live message outside the window still applies immediately', async () => {
    const { container } = render(<ControlRenderer control={mk('light')} />);
    const before = swatch(container);
    push({ color: { x: 0.15, y: 0.06 } });
    expect(swatch(container)).not.toBe(before);
  });

  it('the passive tile updates immediately (it never suppresses)', () => {
    const { container } = render(<ControlRenderer control={mk('tile_light')} />);
    const before = container.querySelector('.tile-light-swatch')?.style.backgroundColor;
    push({ color: { x: 0.15, y: 0.06 } });
    expect(container.querySelector('.tile-light-swatch')?.style.backgroundColor).not.toBe(before);
  });
});
