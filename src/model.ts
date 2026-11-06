// Studio state: the cup, paint sources and cells. Turns the user's actions
// into forces for the simulation. No DOM here.
import { MATS, mixColor, oneHot, splitComp, type Comp } from './sim/materials';
import { NUM_SRC } from './sim/shaders';
import { MAX_IMPOSED, noSource, P, type Forces, type Overlay, type Sim, type Source } from './sim/sim';

export const M = {
  cupR: 0.07,
  pourRate: 0.06, // volume / s while a colour is poured
  whiteRate: 0.14,
  whiteR: 0.045,
  colorR: 0.03,
  cellRate: 3500, // cells per unit of coloured outflow
  tiltCells: 300, // cells per second while the paint flows
  torchR: 0.09, // radius of the torch flame
  torchCells: 900, // cells per second under the flame
  torchHeat: 6, // how much faster paint rises under the flame
  // The cup wall holds the paint back: at rest only a little seeps out under
  // the rim. Moving the cup lets paint escape; lifting releases the rest.
  leakRest: 0.08, // fraction of the contents per second
  leakMove: 6, // extra fraction per second per unit of cup speed
  leakPour: 0.1, // extra while paint lands in the cup
  leakLift: 3.5,
};

const clampVel = (vx: number, vy: number): [number, number] => {
  const m = Math.hypot(vx, vy);
  return m > MAX_IMPOSED ? [(vx * MAX_IMPOSED) / m, (vy * MAX_IMPOSED) / m] : [vx, vy];
};

type Layer = { m: number; c: Comp; v: number };

export type Cup = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  vx: number;
  vy: number;
  R: number;
  layers: Layer[];
  lifting: boolean;
  liftT: number;
  alpha: number;
};

export type Pour = { m: number; x: number; y: number };
export type Push = { x: number; y: number; vx: number; vy: number; r: number };

export class Studio {
  cup: Cup | null = null;
  /** paint that is being poured right now (from the user or the demo) */
  pour: Pour | null = null;
  push: Push | null = null;
  /** where the torch points, or null */
  torch: { x: number; y: number } | null = null;
  /** tilt of the canvas (x, y), smoothed towards target */
  tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  /** true once any paint is on the canvas */
  dirty = false;
  private spawnAcc: Record<string, number> = {};
  private stream: Overlay['stream'] = null;
  private swirl: Forces['swirl'] = [0, 0, 0, 0];

  constructor(readonly sim: Sim) {}

  reset() {
    this.cup = null;
    this.pour = null;
    this.push = null;
    this.torch = null;
    this.dirty = false;
    this.sim.reset();
  }

  placeCup(x: number, y: number) {
    this.cup = { x, y, tx: x, ty: y, vx: 0, vy: 0, R: M.cupR, layers: [], lifting: false, liftT: 0, alpha: 1 };
    return this.cup;
  }

  liftCup() {
    if (this.cup && !this.cup.lifting) {
      this.cup.lifting = true;
      this.cup.liftT = 0;
    }
  }

  /** true if a pour at (x, y) ends up in the cup */
  hitsCup(x: number, y: number, slack = 1) {
    const c = this.cup;
    return !!c && !c.lifting && Math.hypot(x - c.x, y - c.y) < c.R * slack;
  }

  cupVolume(c = this.cup) {
    return c ? c.layers.reduce((a, l) => a + l.v, 0) : 0;
  }

  private pourIntoCup(m: number, v: number) {
    const L = this.cup!.layers;
    let idx = L.length;
    // colours poured from high sink below the white (index 0 = bottom)
    if (m !== 0) while (idx > 0 && L[idx - 1].m === 0) idx--;
    const below = L[idx - 1];
    if (below && below.m === m) below.v += v;
    else L.splice(idx, 0, { m, c: oneHot(m), v });
  }

  private drainCup(q: number) {
    const cup = this.cup!;
    const out = new Float64Array(MATS.length);
    if (q <= 0) return out;
    const V = this.cupVolume();
    // a little of the outflow is well mixed, the rest comes from the bottom layer
    const qm = q * 0.1;
    for (const l of cup.layers) {
      const take = (qm * l.v) / V;
      for (let k = 0; k < out.length; k++) out[k] += l.c[k] * take;
      l.v -= take;
    }
    let rem = q - qm;
    while (rem > 1e-12 && cup.layers.length) {
      const l = cup.layers[0];
      const take = Math.min(l.v, rem);
      for (let k = 0; k < out.length; k++) out[k] += l.c[k] * take;
      l.v -= take;
      rem -= take;
      if (l.v <= 1e-9) cup.layers.shift();
    }
    cup.layers = cup.layers.filter(l => l.v > 1e-9);
    const s = out.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < out.length; k++) out[k] /= s;
    return out;
  }

  private cupColor() {
    const cup = this.cup!;
    const c = new Float64Array(MATS.length);
    let depth = 0,
      wsum = 0;
    for (let i = cup.layers.length - 1; i >= 0; i--) {
      const l = cup.layers[i];
      const w = Math.exp(-depth / 0.015) * l.v;
      for (let k = 0; k < c.length; k++) c[k] += l.c[k] * w;
      wsum += w;
      depth += l.v;
    }
    if (wsum > 0) for (let k = 0; k < c.length; k++) c[k] /= wsum;
    else c[0] = 1;
    return mixColor(c);
  }

  /** spawn `rate` cells per second in an annulus (r0..r1) around (x, y) */
  private spawnCells(key: string, dt: number, rate: number, x: number, y: number, r0: number, r1: number, life: [number, number], size = 1) {
    this.spawnAcc[key] = (this.spawnAcc[key] || 0) + rate * dt;
    while (this.spawnAcc[key] >= 1) {
      this.spawnAcc[key] -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(r0 * r0 + Math.random() * (r1 * r1 - r0 * r0));
      this.sim.addCell(x + Math.cos(a) * r, y + Math.sin(a) * r, life[0] + Math.random() * life[1], size);
    }
  }

  private spawnEverywhere(dt: number, rate: number) {
    const [w, h] = this.sim.dom;
    this.spawnAcc.all = (this.spawnAcc.all || 0) + rate * w * h * dt;
    while (this.spawnAcc.all >= 1) {
      this.spawnAcc.all -= 1;
      this.sim.addCell(Math.random() * w, Math.random() * h, 0.35 + Math.random() * 0.5);
    }
  }

  update(dt: number): Forces {
    const src: Source[] = Array.from({ length: NUM_SRC }, noSource);
    const push: Forces['push'] = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const pushVel: Forces['pushVel'] = [
      [0, 0],
      [0, 0],
    ];
    this.swirl = [0, 0, 0, 0];
    this.stream = null;
    let si = 1;

    const t = this.tilt;
    const k = 1 - Math.exp(-dt * 6);
    t.x += (t.tx - t.x) * k;
    t.y += (t.ty - t.y) * k;

    // pouring: into the cup, or straight onto the canvas
    const pour = this.pour;
    if (pour) {
      const cup = this.cup;
      if (cup && this.hitsCup(pour.x, pour.y, 1.15)) {
        this.pourIntoCup(pour.m, M.pourRate * dt);
        this.stream = { x: cup.x + 0.006, y: cup.y - 0.004, col: MATS[pour.m].rgb };
      } else {
        const white = pour.m === 0;
        src[si++] = {
          x: pour.x,
          y: pour.y,
          r: white ? M.whiteR : M.colorR,
          rate: white ? M.whiteRate : M.pourRate,
          streak: 0,
          ...splitComp(oneHot(pour.m), white ? 0 : 0.55),
        };
        if (!white) this.spawnCells('pour', dt, M.cellRate * M.pourRate * 0.55, pour.x, pour.y, 0, M.colorR, [1.5, 3]);
        this.stream = { x: pour.x, y: pour.y, col: MATS[pour.m].rgb };
        this.dirty = true;
      }
    }

    // cup
    const cup = this.cup;
    if (cup) {
      const ox = cup.x,
        oy = cup.y;
      const f = 1 - Math.exp(-dt * 18);
      cup.x += (cup.tx - cup.x) * f;
      cup.y += (cup.ty - cup.y) * f;
      const vx = (cup.x - ox) / dt,
        vy = (cup.y - oy) / dt;
      cup.vx += (vx - cup.vx) * 0.5;
      cup.vy += (vy - cup.vy) * 0.5;
      const speed = Math.hypot(cup.vx, cup.vy);
      const V = this.cupVolume();
      const intoCup = this.stream && pour && this.hitsCup(pour.x, pour.y, 1.15);
      let leak = M.leakRest + M.leakMove * speed + (intoCup ? M.leakPour : 0);
      if (cup.lifting) leak = M.leakLift;
      let q = V * (1 - Math.exp(-leak * dt));
      if (cup.lifting) q = Math.min(V, Math.max(q, 0.04 * dt));
      if (q > 1e-7) {
        const comp = this.drainCup(q);
        const subFrac = cup.lifting ? 0.75 : 0.97 - 0.4 * Math.min(1, speed / 0.25);
        src[0] = {
          x: cup.x,
          y: cup.y,
          r: cup.R * (cup.lifting ? 1.5 : 1.08),
          rate: q / dt,
          streak: cup.lifting ? 0.6 : 0.9,
          ...splitComp(comp, subFrac),
        };
        // cells form where the coloured paint comes out from under the rim
        const coloured = (q / dt) * (1 - comp[0]) * subFrac;
        this.spawnCells('cup', dt, M.cellRate * coloured, cup.x, cup.y, cup.R * 0.95, cup.R * 1.15, [0.7, 1.3]);
        this.dirty = true;
      }
      // the cup wall drags paint along
      push[0] = [cup.x, cup.y, cup.R * 1.35, 0.9];
      pushVel[0] = clampVel(cup.vx, cup.vy);
      if (cup.lifting) {
        cup.liftT += dt;
        cup.alpha = Math.max(0, 1 - cup.liftT / 0.5);
        const tw = Math.max(0, 1 - cup.liftT / 0.9);
        this.swirl = [cup.x, cup.y, cup.R * 1.7, 9 * tw];
        if (this.cupVolume() < 1e-5 && cup.liftT > 0.9) this.cup = null;
      }
    }

    // while the paint flows more cells pop up
    const flow = Math.min(1, Math.hypot(t.x, t.y) / P.tiltMax);
    this.spawnEverywhere(dt, (M.tiltCells * flow) / 1.6);

    // the torch makes cells pop up under the flame
    const tq = this.torch;
    if (tq) this.spawnCells('torch', dt, M.torchCells, tq.x, tq.y, 0, M.torchR, [0.6, 0.8], 1.7);

    if (this.push) {
      const p = this.push;
      push[1] = [p.x, p.y, p.r, 1.0];
      pushVel[1] = clampVel(p.vx, p.vy);
    }

    return { tilt: [t.x, t.y], push, pushVel, swirl: this.swirl, src, torch: tq ? [tq.x, tq.y, M.torchR, M.torchHeat] : [0, 0, 1, 0] };
  }

  overlay(view: [number, number]): Overlay {
    const c = this.cup;
    return {
      view,
      cup: c ? { x: c.x, y: c.y, R: c.R, alpha: c.alpha, col: this.cupColor(), fill: Math.min(1, this.cupVolume() / 0.03) } : null,
      stream: this.stream,
      torch: this.torch ? { ...this.torch, r: M.torchR } : null,
    };
  }
}
