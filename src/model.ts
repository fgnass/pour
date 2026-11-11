// Studio state: the cup, paint sources and cells. Turns the user's actions
// into forces for the simulation. No DOM here.
import { CupFlow } from './cupflow';
import { CupContent } from './cupcontent';
import { MATS, oneHot, splitComp } from './sim/materials';
import { NUM_SRC } from './sim/shaders';
import { MAX_IMPOSED, noSource, P, type Forces, type Overlay, type Sim, type Source } from './sim/sim';

export const M = {
  cupR: 0.085,
  pourRate: 0.08, // volume / s while a colour is poured
  whiteRate: 0.16,
  whiteR: 0.06,
  colorR: 0.05, // about a fingertip wide
  // A moving stream lays Q / v of paint per length: a fast hand gives a thin
  // line, a slow hand a thick one. Above this speed the line gets narrower
  // (width and height both scale with the square root of Q / v) ...
  streamV: 0.25,
  // ... down to this fraction of the stream radius
  streamMin: 0.75,
  // ... and above that speed the stream gets stronger, up to this factor
  streamBoost: 2.5,
  // thick paint starts to flow slowly: a pour on the canvas starts as a thin
  // thread and is a full stream after about this time (seconds, time constant)
  pourRamp: 0.25,
  cellRate: 3500, // cells per unit of coloured outflow
  tiltCells: 300, // cells per second while the paint flows
  torchR: 0.15, // radius of the torch flame
  torchCells: 140, // cells per second under the flame
  torchCellSize: 3, // torch cells are this much bigger than other cells
  torchHeat: 6, // how much faster paint rises under the flame
  // The cup wall holds the paint back: only a little seeps out under the
  // rim. Moving the cup lets more escape.
  leakRest: 0.012, // fraction of the contents per second
  leakMove: 1.6, // extra fraction per second per unit of cup speed
  leakMaxSpeed: 0.35, // above this speed no more paint gets out
  cupFull: 0.45, // volume of a full cup
  cupTwist: 0.6, // how much the paint under a turning cup turns with it
};

const clampVel = (vx: number, vy: number): [number, number] => {
  const m = Math.hypot(vx, vy);
  return m > MAX_IMPOSED ? [(vx * MAX_IMPOSED) / m, (vy * MAX_IMPOSED) / m] : [vx, vy];
};

export type Cup = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** first smoothing stage between the hand (tx, ty) and the cup */
  mx: number;
  my: number;
  vx: number;
  vy: number;
  R: number;
  /** the paint in it (columns of layers, see cupcontent.ts) */
  content: CupContent;
  /** how the paint has moved inside the cup (see cupflow.ts) */
  flow: CupFlow;
  /** turn (radians) and its speed (radians / s) */
  angle: number;
  omega: number;
  seed: number;
  alpha: number;
  /** held above the canvas, not set down yet: no paint comes out, it pushes nothing */
  lifted: boolean;
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
  private cupMap: Forces['cup'] = null;
  /** share of coloured (not white) paint at the bottom of the cup */
  private cupColoured = 0;
  /** the most common paint at the bottom of the cup */
  private cupMain = 0;

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

  /** Set a cup with this paint down at (x, y) (it gets a copy). */
  placeCup(x: number, y: number, content = new CupContent(), lifted = false) {
    this.cup = {
      x,
      y,
      tx: x,
      ty: y,
      mx: x,
      my: y,
      vx: 0,
      vy: 0,
      R: M.cupR,
      content: content.clone(),
      flow: new CupFlow(),
      angle: 0,
      omega: 0,
      seed: Math.random() * 6.283,
      alpha: 1,
      lifted,
    };
    this.syncCupMaps(this.cup);
    return this.cup;
  }

  /** Turn the cup by da radians: its paint turns with it. */
  turnCup(da: number) {
    if (this.cup) this.cup.angle += da;
  }

  /** true if a pour at (x, y) ends up in the cup */
  hitsCup(x: number, y: number, slack = 1) {
    const c = this.cup;
    return !!c && Math.hypot(x - c.x, y - c.y) < c.R * slack;
  }

  /** send the cup's label maps to the simulation */
  private syncCupMaps(cup: Cup) {
    const bottom = cup.flow.apply(cup.content.bottomLabels());
    this.sim.setCupMaps(bottom, cup.flow.apply(cup.content.topLabels()));
    cup.flow.moved = false;
    // share of coloured (not white) paint at the bottom, and the most common paint there
    const count = new Array(8).fill(0);
    for (const l of bottom) count[l]++;
    const n = count.slice(0, 7).reduce((a, b) => a + b, 0);
    this.cupColoured = n ? (n - count[0]) / n : 0;
    this.cupMain = count.slice(0, 7).indexOf(Math.max(...count.slice(0, 7)));
    this.cupMapsDirty = false;
  }

  /** the cup's label maps must go to the simulation again */
  private cupMapsDirty = false;

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
    this.cupMap = null;
    let si = 1;
    /** where the cup was at the last step (its wall sweeps from there) */
    let cupFrom: [number, number] | null = null;

    const t = this.tilt;
    const k = 1 - Math.exp(-dt * 6);
    t.x += (t.tx - t.x) * k;
    t.y += (t.ty - t.y) * k;

    // pouring onto the canvas
    const pour = this.pour;
    if (!pour) this.land = null;
    this.flow = pour ? this.flow + (1 - this.flow) * (1 - Math.exp(-dt / M.pourRamp)) : 0;
    if (pour) {
      const flow = this.flow;
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
      const land = {
        x: prev.x + (mid.x - prev.x) * f,
        y: prev.y + (mid.y - prev.y) * f,
      };
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
      const slow = Math.min(1, M.streamV / Math.max(this.landV, 1e-6));
      const thin = Math.max(M.streamMin, Math.sqrt(flow * slow));
      // A fast hand would lay a line too thin to cover what is below: the
      // stream gets stronger instead, so the line keeps its body
      const boost = Math.min(M.streamBoost, Math.max(1, (M.streamMin * M.streamMin) / slow));
      const r = (white ? M.whiteR : M.colorR) * thin;
      src[si++] = {
        x: land.x,
        y: land.y,
        x0: prev.x,
        y0: prev.y,
        r,
        rate: (white ? M.whiteRate : M.pourRate) * flow * boost,
        streak: 0,
        ...splitComp(oneHot(pour.m), white ? 0 : 0.55),
      };
      if (!white) this.spawnCells('pour', dt, M.cellRate * M.pourRate * flow * boost * 0.55, land.x, land.y, 0, r, [1.5, 3], 1, prev);
      this.stream = { x: land.x, y: land.y, col: MATS[pour.m].rgb };
      this.dirty = true;
    }

    // cup
    const cup = this.cup;
    if (cup) {
      const ox = cup.x,
        oy = cup.y;
      // the cup follows the hand in two smoothing stages: its path has no
      // corners, even where the hand turns sharply or touch events come
      // unevenly (a corner in the path would show as a fold in the trail)
      const f = 1 - Math.exp(-dt * 24);
      cup.mx += (cup.tx - cup.mx) * f;
      cup.my += (cup.ty - cup.my) * f;
      cup.x += (cup.mx - cup.x) * f;
      cup.y += (cup.my - cup.y) * f;
      const vx = (cup.x - ox) / dt,
        vy = (cup.y - oy) / dt;
      cup.vx += (vx - cup.vx) * 0.5;
      cup.vy += (vy - cup.vy) * 0.5;
      const speed = Math.hypot(cup.vx, cup.vy);
      // the paint inside lags behind the cup's turns and sloshes when it moves
      cup.flow.step(dt, cup.angle, cup.vx, cup.vy, cup.R);
      if (cup.flow.moved) this.cupMapsDirty = true;
      const level = cup.content.level();
      let cupMap: Forces['cup'] = null;
      // The cup stands open on the canvas: a little paint seeps out under
      // the rim all around, more while it moves. At each place the paint at
      // the bottom of the cup there comes out (the simulation paints the
      // bottom map), much of it below the paint already on the canvas.
      const V = level * M.cupFull;
      // (thick paint: moving the cup faster does not let ever more out)
      // (near the bottom the rest runs out as fast as at a quarter full: so the
      // trail keeps its strength to the end and the cup really runs empty)
      const q = Math.min(V, Math.max(V, M.cupFull * 0.25) * (1 - Math.exp(-(M.leakRest + M.leakMove * Math.min(speed, M.leakMaxSpeed)) * dt)));
      if (!cup.lifted && level > 0.003 && q > 1e-7) {
        cup.content.drain(q / M.cupFull);
        this.cupMapsDirty = true;
        const subFrac = 0.97 - 0.4 * Math.min(1, speed / 0.25);
        src[0] = {
          x: cup.x,
          y: cup.y,
          x0: ox,
          y0: oy,
          r: cup.R * 1.08,
          rate: q / dt,
          streak: 0.9,
          ...splitComp(oneHot(0), subFrac),
        };
        cupMap = [cup.x, cup.y, cup.R * 0.93, cup.angle, subFrac, this.cupMain];
        // cells form where the coloured paint comes out from under the rim
        this.spawnCells('cup', dt, M.cellRate * (q / dt) * subFrac * this.cupColoured, cup.x, cup.y, cup.R * 0.95, cup.R * 1.15, [0.7, 1.3]);
        this.dirty = true;
      }
      // the last thin film runs out too: the cup is empty
      else if (!cup.lifted && level > 0 && level <= 0.003) {
        cup.content.empty();
        this.cupMapsDirty = true;
      }
      this.cupMap = cupMap;
      if (this.cupMapsDirty) this.syncCupMaps(cup);
      // the cup wall drags paint along (negative strength: a wall, see
      // imposedVel). Empty, it stays on the canvas and pushes the paint the
      // same way, until another tool is taken: an empty cup is no stronger
      // than a full one.
      if (!cup.lifted) {
        push[0] = [cup.x, cup.y, cup.R * 1.35, -0.9];
        pushVel[0] = clampVel(cup.vx, cup.vy);
        cupFrom = [ox, oy];
      }
      // a turning cup turns the paint under and around it
      cup.omega *= Math.exp(-dt * 6);
      if (!cup.lifted && Math.abs(cup.omega) > 0.05) this.swirl = [cup.x, cup.y, cup.R * 1.3, cup.omega * M.cupTwist];
    }

    // while the paint flows more cells pop up
    const flow = Math.min(1, Math.hypot(t.x, t.y) / P.tiltMax);
    this.spawnEverywhere(dt, (M.tiltCells * flow) / 1.6);

    // the torch makes cells pop up under the flame
    const tq = this.torch;
    if (tq) this.spawnCells('torch', dt, M.torchCells, tq.x, tq.y, 0, M.torchR * 0.8, [0.8, 1.0], M.torchCellSize);

    // a quick swipe pushes the paint along the whole way since the last step
    const pushFrom: Forces['pushFrom'] = [cupFrom ?? [push[0][0], push[0][1]], [0, 0]];
    if (this.push) {
      const p = this.push;
      const from = this.pushFrom ?? p;
      push[1] = [p.x, p.y, p.r, 1.0];
      pushVel[1] = clampVel(p.vx, p.vy);
      pushFrom[1] = [from.x, from.y];
      this.pushFrom = { x: p.x, y: p.y };
    } else this.pushFrom = null;

    return {
      tilt: [t.x * P.grav, t.y * P.grav],
      push,
      pushVel,
      pushFrom,
      swirl: this.swirl,
      src,
      torch: tq ? [tq.x, tq.y, M.torchR, M.torchHeat] : [0, 0, 1, 0],
      cup: this.cupMap,
    };
  }

  overlay(view: [number, number]): Overlay {
    const c = this.cup;
    return {
      view,
      cup: c
        ? {
            x: c.x,
            y: c.y,
            R: c.R,
            alpha: c.alpha,
            lifted: c.lifted,
            angle: c.angle,
            slosh: c.flow.tilt(c.angle),
          }
        : null,
      stream: this.stream,
      torch: this.torch ? { ...this.torch, r: M.torchR } : null,
    };
  }
}
