/**
 * Colour maths for the token contrast table (WCAG 2.2 relative luminance and
 * contrast ratio, with alpha composited over the surface the way a browser
 * paints it). Pure functions, unit-tested in audit/test/contrast.test.mjs.
 */

/** Reads every `--sf-*` custom property per theme block of sonar.css. */
export function parseThemes(css) {
  const themes = {};
  const blocks = [
    ['dark', /:root,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/],
    ['light', /:root\[data-theme="light"\]\s*\{([^}]*)\}/],
  ];
  for (const [name, pattern] of blocks) {
    const match = pattern.exec(css);
    if (!match) throw new Error(`sonar.css: no ${name} theme block`);
    const tokens = {};
    for (const [, key, value] of match[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--sf-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      tokens[key] = value.trim();
    }
    themes[name] = tokens;
  }
  // The light block only overrides colours; everything else is inherited from :root.
  themes.light = { ...themes.dark, ...themes.light };
  return themes;
}

/** `#rgb`, `#rrggbb` or `rgb[a](r, g, b[, a])` → {r, g, b, a} with 0–255 channels. Null for anything else. */
export function parseColor(value) {
  const v = String(value).trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) {
    return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  return null;
}

/** Paints `top` (possibly translucent) over an opaque `bottom`. */
export function composite(top, bottom) {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.2 relative luminance of an opaque sRGB colour. */
export function luminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio of a (possibly translucent) foreground over an opaque background. */
export function contrastRatio(foreground, background) {
  const fg = foreground.a < 1 ? composite(foreground, background) : foreground;
  const l1 = luminance(fg);
  const l2 = luminance(background);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Rounds down to two decimals, so 4.499 never displays as a passing 4.50. */
export function displayRatio(ratio) {
  return Math.floor(ratio * 100) / 100;
}

/**
 * The verdict for one pair.
 * - text: AA needs 4.5:1, or 3:1 for large text (≥ 24 px, or ≥ 18.66 px bold);
 * - non-text (UI component boundaries, focus indicators, chart marks): 3:1.
 */
export function verdict(ratio, kind) {
  if (kind === 'non-text') return ratio >= 3 ? 'pass' : 'fail';
  if (ratio >= 4.5) return 'pass';
  if (ratio >= 3) return 'large-only';
  return 'fail';
}
