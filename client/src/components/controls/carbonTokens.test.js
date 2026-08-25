import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { g100 } from '@carbon/themes';

/**
 * A CSS custom property that names a token which does not exist resolves to
 * nothing, and the declaration is simply dropped — silently. That is how the
 * PillToggle shipped with no background on its OFF state: it used
 * --cds-button-secondary, which is not a Carbon token. ON looked fine (its
 * token was real), so the bug only showed in one state.
 *
 * Nothing else catches this: it compiles, lints, and renders without error.
 */
// Vitest runs from the client/ root; import.meta.url is rewritten by Vite.
const CSS = readFileSync(resolve('src/components/controls/controls.scss'), 'utf8');

/** --cds-layer-03 -> layer03, --cds-text-on-color -> textOnColor */
function cssVarToTokenName(cssVar) {
  const bare = cssVar.replace(/^--cds-/, '');
  return bare.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

describe('Carbon tokens referenced by controls.scss', () => {
  it('every --cds-* variable names a real token', () => {
    const referenced = [...CSS.matchAll(/var\((--cds-[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);

    const unknown = [...new Set(referenced)].filter((v) => {
      const name = cssVarToTokenName(v);
      // Carbon exposes tokens camelCased on the theme object. A handful of
      // layout/spacing vars are not theme tokens, so only flag colour-ish
      // names we can actually resolve.
      return g100[name] === undefined;
    });

    expect(unknown, `unknown Carbon tokens: ${unknown.join(', ')}`).toEqual([]);
  });
});

/**
 * A valid token can still be the WRONG token. The OFF pill used
 * --cds-layer-03 (#525252) while .tile-popup hardcodes #525252, so the pill
 * was the same color as the surface behind it — invisible until hover, when
 * the brightness filter lifted it. Token validity alone does not catch that.
 */
describe('control surfaces have contrast against each other', () => {
  /** Resolve a `var(--cds-x)` reference (or a literal hex) to a hex value. */
  const resolve = (value) => {
    const varMatch = /var\((--cds-[a-z0-9-]+)\)/.exec(value);
    if (!varMatch) return value.trim().toLowerCase();
    const name = cssVarToTokenName(varMatch[1]);
    return String(g100[name] ?? '').toLowerCase();
  };

  /** Pull `background-color: X;` out of the first matching rule block. */
  const backgroundOf = (selector) => {
    const start = CSS.indexOf(`${selector} {`);
    expect(start, `${selector} not found in controls.scss`).toBeGreaterThan(-1);
    const block = CSS.slice(start, CSS.indexOf('\n}', start));
    const decl = /background-color:\s*([^;]+);/.exec(block);
    expect(decl, `${selector} declares no background-color`).toBeTruthy();
    return resolve(decl[1]);
  };

  it('the OFF pill is not the same color as the popup it sits on', () => {
    const pill = backgroundOf('.pill-toggle');
    const popup = backgroundOf('.tile-popup');
    expect(pill).toMatch(/^#[0-9a-f]{6}$/);
    expect(popup).toMatch(/^#[0-9a-f]{6}$/);
    expect(pill, 'OFF pill is invisible against .tile-popup').not.toBe(popup);
  });
});
