export type Finish = 'matte' | 'pearl' | 'metal';
export type Material = {
  name: string;
  hex: string;
  finish: Finish;
  /** colour of the pearl shimmer (pearl only) */
  sheen: string;
  rgb: [number, number, number];
  sheenRgb: [number, number, number];
};
type Def = [name: string, hex: string, finish?: Finish, sheen?: string];
export type Palette = { name: string; paints: Def[] };

const hex2rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

// Each palette has 6 paints. Index 0 is the base (white or cream); the others
// map to pigment channels (see splitComp). Any paint can have any finish.
export const PALETTES: Palette[] = [
  {
    name: 'Galaxy',
    paints: [
      ['Titanium white', '#f3f2ee'],
      ['Red-blue iridescent', '#e2304f', 'pearl', '#5973ff'],
      ['Blue violet', '#4b2186'],
      ['24k gold', '#c9a03a', 'metal'],
      ['Greenish blue', '#1a5cc0'],
      ['Blue-green iridescent', '#17abb6', 'pearl', '#99ffb3'],
    ],
  },
  {
    name: 'Candy',
    paints: [
      ['White', '#f6f4f2'],
      ['Hot pink', '#ff3d8b'],
      ['Magenta', '#c2187a'],
      ['Lime', '#b5e33a'],
      ['Lilac pearl', '#a98be0', 'pearl', '#ffd0ff'],
      ['Turquoise', '#2fc4dc'],
    ],
  },
  {
    name: 'Fuchsia & Jet',
    paints: [
      ['White', '#f4f3f1'],
      ['Fuchsia', '#ec0f78'],
      ['Jet black', '#141416'],
      ['Silver', '#b8bcc4', 'metal'],
      ['Rose', '#f58fb0'],
      ['Mint', '#19c2a8'],
    ],
  },
  {
    name: 'Ember & Ocean',
    paints: [
      ['Cream', '#f1e7d6'],
      ['Rust', '#b9512c'],
      ['Navy', '#1c3a66'],
      ['Copper', '#c8743a', 'metal'],
      ['Sky blue', '#5ec4e2'],
      ['Burgundy', '#5e1428'],
    ],
  },
  {
    name: 'Lagoon',
    paints: [
      ['White', '#efeeea'],
      ['Crimson', '#b3142a'],
      ['Deep teal', '#0c4b55'],
      ['Bronze', '#a8823e', 'metal'],
      ['Petrol', '#0f8f8c'],
      ['Sand', '#c9b48e'],
    ],
  },
  {
    name: 'Orchid',
    paints: [
      ['White', '#f4f2f2'],
      ['Violet', '#6a2aa8'],
      ['Navy', '#1b2766'],
      ['Orchid', '#c97ad6'],
      ['Turquoise pearl', '#22b2c9', 'pearl', '#a0ffff'],
      ['Signal red', '#e3263f'],
    ],
  },
  {
    name: 'Ink & Pearl',
    paints: [
      ['White', '#f5f3f0'],
      ['Aubergine', '#2b1530'],
      ['Mauve', '#8c7ba3'],
      ['Pearl', '#e6e0ec', 'pearl', '#ffe0ff'],
      ['Lemon', '#e6dc5a'],
      ['Black', '#0f0e10'],
    ],
  },
  {
    name: 'Sunset',
    paints: [
      ['Cream', '#f4e6d2'],
      ['Peach', '#f0b088'],
      ['Old rose', '#cf6b8a'],
      ['Gold', '#c9a03a', 'metal'],
      ['Plum', '#7d3f80'],
      ['Teal', '#3a9ea6'],
    ],
  },
];

const toMat = ([name, hex, finish = 'matte', sheen = '#ffffff']: Def): Material => ({
  name,
  hex,
  finish,
  sheen,
  rgb: hex2rgb(hex),
  sheenRgb: hex2rgb(sheen),
});

/** The paints of the current palette. The array is changed in place by setPalette. */
export const MATS: Material[] = PALETTES[0].paints.map(toMat);

export function setPalette(p: Palette) {
  p.paints.forEach((d, i) => (MATS[i] = toMat(d)));
}

export type Comp = Float64Array; // amount of each material, length 6

export const oneHot = (m: number): Comp => {
  const c = new Float64Array(MATS.length);
  c[m] = 1;
  return c;
};

export type Split = { s: number[]; u: number[]; g: number[] };

// composition -> shader channels. S/U: red, violet, greenish blue, blue-green. G: gold.
export function splitComp(c: Comp, subFrac: number): Split {
  const col = [c[1], c[2], c[4], c[5]];
  return {
    s: col.map(v => v * (1 - subFrac)),
    u: col.map(v => v * subFrac),
    g: [c[3] * (1 - subFrac), c[3] * subFrac],
  };
}

// same mixer as the render shader (in sRGB space)
export function mixColor(c: Comp): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let lg = 0,
      lin = 0;
    for (let k = 0; k < MATS.length; k++) {
      const v = Math.max(MATS[k].rgb[ch], 0.02);
      lg += c[k] * Math.log(v);
      lin += c[k] * v;
    }
    out[ch] = Math.exp(lg) * 0.7 + lin * 0.3;
  }
  return out;
}
