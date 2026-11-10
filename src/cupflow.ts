// The paint in a cup on the canvas is a liquid: it moves inside the cup.
// The layers (cupcontent.ts) stay as they are; a flow map says for each
// place of the cup where its paint came from. Two motions move it:
// - Turning: the paint is slow to follow the cup. The wall takes the paint
//   next to it along at once, the middle lags behind, so turning the cup to
//   and fro winds the colours into spirals.
// - Moving: when the cup speeds up or slows down, the paint sloshes to and
//   fro and comes to rest again.
import { GRID } from './cupcontent';

const SPIN_MID = 0.6; // how fast the paint in the middle takes on the cup's turn (1/s)
const SPIN_WALL = 7; // the same at the wall
const SLOSH_HZ = 1.1; // the paint sloshes to and fro this often (1/s)
const SLOSH_DAMP = 0.35; // damping ratio
const SLOSH_GAIN = 0.35; // how far a push of the cup moves the paint
const SLOSH_MAX = 0.3; // largest slosh (share of the radius)

/** centre of cell (i, j) in cup coordinates (-1..1) */
const cellUV = (i: number) => ((i + 0.5) / GRID) * 2 - 1;

export class CupFlow {
  /** where the paint at each cell came from (cup coordinates) */
  private mu = new Float32Array(GRID * GRID);
  private mv = new Float32Array(GRID * GRID);
  private nu = new Float32Array(GRID * GRID);
  private nv = new Float32Array(GRID * GRID);
  /** the paint's own turn speed at each cell (radians / s) */
  private spin = new Float32Array(GRID * GRID);
  /** slosh: offset and its speed (cup coordinates, turned with the cup) */
  private sx = 0;
  private sy = 0;
  private svx = 0;
  private svy = 0;
  private last: { angle: number; vx: number; vy: number } | null = null;
  /** true when the map changed since the labels were made */
  moved = true;

  constructor() {
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        this.mu[j * GRID + i] = cellUV(i);
        this.mv[j * GRID + i] = cellUV(j);
      }
  }

  /** one step: the cup is turned to `angle` and moves at (vx, vy) (canvas units / s); R: its radius */
  step(dt: number, angle: number, vx: number, vy: number, R: number) {
    if (dt <= 0) return;
    const last = this.last ?? { angle, vx, vy };
    this.last = { angle, vx, vy };
    const omega = (angle - last.angle) / dt;
    // the cup's change of speed, in cup coordinates (turned with the cup)
    const ax = (vx - last.vx) / dt / R,
      ay = (vy - last.vy) / dt / R;
    const c = Math.cos(-angle),
      s = Math.sin(-angle);
    const lax = c * ax - s * ay,
      lay = s * ax + c * ay;
    // slosh: a damped spring, pushed against the cup's change of speed
    const w0 = 2 * Math.PI * SLOSH_HZ;
    const sub = Math.max(1, Math.ceil(dt / 0.01));
    const h = dt / sub;
    for (let k = 0; k < sub; k++) {
      this.svx += (-w0 * w0 * this.sx - 2 * SLOSH_DAMP * w0 * this.svx - SLOSH_GAIN * lax) * h;
      this.svy += (-w0 * w0 * this.sy - 2 * SLOSH_DAMP * w0 * this.svy - SLOSH_GAIN * lay) * h;
      this.sx += this.svx * h;
      this.sy += this.svy * h;
    }
    const sl = Math.hypot(this.sx, this.sy);
    if (sl > SLOSH_MAX) {
      this.sx *= SLOSH_MAX / sl;
      this.sy *= SLOSH_MAX / sl;
    }

    // move the map: each cell takes what was upstream of it
    let maxStep = 0;
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const u = cellUV(i),
          v = cellUV(j);
        const r2 = u * u + v * v;
        if (r2 >= 1) {
          this.nu[k] = this.mu[k];
          this.nv[k] = this.mv[k];
          continue;
        }
        // the paint's turn speed follows the cup's, fast at the wall
        const rate = SPIN_MID + (SPIN_WALL - SPIN_MID) * r2 * r2;
        this.spin[k] += (omega - this.spin[k]) * (1 - Math.exp(-rate * dt));
        const rel = this.spin[k] - omega;
        // (sloshing is strongest in the middle; at the wall the paint cannot go on)
        const f = 1 - r2;
        const wu = -rel * v + this.svx * f,
          wv = rel * u + this.svy * f;
        maxStep = Math.max(maxStep, Math.hypot(wu, wv) * dt);
        let bu = u - wu * dt,
          bv = v - wv * dt;
        const br = Math.hypot(bu, bv);
        if (br > 0.97) {
          bu *= 0.97 / br;
          bv *= 0.97 / br;
        }
        [this.nu[k], this.nv[k]] = this.sample(bu, bv);
      }
    [this.mu, this.nu] = [this.nu, this.mu];
    [this.mv, this.nv] = [this.nv, this.mv];
    if (maxStep > 1e-4) this.moved = true;
  }

  /** the map at (u, v), bilinear */
  private sample(u: number, v: number): [number, number] {
    const x = Math.min(GRID - 1.001, Math.max(0, ((u + 1) / 2) * GRID - 0.5)),
      y = Math.min(GRID - 1.001, Math.max(0, ((v + 1) / 2) * GRID - 0.5));
    const i = Math.floor(x),
      j = Math.floor(y);
    const fx = x - i,
      fy = y - j;
    const k = j * GRID + i;
    const at = (m: Float32Array) =>
      (m[k] * (1 - fx) + m[k + 1] * fx) * (1 - fy) + (m[k + GRID] * (1 - fx) + m[k + GRID + 1] * fx) * fy;
    return [at(this.mu), at(this.mv)];
  }

  /** tilt of the surface while the paint sloshes, in canvas axes (the cup is turned by `angle`) */
  tilt(angle: number): [number, number] {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    return [c * this.sx - s * this.sy, s * this.sx + c * this.sy];
  }

  /** a label map (GRID x GRID, 7: none) as the paint has moved */
  apply(L: Uint8Array) {
    const out = new Uint8Array(L.length).fill(7);
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const u = cellUV(i),
          v = cellUV(j);
        if (u * u + v * v >= 1) continue;
        const si = Math.min(GRID - 1, Math.max(0, Math.floor(((this.mu[k] + 1) / 2) * GRID))),
          sj = Math.min(GRID - 1, Math.max(0, Math.floor(((this.mv[k] + 1) / 2) * GRID)));
        out[k] = L[sj * GRID + si];
      }
    return out;
  }
}
