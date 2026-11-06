export type Material = { name: string; hex: string; rgb: [number, number, number] };

const hex2rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

// index 0 is white; the others map to pigment channels (see splitComp).
export const MATS: Material[] = [
  { name: 'Titanium white', hex: '#f3f2ee' },
  { name: 'Red-blue iridescent', hex: '#e2304f' },
  { name: 'Blue violet', hex: '#4b2186' },
  { name: '24k gold', hex: '#c9a03a' },
  { name: 'Greenish blue', hex: '#1a5cc0' },
  { name: 'Blue-green iridescent', hex: '#17abb6' },
].map(m => ({ ...m, rgb: hex2rgb(m.hex) }));

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
