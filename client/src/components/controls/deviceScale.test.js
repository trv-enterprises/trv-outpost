import { describe, it, expect } from 'vitest';
import { resolveDeviceScale, uiToDevice, deviceToUi } from './lightPalette';

// Regression for the bug seen on the "Test Light Control" dashboard: a
// tile_dimmer and a tile_light pointed at the SAME bulb disagreed — the
// dimmer read "48%" where the light correctly read 19%. The dimmer assumed
// the device shared its own 0-100 scale; Zigbee brightness is 0-254.
describe('device scale', () => {
  describe('resolveDeviceScale', () => {
    it('uses device_scale when configured', () => {
      expect(resolveDeviceScale({ device_scale: 254 }, 100)).toBe(254);
    });
    it('falls back to the UI max, preserving historical 1:1 behaviour', () => {
      expect(resolveDeviceScale({}, 100)).toBe(100);
      expect(resolveDeviceScale({ device_scale: 0 }, 100)).toBe(100);
      expect(resolveDeviceScale({ device_scale: -5 }, 100)).toBe(100);
      expect(resolveDeviceScale({ device_scale: 'nonsense' }, 100)).toBe(100);
    });
  });

  describe('uiToDevice', () => {
    it('sends the device-scale value, not the raw percent', () => {
      // The actual bug: "50%" used to publish brightness 50 (= 20% of 254).
      expect(uiToDevice(50, 0, 100, 254)).toBe(127);
      expect(uiToDevice(100, 0, 100, 254)).toBe(254);
      expect(uiToDevice(0, 0, 100, 254)).toBe(0);
    });
    it('is a no-op when the device really is 0-100', () => {
      expect(uiToDevice(50, 0, 100, 100)).toBe(50);
    });
    it('clamps and tolerates a degenerate range', () => {
      expect(uiToDevice(500, 0, 100, 254)).toBe(254);
      expect(uiToDevice(-10, 0, 100, 254)).toBe(0);
      expect(uiToDevice(50, 0, 0, 254)).toBe(0);
    });
  });

  describe('deviceToUi', () => {
    it('reads the device echo back as the right percent', () => {
      // The observed values: device reported 50 (and 48), which is ~19-20%,
      // NOT the "48%" the dimmer used to display.
      expect(deviceToUi(50, 0, 100, 254)).toBe(20);
      expect(deviceToUi(48, 0, 100, 254)).toBe(19);
      expect(deviceToUi(254, 0, 100, 254)).toBe(100);
      expect(deviceToUi(0, 0, 100, 254)).toBe(0);
    });
    it('is a no-op when the device really is 0-100', () => {
      expect(deviceToUi(48, 0, 100, 100)).toBe(48);
    });
    it('guards a zero device scale', () => {
      expect(deviceToUi(48, 0, 100, 0)).toBe(0);
    });
  });

  it('round-trips within rounding error', () => {
    for (const pct of [0, 1, 19, 20, 33, 50, 67, 99, 100]) {
      const back = deviceToUi(uiToDevice(pct, 0, 100, 254), 0, 100, 254);
      expect(Math.abs(back - pct), `pct ${pct}`).toBeLessThanOrEqual(1);
    }
  });

  it('agrees with the light controls on the same raw value', () => {
    // tile_light uses zigbeeToPct; a dimmer on the same bulb must match,
    // which is the whole point of the fix.
    const raw = 50;
    expect(deviceToUi(raw, 0, 100, 254)).toBe(Math.round((raw / 254) * 100));
  });
});
