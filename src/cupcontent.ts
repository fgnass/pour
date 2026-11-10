// The paint in a cup: a grid of columns over the bottom of the cup, each a
// stack of layers (oldest at the bottom). Poured paint lands where the
// stream hits, plunges in and pushes the paint before it outwards. Out of
// the bottom runs the lowest layer of each column.
import { CUP_GRID } from './sim/sim';

export const GRID = CUP_GRID; // columns across the cup
const FILL_RATE = 0.11; // mean height per second while pouring (full = 1)
const MAX_LAYERS = 28;
const FULL = 0.95; // mean height of a full cup
const PLUNGE = 1; // how deep poured paint plunges below the spot (share of the paint there)
const NEW_THICK = 0.12; // thickness of freshly poured paint on the surface (full = 1)
export const THIN = 0.004; // thinner layers join the layer below

type Layer = { m: number; h: number };
/** One pour: paint, amount (mean height) and where it landed (-1..1). */
export type CupPour = { m: number; amount: number; u: number; v: number };

export class CupContent {
  /** columns, row by row (y from front to back); null outside the cup */
  readonly cols: (Layer[] | null)[] = [];
  readonly n: number;
  /** the pours, oldest first */
  pours: CupPour[] = [];

  constructor() {
    let n = 0;
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const [u, v] = cellUV(i, j);
        const inside = u * u + v * v < 1;
        this.cols.push(inside ? [] : null);
        if (inside) n++;
      }
    this.n = n;
  }

  empty() {
    for (let k = 0; k < this.cols.length; k++) if (this.cols[k]) this.cols[k] = [];
    this.pours = [];
    this.seg = null;
  }

  /** a copy (the cup on the canvas gets its own) */
  clone() {
    const c = new CupContent();
    for (let k = 0; k < this.cols.length; k++) {
      const col = this.cols[k];
      if (col) c.cols[k] = col.map(l => ({ ...l }));
    }
    c.pours = this.pours.map(p => ({ ...p }));
    return c;
  }

  /**
   * Paint of mean height h runs out at the bottom (the oldest first). The
   * paint is a liquid: it gets thinner everywhere alike, so each column
   * loses the same share of its height and none runs dry before the rest.
   */
  drain(h: number) {
    const level = this.level();
    if (level <= 0) return;
    const f = Math.min(1, h / level);
    for (const c of this.cols) if (c) takeBottom(c, f >= 1 ? Infinity : c.reduce((a, l) => a + l.h, 0) * f);
  }

  /** label map (GRID x GRID, row by row, 7: none): the paint on top of each column */
  topLabels() {
    const L = new Uint8Array(GRID * GRID).fill(7);
    for (let k = 0; k < this.cols.length; k++) {
      const col = this.cols[k];
      if (!col || !col.length) continue;
      let t = col.length - 1;
      while (t > 0 && col[t].h < THIN) t--;
      L[k] = col[t].m;
    }
    smooth(L, GRID, GRID, false);
    this.fillEmpty(L);
    return L;
  }

  /** label map: the paint at the bottom of each column (what runs out there) */
  bottomLabels() {
    const L = new Uint8Array(GRID * GRID).fill(7);
    for (let k = 0; k < this.cols.length; k++) {
      const col = this.cols[k];
      if (!col || !col.length) continue;
      let b = 0;
      while (b < col.length - 1 && col[b].h < THIN) b++;
      L[k] = col[b].m;
    }
    smooth(L, GRID, GRID, false);
    this.fillEmpty(L);
    return L;
  }

  /** a spot without paint gets the paint next to it: the liquid covers the whole floor */
  private fillEmpty(L: Uint8Array) {
    for (let pass = 0; pass < GRID; pass++) {
      let open = false,
        changed = false;
      const src = L.slice();
      for (let k = 0; k < L.length; k++) {
        if (!this.cols[k] || src[k] !== 7) continue;
        const i = k % GRID,
          j = (k / GRID) | 0;
        let m = 7;
        if (i > 0 && src[k - 1] !== 7) m = src[k - 1];
        else if (i < GRID - 1 && src[k + 1] !== 7) m = src[k + 1];
        else if (j > 0 && src[k - GRID] !== 7) m = src[k - GRID];
        else if (j < GRID - 1 && src[k + GRID] !== 7) m = src[k + GRID];
        if (m === 7) open = true;
        else {
          L[k] = m;
          changed = true;
        }
      }
      if (!open || !changed) break;
    }
  }

  height(k: number) {
    const c = this.cols[k];
    return c ? c.reduce((a, l) => a + l.h, 0) : 0;
  }

  /** mean height (0 empty, 1 full) */
  level() {
    let s = 0;
    for (let k = 0; k < this.cols.length; k++) s += this.height(k);
    return s / this.n;
  }

  /**
   * Pour paint m for dt seconds; the stream hits at (u, v). Returns false
   * when the cup is full.
   *
   * Where the stream lands, the new paint forms a disc that grows and
   * pushes all paint before it outwards: an area-true radial push, squeezed
   * against the wall. The paint below the disc is the paint that was under
   * the spot. Each push is computed from a copy taken when this pour (at
   * this spot) began, so no error builds up from frame to frame.
   */
  pour(m: number, u: number, v: number, dt: number) {
    const full = this.level() > FULL;
    const seg = this.seg;
    if (!seg || seg.m !== m || Math.hypot(seg.u - u, seg.v - v) > 0.06 || this.pouringNew) {
      this.commit();
      this.seg = { m, u, v, vol: 0, base: this.cols.map(c => (c ? c.map(l => ({ ...l })) : null)) };
      let p = this.pours[this.pours.length - 1];
      if (!p || p.m !== m || this.pouringNew) this.pours.push((p = { m, amount: 0, u, v }));
      this.pouringNew = false;
    }
    const sg = this.seg!;
    // a full cup: as much runs out at the bottom as comes in at the top
    // (the oldest paint, from the bottom of every column)
    if (full) for (const c of sg.base) if (c) takeBottom(c, FILL_RATE * dt);
    // poured volume (cup units: the floor is the unit disc, full = 1 high)
    const add = FILL_RATE * dt * Math.PI;
    sg.vol += add;
    this.pours[this.pours.length - 1].amount += add / Math.PI;
    this.push(sg);
    return true;
  }

  /** the pour at one spot is over: what it made stays */
  commit() {
    this.seg = null;
  }

  private seg: { m: number; u: number; v: number; vol: number; base: (Layer[] | null)[] } | null = null;

  private push(sg: NonNullable<CupContent['seg']>) {
    const { u: pu, v: pv, base } = sg;
    const at = (x: number, y: number) => {
      const i = Math.min(GRID - 1, Math.max(0, Math.floor(((x + 1) / 2) * GRID))),
        j = Math.min(GRID - 1, Math.max(0, Math.floor(((y + 1) / 2) * GRID)));
      let c = base[j * GRID + i];
      // just outside the round floor: the nearest cell inside
      if (!c) c = base[Math.min(GRID - 1, Math.max(0, Math.floor(((y * 0.97 + 1) / 2) * GRID))) * GRID + Math.min(GRID - 1, Math.max(0, Math.floor(((x * 0.97 + 1) / 2) * GRID)))];
      return c ?? [];
    };
    const under = at(pu, pv);
    const hu = under.reduce((s, l) => s + l.h, 0);
    // Dense paint poured from above plunges in: below the spot it goes down
    // to the floor, towards the edge of its disc less deep, a cone. Each
    // pour leaves such a cone; later pours push it outwards, so at the bottom
    // the pours lie side by side in rings. The disc's area follows its volume.
    const deep = Math.max(NEW_THICK, PLUNGE * hu);
    const a2 = sg.vol / Math.PI / (NEW_THICK + deep * 0.6);
    for (let k = 0; k < this.cols.length; k++) {
      if (!this.cols[k]) continue;
      const [cu, cv] = cellUV(k % GRID, (k / GRID) | 0);
      const dx = cu - pu,
        dy = cv - pv,
        d = Math.hypot(dx, dy);
      const ex = d > 1e-6 ? dx / d : 1,
        ey = d > 1e-6 ? dy / d : 0;
      // distance from the spot to the wall in this direction
      const pd = pu * ex + pv * ey;
      const rw = -pd + Math.sqrt(Math.max(0, pd * pd - (pu * pu + pv * pv - 1)));
      const a = Math.min(Math.sqrt(a2), rw * 0.995);
      if (d < a) {
        // the new paint, down to the depth it reached, on what was below it
        // there (once the disc fills the whole cup, it gets thicker)
        // (a blunt cone: in the inner half of its disc down to the floor)
        const depth = Math.max(NEW_THICK, deep * Math.min(1, 2 * (1 - d / a)));
        const c = bottomOf(under, hu - depth);
        pushTop(c, sg.m, depth + NEW_THICK * Math.max(1, a2));
        this.cols[k] = c;
      } else {
        // pushed out: this cell shows what was nearer to the spot
        const s = rw * Math.sqrt(Math.max(0, (d * d - a * a) / Math.max(1e-6, rw * rw - a * a)));
        const c = at(pu + ex * s, pv + ey * s).map(l => ({ ...l }));
        // no paint there yet (an empty cup): the new paint runs over the
        // bare floor at once
        if (!c.length) pushTop(c, sg.m, NEW_THICK * Math.max(1, a2) * 0.5);
        this.cols[k] = c;
      }
    }
  }

  /** the next pour starts a new layer, even in the same colour */
  pouringNew = true;
}

/** centre of cell (i, j) in cup coordinates (-1..1); j grows to the back */
function cellUV(i: number, j: number): [number, number] {
  return [((i + 0.5) / GRID) * 2 - 1, ((j + 0.5) / GRID) * 2 - 1];
}

/** 3x3 majority filter on a label array (w x h; xMajor: index x * h + y): no single odd cells */
export function smooth(L: Int8Array | Uint8Array, w: number, h: number, xMajor: boolean) {
  const src = L.slice();
  const n = new Uint8Array(8);
  const at = (x: number, y: number) => (xMajor ? src[x * h + y] : src[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const self = at(x, y);
      if (self < 0) continue;
      n.fill(0);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const m = at(xx, yy);
          if (m >= 0) n[m]++;
        }
      let best = self;
      for (let m = 0; m < 8; m++) if (n[m] > n[best]) best = m;
      if (n[best] >= 5) L[xMajor ? x * h + y : y * w + x] = best;
    }
}

function pushTop(c: Layer[], m: number, h: number) {
  if (h <= 0) return;
  const top = c[c.length - 1];
  if (top && top.m === m) top.h += h;
  // a thin bit on top of another colour joins the layer below it
  else if (top && h < THIN && c.length > 1 && c[c.length - 2].m === m) c[c.length - 2].h += h;
  else {
    c.push({ m, h });
    if (c.length > MAX_LAYERS) mergeThinnest(c);
  }
}

/** a copy of the bottom part of a column, up to height h */
function bottomOf(c: Layer[], h: number) {
  const out: Layer[] = [];
  for (const l of c) {
    if (h <= 1e-6) break;
    const q = Math.min(h, l.h);
    out.push({ m: l.m, h: q });
    h -= q;
  }
  return out;
}

/** take paint of height h from the bottom of a column */
function takeBottom(c: Layer[], h: number) {
  while (h > 0 && c.length) {
    const q = Math.min(h, c[0].h);
    c[0].h -= q;
    h -= q;
    if (c[0].h <= 1e-6) c.shift();
  }
}

/** too many layers: the thinnest one joins its thicker neighbour */
function mergeThinnest(c: Layer[]) {
  let t = 0;
  for (let k = 1; k < c.length; k++) if (c[k].h < c[t].h) t = k;
  const n = t === 0 ? 1 : t === c.length - 1 ? t - 1 : c[t - 1].h > c[t + 1].h ? t - 1 : t + 1;
  c[n].h += c[t].h;
  c.splice(t, 1);
}

