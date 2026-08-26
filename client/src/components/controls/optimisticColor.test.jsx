import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const executeControlCommand = vi.fn().mockResolvedValue({ message: 'ok' });
let subs = [];
// Device starts ORANGE; the user will pick BLUE.
const ORANGE = { topic: 'zigbee2mqtt/lamp', state: 'ON', brightness: 100, color: { x: 0.5, y: 0.44 } };

vi.mock('../../utils/streamConnectionManager', () => ({
  default: {
    getInstance: () => ({
      subscribe: (_c, cb) => { subs.push(cb); cb({ ...ORANGE }); return () => { subs = subs.filter((s) => s !== cb); }; },
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
const control = {
  id: 'c1', name: 'Night Light', title: 'Night Light', connection_id: 'conn1',
  control_config: { control_type: 'light', target: 'zigbee2mqtt/lamp/set', ui_config: {} },
};
const swatch = (c) => c.querySelector('.color-swatch-picker__trigger')?.style.backgroundColor;

// The bug: picking a color left the control showing the OLD device color
// until the device echoed back. holdWrittenHex yielded to the device whenever
// the two differed — but right after a write they ALWAYS differ, because the
// device has not caught up yet. So the optimistic update was discarded at
// exactly the moment it was needed.
describe('a picked color shows immediately', () => {
  beforeEach(() => { executeControlCommand.mockClear(); subs = []; vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  const pickBlue = async (container) => {
    fireEvent.click(container.querySelector('.color-swatch-picker__trigger'));
    fireEvent.click(document.querySelector('[aria-label="Blue"]'));
    await waitFor(() => expect(executeControlCommand).toHaveBeenCalled());
  };

  it('shows the picked color before the device echoes anything', async () => {
    const { container } = render(<ControlRenderer control={control} />);
    const orange = swatch(container);
    expect(orange).toBeTruthy();

    await pickBlue(container);

    // No device message has arrived yet — the swatch must ALREADY be blue.
    expect(swatch(container), 'optimistic update did not appear').toBe('rgb(84, 124, 255)');
    expect(swatch(container)).not.toBe(orange);
  });

  it('keeps showing the picked color while the device still reports the old one', async () => {
    const { container } = render(<ControlRenderer control={control} />);
    await pickBlue(container);
    // A stale echo carrying the OLD color must not clobber the pick.
    push({ color: { x: 0.5, y: 0.44 } });
    expect(swatch(container)).toBe('rgb(84, 124, 255)');
  });

  it('yields to the device once the hold expires', async () => {
    const { container } = render(<ControlRenderer control={control} />);
    await pickBlue(container);
    // An automation recolors the bulb green; after the hold the UI follows.
    push({ color: { x: 0.2, y: 0.6 } });
    await act(async () => { vi.advanceTimersByTime(5000); });
    await waitFor(() => {
      expect(swatch(container), 'never yielded to the device').not.toBe('rgb(84, 124, 255)');
    });
  });
});
