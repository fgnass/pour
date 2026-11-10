// Scripted open cup pour: one cup set half into fresh white, filled with
// colours, dragged off in a spiral so the paint runs out; an edge smeared,
// then tilt to spread the paint, and the torch to bring up cells.
import { CupContent } from './cupcontent';
import type { Studio } from './model';
import { P } from './sim/sim';

const ease = (s: number) => s * s * (3 - 2 * s);
type Path = (s: number) => [number, number];

export class Demo {
  active = false;
  tilting = false;
  private run = 0;
  private waiters: { until: number; res: () => void; rej: (e: Error) => void; run: number }[] = [];
  onChange?: (active: boolean) => void;

  constructor(private studio: Studio) {}

  private get now() {
    return this.studio.sim.time;
  }

  private wait(sec: number) {
    const run = this.run;
    return new Promise<void>((res, rej) => this.waiters.push({ until: this.now + sec, res, rej, run }));
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
    s.cup = null;
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

  private async cupPour(x: number, y: number, white: [number, number], off: Path) {
    const s = this.studio;
    s.pour = { m: 0, x: white[0], y: white[1] };
    await this.wait(1.8);
    s.pour = null;
    // fill a cup: each colour poured for a while at a spot a little off the middle
    const content = new CupContent();
    const r = () => (Math.random() - 0.5) * 0.8;
    for (const [m, secs] of [[0, 1.2], [1, 0.8], [0, 0.4], [2, 0.6], [3, 0.4], [0, 0.4], [4, 0.8], [5, 0.8]]) {
      const u = r(),
        v = r();
      content.pouringNew = true;
      for (let t = 0; t < secs; t += 1 / 30) content.pour(m, u, v, 1 / 30);
    }
    const cup = s.placeCup(x, y, content);
    await this.wait(1.5);
    // drag it off in a spiral, turning it a little: the paint runs out of the
    // open bottom along the path
    let a0 = 0;
    await this.animate(3.6, t => {
      const p = off(ease(t));
      cup.tx = p[0];
      cup.ty = p[1];
      const a = Math.sin(t * Math.PI) * 1.2;
      s.turnCup(a - a0);
      cup.omega = (a - a0) * 60;
      a0 = a;
    });
    await this.wait(0.4);
    s.cup = null;
  }

  async start() {
    this.stop();
    const s = this.studio;
    s.reset();
    this.active = true;
    this.onChange?.(true);
    const run = ++this.run;
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
      const c = at(0.5, 0.5);
      await this.cupPour(...c, at(0.5, 0.5), spiral(c, Math.PI, -1, 1.1, 0.12, 0.2, 0.02));
      // smear an edge with the cup
      await this.wait(0.6);
      const p0 = at(0.3, 0.62);
      await this.animate(1.4, t => {
        s.push = { x: p0[0] + 0.14 * t, y: p0[1] - 0.05 * t, vx: 0.1, vy: -0.035, r: 0.035 };
      });
      s.push = null;
      // tilt: come off one side first, then work the paint into the corners
      this.tilting = true;
      const seq = [
        [-0.55, 0.1, 3],
        [0.2, -0.6, 3],
        [0.65, 0.2, 3],
        [-0.2, 0.65, 3],
        [-0.6, -0.5, 2.5],
        [0.6, 0.6, 2.5],
        [0, 0, 1.5],
      ];
      for (const [x, y, d] of seq) {
        s.tilt.tx = x * P.tiltMax;
        s.tilt.ty = y * P.tiltMax;
        await this.wait(d);
      }
      this.tilting = false;
      // torch: a slow loop over the middle brings up cells
      await this.animate(5, t => {
        const a = t * Math.PI * 2;
        s.torch = { x: W / 2 + Math.cos(a) * 0.18 * sx, y: H / 2 + Math.sin(a) * 0.12 * sy };
      });
      s.torch = null;
      await this.wait(1);
    } catch (e) {
      if (run === this.run) console.error(e);
      return;
    }
    if (run === this.run) this.stop();
  }
}
