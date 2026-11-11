// Scripted demo, step by step as a user would do it: a blob of white in
// the middle, fill a cup with layers in the 3D view, set it down and drag it off
// in a spiral, swipe through the wet paint, tilt, and the torch to bring up
// cells. The tool bar, the hint and a finger dot show what goes on.
import type { CupFill } from './cupfill';
import type { Studio } from './model';
import { P } from './sim/sim';

const ease = (s: number) => s * s * (3 - 2 * s);
type Path = (s: number) => [number, number];
export type DemoTool = 'pour' | 'cup' | 'swipe' | 'torch' | 'tilt' | 'none';

/** what the demo needs from the app around it */
export type DemoUI = {
  cupFill: CupFill;
  /** show this tool as the active one (no side effects) */
  tool(t: DemoTool): void;
  /** select this paint */
  paint(m: number): void;
  /** show this text as the hint */
  say(text: string): void;
  /** the finger dot: on the canvas (domain units), on the screen (CSS px) or gone */
  finger(p: { x: number; y: number; screen?: boolean } | null): void;
  /** the cup is full: turn it over to the canvas (like *Done*); resolves when it is there */
  cupDone(): Promise<void>;
};

export class Demo {
  active = false;
  tilting = false;
  private run = 0;
  private waiters: { until: number; res: () => void; rej: (e: Error) => void; run: number }[] = [];
  onChange?: (active: boolean) => void;

  constructor(
    private studio: Studio,
    private ui: DemoUI,
  ) {}

  private get now() {
    return this.studio.sim.time;
  }

  private wait(sec: number) {
    const run = this.run;
    return new Promise<void>((res, rej) => this.waiters.push({ until: this.now + sec, res, rej, run }));
  }

  /** wait for a promise from outside, but give up when the demo stops */
  private async until<T>(p: Promise<T>) {
    const run = this.run;
    const v = await p;
    if (run !== this.run) throw new Error('stopped');
    return v;
  }

  tick() {
    this.waiters = this.waiters.filter(w => {
      if (w.run !== this.run) {
        w.rej(new Error('stopped'));
        return false;
      }
      if (this.now >= w.until) {
        w.res();
        return false;
      }
      return true;
    });
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.tilting = false;
    this.run++;
    const s = this.studio;
    s.pour = null;
    s.push = null;
    s.torch = null;
    s.tilt.tx = s.tilt.ty = 0;
    // (an open cup stays open: the user can go on filling it)
    this.ui.cupFill.stop();
    this.ui.finger(null);
    this.tick();
    this.onChange?.(false);
  }

  private async animate(sec: number, fn: (s: number) => void) {
    const t0 = this.now;
    for (;;) {
      const s = Math.min(1, (this.now - t0) / sec);
      fn(s);
      if (s >= 1) return;
      await this.wait(0);
    }
  }

  /** move along a path; the finger dot follows */
  private async trace(sec: number, path: Path, fn: (x: number, y: number, s: number) => void) {
    await this.animate(sec, s => {
      const [x, y] = path(s);
      this.ui.finger({ x, y });
      fn(x, y, s);
    });
  }

  /** a blob of white in the middle: the coloured paint runs into it */
  private async whiteBlob() {
    const s = this.studio;
    const [W, H] = s.sim.dom;
    const c = { x: W / 2, y: H / 2 };
    this.ui.finger(c);
    s.pour = { m: 0, ...c };
    await this.wait(2.2);
    s.pour = null;
  }

  /**
   * Fill the cup in the 3D view, calmly: a few colours, each poured for a
   * while with the hand slowly circling. Mostly the stream runs on while the
   * colour changes and the hand moves over; once it stops in between.
   */
  private async fillCup() {
    const cf = this.ui.cupFill;
    const ui = this.ui;
    cf.content.empty();
    cf.open();
    await this.wait(0.8);
    // paint, seconds, a break before it
    const layers: [number, number, boolean][] = [
      [1, 1.0, true],
      [2, 0.8, false],
      [0, 0.5, false],
      [3, 0.6, true],
      [5, 1.0, false],
    ];
    const show = () => ui.finger({ ...cf.screenOf(cf.aim.u, cf.aim.v), screen: true });
    for (const [m, sec, gap] of layers) {
      const u0 = (Math.random() - 0.5) * 0.7,
        v0 = (Math.random() - 0.5) * 0.7;
      const a = Math.random() * Math.PI * 2;
      const at = (t: number) => ({ u: u0 + Math.cos(a + t * 1.5) * 0.08, v: v0 + Math.sin(a + t * 1.5) * 0.08 });
      // the hand moves over to where the next colour goes: with a break
      // first, else while the stream runs on in the new colour
      const first = cf.pouringM === null;
      if (gap && !first) {
        cf.stop();
        await this.wait(0.25);
      }
      ui.paint(m);
      if (!gap) cf.start(m);
      const from = { ...cf.aim };
      const to = at(0);
      await this.animate(first ? 0.2 : 0.45, t => {
        const e = ease(t);
        cf.aim = { u: from.u + (to.u - from.u) * e, v: from.v + (to.v - from.v) * e };
        show();
      });
      if (gap) cf.start(m);
      await this.animate(sec, t => {
        cf.aim = at(t);
        show();
      });
    }
    cf.stop();
    ui.finger(null);
    // (let the last stream land)
    await this.wait(0.5);
  }

  async start() {
    this.stop();
    const s = this.studio;
    s.reset();
    this.active = true;
    this.onChange?.(true);
    const run = ++this.run;
    const ui = this.ui;
    const [W, H] = s.sim.dom;
    // map positions of a unit square onto the canvas, stretched along the long side
    const sx = W > H ? 1 + (W - 1) * 0.6 : 1;
    const sy = H > W ? 1 + (H - 1) * 0.6 : 1;
    const at = (x: number, y: number): [number, number] => [W / 2 + (x - 0.5) * sx, H / 2 + (y - 0.5) * sy];
    const spiral = (c: [number, number], a0: number, dir: number, turns: number, r1: number, ox: number, oy: number): Path => s => {
      const a = a0 + dir * s * turns * Math.PI * 2;
      const r = r1 * Math.sin((Math.min(1, s * 1.4) * Math.PI) / 2);
      return [c[0] + Math.cos(a) * r + ox * s * s, c[1] + Math.sin(a) * r + oy * s * s * sy];
    };
    try {
      // 1. wet the canvas with white
      ui.tool('pour');
      ui.paint(0);
      ui.say('Demo · first a blob of white in the middle');
      await this.whiteBlob();
      ui.finger(null);
      await this.wait(0.4);

      // 2. fill a cup with layers
      ui.tool('cup');
      ui.say('Fill a cup: pour the colours in one after the other');
      await this.fillCup();
      ui.say('*Done* turns the cup over to the canvas');
      await this.wait(0.5);
      await this.until(ui.cupDone());
      const cup = s.cup!;
      await this.wait(0.3);
      cup.lifted = false;
      await this.wait(0.8);

      // 3. drag it off in a spiral, turning it a little: the paint runs out
      // of the open bottom along the path
      ui.say('Drag the cup: the paint runs out under its rim');
      const c: [number, number] = [cup.x, cup.y];
      const off = spiral(c, Math.PI, -1, 1.1, 0.12, 0.2, 0.02);
      let a0 = 0;
      await this.trace(3.6, t => off(ease(t)), (x, y, t) => {
        cup.tx = x;
        cup.ty = y;
        const a = Math.sin(t * Math.PI) * 1.2;
        s.turnCup(a - a0);
        cup.omega = (a - a0) * 60;
        a0 = a;
      });
      ui.finger(null);
      await this.wait(0.4);
      s.cup = null;

      // 4. swipe through the wet paint
      ui.tool('swipe');
      ui.say('*Swipe* pushes the wet paint');
      await this.wait(0.5);
      for (const [x0, y0, x1, y1] of [
        [0.22, 0.42, 0.78, 0.6],
        [0.7, 0.3, 0.35, 0.72],
      ]) {
        const p0 = at(x0, y0),
          p1 = at(x1, y1);
        const dur = 1.1;
        const vx = (p1[0] - p0[0]) / dur,
          vy = (p1[1] - p0[1]) / dur;
        const line: Path = t => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
        s.push = { x: p0[0], y: p0[1], vx: 0, vy: 0, r: 0.055 };
        // (even speed: the push takes the speed of the finger)
        await this.trace(dur, line, (x, y) => Object.assign(s.push!, { x, y, vx, vy }));
        s.push = null;
        ui.finger(null);
        await this.wait(0.35);
      }

      // 5. tilt: a few short tilts work the paint into the corners
      ui.tool('tilt');
      ui.say('*Tilt* the canvas: the paint runs downhill');
      this.tilting = true;
      for (const [x, y, d] of [
        [-0.6, 0.15, 1.1],
        [0.25, -0.6, 1.1],
        [0.6, 0.35, 1.1],
        [0, 0, 0.6],
      ]) {
        s.tilt.tx = x * P.tiltMax;
        s.tilt.ty = y * P.tiltMax;
        await this.wait(d);
      }
      this.tilting = false;

      // 6. torch: a slow loop over the middle brings up cells
      ui.tool('torch');
      ui.say('The *Torch* brings up cells');
      await this.wait(0.3);
      await this.trace(
        5,
        t => {
          const a = t * Math.PI * 2;
          return [W / 2 + Math.cos(a) * 0.18 * sx, H / 2 + Math.sin(a) * 0.12 * sy];
        },
        (x, y) => (s.torch = { x, y }),
      );
      s.torch = null;
      ui.finger(null);
      // the torch off again (as a second tap on it does)
      ui.tool('none');
      await this.wait(1);
    } catch (e) {
      if (run === this.run) console.error(e);
      return;
    }
    if (run === this.run) this.stop();
  }
}
