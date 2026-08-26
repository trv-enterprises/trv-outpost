import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import ColorSwatchPicker from './ColorSwatchPicker';

// React maps onChange on <input type="color"> to the native `input` event,
// which fires continuously while the OS color wheel is dragged. For a caller
// that turns each change into a device command, that is a flood — every drag
// step published an MQTT message and reset the bulb.
describe('custom color input throttling', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const openPicker = (onChange, props = {}) => {
    const r = render(
      <ColorSwatchPicker value="#000000" onChange={onChange} allowCustom {...props} />,
    );
    fireEvent.click(r.container.querySelector('.color-swatch-picker__trigger'));
    return r;
  };
  const custom = (c) => c.querySelector('input[type="color"]');

  it('forwards every change when no throttle is set (existing callers)', () => {
    const onChange = vi.fn();
    const { container } = openPicker(onChange);
    for (const hex of ['#111111', '#222222', '#333333']) {
      fireEvent.change(custom(container), { target: { value: hex } });
    }
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('rate-limits a burst of drag events', () => {
    const onChange = vi.fn();
    const { container } = openPicker(onChange, { customThrottleMs: 250 });

    // A drag: many changes in quick succession.
    for (const hex of ['#111111', '#222222', '#333333', '#444444', '#555555']) {
      fireEvent.change(custom(container), { target: { value: hex } });
    }
    // The first lands immediately; the rest are collapsed.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('#111111');
  });

  it('still delivers the FINAL color of a drag (trailing send)', () => {
    const onChange = vi.fn();
    const { container } = openPicker(onChange, { customThrottleMs: 250 });

    fireEvent.change(custom(container), { target: { value: '#111111' } });
    fireEvent.change(custom(container), { target: { value: '#222222' } });
    fireEvent.change(custom(container), { target: { value: '#abcdef' } }); // where the user settles

    act(() => { vi.advanceTimersByTime(300); });

    // The color the user actually chose must land, not just the first one.
    expect(onChange).toHaveBeenLastCalledWith('#abcdef');
  });

  it('allows a later change once the window has passed', () => {
    const onChange = vi.fn();
    const { container } = openPicker(onChange, { customThrottleMs: 250 });

    fireEvent.change(custom(container), { target: { value: '#111111' } });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.change(custom(container), { target: { value: '#222222' } });

    expect(onChange).toHaveBeenCalledWith('#111111');
    expect(onChange).toHaveBeenCalledWith('#222222');
  });

  it('palette clicks are never throttled', () => {
    const onChange = vi.fn();
    const { container } = openPicker(onChange, { customThrottleMs: 250 });
    const swatches = container.querySelectorAll('.color-swatch-picker__swatch');
    fireEvent.click(swatches[1]);
    fireEvent.click(swatches[2]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
