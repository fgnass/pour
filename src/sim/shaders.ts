// Shaders of the open cup pour simulation.
//
// Units: the canvas is a rectangle in "domain units". Its short side is 1.
// Positions (sources, cup, particles) are in domain units. Textures are
// sampled with uv in [0, 1]. uDom converts between the two (p = uv * uDom).

const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
float disc(vec2 p, vec2 c, float r) { return 1.0 - smoothstep(0.7 * r, r, length(p - c)); }
const float DISC_AREA = 3.14159265 * 0.7225;
`;

const FORCES = `
uniform vec2 uTilt;
uniform vec4 uPush[2];     // x, y, radius, strength
uniform vec2 uPushVel[2];
uniform vec4 uSwirl;       // x, y, radius, omega
vec2 imposedVel(vec2 p) {
  vec2 v = vec2(0.0);
  for (int i = 0; i < 2; i++) v += uPushVel[i] * uPush[i].w * disc(p, uPush[i].xy, uPush[i].z);
  vec2 d = p - uSwirl.xy;
  v += uSwirl.w * vec2(-d.y, d.x) * disc(p, uSwirl.xy, uSwirl.z);
  return v;
}
`;

const H_AT = `
uniform sampler2D uH;
uniform ivec2 uN;
float hAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= uN.x || c.y >= uN.y) return 0.0;
  return texelFetch(uH, c, 0).r;
}
`;

export const NUM_SRC = 3;

// Thin film flow: q = A h^3 (tilt - K grad h), with a yield stress.
export const FLUX_FS = COMMON + FORCES + H_AT + `
uniform float uDt, uDx, uA, uK, uTau, uCap;
uniform vec4 uSrc[${NUM_SRC}];      // x, y, radius, volume rate
out vec4 o;

// flux from cell a to cell b across their shared face.
// g: tilt along the face normal, ft: tangential force (for the yield test)
float flux(float ha, float hb, float g, float ft, float vp) {
  float F = g - uK * (hb - ha) / uDx;
  float hf = min(F > 0.0 ? ha : hb, uCap);
  float y = max(0.0, 1.0 - uTau / (hf * length(vec2(F, ft)) + 1e-6));
  float q = uA * hf * hf * hf * F * y;
  q += (vp > 0.0 ? ha : hb) * vp;
  return q;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 p = (vec2(c) + 0.5) * uDx;
  float h = hAt(c);
  float hl = hAt(c + ivec2(-1, 0)), hr = hAt(c + ivec2(1, 0));
  float hd = hAt(c + ivec2(0, -1)), hu = hAt(c + ivec2(0, 1));
  float hlu = hAt(c + ivec2(-1, 1)), hru = hAt(c + ivec2(1, 1));
  float hld = hAt(c + ivec2(-1, -1)), hrd = hAt(c + ivec2(1, -1));
  float k4 = uK / (4.0 * uDx);
  float tR = uTilt.y - k4 * (hu + hru - hd - hrd);
  float tL = uTilt.y - k4 * (hlu + hu - hld - hd);
  float tU = uTilt.x - k4 * (hr + hru - hl - hlu);
  float tD = uTilt.x - k4 * (hr + hrd - hl - hld);
  vec2 ex = vec2(0.5 * uDx, 0.0), ey = vec2(0.0, 0.5 * uDx);
  float qr = flux(h, hr, uTilt.x, tR, imposedVel(p + ex).x);
  float ql = flux(hl, h, uTilt.x, tL, imposedVel(p - ex).x);
  float qu = flux(h, hu, uTilt.y, tU, imposedVel(p + ey).y);
  float qd = flux(hd, h, uTilt.y, tD, imposedVel(p - ey).y);
  float s = 0.0;
  for (int i = 0; i < ${NUM_SRC}; i++) {
    float r = uSrc[i].z;
    if (r > 0.0) s += uSrc[i].w * disc(p, uSrc[i].xy, r) / (DISC_AREA * r * r);
  }
  h += -uDt / uDx * (qr - ql + qu - qd) + uDt * s;
  if (isnan(h) || isinf(h)) h = 0.0;
  o = vec4(clamp(h, 0.0, 50.0), 0.0, 0.0, 1.0);
}`;

// Mean film velocity (xy) and thickness (z, for linear sampling).
export const VEL_FS = COMMON + FORCES + H_AT + `
uniform float uDx, uA, uK, uTau, uCap;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 p = (vec2(c) + 0.5) * uDx;
  float h = hAt(c);
  float hl = hAt(c + ivec2(-1, 0)), hr = hAt(c + ivec2(1, 0));
  float hd = hAt(c + ivec2(0, -1)), hu = hAt(c + ivec2(0, 1));
  // extend the velocity a little into dry cells so colour reaches the front
  float hm = max(h, 0.7 * max(max(hl, hr), max(hd, hu)));
  vec2 F = uTilt - uK * vec2(hr - hl, hu - hd) / (2.0 * uDx);
  float hc = min(hm, uCap);
  float y = max(0.0, 1.0 - uTau / (hc * length(F) + 1e-6));
  vec2 u = uA * hc * hc * F * y + imposedVel(p) * step(0.02, hm);
  float m = length(u);
  if (m > 1.5) u *= 1.5 / m;
  o = vec4(u, h, 1.0);
}`;

const HASH = `
uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash3(vec2 p, float s) {
  return vec3(pcg3(uvec3(uvec2(ivec2(p) + 4096), uint(s)))) * (1.0 / 4294967295.0);
}
`;

// Pigment advection. S: surface colours, U: submerged colours,
// G: gold (x surface, y submerged).
export const PIG_FS = COMMON + HASH + `
uniform sampler2D uS, uU, uG, uV, uMask;
uniform vec2 uSize, uDom;
uniform float uDt, uSurfK, uSubK, uRise, uSharpen, uTime;
uniform vec4 uTorch; // x, y, radius, strength: heat makes paint rise faster
uniform vec4 uSrc[${NUM_SRC}];
uniform vec4 uSrcS[${NUM_SRC}];
uniform vec4 uSrcU[${NUM_SRC}];
uniform vec2 uSrcG[${NUM_SRC}];
uniform float uSrcStreak[${NUM_SRC}];
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oU;
layout(location = 2) out vec4 oG;

// Catmull-Rom (9 bilinear taps), clamped to the 4 nearest texels
vec4 cr(sampler2D t, vec2 uv) {
  vec2 sp = uv * uSize - 0.5;
  vec2 fl = floor(sp);
  vec2 f = sp - fl;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 tc = fl + 0.5;
  vec2 t0 = (tc - 1.0) / uSize, t3 = (tc + 2.0) / uSize, t12 = (tc + w2 / w12) / uSize;
  vec4 r =
    (texture(t, vec2(t0.x, t0.y)) * w0.x + texture(t, vec2(t12.x, t0.y)) * w12.x + texture(t, vec2(t3.x, t0.y)) * w3.x) * w0.y +
    (texture(t, vec2(t0.x, t12.y)) * w0.x + texture(t, vec2(t12.x, t12.y)) * w12.x + texture(t, vec2(t3.x, t12.y)) * w3.x) * w12.y +
    (texture(t, vec2(t0.x, t3.y)) * w0.x + texture(t, vec2(t12.x, t3.y)) * w12.x + texture(t, vec2(t3.x, t3.y)) * w3.x) * w3.y;
  ivec2 mx = ivec2(uSize) - 1;
  ivec2 i = clamp(ivec2(fl), ivec2(0), mx), j = clamp(ivec2(fl) + 1, ivec2(0), mx);
  vec4 a = texelFetch(t, i, 0), b = texelFetch(t, ivec2(j.x, i.y), 0);
  vec4 c = texelFetch(t, ivec2(i.x, j.y), 0), d = texelFetch(t, j, 0);
  return clamp(r, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
}

// counteracts the numerical diffusion of repeated resampling
vec4 sharpen(sampler2D t, vec2 uv, vec4 v) {
  vec2 e = 1.0 / uSize;
  vec4 a = texture(t, uv + vec2(e.x, 0.0)), b = texture(t, uv - vec2(e.x, 0.0));
  vec4 c = texture(t, uv + vec2(0.0, e.y)), d = texture(t, uv - vec2(0.0, e.y));
  vec4 lo = min(min(a, b), min(c, d)), hi = max(max(a, b), max(c, d));
  return clamp(v + uSharpen * (v - 0.25 * (a + b + c + d)), min(lo, v), max(hi, v));
}

void main() {
  vec2 x = vUv;
  vec2 p = x * uDom;
  vec2 v1 = texture(uV, x).xy / uDom;
  vec2 v2 = texture(uV, x - 0.5 * uDt * uSurfK * v1).xy / uDom;
  // torch: the hot surface flows away from the flame (Marangoni flow)
  vec2 td = p - uTorch.xy;
  float tr = max(uTorch.z, 1e-4);
  vec2 mar = 0.02 * uTorch.w * td / tr * exp(-dot(td, td) / (tr * tr) * 1.5);
  vec2 xs = x - uDt * (uSurfK * v2 + mar / uDom);
  vec2 xu = x - uDt * uSubK * v2;

  vec4 S = sharpen(uS, xs, cr(uS, xs));
  vec4 U = sharpen(uU, xu, cr(uU, xu));
  vec4 G = vec4(cr(uG, xs).x, cr(uG, xu).y, 0.0, 0.0);

  // new paint from sources (mass-weighted mixing)
  float h = texture(uV, x).z;
  for (int i = 0; i < ${NUM_SRC}; i++) {
    float r = uSrc[i].z;
    if (r <= 0.0) continue;
    float dh = uSrc[i].w * disc(p, uSrc[i].xy, r) / (DISC_AREA * r * r) * uDt;
    float fr = dh / (h + dh + 1e-4);
    // paint escapes under the rim in fingers: radial streaks of surface colour
    vec2 d = p - uSrc[i].xy;
    float a = atan(d.y, d.x) / 6.2831853 * 46.0 + uTime * 0.7;
    float n = mix(hash3(vec2(floor(a), 0.0), 11.0).x, hash3(vec2(floor(a) + 1.0, 0.0), 11.0).x, smoothstep(0.0, 1.0, fract(a)));
    float st = mix(1.0, smoothstep(0.35, 0.75, n) * 1.6, uSrcStreak[i]);
    vec4 ss = uSrcS[i] * st;
    vec2 gs = vec2(uSrcG[i].x * st, uSrcG[i].y);
    vec4 su = uSrcU[i] + uSrcS[i] - ss;
    gs.y += uSrcG[i].x - gs.x;
    S = mix(S, ss, fr);
    U = mix(U, max(su, 0.0), fr);
    G.xy = mix(G.xy, max(gs, 0.0), fr);
    h += dh;
  }

  // submerged paint rises back to the surface inside cells
  float m = texture(uMask, x).r;
  float heat = uTorch.w * exp(-dot(td, td) / (tr * tr) * 2.0);
  float t = 1.0 - exp(-uRise * (1.0 + heat) * m * uDt);
  S += t * U; U -= t * U;
  G.x += t * G.y; G.y -= t * G.y;

  oS = clamp(S, 0.0, 1.0); oU = clamp(U, 0.0, 1.0); oG = clamp(G, 0.0, 1.0);
}`;

// Moves the cell particles (x, y, radius, time of death) with the paint.
export const PART_FS = COMMON + `
uniform sampler2D uP, uV;
uniform vec2 uDom;
uniform float uDt, uK, uTime;
out vec4 o;
void main() {
  vec4 p = texelFetch(uP, ivec2(gl_FragCoord.xy), 0);
  if (p.z > 0.0) {
    vec2 v1 = texture(uV, p.xy / uDom).xy;
    vec2 v2 = texture(uV, (p.xy + 0.5 * uDt * uK * v1) / uDom).xy;
    p.xy += uDt * uK * v2;
    if (p.x < 0.0 || p.y < 0.0 || p.x > uDom.x || p.y > uDom.y || uTime > p.w) p.z = 0.0;
  }
  o = p;
}`;

// Splats the cells into a mask: where submerged paint rises.
export const MASK_VS = `#version 300 es
uniform sampler2D uP;
uniform int uPW;
uniform vec2 uDom;
uniform float uPxPerUnit, uTime;
out float vS;
out float vSize;
void main() {
  vec4 p = texelFetch(uP, ivec2(gl_VertexID % uPW, gl_VertexID / uPW), 0);
  vSize = 2.0 * p.z * uPxPerUnit + 2.0;
  vS = smoothstep(0.0, 0.4, p.w - uTime);
  if (p.z <= 0.0 || vS <= 0.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; return; }
  gl_Position = vec4(p.xy / uDom * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = vSize;
}`;
export const MASK_FS = `#version 300 es
precision highp float;
in float vS;
in float vSize;
out vec4 o;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0) * vSize / max(vSize - 2.0, 1.0);
  o = vec4((1.0 - smoothstep(0.6, 1.0, d)) * vS);
}`;

export const RENDER_FS = COMMON + HASH + `
uniform sampler2D uV, uS, uU, uG;
uniform vec2 uDom, uPSize;
uniform float uDx;       // thickness cell size (domain units)
uniform vec3 uCol[6];
uniform vec3 uSheen[6];  // pearl shimmer colour per paint
uniform float uPearl[6]; // 1 for pearl paints
uniform float uMetal[6]; // 1 for metallic paints
uniform vec4 uTorch;     // x, y, radius, active
uniform vec2 uView;      // tilt of the board relative to the viewer
uniform float uPx;       // domain units per screen pixel
uniform vec4 uCup;       // x, y, radius, alpha
uniform float uCupFill;
uniform vec4 uRing[10];  // colour rings in the cup: x, y, radius, seed (oldest first)
uniform vec3 uRingCol[10];
uniform int uRingN;
uniform vec4 uStream;    // x, y, radius, active
uniform vec3 uStreamCol;
out vec4 o;

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }

vec3 paintMix(vec4 c, float gold) {
  // tinting strength: a little pigment colours a lot of white
  const float TS = 4.5;
  c = c * TS / (1.0 + c * (TS - 1.0));
  gold = gold * TS / (1.0 + gold * (TS - 1.0));
  float sum = c.x + c.y + c.z + c.w + gold;
  if (sum > 1.0) { c /= sum; gold /= sum; sum = 1.0; }
  float wh = 1.0 - sum;
  vec3 L[6];
  for (int i = 0; i < 6; i++) L[i] = max(uCol[i], vec3(0.02));
  vec3 lg = wh * log(L[0]) + c.x * log(L[1]) + c.y * log(L[2]) + gold * log(L[3]) + c.z * log(L[4]) + c.w * log(L[5]);
  vec3 lin = wh * L[0] + c.x * L[1] + c.y * L[2] + gold * L[3] + c.z * L[4] + c.w * L[5];
  return exp(lg) * 0.7 + lin * 0.3;
}

float hS(vec2 uv) { return texture(uV, uv).z; }
float pigSum(vec2 uv) { return dot(texture(uS, uv), vec4(1.0)) + texture(uG, uv).x; }

// soft-box reflection
float env(vec3 r) {
  if (r.z <= 0.0) return 0.0;
  vec2 q = r.xy / r.z;
  vec2 b = abs(q - vec2(-0.32, 0.42)) - vec2(0.22, 0.1);
  float box = 1.0 - smoothstep(0.0, 0.06, max(b.x, b.y));
  vec2 b2 = abs(q - vec2(0.45, -0.1)) - vec2(0.05, 0.3);
  float box2 = 1.0 - smoothstep(0.0, 0.05, max(b2.x, b2.y));
  return box + 0.5 * box2;
}

void main() {
  vec2 uv = vUv;
  vec2 p = uv * uDom;
  vec2 e = uDx / uDom;
  float h = hS(uv);
  vec2 grad = vec2(hS(uv + vec2(e.x, 0.0)) - hS(uv - vec2(e.x, 0.0)),
                   hS(uv + vec2(0.0, e.y)) - hS(uv - vec2(0.0, e.y))) / (2.0 * uDx);
  vec2 pe = 1.0 / uPSize;
  // pigment gradient per pigment texel
  vec2 pgrad = 0.5 * vec2(pigSum(uv + vec2(pe.x, 0.0)) - pigSum(uv - vec2(pe.x, 0.0)),
                          pigSum(uv + vec2(0.0, pe.y)) - pigSum(uv - vec2(0.0, pe.y)));

  vec4 S = texture(uS, uv), U = texture(uU, uv), G = texture(uG, uv);
  float vis = mix(0.12, 0.035, smoothstep(0.3, 2.0, h));
  vec4 c = S + vis * U;
  float gold = G.x + vis * G.y;
  vec3 base = toLin(paintMix(c, gold));

  // cell rims: pigment edges are slightly darker
  float edge = clamp(length(pgrad) * 1.6, 0.0, 1.0);
  base *= 1.0 - 0.2 * edge * smoothstep(0.1, 0.6, dot(c, vec4(1.0)));

  float cover = smoothstep(0.03, 0.22, h);
  vec3 n = normalize(vec3(-(grad * 0.0035 + pgrad * 0.25 * cover), 1.0));
  n = normalize(n + vec3(uView * 0.22, 0.0));

  vec3 P = vec3((p - 0.5 * uDom) / max(uDom.x, uDom.y), 0.0);
  vec3 cam = vec3(0.0, -0.15, 1.5);
  vec3 vdir = normalize(cam - P);
  vec3 r = reflect(-vdir, n);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, vdir), 0.0), 5.0);

  // iridescent / metallic flakes
  vec2 fc = floor(uv * uPSize * 1.3);
  vec3 hs = hash3(fc, 3.0);
  vec3 fn = normalize(n + (hs - 0.5) * 0.9);
  vec3 L = normalize(vec3(-0.3, 0.42, 1.0));
  float glint = pow(max(dot(reflect(-vdir, fn), L), 0.0), 60.0);
  // finishes of the paints in this mix (index: 0 base, 1, 2, 3 = gold channel, 4, 5)
  float W[6] = float[6](0.0, c.x, c.y, gold, c.z, c.w);
  float irid = 0.0, metal = 0.0;
  vec3 sheen = vec3(0.0), mtint = vec3(0.0);
  for (int i = 1; i < 6; i++) {
    irid += W[i] * uPearl[i];
    sheen += W[i] * uPearl[i] * uSheen[i];
    metal += W[i] * uMetal[i];
    mtint += W[i] * uMetal[i] * uCol[i] / max(max(uCol[i].r, uCol[i].g), max(uCol[i].b, 0.05));
  }
  sheen /= irid + 1e-4;
  mtint /= metal + 1e-4;
  base += irid * 0.9 * glint * sheen + metal * 2.5 * glint * mtint;
  float shift = dot(n.xy, vec2(0.7, 0.7)) * 4.0;
  base += 0.06 * irid * sheen * (0.5 + 0.5 * sin(shift * 6.0 + p.x * 20.0));

  // diffuse + gloss
  float diff = 0.82 + 0.18 * max(dot(n, L), 0.0) / L.z;
  vec3 paint = base * diff + fres * env(r) * 1.6 + 0.04 * env(r);

  // bare primed canvas
  vec3 hc = hash3(floor(p * 1400.0), 1.0);
  vec3 cv = toLin(vec3(0.925, 0.92, 0.9)) * (0.97 + 0.03 * hc.x);

  vec3 col = mix(cv, paint, cover);

  // cup
  if (uCup.w > 0.0) {
    vec2 d2 = p - uCup.xy;
    float d = length(d2), R = uCup.z;
    float sh = 1.0 - smoothstep(R * 0.95, R * 1.35, length(d2 - vec2(0.012, -0.018)));
    col *= 1.0 - 0.25 * sh * step(R, d) * uCup.w;
    float inside = 1.0 - smoothstep(R * 0.93, R * 0.95, d);
    // contents: newer paint pushes the older paint outwards into rings
    vec3 contents = toLin(uRingN > 0 ? uRingCol[0] : vec3(0.93));
    for (int i = 1; i < 10; i++) {
      if (i >= uRingN) break;
      vec2 q = p - uRing[i].xy;
      float a = atan(q.y, q.x), sd = uRing[i].w;
      float rr = uRing[i].z * (1.0 + 0.07 * sin(3.0 * a + sd) + 0.04 * sin(5.0 * a + 2.3 * sd));
      float e = length(q) - rr;
      float m = 1.0 - smoothstep(-uPx, uPx, e);
      contents = mix(contents, toLin(uRingCol[i]), m);
      contents *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, uPx * 2.5, abs(e)));
    }
    contents *= 0.85 + 0.15 * (1.0 - d / R);
    col = mix(col, contents, inside * uCupFill * 0.9 * uCup.w);
    col = mix(col, col * 0.92 + 0.06, inside * uCup.w * 0.6);
    float px = uPx;
    float rim = 1.0 - smoothstep(px * 0.6, px * 2.2, abs(d - R));
    float rim2 = 1.0 - smoothstep(px * 0.4, px * 1.4, abs(d - R * 0.93));
    float spec = 0.5 + 0.5 * dot(normalize(d2 + 1e-6), normalize(vec2(-0.6, 0.8)));
    col += (rim * (0.35 + 0.65 * spec) + rim2 * 0.25) * uCup.w;
  }
  // stream of paint falling from above
  if (uStream.w > 0.0) {
    float d = length(p - uStream.xy);
    float s = 1.0 - smoothstep(uStream.z * 0.7, uStream.z, d);
    vec3 sc = toLin(uStreamCol) * (0.8 + 0.6 * (1.0 - d / uStream.z));
    col = mix(col, sc, s * uStream.w);
    float ring = 1.0 - smoothstep(0.0, uPx * 1.5, abs(d - uStream.z * 2.4));
    col += ring * 0.08 * uStream.w;
  }

  // torch: a warm glow where the flame points
  if (uTorch.w > 0.0) {
    float d = length(p - uTorch.xy) / uTorch.z;
    col += vec3(1.0, 0.55, 0.2) * 0.22 * uTorch.w * exp(-d * d * 2.5);
    float ring = 1.0 - smoothstep(0.0, uPx * 1.5, abs(d - 1.0) * uTorch.z);
    col += ring * 0.12 * uTorch.w * vec3(1.0, 0.7, 0.4);
  }

  o = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;

export const CLEAR_FS = `#version 300 es
precision highp float;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); }`;
