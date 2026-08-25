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

describe('setting color from the tile', () => {
  beforeEach(() => executeControlCommand.mockClear());

  it('publishes hex directly, with no conversion on the command path', async () => {
    const { container } = render(<ControlRenderer control={control} />);

    // One tap on the tile opens the popup, which carries the picker. (The
    // picker cannot live on the tile face: Carbon's Popover renders inline
    // and the tile clips it.)
    fireEvent.click(container.querySelector('.tile-light'));
    const popup = document.querySelector('.tile-popup');
    expect(popup).toBeTruthy();

    fireEvent.click(popup.querySelector('.color-swatch-picker__trigger'));
    fireEvent.click(await screen.findByLabelText('Amber'));

    await waitFor(() => expect(executeControlCommand).toHaveBeenCalledTimes(1));
    const [id, value] = executeControlCommand.mock.calls[0];
    expect(id).toBe('light-1');
    // Composite object: hex verbatim, and state:ON so a color pick also
    // turns the light on.
    expect(value).toEqual({ state: 'ON', color: { hex: '#FFD300' } });
  });

  it('reaches the picker in one tap from the tile', async () => {
    const { container } = render(<ControlRenderer control={control} />);
    fireEvent.click(container.querySelector('.tile-light'));
    const popup = document.querySelector('.tile-popup');
    fireEvent.click(popup.querySelector('.color-swatch-picker__trigger'));
    // The palette is portalled with the popup, so nothing clips it.
    expect(await screen.findByLabelText('Amber')).toBeTruthy();
  });
});
