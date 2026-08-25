import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const executeControlCommand = vi.fn().mockResolvedValue({ message: 'ok' });

vi.mock('../../utils/streamConnectionManager', () => ({
  default: { getInstance: () => ({ subscribe: () => () => {} }) },
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

const control = {
  id: 'light-1', name: 'Nightlight', title: 'Nightlight',
  connection_id: 'conn1',
  control_config: {
    control_type: 'tile_light',
    target: 'zigbee2mqtt/motion-night-light-001/set',
    ui_config: {},
  },
};

describe('setting colour from the tile face', () => {
  beforeEach(() => executeControlCommand.mockClear());

  it('publishes hex directly, with no conversion on the command path', async () => {
    const { container } = render(<ControlRenderer control={control} />);

    // The swatch trigger lives on the tile itself — one tap, not via the popup.
    const trigger = container.querySelector('.tile-light-swatch button');
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);

    // Pick amber from the light palette.
    const amber = await screen.findByLabelText('Amber');
    fireEvent.click(amber);

    await waitFor(() => expect(executeControlCommand).toHaveBeenCalledTimes(1));
    const [id, value] = executeControlCommand.mock.calls[0];
    expect(id).toBe('light-1');
    // Composite object: hex verbatim, and state:ON so a colour pick also
    // turns the light on.
    expect(value).toEqual({ state: 'ON', color: { hex: '#FFD300' } });
  });

  it('does not open the tile popup when the swatch is used', async () => {
    const { container } = render(<ControlRenderer control={control} />);
    fireEvent.click(container.querySelector('.tile-light-swatch button'));
    await screen.findByLabelText('Amber');
    // The popup hosts the full control; it must not be behind the picker.
    expect(document.querySelector('.tile-popup')).toBeFalsy();
  });
});
