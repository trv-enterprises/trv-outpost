import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
import * as controlsBarrel from './index';

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

// Regression guard: the palette moved out of ControlLight.jsx into its own
// module (a non-component export breaks Fast Refresh), and the barrel kept
// re-exporting it from the old location. That resolves fine in tests that
// import the components directly, but breaks the app at load time with
// "doesn't provide an export named". Assert every name the barrel claims.
describe('controls barrel exports', () => {
  it('resolves every light-related name it re-exports', () => {
    for (const name of [
      'ControlLight', 'TileLight',
      'LIGHT_COLOR_PALETTE', 'ZIGBEE_MAX_BRIGHTNESS', 'pctToZigbee', 'zigbeeToPct',
    ]) {
      expect(controlsBarrel[name], name).toBeDefined();
    }
  });

  it('has no undefined exports at all', () => {
    const dead = Object.keys(controlsBarrel).filter((k) => controlsBarrel[k] === undefined);
    expect(dead).toEqual([]);
  });
});

// The swatch sits inside the tile, which opens a popup on click. Stopping
// propagation on the whole wrapper made its padding/gap a dead zone: clicks
// there were swallowed but hit no handler, so that corner of the tile did
// nothing at all instead of opening the popup like everywhere else.
describe('tile swatch click handling', () => {
  const mkTile = () => ({
    id: 'c1', name: 'Nightlight', title: 'Nightlight',
    connection_id: 'conn1',
    control_config: { control_type: 'tile_light', target: 'zigbee2mqtt/lamp/set', ui_config: {} },
  });

  it('opens the picker (not the tile popup) when the swatch itself is clicked', async () => {
    const { container } = render(<ControlRenderer control={mkTile()} />);
    fireEvent.click(container.querySelector('.tile-light-swatch button'));
    expect(await screen.findByLabelText('Amber')).toBeTruthy();
    expect(document.querySelector('.tile-popup')).toBeFalsy();
  });

  it('opens the tile popup when the wrapper AROUND the swatch is clicked', () => {
    const { container } = render(<ControlRenderer control={mkTile()} />);
    const wrapper = container.querySelector('.tile-light-swatch');
    // A click landing on the wrapper but not on the picker must fall through
    // to the tile rather than being silently swallowed.
    fireEvent.click(wrapper, { bubbles: true });
    expect(document.querySelector('.tile-popup')).toBeTruthy();
  });

  it('opens the tile popup from the tile body', () => {
    const { container } = render(<ControlRenderer control={mkTile()} />);
    fireEvent.click(container.querySelector('.tile-light'));
    expect(document.querySelector('.tile-popup')).toBeTruthy();
  });
});
