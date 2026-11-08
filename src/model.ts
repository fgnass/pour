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
  // A moving stream lays Q / v of paint per length: a fast hand gives a thin
  // line, a slow hand a thick one. Above this speed the line gets narrower
  // (width and height both scale with the square root of Q / v) ...
  streamV: 0.25,
  // ... down to this fraction of the stream radius
  streamMin: 0.35,
  // thick paint starts to flow slowly: a pour on the canvas starts as a thin
  // thread and is a full stream after about this time (seconds, time constant)
  pourRamp: 0.25,
  cellRate: 3500, // cells per unit of coloured outflow
  tiltCells: 300, // cells per second while the paint flows
  torchR: 0.09, // radius of the torch flame
  torchCells: 900, // cells per second under the flame
  torchHeat: 6, // how much faster paint rises under the flame
  // The cup wall holds the paint back: the paint collects in the cup and only
  // a little seeps out under the rim. Moving the cup lets some escape; lifting
  // releases the rest.
  leakRest: 0.012, // fraction of the contents per second
  leakMove: 2.5, // extra fraction per second per unit of cup speed
  liftSecs: 1.4, // a lifted cup empties at a steady rate in this time
  maxRings: 10, // colour rings shown in the cup
};

const clampVel = (vx: number, vy: number): [number, number] => {
  const m = Math.hypot(vx, vy);
  return m > MAX_IMPOSED ? [(vx * MAX_IMPOSED) / m, (vy * MAX_IMPOSED) / m] : [vx, vy];
};

/**
 * One pour into the cup (oldest first). Seen from above, each pour pushes the
 * older paint outwards, so the pours show as rings. They also leave the cup
 * in this order: the oldest paint is at the bottom.
 */
export type Ring = { m: number; c: Comp; v: number; ox: number; oy: number; seed: number };

export type Cup = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  vx: number;
  vy: number;
  R: number;
  /** oldest first */
  rings: Ring[];
  lifting: boolean;
  liftT: number;
  /** contents when the lift started */
  liftV: number;
  seed: number;
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
  /** where the swipe was at the last step */
  private pushFrom: { x: number; y: number } | null = null;
  /** where the falling stream lands: it trails the hand a little */
  private land: { x: number; y: number } | null = null;
  /** first smoothing stage between the hand and the landing point */
  private landMid = { x: 0, y: 0 };
  /** recent landing points (t, x, y), to measure the speed over a short window */
  private landPath: number[][] = [];
  private landT = 0;
  /** smoothed speed of the landing point */
  private landV = 0;
  /** 0..1: how far the current pour stream has built up */
  private flow = 0;
  private swirl: Forces['swirl'] = [0, 0, 0, 0];

  constructor(readonly sim: Sim) {}

  reset() {
    this.cup = null;
    this.pour = null;
    this.push = null;
    this.torch = null;
    this.dirty = false;
    this.land = null;
    this.pushFrom = null;
    this.sim.reset();
  }

  placeCup(x: number, y: number) {
    this.cup = { x, y, tx: x, ty: y, vx: 0, vy: 0, R: M.cupR, rings: [], lifting: false, liftT: 0, liftV: 0, seed: Math.random() * 6.283, alpha: 1 };
    return this.cup;
  }

  liftCup() {
    if (this.cup && !this.cup.lifting) {
      this.cup.lifting = true;
      this.cup.liftT = 0;
      this.cup.liftV = this.cupVolume();
    }
  }

  /** true if a pour at (x, y) ends up in the cup */
  hitsCup(x: number, y: number, slack = 1) {
    const c = this.cup;
    return !!c && !c.lifting && Math.hypot(x - c.x, y - c.y) < c.R * slack;
  }

  cupVolume(c = this.cup) {
    return c ? c.rings.reduce((a, r) => a + r.v, 0) : 0;
  }

  /** The newest ring grows while the same colour lands at the same spot. */
  private pourIntoCup(m: number, v: number, ox: number, oy: number) {
    const R = this.cup!.rings;
    const top = R[R.length - 1];
    if (top && top.m === m && Math.hypot(top.ox - ox, top.oy - oy) < M.cupR * 0.3) {
      top.ox += ((ox - top.ox) * v) / (top.v + v);
      top.oy += ((oy - top.oy) * v) / (top.v + v);
      top.v += v;
      return;
    }
    R.push({ m, c: oneHot(m), v, ox, oy, seed: Math.random() * 6.283 });
    if (R.length > M.maxRings) {
      // the two oldest rings blend into one
      const [a, b] = R.splice(0, 2);
      const w = a.v + b.v;
      R.unshift({ m: -1, c: a.c.map((x, i) => (x * a.v + b.c[i] * b.v) / w), v: w, ox: 0, oy: 0, seed: a.seed });
    }
  }

  /** Take q of paint out of the cup: the oldest pour first, a little mixed. */
  private drainCup(q: number) {
    const cup = this.cup!;
    const out = new Float64Array(MATS.length);
    if (q <= 0) return out;
    const V = this.cupVolume();
    const qm = q * 0.03;
    for (const r of cup.rings) {
      const take = (qm * r.v) / V;
      for (let k = 0; k < out.length; k++) out[k] += r.c[k] * take;
      r.v -= take;
    }
    let rem = q - qm;
    while (rem > 1e-12 && cup.rings.length) {
      const r = cup.rings[0];
      const take = Math.min(r.v, rem);
      for (let k = 0; k < out.length; k++) out[k] += r.c[k] * take;
      r.v -= take;
      rem -= take;
      if (r.v <= 1e-9) cup.rings.shift();
    }
    cup.rings = cup.rings.filter(r => r.v > 1e-9);
    const s = out.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < out.length; k++) out[k] /= s;
    return out;
  }

  /** spawn `rate` cells per second in an annulus (r0..r1) around (x, y) */
  /** cells around (x, y); with `from`, around a random point between `from` and (x, y) */
  private spawnCells(key: string, dt: number, rate: number, x: number, y: number, r0: number, r1: number, life: [number, number], size = 1, from?: { x: number; y: number }) {
    this.spawnAcc[key] = (this.spawnAcc[key] || 0) + rate * dt;
    while (this.spawnAcc[key] >= 1) {
      this.spawnAcc[key] -= 1;
      const t = from ? Math.random() : 1;
      const cx = from ? from.x + (x - from.x) * t : x,
        cy = from ? from.y + (y - from.y) * t : y;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(r0 * r0 + Math.random() * (r1 * r1 - r0 * r0));
      this.sim.addCell(cx + Math.cos(a) * r, cy + Math.sin(a) * r, life[0] + Math.random() * life[1], size);
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
    if (!pour) this.land = null;
    this.flow = pour ? this.flow + (1 - this.flow) * (1 - Math.exp(-dt / M.pourRamp)) : 0;
    if (pour) {
      const flow = this.flow;
      const cup = this.cup;
      if (cup && this.hitsCup(pour.x, pour.y, 1.15)) {
        // where the stream lands in the cup (kept inside the cup)
        let ox = pour.x - cup.x,
          oy = pour.y - cup.y;
        const l = Math.hypot(ox, oy),
          lim = cup.R * 0.6;
        if (l > lim) {
          ox *= lim / l;
          oy *= lim / l;
        }
        this.land = null;
        this.pourIntoCup(pour.m, M.pourRate * dt, ox, oy);
        this.stream = { x: cup.x + ox, y: cup.y + oy, col: MATS[pour.m].rgb };
      } else {
        const white = pour.m === 0;
        // the stream has some inertia: it follows the hand with a short lag
        // and lays down a continuous line between frames. Two smoothing
        // stages, so it moves evenly also when touch events come unevenly
        // (with one stage it jumps after each event: lumps in the line).
        if (!this.land) {
          this.landMid = { x: pour.x, y: pour.y };
          this.landV = 0;
          this.landPath = [];
        }
        const prev = this.land ?? { x: pour.x, y: pour.y };
        const mid = this.landMid;
        const f = 1 - Math.exp(-dt * 35);
        mid.x += (pour.x - mid.x) * f;
        mid.y += (pour.y - mid.y) * f;
        const land = { x: prev.x + (mid.x - prev.x) * f, y: prev.y + (mid.y - prev.y) * f };
        this.land = land;
        // speed over the last 0.12 s: touch events do not come every frame, and
        // a speed per frame would make the line wider and narrower in steps
        const path = this.landPath;
        path.push([(this.landT += dt), land.x, land.y]);
        while (path.length > 2 && this.landT - path[1][0] >= 0.12) path.shift();
        const [t0, x0, y0] = path[0];
        const v = this.landT > t0 ? Math.hypot(land.x - x0, land.y - y0) / (this.landT - t0) : 0;
        this.landV += (v - this.landV) * (1 - Math.exp(-dt * 10));
        // cross-section of the line: flow / speed (and the stream itself while it builds up)
        const thin = Math.max(M.streamMin, Math.sqrt(flow * Math.min(1, M.streamV / Math.max(this.landV, 1e-6))));
        const r = (white ? M.whiteR : M.colorR) * thin;
        src[si++] = {
          x: land.x,
          y: land.y,
          x0: prev.x,
          y0: prev.y,
          r,
          rate: (white ? M.whiteRate : M.pourRate) * flow,
          streak: 0,
          ...splitComp(oneHot(pour.m), white ? 0 : 0.55),
        };
        if (!white) this.spawnCells('pour', dt, M.cellRate * M.pourRate * flow * 0.55, land.x, land.y, 0, r, [1.5, 3], 1, prev);
        this.stream = { x: land.x, y: land.y, col: MATS[pour.m].rgb };
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
      const leak = M.leakRest + M.leakMove * speed;
      let q = V * (1 - Math.exp(-leak * dt));
      // lifted: the paint runs out at a steady rate, one pour after the other
      if (cup.lifting) q = Math.min(V, Math.max((cup.liftV / M.liftSecs) * dt, 0.04 * dt));
      if (q > 1e-7) {
        const comp = this.drainCup(q);
        const subFrac = cup.lifting ? 0.3 : 0.97 - 0.4 * Math.min(1, speed / 0.25);
        // a lifted cup wobbles a little: the rings come out uneven
        const w = cup.lifting ? cup.R * 0.25 * Math.min(1, cup.liftT * 2) : 0;
        src[0] = {
          x: cup.x + w * Math.sin(cup.liftT * 4.1 + cup.seed),
          y: cup.y + w * Math.cos(cup.liftT * 3.3 + cup.seed * 1.7),
          r: cup.R * (cup.lifting ? 0.9 : 1.08),
          rate: q / dt,
          streak: cup.lifting ? 0.2 : 0.9,
          plug: cup.lifting ? 1 : 0,
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
        this.swirl = [cup.x, cup.y, cup.R * 1.7, 4 * tw];
        if (this.cupVolume() < 1e-5 && cup.liftT > M.liftSecs) this.cup = null;
      }
    }

    // while the paint flows more cells pop up
    const flow = Math.min(1, Math.hypot(t.x, t.y) / P.tiltMax);
    this.spawnEverywhere(dt, (M.tiltCells * flow) / 1.6);

    // the torch makes cells pop up under the flame
    const tq = this.torch;
    if (tq) this.spawnCells('torch', dt, M.torchCells, tq.x, tq.y, 0, M.torchR, [0.6, 0.8], 1.7);

    // a quick swipe pushes the paint along the whole way since the last step
    const pushFrom: Forces['pushFrom'] = [
      [push[0][0], push[0][1]],
      [0, 0],
    ];
    if (this.push) {
      const p = this.push;
      const from = this.pushFrom ?? p;
      push[1] = [p.x, p.y, p.r, 1.0];
      pushVel[1] = clampVel(p.vx, p.vy);
      pushFrom[1] = [from.x, from.y];
      this.pushFrom = { x: p.x, y: p.y };
    } else this.pushFrom = null;

    return { tilt: [t.x, t.y], push, pushVel, pushFrom, swirl: this.swirl, src, torch: tq ? [tq.x, tq.y, M.torchR, M.torchHeat] : [0, 0, 1, 0] };
  }

  /**
   * Discs to draw in the cup, oldest first. Each disc holds its own paint and
   * all newer paint, so its area follows that volume. A disc sits around the
   * spot where its paint landed but is pushed inwards as it grows.
   */
  private ringDiscs(c: Cup) {
    const V = c.rings.reduce((a, r) => a + r.v, 0);
    if (V <= 0) return [];
    const Ri = c.R * 0.93;
    let cum = V;
    return c.rings.map(r => {
      const rad = Ri * Math.sqrt(Math.max(0, cum) / V);
      cum -= r.v;
      const k = 1 - rad / Ri;
      return { x: c.x + r.ox * k, y: c.y + r.oy * k, r: rad, seed: r.seed, col: mixColor(r.c) };
    });
  }

  overlay(view: [number, number]): Overlay {
    const c = this.cup;
    return {
      view,
      cup: c ? { x: c.x, y: c.y, R: c.R, alpha: c.alpha, rings: this.ringDiscs(c), fill: Math.min(1, this.cupVolume() / 0.03) } : null,
      stream: this.stream,
      torch: this.torch ? { ...this.torch, r: M.torchR } : null,
    };
  }
}
