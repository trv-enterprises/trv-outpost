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
