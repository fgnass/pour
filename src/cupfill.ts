// Filling the cup: the cup seen at an angle from above, before it is set
// down on the canvas. The paint in it is a grid of columns over the bottom
// of the cup; each column is a stack of layers. Poured paint lands where
// the stream hits, partly plunges into the paint below, spreads, and the
// surface slowly levels out. Through the wall the layers show; the top
// shows the surface.
import { CupContent, GRID, smooth } from './cupcontent';
import { CUP, CupView, screenToPlane, STREAM_TOP, toScreen, WALL_H, WALL_W } from './cupview';

const FALL = 0.35; // seconds the paint takes from the hand (above the screen) to the surface
const RISE = 0.06; // seconds the stream takes to reach its full width when the pour starts
const TAIL = 0.3; // seconds it takes to thin out to nothing after the pour stops
const HAND = 0.06; // the hand that pours follows the finger this smoothly (time constant, s)
const R_TOP = 0.045; // radius of the stream where it leaves the hand
const N_PATH = 16; // points along the stream for the shader
const SET_MS = 650; // setting the cup down takes this long
import { MATS } from './sim/materials';

/**
 * The view: the cup with its content, drawn by a shader (see cupview.ts)
 * over the picture. Touch the cup to aim the stream; while a paint is held
 * (or the cup is touched) paint runs in.
 */
export class CupFill {
  readonly content = new CupContent();
  /** where the stream hits (cup coordinates, -1..1; v to the back) */
  aim = { u: 0, v: 0 };
  /** paint that runs in right now */
  pouringM: number | null = null;
  onChange?: () => void;
  private view: CupView;
  private raf = 0;
  private last = 0;
  private geo = { cx: 0, cy: 0, s: 1, dpr: 1, angle: CUP.A };
  /** setting the cup down: it turns to the view from above and moves to where it lands */
  private anim: { t0: number; from: { cx: number; cy: number; s: number }; to: { cx: number; cy: number; s: number }; done: () => void } | null = null;
  private touch: number | null = null;
  private dirty = true;
  /**
   * The stream in the air: where the hand was (time, u, v), when it began
   * and when it stopped. It lands FALL seconds after it left the hand, so
   * it trails behind the hand and still runs in a moment after a stop.
   */
  /** paint from the stream is landing in the cup right now */
  private landing = false;
  /** the hand that pours: it follows the finger (aim) smoothly */
  private hand = { u: 0, v: 0 };
  private str: { m: number; path: [number, number, number][]; t0: number; t1: number | null } | null = null;

  constructor(
    readonly el: HTMLElement,
    private canvas: HTMLCanvasElement,
    private actions: HTMLElement,
    private paint: () => number,
  ) {
    this.view = new CupView(canvas);
    canvas.addEventListener('pointerdown', e => {
      const a = this.anim ? null : this.toCup(e);
      if (!a) return;
      this.touch = e.pointerId;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      this.aim = a;
      this.start(this.paint());
    });
    canvas.addEventListener('pointermove', e => {
      if (e.pointerId !== this.touch) return;
      const a = this.toCup(e, true);
      if (a) this.aim = a;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.touch) return;
      this.touch = null;
      this.stop();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    addEventListener('resize', () => this.isOpen && this.layout());
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.anim = null;
    this.el.classList.remove('setting');
    this.el.hidden = false;
    this.dirty = true;
    this.layout();
    this.kick();
  }

  close() {
    this.stop();
    // (what is still in the air lands at once)
    this.str = null;
    if (this.landing) this.content.commit();
    this.landing = false;
    this.el.hidden = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * Set the cup down: it turns until it is seen from above and moves to
   * (cx, cy) (CSS px) with its rim r px wide; then done() (the canvas takes
   * the cup over there).
   */
  setDown(cx: number, cy: number, r: number, done: () => void) {
    this.stop();
    this.str = null;
    if (this.landing) this.content.commit();
    this.landing = false;
    this.el.classList.add('setting');
    const g = this.geo;
    this.anim = { t0: performance.now(), from: { cx: g.cx, cy: g.cy, s: g.s }, to: { cx, cy, s: r / CUP.RT }, done };
    this.kick();
  }

  /** paint m starts to run into the cup */
  start(m: number) {
    this.pouringM = m;
    const now = performance.now() / 1000;
    // (a new colour, or the old stream gone: a new stream from the top)
    if (!this.str || this.str.m !== m || this.str.t1 !== null) {
      this.hand = { ...this.aim };
      this.str = { m, path: [[now, this.hand.u, this.hand.v]], t0: now, t1: null };
    }
    this.kick();
    this.onChange?.();
  }

  stop() {
    if (this.pouringM === null) return;
    this.pouringM = null;
    if (this.str) this.str.t1 = performance.now() / 1000;
    this.dirty = true;
    this.kick();
    this.onChange?.();
  }

  /** where the hand was at time t (u, v) */
  private aimAt(t: number): [number, number] {
    const p = this.str!.path;
    let i = p.length - 1;
    while (i > 0 && p[i][0] > t) i--;
    const a = p[i],
      b = p[Math.min(i + 1, p.length - 1)];
    const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  /** the same, averaged over a window of w seconds: thick paint does not bend sharply */
  private smoothAimAt(t: number, w: number): [number, number] {
    let u = 0,
      v = 0;
    for (let k = -2; k <= 2; k++) {
      const [a, b] = this.aimAt(t + (k * w) / 4);
      u += a / 5;
      v += b / 5;
    }
    return [u, v];
  }

  /** how much paint left the hand at time t (0..1): it starts quickly and thins out slowly after a stop */
  private emitted(t: number) {
    const st = this.str!;
    if (t < st.t0) return 0;
    const up = Math.min(1, (t - st.t0) / RISE);
    const down = st.t1 === null ? 1 : Math.max(0, 1 - (t - st.t1) / TAIL);
    return up * down * down * (3 - 2 * down);
  }

  /** seconds a part of the stream at height y has been falling (it speeds up as it falls) */
  private fallTime(y: number) {
    return FALL * Math.sqrt(Math.max(0, (STREAM_TOP - y) / (STREAM_TOP - this.levelY())));
  }

  /** draw again (after the content changed from outside) */
  draw() {
    this.dirty = true;
    this.kick();
  }

  private kick() {
    if (!this.raf && this.isOpen) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(() => this.frame());
    }
  }

  private frame() {
    this.raf = 0;
    // (not the frame time stamp: it can lie before the time kick() noted)
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    const st = this.str;
    if (st) {
      const t = now / 1000;
      this.hand.u += (this.aim.u - this.hand.u) * (1 - Math.exp(-dt / HAND));
      this.hand.v += (this.aim.v - this.hand.v) * (1 - Math.exp(-dt / HAND));
      if (st.t1 === null) st.path.push([t, this.hand.u, this.hand.v]);
      while (st.path.length > 2 && st.path[1][0] < t - FALL - 0.3) st.path.shift();
      // paint lands where the hand was FALL seconds ago, as much as left it then
      const tl = t - FALL;
      const e = this.emitted(tl);
      if (e > 0.01) {
        if (!this.landing) this.content.pouringNew = true;
        this.landing = true;
        const [u, v] = this.smoothAimAt(tl, 0.12);
        this.content.pour(st.m, u, v, dt * e);
      } else if (this.landing) {
        this.landing = false;
        this.content.commit();
        this.dirty = true;
      }
      // all of it has landed
      if (st.t1 !== null && tl > st.t1 + TAIL) this.str = null;
    }
    const an = this.anim;
    if (an) {
      const f = Math.min(1, (now - an.t0) / SET_MS);
      const e = f * f * (3 - 2 * f);
      const g = this.geo;
      g.cx = an.from.cx + (an.to.cx - an.from.cx) * e;
      g.cy = an.from.cy + (an.to.cy - an.from.cy) * e;
      g.s = an.from.s * Math.pow(an.to.s / an.from.s, e);
      g.angle = CUP.A + (Math.PI / 2 - CUP.A) * e;
    }
    this.render();
    if (an && performance.now() - an.t0 >= SET_MS) {
      this.anim = null;
      an.done();
      return;
    }
    if (this.str || this.anim) this.kick();
  }


  private layout() {
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    const w = innerWidth,
      h = innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const s = Math.min(w * 0.3, h * 0.19, 170);
    const cy = Math.max(110 + s, h * 0.4);
    this.geo = { cx: w / 2, cy, s, dpr, angle: CUP.A };
    // the buttons below the cup
    const foot = toScreen(0, 0, CUP.RB);
    this.actions.style.top = `${cy - foot.sy * s + 26}px`;
    this.dirty = true;
    this.render();
  }

  /** height of the paint surface (cup units) */
  private levelY() {
    return Math.min(1, this.content.level()) * CUP.HC * 0.92;
  }

  /**
   * Screen point -> where the stream lands on the paint surface (cup
   * coordinates, -1..1), or null away from the cup. The stream falls
   * straight down through the finger: on the surface it lands under the
   * finger; above the surface (over the back of the cup) it lands as far
   * back as it can, below it (on the front wall) as far forward. While a
   * finger pours, it is kept inside the cup.
   */
  private toCup(e: PointerEvent, clamp = false) {
    const { cx, cy, s } = this.geo;
    const r = this.canvas.getBoundingClientRect();
    const sx = (e.clientX - r.left - cx) / s,
      sy = (cy - (e.clientY - r.top)) / s;
    const L = this.levelY();
    if (!clamp) {
      // anywhere over the cup, and a little above its rim
      const bottom = toScreen(0, 0, CUP.RB).sy,
        top = toScreen(0, CUP.HC, -CUP.RT).sy + 0.5;
      if (Math.abs(sx) > CUP.RT * 1.05 || sy < bottom - 0.05 || sy > top) return null;
    }
    const q = screenToPlane(sx, sy, L);
    const rad = CUP.RB + ((CUP.RT - CUP.RB) * L) / CUP.HC;
    // (keep the stream at the finger's x; move it to the back or front instead)
    const u = Math.max(-0.95, Math.min(0.95, q.x / rad));
    const vm = Math.sqrt(0.95 * 0.95 - u * u);
    const v = Math.max(-vm, Math.min(vm, -q.z / rad));
    return { u, v };
  }

  private render() {
    const level = this.levelY();
    if (this.dirty || this.landing) {
      const { top, wall } = this.labels(level);
      this.view.setLabels(top, GRID, wall);
      this.dirty = false;
    }
    const { cx, cy, s, dpr, angle } = this.geo;
    let stream = null;
    const st = this.str;
    if (st) {
      const t = performance.now() / 1000;
      const r = CUP.RB + ((CUP.RT - CUP.RB) * level) / CUP.HC;
      // each point of the stream left the hand a while ago (the lower, the
      // earlier); there it is narrower, as the paint falls faster, and
      // smoother, as thick paint does not bend sharply
      const path: number[] = [];
      for (let k = 0; k < N_PATH; k++) {
        const y = level + ((STREAM_TOP - level) * k) / (N_PATH - 1);
        const age = this.fallTime(y);
        const [u, v] = this.smoothAimAt(t - age, 0.02 + 0.3 * age);
        const taper = Math.pow(1 + (STREAM_TOP - y) / 0.6, -0.25);
        path.push(u * r, -v * r, R_TOP * taper * Math.sqrt(this.emitted(t - age)));
      }
      stream = { path, m: st.m, landed: this.emitted(t - FALL) };
    }
    this.view.render({ cx, cy, scale: s, dpr, angle, level, time: performance.now() / 1000, colors: Array.from({ length: 8 }, (_, i) => (i === 7 ? [0.86, 0.86, 0.84] : (MATS[i]?.rgb ?? [0.86, 0.86, 0.84]))), stream });
  }

  /**
   * Label maps for the shader: the paint on top of each column, and the
   * layers along the wall (each column at the rim, scaled to the level so
   * the surface is flat). 7: no paint.
   */
  private labels(level: number) {
    const c = this.content;
    const top = c.topLabels();
    const wall = new Int8Array(WALL_W * WALL_H).fill(7);
    for (let a = 0; a < WALL_W; a++) {
      const th = ((a + 0.5) / WALL_W) * Math.PI * 2 - Math.PI;
      // the column at the rim in that direction (x: cos, back: -sin)
      const u = Math.cos(th) * 0.95,
        v = -Math.sin(th) * 0.95;
      const i = Math.min(GRID - 1, Math.floor(((u + 1) / 2) * GRID)),
        j = Math.min(GRID - 1, Math.floor(((v + 1) / 2) * GRID));
      const col = c.cols[j * GRID + i];
      if (!col || !col.length) continue;
      const ch = col.reduce((s, l) => s + l.h, 0);
      let li = 0,
        acc = col[0].h;
      for (let r = 0; r < WALL_H; r++) {
        const y = ((r + 0.5) / WALL_H) * CUP.HC;
        // a little above the level too: the top of the wall joins the surface
        if (y > level + (2 * CUP.HC) / WALL_H) break;
        const hz = Math.min(ch, (y / level) * ch);
        while (hz > acc && li < col.length - 1) acc += col[++li].h;
        wall[r * WALL_W + a] = col[li].m;
      }
    }
    smooth(wall, WALL_W, WALL_H, false);
    return { top, wall: new Uint8Array(wall.buffer) };
  }
}
