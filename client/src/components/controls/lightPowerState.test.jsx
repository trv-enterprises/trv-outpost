import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const executeControlCommand = vi.fn().mockResolvedValue({ message: 'ok' });

// One fake MQTT record, pushed to every subscriber on mount. Zigbee reports
// `brightness` as the REMEMBERED level while `state` is OFF — that pairing is
// the whole point of these tests.
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
    executeControlCommand: (...a) => executeControlCommand(...a),
    getSetting: vi.fn().mockResolvedValue({ value: 'sm' }),
  },
}));

import ControlRenderer from './ControlRenderer';
import './index';

const mk = (type, ui = {}) => ({
  id: 'c1', name: 'Lamp', title: 'Lamp', connection_id: 'conn1',
  control_config: { control_type: type, target: 'zigbee2mqtt/lamp/set', ui_config: ui },
});

describe('an OFF light with a remembered brightness', () => {
  beforeEach(() => { executeControlCommand.mockClear(); });

  // The reported symptom: light is off, but the tiles rendered it as on and
  // in colour, because brightness was non-zero.
  const OFF_WITH_LEVEL = { state: 'OFF', brightness: 109, color: { x: 0.4995, y: 0.4697 } };

  it('tile_light renders OFF and unlit', () => {
    record = OFF_WITH_LEVEL;
    const { container } = render(<ControlRenderer control={mk('tile_light')} />);
    expect(container.querySelector('.tile-light-off')).toBeTruthy();
    expect(container.querySelector('.tile-light-on')).toBeFalsy();
    // No coloured fill while off.
    expect(container.querySelector('.tile-light-fill').style.height).toBe('0%');
  });

  it('tile_dimmer renders OFF rather than inferring ON from brightness', () => {
    record = OFF_WITH_LEVEL;
    const { container } = render(
      <ControlRenderer control={mk('tile_dimmer', { device_scale: 254 })} />);
    expect(container.querySelector('.tile-dimmer-high')).toBeFalsy();
    expect(container.querySelector('.tile-dimmer-fill').style.height).toBe('0%');
  });

  it('adjusting brightness on an off light turns it on, and says so', async () => {
    // Verified on the real bulb: {"brightness":N} on an OFF light makes it
    // ON, and {"state":"OFF","brightness":N} leaves the level unchanged --
    // the value is DISCARDED, not remembered. So "set the level without
    // lighting it" is not achievable; sending state:'ON' keeps the UI honest
    // rather than showing OFF while the bulb lights up.
    record = OFF_WITH_LEVEL;
    const { container } = render(<ControlRenderer control={mk('light')} />);
    fireEvent.keyDown(container.querySelector('.control-light__bar'), { key: 'ArrowUp' });
    await waitFor(() => expect(executeControlCommand).toHaveBeenCalled());
    const [, value] = executeControlCommand.mock.calls[0];
    expect(value.state).toBe('ON');
    expect(value.brightness).toBeGreaterThan(0);
    // And the toggle must follow the command, not lag behind it.
    expect(
      container.querySelector('.control-light__toggle button[role="switch"]')
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('the brightness bar is styled as inactive while off', () => {
    record = OFF_WITH_LEVEL;
    const { container } = render(<ControlRenderer control={mk('light')} />);
    expect(container.querySelector('.control-light__bar-fill.is-off')).toBeTruthy();
  });
});

describe('an ON light', () => {
  beforeEach(() => { executeControlCommand.mockClear(); });
  const ON = { state: 'ON', brightness: 109, color: { x: 0.4995, y: 0.4697 } };

  it('tile_light renders ON with a coloured fill', () => {
    record = ON;
    const { container } = render(<ControlRenderer control={mk('tile_light')} />);
    expect(container.querySelector('.tile-light-on')).toBeTruthy();
    expect(container.querySelector('.tile-light-fill').style.height).not.toBe('0%');
  });

  it('adjusting brightness on an on light keeps it on', async () => {
    record = ON;
    const { container } = render(<ControlRenderer control={mk('light')} />);
    fireEvent.keyDown(container.querySelector('.control-light__bar'), { key: 'ArrowDown' });
    await waitFor(() => expect(executeControlCommand).toHaveBeenCalled());
    const [, value] = executeControlCommand.mock.calls[0];
    expect(value.state).toBe('ON');
  });
});

describe('devices that publish no state field', () => {
  beforeEach(() => { executeControlCommand.mockClear(); });

  it('tile_dimmer still infers power from level (historical behaviour)', () => {
    record = { brightness: 109 };
    const { container } = render(
      <ControlRenderer control={mk('tile_dimmer', { device_scale: 254 })} />);
    // No state field, so a non-zero level means on.
    expect(container.querySelector('.tile-dimmer-fill').style.height).not.toBe('0%');
  });
});
