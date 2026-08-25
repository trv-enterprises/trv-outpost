import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../utils/streamConnectionManager', () => ({
  default: { getInstance: () => ({ subscribe: () => () => {} }) },
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

const mk = (type, extra = {}) => ({
  id: 'c1', name: 'Nightlight', title: 'Nightlight',
  connection_id: 'conn1',
  control_config: { control_type: type, target: 'zigbee2mqtt/lamp/set', ui_config: extra },
});

describe('light controls', () => {
  it('renders tile_light', () => {
    const { container } = render(<ControlRenderer control={mk('tile_light')} />);
    expect(container.querySelector('.tile-light')).toBeTruthy();
    // ControlRenderer owns the panel title; the tile must not render its own.
    expect(container.querySelectorAll('.control-title').length).toBe(0);
  });

  it('renders light (panel form) with its title from ControlRenderer', () => {
    const { container } = render(<ControlRenderer control={mk('light')} />);
    expect(container.querySelector('.control-light')).toBeTruthy();
    expect(container.querySelector('.control-title')?.textContent).toBe('Nightlight');
  });

  it('shows the colour swatch on the tile face', () => {
    const { container } = render(<ControlRenderer control={mk('tile_light')} />);
    expect(container.querySelector('.tile-light-swatch')).toBeTruthy();
  });

  it('hides the tile swatch when the user cannot control', () => {
    const { container } = render(<ControlRenderer control={mk('tile_light')} canControl={false} />);
    expect(container.querySelector('.tile-light-swatch')).toBeFalsy();
  });

  it('hides the tile swatch when configured off', () => {
    const { container } = render(
      <ControlRenderer control={mk('tile_light', { show_color_on_tile: false })} />);
    expect(container.querySelector('.tile-light-swatch')).toBeFalsy();
  });

  it('omits the motion dot when the device reports no occupancy field', () => {
    const { container } = render(<ControlRenderer control={mk('tile_light')} />);
    expect(container.querySelector('.tile-light-motion')).toBeFalsy();
  });

  it('renders OFF state before any device message arrives', () => {
    render(<ControlRenderer control={mk('tile_light')} />);
    expect(screen.getByText('OFF')).toBeTruthy();
  });
});
