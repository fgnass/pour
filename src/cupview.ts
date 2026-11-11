// The cup in the fill view, drawn by a fragment shader: each pixel casts a
// ray against a plastic cup (a cone that is narrower at the bottom, with
// ribs), the paint in it (filled up to a level) and the stream of paint
// that runs in. The paint comes from two label maps: the colour on top of
// each column (the surface) and the layers along the wall.

export const CUP = { RT: 1, RB: 0.74, HC: 1.5, A: 0.52 }; // radii, height, view angle (radians below the horizon)
export const WALL_W = 256; // steps around the wall
export const WALL_H = 128; // steps up the wall
export const STREAM_TOP = 4.5; // the stream comes from this high (above the screen)

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform vec2 uRes;      // canvas pixels
uniform float uDpr;
uniform vec2 uCenter;   // where the middle of the cup is (CSS px, y down)
uniform float uScale;   // CSS px per unit
uniform float uLevel;   // paint level (units above the floor)
uniform float uTime;
uniform float uA;        // view angle below the horizon (radians; pi/2: straight from above)
uniform usampler2D uTop;  // label of the paint on top of each column
uniform usampler2D uWall; // label of the paint along the wall (x: around, y: up)
uniform ivec2 uTopSize;
uniform vec3 uCol[8];     // colours of the labels (7: none)
uniform vec4 uStream;     // x, z (where it lands), radius, on
uniform float uStreamM;   // label of the paint in the stream ...
uniform float uStreamM2;  // ... and of a new paint above this height (it joined the running stream)
uniform float uStreamSplit;
// The stream falls from above: each part of it left the hand a little
// earlier the lower it is, so it trails behind the hand's moves. Its centre
// (x, z) and radius at 16 heights from the surface (uLevel) up to
// STREAM_TOP; radius 0 where there is no paint (before it starts, after it
// thinned out).
uniform vec3 uStreamPath[16];
uniform float uLanded;    // how much paint lands right now (0..1)
out vec4 o;

const float RT = ${CUP.RT.toFixed(4)}, RB = ${CUP.RB.toFixed(4)}, HC = ${CUP.HC.toFixed(4)};
const float K = (RT - RB) / HC;
const float STREAM_TOP = ${STREAM_TOP.toFixed(4)};

// centre and radius of the stream at height y (a smooth curve through the points)
vec3 streamAt(float y) {
  float f = clamp((y - uLevel) / (STREAM_TOP - uLevel), 0.0, 1.0) * 15.0;
  int i = min(int(f), 14);
  float t = f - float(i);
  vec3 p0 = uStreamPath[max(i - 1, 0)], p1 = uStreamPath[i], p2 = uStreamPath[i + 1], p3 = uStreamPath[min(i + 2, 15)];
  vec3 c = 0.5 * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (3.0 * p1 - p0 - 3.0 * p2 + p3) * t * t * t);
  // (between points, the radius must not overshoot below 0)
  c.z = max(c.z, 0.0);
  return c;
}
const vec3 LIGHT = normalize(vec3(-0.5, 0.9, 0.6));
const float PI = 3.14159265;

float rad(float y) { return RB + K * y; }

// the ray against the (double) cone of the wall; returns both roots
bool cone(vec3 ro, vec3 rd, out float t0, out float t1) {
  float r0 = RB + K * ro.y;
  float a = rd.x * rd.x + rd.z * rd.z - K * K * rd.y * rd.y;
  float b = 2.0 * (ro.x * rd.x + ro.z * rd.z - K * rd.y * r0);
  float c = ro.x * ro.x + ro.z * ro.z - r0 * r0;
  float d = b * b - 4.0 * a * c;
  if (d < 0.0) return false;
  d = sqrt(d);
  t0 = (-b - d) / (2.0 * a);
  t1 = (-b + d) / (2.0 * a);
  return true;
}

uint lab(usampler2D t, ivec2 p, ivec2 size) {
  return texelFetch(t, clamp(p, ivec2(0), size - 1), 0).r;
}

// The paint at grid position g: each label gets the weight of its cells
// among the 4 x 4 nearest (a Gaussian of their distance); the strongest
// wins. The edge to the runner-up is smoothed over about one screen pixel,
// so borders are smooth, sharp curves.
vec4 paintAt(usampler2D t, ivec2 size, vec2 g, bool wrapX) {
  // a slow warp: the borders wind a little, they do not follow the grid
  g += vec2(sin(g.y * 0.19 + 1.7) + 0.5 * sin(g.y * 0.47 + g.x * 0.13),
            sin(g.x * 0.17 + 0.4) + 0.5 * sin(g.x * 0.41 - g.y * 0.11)) * 0.7;
  g -= 0.5;
  ivec2 b = ivec2(floor(g)) - 1;
  float w[8];
  for (int i = 0; i < 8; i++) w[i] = 0.0;
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) {
      ivec2 q = b + ivec2(i, j);
      vec2 d = vec2(q) - g;
      float wt = exp(-dot(d, d) * 1.2);
      if (wrapX) q.x = (q.x % size.x + size.x) % size.x;
      w[int(lab(t, q, size))] += wt;
    }
  // no paint (outside the floor) only where there is no paint near at all
  if (w[0] + w[1] + w[2] + w[3] + w[4] + w[5] + w[6] > 0.0) w[7] = 0.0;
  int bi = 0; float sb = w[0];
  for (int i = 1; i < 8; i++) if (w[i] > sb) { bi = i; sb = w[i]; }
  int ci = bi; float sc = 0.0;
  for (int i = 0; i < 8; i++) if (i != bi && w[i] > sc) { ci = i; sc = w[i]; }
  float e = (sb - sc) / (sb + sc + 1e-6);
  float a = ci == bi ? 1.0 : clamp(0.5 + e / (2.0 * max(fwidth(e), 1e-3)), 0.5, 1.0);
  return vec4(float(bi), float(ci), a, 0.0);
}

vec3 colOf(vec4 p) { return mix(uCol[int(p.y)], uCol[int(p.x)], p.z); }

void main() {
  // the camera looks down at the cup at angle A (no perspective)
  float A = uA;
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 s = vec2(p.x - uCenter.x, uCenter.y - p.y) / uScale;
  vec3 rd = vec3(0.0, -sin(A), -cos(A));
  vec3 up = vec3(0.0, cos(A), -sin(A));
  vec3 ro = vec3(0.0, HC * 0.5, 0.0) + vec3(s.x, 0.0, 0.0) + up * s.y - rd * 10.0;
  float L = uLevel;

  vec3 col = vec3(0.0);
  float alpha = 0.0;   // 1 where something opaque is seen
  float tScene = 1e9;  // distance of what is seen
  bool front = false;  // seen through the front wall
  vec3 pFront;

  float t0, t1;
  bool hit = cone(ro, rd, t0, t1);
  float tIn = -1.0;
  if (hit) {
    float y0 = ro.y + t0 * rd.y;
    if (y0 >= 0.0 && y0 <= HC) { tIn = t0; front = true; pFront = ro + rd * t0; }
  }
  // the opening
  float tOpen = (HC - ro.y) / rd.y;
  vec3 qOpen = ro + rd * tOpen;
  bool inOpen = length(qOpen.xz) < RT;
  if (tIn < 0.0 && inOpen) tIn = tOpen;

  if (tIn > 0.0) {
    vec3 pin = ro + rd * tIn;
    if (front && pin.y < L) {
      // the paint behind the front wall: the layers there
      float th = atan(pin.z, pin.x);
      vec2 g = vec2((th + PI) / (2.0 * PI) * ${WALL_W}.0, pin.y / HC * ${WALL_H}.0);
      vec4 pa = paintAt(uWall, ivec2(${WALL_W}, ${WALL_H}), g, true);
      vec3 n = normalize(vec3(pin.x, 0.0, pin.z));
      col = colOf(pa) * (0.62 + 0.38 * max(dot(n, LIGHT), 0.0));
      alpha = 1.0;
      tScene = tIn;
    } else {
      float tp = (L - ro.y) / rd.y;
      vec3 pp = ro + rd * tp;
      float rl = rad(L);
      if (tp > tIn && length(pp.xz) < rl) {
        tScene = tp;
        vec3 c;
        if (L < 0.003) c = vec3(0.86, 0.86, 0.84); // the empty floor
        else {
          vec2 uv = vec2(pp.x, -pp.z) / rl;
          vec2 g = (uv * 0.5 + 0.5) * vec2(uTopSize);
          vec4 pa = paintAt(uTop, uTopSize, g, false);
          c = pa.x > 6.5 ? uCol[0] : colOf(pa);
          // fresh paint pools where the stream lands
          if (uStream.w > 0.0 && uLanded > 0.05) {
            float d = length(pp.xz - uStream.xy) / 0.028;
            float ring = 2.2 + 0.12 * sin(atan(pp.z - uStream.y, pp.x - uStream.x) * 5.0 + uTime * 1.5);
            c = mix(c, uCol[int(uStreamM)], (1.0 - smoothstep(ring - 0.4, ring, d)) * uLanded);
          }
          // wet paint shines
          vec3 h = normalize(LIGHT - rd);
          c = c * (0.92 + 0.08 * h.y) + vec3(pow(max(h.y, 0.0), 120.0) * 0.5);
          // darker near the wall (the meniscus)
          c *= 0.9 + 0.1 * smoothstep(1.0, 0.9, length(pp.xz) / rl);
        }
        col = c;
        alpha = 1.0;
      }
    }
  }

  // the stream: a bent column of paint that ends on the surface. Each
  // screen row shows it at one height (its depth shifts that a little:
  // solved in a few rounds); there it is a round column around its centre.
  if (uStream.w > 0.0) {
    vec3 c = streamAt(HC);
    float yy = HC;
    for (int k = 0; k < 3; k++) {
      yy = (s.y + c.y * sin(A)) / max(cos(A), 0.05) + HC * 0.5;
      c = streamAt(yy);
    }
    // where it lands it widens a little
    float rs = c.z * (1.0 + 0.6 * uLanded * exp(-max(yy - L, 0.0) * 12.0));
    float dx = s.x - c.x;
    if (abs(dx) < rs && yy > L) {
      float h = sqrt(rs * rs - dx * dx);
      // the near side (the ray runs towards -z)
      float ts = (c.y + h - ro.z) / rd.z;
      if (ts < tScene) {
        vec3 n = normalize(vec3(dx, 0.0, h));
        vec3 base = mix(uCol[int(uStreamM)], uCol[int(uStreamM2)], smoothstep(uStreamSplit - 0.04, uStreamSplit + 0.04, yy));
        vec3 hv = normalize(LIGHT - rd);
        // it comes from above the screen
        col = base * (0.6 + 0.4 * max(dot(n, LIGHT), 0.0)) + vec3(pow(max(dot(n, hv), 0.0), 30.0) * 0.5);
        // (a thin thread: soft edges instead of flicker)
        alpha = clamp(rs / 0.004, 0.0, 1.0);
        col *= alpha;
        tScene = ts;
        if (yy > HC) front = false; // above the cup: not behind the wall
      }
    }
  }

  // the plastic: the back wall above the paint, seen from inside (through
  // the opening or through the front wall). Its ribs show there too.
  if (hit) {
    float y1 = ro.y + t1 * rd.y;
    if (y1 > L && y1 <= HC && t1 < tScene + 1e-4 && alpha < 0.5) {
      vec3 pb = ro + rd * t1;
      float th = atan(pb.z, pb.x);
      float yy = pb.y / HC;
      float rib = sin(yy * 2.0 * PI * 7.0) * smoothstep(0.08, 0.2, yy) + 0.8 * sin(yy * 2.0 * PI * 22.0) * smoothstep(0.86, 0.9, yy);
      // (the inner side: the normal points into the cup)
      vec3 n = -normalize(vec3(cos(th), K + rib * 0.7, sin(th)));
      float ndv = abs(dot(n, -rd));
      float fres = 0.04 + 0.96 * pow(1.0 - ndv, 4.0);
      float spec = pow(max(dot(reflect(rd, n), LIGHT), 0.0), 50.0);
      float edge = 0.35 * fres;
      float milk = 0.04 + 0.07 * max(-rib, 0.0);
      float dark = 0.05 * max(rib, 0.0);
      col = col * (1.0 - edge - milk - dark) + vec3(0.45, 0.47, 0.5) * edge + vec3(0.95) * milk + vec3(0.3) * dark + vec3(spec * 0.5);
      alpha = max(alpha, clamp(edge + milk + dark + spec * 0.5, 0.0, 1.0));
    }
  }
  // the front wall: milky plastic with ribs, a sheen at grazing angles
  if (front) {
    float th = atan(pFront.z, pFront.x);
    // ribs around the cup (rings), more of them near the rim
    float yy = pFront.y / HC;
    float rib = sin(yy * 2.0 * PI * 7.0) * smoothstep(0.08, 0.2, yy) + 0.8 * sin(yy * 2.0 * PI * 22.0) * smoothstep(0.86, 0.9, yy);
    vec3 n = normalize(vec3(cos(th), K + rib * 0.7, sin(th)));
    float ndv = abs(dot(n, -rd));
    float fres = 0.04 + 0.96 * pow(1.0 - ndv, 4.0);
    float spec = pow(max(dot(reflect(rd, n), LIGHT), 0.0), 50.0);
    // clear plastic over a light canvas: grey where it is seen at a
    // grazing angle (the outline), the ribs catch the light: brighter on
    // their upper flank, darker below
    float edge = 0.5 * fres;
    float milk = 0.05 + 0.1 * max(rib, 0.0);
    float dark = 0.06 * max(-rib, 0.0);
    col = col * (1.0 - edge - milk - dark) + vec3(0.42, 0.44, 0.47) * edge + vec3(0.97) * milk + vec3(0.3) * dark + vec3(spec * 0.8);
    alpha = max(alpha, clamp(edge + milk + dark + spec, 0.0, 1.0));
  }
  // the rim
  {
    float dr = abs(length(qOpen.xz) - RT);
    float w = 0.012;
    if (dr < w * 2.0) {
      float a = (1.0 - smoothstep(w * 0.4, w * 1.2, dr)) * 0.85;
      bool frontRim = qOpen.z > 0.0;
      if (frontRim || tOpen < tScene) {
        // (a rolled edge: grey, lit on the side towards the light)
        float lit = 0.5 + 0.5 * dot(normalize(qOpen.xz), normalize(vec2(-0.5, -0.6)));
        col = col * (1.0 - a) + mix(vec3(0.55, 0.57, 0.6), vec3(1.0), lit) * a;
        alpha = max(alpha, a);
      }
    }
  }
  // the cup stands on the canvas: its shadow falls there (light from the
  // upper left, as on the canvas)
  if (alpha < 0.5) {
    float tg = -ro.y / rd.y;
    vec3 q = ro + rd * tg;
    if (tg > 0.0 && tg < tScene) {
      float sd = length(q.xz - vec2(0.18, 0.22)) - RB * 1.02;
      float sh = (1.0 - smoothstep(-0.25, 0.35, sd)) * 0.22;
      col = col * (1.0 - sh);
      alpha = alpha + sh * (1.0 - alpha);
    }
  }
  o = vec4(col, alpha);
}`;

export class CupView {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private top: WebGLTexture;
  private wall: WebGLTexture;
  private topSize = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false })!;
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'cup shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'cup program');
    this.prog = p;
    for (const n of ['uRes', 'uDpr', 'uCenter', 'uScale', 'uLevel', 'uTime', 'uTop', 'uWall', 'uTopSize', 'uCol', 'uStream', 'uStreamM', 'uStreamM2', 'uStreamSplit', 'uStreamPath', 'uLanded', 'uA'])
      this.uni[n] = gl.getUniformLocation(p, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.top = tex();
    this.wall = tex();
  }

  /** labels: top (size x size) and wall (WALL_W x WALL_H, row by row from the floor up) */
  setLabels(top: Uint8Array, size: number, wall: Uint8Array) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.top);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, size, size, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, top);
    gl.bindTexture(gl.TEXTURE_2D, this.wall);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, WALL_W, WALL_H, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, wall);
    this.topSize = size;
  }

  render(o: { cx: number; cy: number; scale: number; dpr: number; level: number; time: number; angle: number; colors: number[][]; stream: { path: number[]; m: number; m2: number; split: number; landed: number } | null }) {
    const gl = this.gl;
    const c = this.canvas;
    gl.viewport(0, 0, c.width, c.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // only the pixels around the cup (and the stream above it) are drawn
    const k = o.dpr;
    const x0 = Math.max(0, Math.floor((o.cx - o.scale * CUP.RT * 1.3) * k));
    const x1 = Math.min(c.width, Math.ceil((o.cx + o.scale * CUP.RT * 1.6) * k));
    const yTop = o.stream ? 0 : o.cy - o.scale * (Math.max(toScreen(0, CUP.HC, -CUP.RT, o.angle).sy, toScreen(0, 0, -CUP.RT, o.angle).sy) + 0.1);
    const yBot = o.cy - o.scale * (Math.min(toScreen(0, 0, CUP.RB + 0.6, o.angle).sy, toScreen(0, CUP.HC, CUP.RT, o.angle).sy) - 0.1);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, Math.max(0, Math.floor(c.height - yBot * k)), x1 - x0, Math.ceil((yBot - yTop) * k));
    gl.useProgram(this.prog);
    const u = this.uni;
    gl.uniform2f(u.uRes, c.width, c.height);
    gl.uniform1f(u.uDpr, o.dpr);
    gl.uniform2f(u.uCenter, o.cx, o.cy);
    gl.uniform1f(u.uScale, o.scale);
    gl.uniform1f(u.uLevel, o.level);
    gl.uniform1f(u.uTime, o.time);
    gl.uniform1f(u.uA, o.angle);
    gl.uniform2i(u.uTopSize, this.topSize, this.topSize);
    const cols = Array.from({ length: 8 }, (_, i) => o.colors[i] ?? [0, 0, 0]).flat();
    gl.uniform3fv(u.uCol, cols);
    const s = o.stream;
    gl.uniform4f(u.uStream, s?.path[0] ?? 0, s?.path[1] ?? 0, s?.path[2] ?? 0, s ? 1 : 0);
    gl.uniform1f(u.uStreamM, s?.m ?? 0);
    gl.uniform1f(u.uStreamM2, s?.m2 ?? 0);
    gl.uniform1f(u.uStreamSplit, s?.split ?? 99);
    gl.uniform3fv(u.uStreamPath, s?.path ?? new Array(48).fill(0));
    gl.uniform1f(u.uLanded, s?.landed ?? 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.top);
    gl.uniform1i(u.uTop, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.wall);
    gl.uniform1i(u.uWall, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/** screen offset from the middle of the cup (units, y up) -> point on the plane at height y */
export function screenToPlane(sx: number, sy: number, y: number, A = CUP.A) {
  const { HC } = CUP;
  const rd = [0, -Math.sin(A), -Math.cos(A)];
  const up = [0, Math.cos(A), -Math.sin(A)];
  const ro = [sx, HC * 0.5 + up[1] * sy - rd[1] * 10, up[2] * sy - rd[2] * 10];
  const t = (y - ro[1]) / rd[1];
  return { x: ro[0] + rd[0] * t, z: ro[2] + rd[2] * t };
}

/** a point of the cup (units) -> screen offset from the middle of the cup (units, y up) */
export function toScreen(x: number, y: number, z: number, A = CUP.A) {
  const { HC } = CUP;
  return { sx: x, sy: (y - HC * 0.5) * Math.cos(A) - z * Math.sin(A) };
}
