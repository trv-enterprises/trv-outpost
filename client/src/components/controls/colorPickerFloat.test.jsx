import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const executeControlCommand = vi.fn().mockResolvedValue({ message: 'ok' });
vi.mock('../../utils/streamConnectionManager', () => ({
  default: { getInstance: () => ({ subscribe: (_c, cb) => { cb({ topic: 'zigbee2mqtt/lamp', state: 'ON', brightness: 100 }); return () => {}; } }) },
}));
vi.mock('../../context/NotificationContext', () => ({ useNotifications: () => ({ addNotification: () => {} }) }));
vi.mock('../../api/client', () => ({
  default: { executeControlCommand: (...a) => executeControlCommand(...a), getSetting: vi.fn().mockResolvedValue({ value: 'sm' }) },
}));

import ControlRenderer from './ControlRenderer';
import './index';

const control = {
  id: 'light-1', name: 'Night Light', title: 'Night Light', connection_id: 'conn1',
  control_config: { control_type: 'light', target: 'zigbee2mqtt/lamp/set', ui_config: {} },
};

// Dashboard panels and tiles set overflow:hidden, so an inline popover is
// clipped at the panel edge — the palette was cut off mid-row. Floating mode
// portals it to document.body so nothing can clip it.
describe('color palette escapes its clipping container', () => {
  beforeEach(() => executeControlCommand.mockClear());

  it('renders the palette outside the control subtree', async () => {
    const { container } = render(<ControlRenderer control={control} />);
    fireEvent.click(container.querySelector('.color-swatch-picker__trigger'));

    const amber = await screen.findByLabelText('Amber');
    // The swatch must NOT be inside the (clipping) control markup...
    expect(container.contains(amber)).toBe(false);
    // ...it lives on document.body instead.
    expect(document.querySelector('.color-swatch-picker__content--float')).toBeTruthy();
  });

  it('still picks a color through the portal', async () => {
    const { container } = render(<ControlRenderer control={control} />);
    fireEvent.click(container.querySelector('.color-swatch-picker__trigger'));
    fireEvent.click(await screen.findByLabelText('Amber'));

    await waitFor(() => expect(executeControlCommand).toHaveBeenCalledTimes(1));
    const [, value] = executeControlCommand.mock.calls[0];
    expect(value).toEqual({ state: 'ON', color: { hex: '#FFD300' } });
  });

  it('closes on the backdrop', async () => {
    const { container } = render(<ControlRenderer control={control} />);
    fireEvent.click(container.querySelector('.color-swatch-picker__trigger'));
    await screen.findByLabelText('Amber');
    fireEvent.click(document.querySelector('.color-swatch-picker__backdrop'));
    expect(document.querySelector('.color-swatch-picker__content--float')).toBeFalsy();
  });

  it('leaves other callers inline (no portal without the flag)', async () => {
    // Guards the 8 chart/threshold call sites that did not opt in.
    const { default: ColorSwatchPicker } = await import('../shared/ColorSwatchPicker');
    const { container } = render(<ColorSwatchPicker value="#ff0000" onChange={() => {}} />);
    fireEvent.click(container.querySelector('.color-swatch-picker__trigger'));
    expect(document.querySelector('.color-swatch-picker__content--float')).toBeFalsy();
  });
});
