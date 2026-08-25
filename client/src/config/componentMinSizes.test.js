import { describe, it, expect } from 'vitest';
import { getComponentMinSize, COMPONENT_MIN_SIZES } from './layoutConfig';
import { CONTROL_TYPE_INFO } from '../components/controls/controlTypes';

// tile_light shipped without an entry here, so it silently fell through to
// `default` ({w:4,h:2}) and refused to shrink to 3x3 like every other tile.
// Nothing failed — the panel just would not resize, which is easy to miss
// until someone tries it on a real dashboard.
describe('component minimum sizes', () => {
  it('every registered control type has an explicit minimum', () => {
    const missing = Object.keys(CONTROL_TYPE_INFO).filter(
      (subtype) => COMPONENT_MIN_SIZES[subtype] === undefined,
    );
    expect(missing, `control types with no COMPONENT_MIN_SIZES entry: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('tiles can shrink to 3x3', () => {
    // The whole point of a tile is density; a tile that cannot reach the
    // standard 3x3 footprint does not match the rest of the set.
    const tiles = Object.keys(CONTROL_TYPE_INFO).filter((t) => t.startsWith('tile_'));
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      const { w, h } = getComponentMinSize(t);
      expect(w, `${t} min width`).toBeLessThanOrEqual(3);
      expect(h, `${t} min height`).toBeLessThanOrEqual(3);
    }
  });

  it('falls back to the default for an unknown subtype', () => {
    expect(getComponentMinSize('not-a-real-type')).toEqual(COMPONENT_MIN_SIZES.default);
  });
});
