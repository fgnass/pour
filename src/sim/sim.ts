import { GL, type Program } from './gl';
import { MATS } from './materials';
import { CLEAR_FS, FLUX_FS, MASK_FS, MASK_VS, NUM_SRC, PART_FS, PIG_FS, RENDER_FS, VEL_FS } from './shaders';

// Physical parameters (domain units: the short side of the canvas is 1).
export const P = {
  A: 0.15, // mobility
  K: 1 / 600, // hydrostatic term
  tau: 0.05, // yield stress
  hCap: 2.0, // mobility cap (stability)
  surfK: 1.4, // surface velocity / mean velocity
  subK: 0.6, // submerged velocity / mean velocity
  rise: 3.0, // how fast a cell pulls submerged paint up
  tiltMax: 0.5,
};

export type Source = {
  x: number;
  y: number;
  r: number;
  rate: number;
  s: number[];
  u: number[];
  g: number[];
  streak: number;
};

export const noSource = (): Source => ({ x: 0, y: 0, r: 0, rate: 0, s: [0, 0, 0, 0], u: [0, 0, 0, 0], g: [0, 0], streak: 0 });

export type Forces = {
  tilt: [number, number];
  push: [number, number, number, number][]; // 2 entries: x, y, radius, strength
  pushVel: [number, number][];
  swirl: [number, number, number, number];
  src: Source[]; // NUM_SRC entries
  riseK: number;
};

export type Overlay = {
  view: [number, number];
  cup: { x: number; y: number; R: number; alpha: number; col: number[]; fill: number } | null;
  stream: { x: number; y: number; col: number[] } | null;
};

export type Quality = { n: number; np: number };

const PW = 256;
const PCOUNT = PW * PW;
const MAX_SUB = 60;

export class Sim {
  readonly g: GL;
  readonly dom: [number, number];
  readonly dx: number;
  readonly NX: number;
  readonly NY: number;
  readonly PX: number;
  readonly PY: number;
  time = 0;
  substeps = 0;

  private H: WebGLTexture[];
  private Hfb: WebGLFramebuffer[];
  private V: WebGLTexture;
  private Vfb: WebGLFramebuffer;
  private PS: WebGLTexture[][];
  private PSfb: WebGLFramebuffer[];
  private PT: WebGLTexture[];
  private PTfb: WebGLFramebuffer[];
  private MASK: WebGLTexture;
  private MASKfb: WebGLFramebuffer;
  private hi = 0;
  private pi = 0;
  private ppi = 0;
  private pRing = 0;
  private spawns: number[] = [];
  private prog: Record<'flux' | 'vel' | 'pig' | 'render' | 'clear' | 'part' | 'mask', Program>;
  private resources: { tex: WebGLTexture[]; fb: WebGLFramebuffer[] } = { tex: [], fb: [] };

  constructor(g: GL, aspect: number, q: Quality) {
    this.g = g;
    const gl = g.gl;
    const w = aspect >= 1 ? aspect : 1;
    const h = aspect >= 1 ? 1 : 1 / aspect;
    this.NX = Math.round(w * q.n);
    this.NY = Math.round(h * q.n);
    this.dx = 1 / q.n;
    this.dom = [this.NX * this.dx, this.NY * this.dx];
    this.PX = Math.round(this.dom[0] * q.np);
    this.PY = Math.round(this.dom[1] * q.np);

    const tex = (w: number, h: number, f: number, lin: boolean) => {
      const t = g.tex(w, h, f, lin);
      this.resources.tex.push(t);
      return t;
    };
    const fbo = (t: WebGLTexture[]) => {
      const f = g.fbo(t);
      this.resources.fb.push(f);
      return f;
    };

    const PIG = g.floatLinear ? gl.RGBA32F : gl.RGBA16F;
    this.H = [0, 1].map(() => tex(this.NX, this.NY, gl.R32F, false));
    this.Hfb = this.H.map(t => fbo([t]));
    this.V = tex(this.NX, this.NY, gl.RGBA16F, true);
    this.Vfb = fbo([this.V]);
    this.PS = [0, 1].map(() => [0, 1, 2].map(() => tex(this.PX, this.PY, PIG, true)));
    this.PSfb = this.PS.map(fbo);
    this.PT = [0, 1].map(() => tex(PW, PW, gl.RGBA32F, false));
    this.PTfb = this.PT.map(t => fbo([t]));
    this.MASK = tex(this.PX, this.PY, gl.RGBA8, true);
    this.MASKfb = fbo([this.MASK]);

    this.prog = {
      flux: g.compile(FLUX_FS),
      vel: g.compile(VEL_FS),
      pig: g.compile(PIG_FS),
      render: g.compile(RENDER_FS),
      clear: g.compile(CLEAR_FS),
      part: g.compile(PART_FS),
      mask: g.compile(MASK_FS, MASK_VS),
    };
    this.reset();
  }

  dispose() {
    const gl = this.g.gl;
    this.resources.fb.forEach(f => gl.deleteFramebuffer(f));
    this.resources.tex.forEach(t => gl.deleteTexture(t));
    Object.values(this.prog).forEach(p => gl.deleteProgram(p.prog));
  }

  reset() {
    const gl = this.g.gl;
    gl.clearColor(0, 0, 0, 0);
    for (const f of [...this.Hfb, ...this.PTfb, this.Vfb]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.useProgram(this.prog.clear.prog);
    for (const f of this.PSfb) this.g.draw(f, this.PX, this.PY);
    this.spawns.length = 0;
    this.time = 0;
  }

  /** Largest time step that the explicit thickness solver can take. */
  stableDt() {
    const dx = this.dx;
    const dtDiff = (0.22 * dx * dx) / (P.A * P.K * P.hCap ** 3);
    const dtAdv = (0.45 * dx) / (3 * P.A * P.hCap ** 2 * P.tiltMax + 1.5);
    return Math.min(dtDiff, dtAdv);
  }
  maxDt() {
    return MAX_SUB * this.stableDt();
  }

  private cellRadius() {
    const u = Math.random();
    return 0.0022 + 0.009 * u * u * u;
  }

  /** Add one cell (a spot where submerged paint rises). */
  addCell(x: number, y: number, life: number) {
    this.spawns.push(x, y, this.cellRadius(), this.time + life);
  }

  private flushSpawns() {
    const gl = this.g.gl;
    let n = Math.min(this.spawns.length / 4, PCOUNT);
    let off = 0;
    gl.bindTexture(gl.TEXTURE_2D, this.PT[this.ppi]);
    while (n > 0) {
      const x = this.pRing % PW,
        y = (this.pRing / PW) | 0;
      const len = Math.min(n, PW - x);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, len, 1, gl.RGBA, gl.FLOAT, new Float32Array(this.spawns.slice(off * 4, (off + len) * 4)));
      this.pRing = (this.pRing + len) % PCOUNT;
      off += len;
      n -= len;
    }
    this.spawns.length = 0;
  }

  private setForces(p: Program, f: Forces) {
    const gl = this.g.gl;
    gl.uniform2f(p.uni.uTilt, f.tilt[0], f.tilt[1]);
    gl.uniform4fv(p.uni.uPush, f.push.flat());
    gl.uniform2fv(p.uni.uPushVel, f.pushVel.flat());
    gl.uniform4fv(p.uni.uSwirl, f.swirl);
  }
  private setSources(p: Program, src: Source[]) {
    this.g.gl.uniform4fv(p.uni.uSrc, src.flatMap(s => [s.x, s.y, s.r, s.rate]));
  }
  private setFilm(p: Program) {
    const gl = this.g.gl;
    gl.uniform2i(p.uni.uN, this.NX, this.NY);
    gl.uniform1f(p.uni.uDx, this.dx);
    gl.uniform1f(p.uni.uA, P.A);
    gl.uniform1f(p.uni.uK, P.K);
    gl.uniform1f(p.uni.uTau, P.tau);
    gl.uniform1f(p.uni.uCap, P.hCap);
  }

  step(dt: number, f: Forces) {
    const g = this.g;
    const gl = g.gl;
    if (f.src.length !== NUM_SRC) throw new Error('bad source count');
    const n = Math.max(1, Math.ceil(dt / this.stableDt() - 1e-6));
    this.substeps = n;
    const sdt = dt / n;

    // paint thickness
    let p = this.prog.flux;
    gl.useProgram(p.prog);
    this.setFilm(p);
    gl.uniform1f(p.uni.uDt, sdt);
    this.setForces(p, f);
    this.setSources(p, f.src);
    for (let i = 0; i < n; i++) {
      g.bindTex(p, 'uH', 0, this.H[this.hi]);
      g.draw(this.Hfb[1 - this.hi], this.NX, this.NY);
      this.hi = 1 - this.hi;
    }

    p = this.prog.vel;
    gl.useProgram(p.prog);
    this.setFilm(p);
    this.setForces(p, f);
    g.bindTex(p, 'uH', 0, this.H[this.hi]);
    g.draw(this.Vfb, this.NX, this.NY);

    // cell particles: spawn, move, splat into the rise mask
    this.flushSpawns();
    p = this.prog.part;
    gl.useProgram(p.prog);
    g.bindTex(p, 'uP', 0, this.PT[this.ppi]);
    g.bindTex(p, 'uV', 1, this.V);
    gl.uniform2f(p.uni.uDom, ...this.dom);
    gl.uniform1f(p.uni.uDt, dt);
    gl.uniform1f(p.uni.uK, P.subK);
    gl.uniform1f(p.uni.uTime, this.time);
    g.draw(this.PTfb[1 - this.ppi], PW, PW);
    this.ppi = 1 - this.ppi;

    p = this.prog.mask;
    gl.useProgram(p.prog);
    g.bindTex(p, 'uP', 0, this.PT[this.ppi]);
    gl.uniform1i(p.uni.uPW, PW);
    gl.uniform2f(p.uni.uDom, ...this.dom);
    gl.uniform1f(p.uni.uPxPerUnit, this.PX / this.dom[0]);
    gl.uniform1f(p.uni.uTime, this.time);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.MASKfb);
    gl.viewport(0, 0, this.PX, this.PY);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    g.points(PCOUNT);
    gl.disable(gl.BLEND);

    // pigments
    p = this.prog.pig;
    gl.useProgram(p.prog);
    const cur = this.PS[this.pi];
    ['uS', 'uU', 'uG'].forEach((nm, i) => g.bindTex(p, nm, i, cur[i]));
    g.bindTex(p, 'uV', 3, this.V);
    g.bindTex(p, 'uMask', 4, this.MASK);
    gl.uniform2f(p.uni.uSize, this.PX, this.PY);
    gl.uniform2f(p.uni.uDom, ...this.dom);
    gl.uniform1f(p.uni.uDt, dt);
    gl.uniform1f(p.uni.uSurfK, P.surfK);
    gl.uniform1f(p.uni.uSubK, P.subK);
    gl.uniform1f(p.uni.uSharpen, 0.015);
    gl.uniform1f(p.uni.uRise, P.rise * f.riseK);
    this.setSources(p, f.src);
    gl.uniform4fv(p.uni.uSrcS, f.src.flatMap(s => s.s));
    gl.uniform4fv(p.uni.uSrcU, f.src.flatMap(s => s.u));
    gl.uniform2fv(p.uni.uSrcG, f.src.flatMap(s => s.g));
    gl.uniform1fv(p.uni.uSrcStreak, f.src.map(s => s.streak));
    gl.uniform1f(p.uni.uTime, this.time);
    g.draw(this.PSfb[1 - this.pi], this.PX, this.PY);
    this.pi = 1 - this.pi;

    this.time += dt;
  }

  render(o: Overlay, width: number, height: number) {
    const g = this.g;
    const gl = g.gl;
    const p = this.prog.render;
    gl.useProgram(p.prog);
    g.bindTex(p, 'uV', 0, this.V);
    ['uS', 'uU', 'uG'].forEach((nm, i) => g.bindTex(p, nm, i + 1, this.PS[this.pi][i]));
    gl.uniform2f(p.uni.uDom, ...this.dom);
    gl.uniform2f(p.uni.uPSize, this.PX, this.PY);
    gl.uniform1f(p.uni.uDx, this.dx);
    gl.uniform3fv(p.uni.uCol, MATS.flatMap(m => m.rgb));
    gl.uniform2f(p.uni.uView, ...o.view);
    gl.uniform1f(p.uni.uPx, this.dom[0] / width);
    if (o.cup) {
      const c = o.cup;
      gl.uniform4f(p.uni.uCup, c.x, c.y, c.R, c.alpha);
      gl.uniform4f(p.uni.uCupCol, c.col[0], c.col[1], c.col[2], c.fill);
    } else gl.uniform4f(p.uni.uCup, 0, 0, 0, 0);
    if (o.stream) {
      gl.uniform4f(p.uni.uStream, o.stream.x, o.stream.y, 0.0055, 1);
      gl.uniform3fv(p.uni.uStreamCol, o.stream.col);
    } else gl.uniform4f(p.uni.uStream, 0, 0, 0, 0);
    g.draw(null, width, height);
  }

  /** Reads the image that render() just drew (call in the same frame). */
  readImage(width: number, height: number) {
    const gl = this.g.gl;
    const px = new Uint8ClampedArray(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // flip vertically
    const row = width * 4;
    const tmp = new Uint8ClampedArray(row);
    for (let y = 0; y < height >> 1; y++) {
      const a = y * row,
        b = (height - 1 - y) * row;
      tmp.set(px.subarray(a, a + row));
      px.copyWithin(a, b, b + row);
      px.set(tmp, b);
    }
    return new ImageData(px, width, height);
  }
}
