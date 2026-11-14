// Shaders of the open cup pour simulation.
//
// Units: the canvas is a rectangle in "domain units". Its short side is 1.
// Positions (sources, cup, particles) are in domain units. Textures are
// sampled with uv in [0, 1]. uDom converts between the two (p = uv * uDom).

// thickness of the film that pushed paint leaves on the canvas
const PUSH_FILM = '0.2';

const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
float disc(vec2 p, vec2 c, float r) { return 1.0 - smoothstep(0.7 * r, r, length(p - c)); }
const float DISC_AREA = 3.14159265 * 0.7225;
// a disc moved evenly from a to b during the step: a moving pour stream lays
// down a line, not dots. Samples sit at the middles of equal parts, so the
// segments of two steps join without a double dose. Integrates to 1.
float swept(vec2 p, vec2 a, vec2 b, float r) {
  // samples at most r/4 apart (up to 24), so fast strokes keep smooth edges
  int n = int(clamp(ceil(4.0 * length(b - a) / r), 1.0, 24.0));
  float s = 0.0;
  for (int k = 0; k < 24; k++) {
    if (k >= n) break;
    s += disc(p, mix(a, b, (float(k) + 0.5) / float(n)), r);
  }
  return s / (float(n) * DISC_AREA * r * r);
}
`;

const FORCES = `
uniform vec2 uTilt;
uniform vec4 uPush[2];     // x, y, radius, strength
uniform vec2 uPushA[2];    // where the pusher was one step ago (it sweeps from there)
uniform vec2 uPushVel[2];
uniform vec4 uSwirl;       // x, y, radius, omega
uniform vec2 uWall;        // size of the canvas (domain units)
uniform vec3 uFlowBack;    // finger: flow round it, flow together behind it, drag along
// 1 inside the band swept by a disc of radius r moving from a to b
float band(vec2 p, vec2 a, vec2 b, float r) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
  return 1.0 - smoothstep(0.7 * r, r, length(p - a - ab * t));
}
// the imposed velocity while the pushers move over the part t0..t1 of
// their sweep this step
vec2 imposedVelPart(vec2 p, float t0, float t1) {
  vec2 v = vec2(0.0);
  for (int i = 0; i < 2; i++) {
    float w = uPush[i].w;
    vec2 A = mix(uPushA[i], uPush[i].xy, t0), B = mix(uPushA[i], uPush[i].xy, t1);
    float m = band(p, A, B, uPush[i].z);
    if (w < 0.0) {
      // a wall (the cup): it pushes only the paint before it, in a ring
      // around its rim. What runs out inside stays where it lands, behind
      // the moving cup: the wall must not shove it along to its front.
      // The ring sweeps from where the cup was a step ago. Taken at a few
      // positions only, a fast cup pushes one crescent per position; so the
      // sweep is exact: a point is pushed if the front of the rim passed it
      // during the step. The steps join without gap or overlap.
      w = -w;
      vec2 a = A, b = B;
      float R = uPush[i].z;
      vec2 dir = uPushVel[i] / max(length(uPushVel[i]), 1e-6);
      // the ring at the end position
      vec2 d = p - b;
      float l = length(d);
      float ring = smoothstep(0.62, 0.78, l / R) * smoothstep(-0.1, 0.4, dot(d, dir) / max(l, 1e-6)) * (1.0 - smoothstep(0.7 * R, R, l));
      // the band the front of the rim swept over during the step: a point
      // at distance lat from the path was crossed by the middle of the
      // ring (radius rm) when the cup was a distance back behind it, at that angle
      vec2 ab = b - a;
      float L = length(ab);
      if (L > 1e-6) {
        vec2 e = ab / L, q = p - a;
        float lat = abs(dot(q, vec2(-e.y, e.x))), rm = 0.7 * R;
        float back = sqrt(max(rm * rm - lat * lat, 0.0));
        float at = dot(q, e) - back;
        if (at >= 0.0 && at <= L) ring = max(ring, smoothstep(-0.1, 0.4, back / rm) * (1.0 - smoothstep(0.7 * R, R, lat)));
      }
      v += uPushVel[i] * w * ring;
    } else if (w > 0.0) {
      // a finger: the paint cannot go through it, it slides off around its
      // rim to the sides and stays there, beside the groove. Each point is
      // pushed away from the finger only as fast as the finger comes
      // towards it. (Pushing all the paint along with the finger would
      // heap it up in front without limit.)
      vec2 a = A, ab = B - a;
      float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
      vec2 dir = uPushVel[i] / max(length(uPushVel[i]), 1e-6);
      // (a little forward, so nothing stays under the finger; and away from
      // the axis to the side the point is on, so no paint rides ahead of it
      // on the axis and falls off in blobs along the groove)
      vec2 q = p - a - ab * t, side = vec2(-dir.y, dir.x);
      vec2 n = normalize(q + (dir * 0.25 + side * sign(dot(q, side)) * 0.15) * uPush[i].z);
      vec2 vp = n * max(0.0, dot(uPushVel[i], n)) * m;
      // The paint sticks to the finger: what lies under it and beside it is
      // dragged along in part. So a finger that leaves the paint pulls a
      // tongue of it out over the edge; it does not only shove it aside.
      float l0 = length(q);
      float drag = uFlowBack.z * (1.0 - smoothstep(1.0 * uPush[i].z, 2.5 * uPush[i].z, l0));
      v += (vp + drag * (uPushVel[i] - vp)) * w;
      // Ahead and at the sides the paint gives way as round a moving
      // cylinder: it runs back past the finger ...
      vec2 U = uPushVel[i];
      float R = uPush[i].z, l = max(length(q), 1e-6), sp = length(U);
      vec2 e = q / l;
      float k = (R * R) / (l * l) * (1.0 - smoothstep(2.0 * R, 4.0 * R, l)) * smoothstep(0.9 * R, 1.3 * R, l);
      v += uFlowBack.x * w * k * smoothstep(-0.5, 0.2, dot(e, dir)) * (2.0 * dot(U, e) * e - U);
      // ... and behind it only the walls of the groove slump back in: the
      // groove stays open for a moment and fills slowly from its edges. (A
      // wide pull from both sides sucks the paint together like dough.)
      vec2 r = p - B;
      float back = -dot(r, dir), lat = dot(r, side);
      float wake = smoothstep(1.0 * R, 3.0 * R, back) * (1.0 - smoothstep(4.0 * R, 12.0 * R, back))
                 * smoothstep(0.3 * R, 0.8 * R, abs(lat)) * (1.0 - smoothstep(1.1 * R, 1.8 * R, abs(lat)));
      v -= side * sign(lat) * uFlowBack.y * w * sp * wake;
    }
  }
  vec2 d = p - uSwirl.xy;
  v += uSwirl.w * vec2(-d.y, d.x) * disc(p, uSwirl.xy, uSwirl.z);
  // At the edge of the canvas no paint comes in from outside: a push there
  // must not pull paint away from the edge (it would stretch the colours at
  // the edge into streaks). Pushing paint over the edge is fine.
  vec2 lo = smoothstep(0.0, 0.08, p), hi = smoothstep(0.0, 0.08, uWall - p);
  v *= mix(hi, lo, step(0.0, v));
  return v;
}
vec2 imposedVel(vec2 p) { return imposedVelPart(p, 0.0, 1.0); }
// How far the pushers move the paint at p during a step of length dt
// (traced back from the end of the step). A fast cup moves more than the
// width of its rim per step: in one jump each step would print one crescent,
// so the step is cut into parts no longer than a quarter radius.
vec2 imposedShift(vec2 p, float dt) {
  float n = 1.0;
  bool near = false;
  for (int i = 0; i < 2; i++) {
    if (uPush[i].w == 0.0) continue;
    vec2 a = uPushA[i], ab = uPush[i].xy - a;
    float L = length(ab), R = uPush[i].z;
    float t = clamp(dot(p - a, ab) / max(L * L, 1e-12), 0.0, 1.0);
    if (length(p - a - ab * t) < 9.0 * R) near = true;
    n = max(n, ceil(L / (0.25 * R)));
  }
  if (uSwirl.w != 0.0 && length(p - uSwirl.xy) < uSwirl.z) near = true;
  if (!near) return vec2(0.0);
  int k = int(min(n, 8.0));
  vec2 q = p;
  for (int j = 7; j >= 0; j--) {
    if (j >= k) continue;
    q -= dt / float(k) * imposedVelPart(q, float(j) / float(k), float(j + 1) / float(k));
  }
  return p - q;
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

// The cup's paint as label maps (one paint index per cell, 7: none): the
// bottom (what runs out) and the top (what shows). labelAt() looks up the
// paint at a point of the cup (-1..1, turned with the cup): each label gets
// the weight of its cells among the 4 x 4 nearest; the strongest wins. A
// slow warp makes the borders wind instead of following the grid.
const CUP_LABELS = `
precision highp usampler2D;
uniform vec4 uCupMap;   // x, y, radius, turn
uniform ivec2 uCupSize;
vec3 labelAt(usampler2D t, vec2 p, vec2 centre) {
  vec2 d = p - centre;
  float c = cos(-uCupMap.w), s = sin(-uCupMap.w);
  vec2 uv = vec2(c * d.x - s * d.y, s * d.x + c * d.y) / uCupMap.z;
  vec2 g = (uv * 0.5 + 0.5) * vec2(uCupSize);
  g += vec2(sin(g.y * 0.19 + 1.7) + 0.5 * sin(g.y * 0.47 + g.x * 0.13),
            sin(g.x * 0.17 + 0.4) + 0.5 * sin(g.x * 0.41 - g.y * 0.11)) * 0.7;
  g -= 0.5;
  ivec2 b = ivec2(floor(g)) - 1;
  float w[8];
  for (int i = 0; i < 8; i++) w[i] = 0.0;
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) {
      ivec2 q = b + ivec2(i, j);
      vec2 e = vec2(q) - g;
      w[int(texelFetch(t, clamp(q, ivec2(0), uCupSize - 1), 0).r)] += exp(-dot(e, e) * 1.2);
    }
  // no paint (outside the floor) only where there is no paint near at all
  if (w[0] + w[1] + w[2] + w[3] + w[4] + w[5] + w[6] > 0.0) w[7] = 0.0;
  int bi = 0; float sb = w[0];
  for (int i = 1; i < 8; i++) if (w[i] > sb) { bi = i; sb = w[i]; }
  int ci = bi; float sc = 0.0;
  for (int i = 0; i < 8; i++) if (i != bi && w[i] > sc) { ci = i; sc = w[i]; }
  float e = (sb - sc) / (sb + sc + 1e-6);
  float a = ci == bi ? 1.0 : clamp(0.5 + e / (2.0 * max(fwidth(e), 1e-3)), 0.5, 1.0);
  return vec3(float(bi), float(ci), a);
}
`;

// Thin film flow: q = A mob(h) (tilt - K grad h), with a yield stress.
export const FLUX_FS = COMMON + FORCES + H_AT + `
uniform float uDt, uDx, uA, uK, uTau, uCap;
// Mobility: flux per unit of force. A plain film goes as h^3 (its mean
// speed as h^2), so a thin film all but stops: a blob could never cover the
// canvas. Here the mean speed grows in proportion to the thickness while the
// paint is thinner than uSlip, and levels off above it. The thickest paint
// (uCap) moves as fast as before, and no paint changes its thickness faster
// than before: the time step stays the same.
uniform float uSlip;
float mob(float h) { return uCap * (uCap + uSlip) * h * h / (h + uSlip); }
uniform vec4 uSrc[${NUM_SRC}];      // x, y, radius, volume rate
uniform vec2 uSrcA[${NUM_SRC}];     // start of the swept segment (= x, y when still)
out vec4 o;

// flux from cell a to cell b across their shared face.
// g: tilt along the face normal, ft: tangential force (for the yield test)
float flux(float ha, float hb, float g, float ft, float vp) {
  float F = g - uK * (hb - ha) / uDx;
  float hf = min(F > 0.0 ? ha : hb, uCap);
  float y = max(0.0, 1.0 - uTau / (hf * length(vec2(F, ft)) + 1e-6));
  float q = uA * mob(hf) * F * y;
  // Paint that is pushed (finger, cup) leaves a thin film behind: it wets
  // the canvas. So a push never bares the canvas, also not at the edge,
  // where no paint comes in from outside to fill up.
  q += max((vp > 0.0 ? ha : hb) - ${PUSH_FILM}, 0.0) * vp;
  return q;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 p = (vec2(c) + 0.5) * uDx;
  float h = hAt(c);
  float hl = hAt(c + ivec2(-1, 0)), hr = hAt(c + ivec2(1, 0));
  float hd = hAt(c + ivec2(0, -1)), hu = hAt(c + ivec2(0, 1));
  float s = 0.0;
  for (int i = 0; i < ${NUM_SRC}; i++) {
    float r = uSrc[i].z;
    if (r > 0.0) s += uSrc[i].w * swept(p, uSrcA[i], uSrc[i].xy, r);
  }
  // no paint here and around, none coming: every flux is 0 (most of an
  // empty canvas; this pass runs many times per frame)
  if (max(max(h, max(hl, hr)), max(hd, hu)) <= 0.0 && s <= 0.0) {
    o = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
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
  h += -uDt / uDx * (qr - ql + qu - qd) + uDt * s;
  if (isnan(h) || isinf(h)) h = 0.0;
  o = vec4(clamp(h, 0.0, 50.0), 0.0, 0.0, 1.0);
}`;

// Mean film velocity (xy) and thickness (z, for linear sampling).
export const VEL_FS = COMMON + FORCES + H_AT + `
uniform float uDx, uA, uK, uTau, uCap;
uniform float uSlip;
float mob(float h) { return uCap * (uCap + uSlip) * h * h / (h + uSlip); }
uniform sampler2D uH0; // thickness before this step
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
  // mean velocity = flux / thickness. The flux uses the capped thickness, so
  // divide by the real one: thick paint must not carry its colour faster
  // than the paint itself moves. At the edge of a puddle that is the thin
  // paint of this cell (not the thicker neighbour): there the paint moves
  // fastest, and its colour must keep up with it, or the edge runs ahead
  // without pigment (a white rim).
  // (the pushed paint fades in over a little thickness: a hard step here
  // would print the coarse grid into the colours)
  vec2 u = uA * mob(hc) / max(min(hm, max(h, 0.15 * hm)), 1e-3) * F * y + imposedVel(p) * smoothstep(0.01, 0.04, hm);
  float m = length(u);
  if (m > 1.5) u *= 1.5 / m;
  o = vec4(u, h, texelFetch(uH0, c, 0).r);
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

// finishes of the paints in a mix (index: 0 base, 1, 2, 3 = gold channel, 4, 5)
const FINISH = `
uniform vec3 uCol[6];
uniform vec3 uSheen[6];  // pearl shimmer colour per paint
uniform float uPearl[6]; // 1 for pearl paints
uniform float uMetal[6]; // 1 for metallic paints
// (no arrays here: some mobile drivers reject array constructors)
void fin1(float w, int i, inout float irid, inout vec3 sheen, inout float metal, inout vec3 mtint) {
  irid += w * uPearl[i];
  sheen += w * uPearl[i] * uSheen[i];
  metal += w * uMetal[i];
  mtint += w * uMetal[i] * uCol[i] / max(max(uCol[i].r, uCol[i].g), max(uCol[i].b, 0.05));
}
void finish(vec4 c, float gold, out float irid, out vec3 sheen, out float metal, out vec3 mtint) {
  irid = 0.0; metal = 0.0; sheen = vec3(0.0); mtint = vec3(0.0);
  fin1(c.x, 1, irid, sheen, metal, mtint);
  fin1(c.y, 2, irid, sheen, metal, mtint);
  fin1(gold, 3, irid, sheen, metal, mtint);
  fin1(c.z, 4, irid, sheen, metal, mtint);
  fin1(c.w, 5, irid, sheen, metal, mtint);
  sheen /= irid + 1e-4;
  mtint /= metal + 1e-4;
}
`;

// how far from a torch cell it pulls in paint when no paint lies below it
const TORCH_PULL = '0.05';
// scale of the cells' push potential in the mask (see MASK_FS)
const CELL_PHI = '1000.0';
// thickness of poured paint that hides about 63 % of the paint below it
const POUR_OPAQUE = '0.12';

// Torch: the hot surface flows away from the flame (Marangoni flow), in
// domain units / s. Shared by the surface pigments and the glitter.
const TORCH_FLOW = `
uniform vec4 uTorch; // x, y, radius, strength
vec2 marangoni(vec2 p) {
  vec2 td = p - uTorch.xy;
  float tr = max(uTorch.z, 1e-4);
  return 0.02 * uTorch.w * td / tr * exp(-dot(td, td) / (tr * tr) * 1.5);
}
`;

// Pigment advection. S: surface colours, U: submerged colours,
// G: gold (x surface, y submerged), z: 0..1, white paint lies below. Without it, "no pigment below" could mean white paint below
// or no paint below at all (or the same colour as on top).
export const PIG_FS = COMMON + FORCES + HASH + TORCH_FLOW + CUP_LABELS + `
uniform sampler2D uS, uU, uG, uV, uMask;
uniform vec2 uSize, uDom;
uniform float uDt, uSurfK, uSubK, uRise, uSharpen, uTime;
uniform vec4 uSrc[${NUM_SRC}];
uniform vec2 uSrcA[${NUM_SRC}];
uniform vec4 uSrcS[${NUM_SRC}];
uniform vec4 uSrcU[${NUM_SRC}];
uniform vec2 uSrcG[${NUM_SRC}];
uniform float uSrcStreak[${NUM_SRC}];
uniform float uSrcPlug[${NUM_SRC}];
// The cup (source 0, when uCupOn): the paint that seeps out at a place is
// the paint at the bottom of the cup there (its bottom map).
uniform float uCupOn;
uniform usampler2D uCupBot;
uniform vec4 uLabS[8];  // pigments of each paint (label)
uniform vec2 uLabG[8];
uniform float uCupSub;  // share that goes below the paint already there
uniform int uCupFallback; // the most common paint left at the bottom
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

// mean film velocity at uv without what the pushers impose (domain units / s)
vec2 filmVel(vec2 uv) {
  vec4 t = texture(uV, uv);
  return t.xy - imposedVel(uv * uDom) * smoothstep(0.01, 0.04, t.z);
}

void main() {
  vec2 x = vUv;
  vec2 p = x * uDom;
  // The flow moves the surface faster than the paint below it. What a
  // finger or the cup wall pushes moves both alike: pushing paint only
  // shifts and swirls the colours, it does not pull the layers apart. So the
  // pushed part is taken out of the velocity (at the same place it is read:
  // taken out at another place, a fast push would leave a print of the
  // cup's rim there, one crescent per step) and moved separately.
  vec2 v1 = filmVel(x) / uDom;
  vec2 v2 = filmVel(x - 0.5 * uDt * uSurfK * v1) / uDom;
  // opening cells push the surface paint out of their way (see MASK_FS)
  vec2 me = 1.0 / uSize;
  vec2 cellPush = -vec2(texture(uMask, x + vec2(me.x, 0.0)).g - texture(uMask, x - vec2(me.x, 0.0)).g,
                        texture(uMask, x + vec2(0.0, me.y)).g - texture(uMask, x - vec2(0.0, me.y)).g) / (2.0 * me * uDom) / ${CELL_PHI};
  vec2 shift = imposedShift(p, uDt) * smoothstep(0.01, 0.04, texture(uV, x).z) / uDom;
  vec2 xs = x - uDt * (uSurfK * v2 + (marangoni(p) + cellPush) / uDom) - shift;
  vec2 xu = x - uDt * uSubK * v2 - shift;

  vec4 S = sharpen(uS, xs, cr(uS, xs));
  vec4 U = sharpen(uU, xu, cr(uU, xu));
  vec4 G = vec4(cr(uG, xs).x, cr(uG, xu).yz, 0.0);

  // new paint from sources (mass-weighted mixing). The thickness in uV already
  // holds this step's new paint: take it out, so fresh paint on a bare spot
  // shows its full colour.
  float h = texture(uV, x).z;
  float h0 = texture(uV, x).w;
  for (int i = 0; i < ${NUM_SRC}; i++) {
    float r = uSrc[i].z;
    if (r > 0.0) h -= uSrc[i].w * swept(p, uSrcA[i], uSrc[i].xy, r) * uDt;
  }
  h = max(h, 0.0);
  for (int i = 0; i < ${NUM_SRC}; i++) {
    float r = uSrc[i].z;
    if (r <= 0.0) continue;
    float dh = uSrc[i].w * swept(p, uSrcA[i], uSrc[i].xy, r) * uDt;
    // share of the new paint, against the paint that was here before this
    // step: new paint that ran sideways during the step must not count as
    // old paint, or the edge of a fast line shows one arc per frame
    float fr = dh / (min(h, h0) + dh + 1e-4);
    // plug flow (a lifted cup): the new paint fills the core and pushes the
    // older paint outwards, so consecutive colours form rings
    fr = mix(fr, 1.0 - smoothstep(0.55 * r, 0.7 * r, length(p - uSrc[i].xy)), uSrcPlug[i]);
    // paint escapes under the rim in fingers: radial streaks of surface colour
    vec2 d = p - uSrc[i].xy;
    float a = atan(d.y, d.x) / 6.2831853 * 46.0 + uTime * 0.7;
    float n = mix(hash3(vec2(floor(a), 0.0), 11.0).x, hash3(vec2(floor(a) + 1.0, 0.0), 11.0).x, smoothstep(0.0, 1.0, fract(a)));
    float st = mix(1.0, smoothstep(0.35, 0.75, n) * 1.6, uSrcStreak[i]);
    vec4 srcS = uSrcS[i], srcU = uSrcU[i];
    vec2 srcG = uSrcG[i];
    if (i == 0 && uCupOn > 0.5) {
      // the paint that seeps out here is what lies at the bottom of the cup
      // there (just inside the rim for the paint outside the cup)
      // The cup moved from uSrcA to uSrc during this step: its bottom is
      // stamped at every place on the way (at most a few cells of its map
      // apart), each stamp with the paint below this point at that time. So
      // a fast cup leaves the same trail as a slow one, no dots.
      vec2 a0 = uSrcA[i], a1 = uSrc[i].xy;
      int ns = int(clamp(ceil(12.0 * length(a1 - a0) / r), 1.0, 12.0));
      vec4 col = vec4(0.0);
      vec2 gold = vec2(0.0);
      float wsum = 0.0;
      // Only where the cup lays paint: elsewhere these lookups are costly
      // and change nothing. Decided for whole 2 x 2 pixel groups (any pixel
      // of a group that needs it takes the group in), so labelAt's
      // derivatives stay valid.
      float need = dh > 0.0 ? 1.0 : 0.0;
      need += abs(dFdx(need)) + abs(dFdy(need));
      need += abs(dFdx(need)) + abs(dFdy(need));
      if (need > 0.0)
      for (int k = 0; k < 12; k++) {
        if (k >= ns) break;
        vec2 ck = mix(a0, a1, (float(k) + 0.5) / float(ns));
        // (no early exit: labelAt uses derivatives, which need all pixels)
        float wk = disc(p, ck, r) + 1e-4;
        vec2 rel = p - ck;
        vec3 l = labelAt(uCupBot, ck + rel * min(1.0, uCupMap.z * 0.95 / max(length(rel), 1e-6)), ck);
        int b = int(l.x), c = int(l.y);
        // where the bottom has run empty, the paint that is left elsewhere
        // in the cup comes out (paint without pigment would be white)
        if (b == 7) b = uCupFallback;
        if (c == 7) c = b;
        col += wk * mix(uLabS[c], uLabS[b], l.z);
        gold += wk * mix(uLabG[c], uLabG[b], l.z);
        wsum += wk;
      }
      col /= max(wsum, 1e-6);
      gold /= max(wsum, 1e-6);
      {
        // Below white paint that is there already (a white ground), in
        // fingers (between them its surface colour goes under too). On a
        // bare canvas or on coloured paint (its own too) it lies on top:
        // pigment below unpigmented paint would look white.
        float white = 1.0 - smoothstep(0.05, 0.3, dot(S, vec4(1.0)) + G.x);
        // Only at the rim: below the cup the paint lands on the ground and
        // stays on top; it creeps under the white where it seeps out.
        float rim = smoothstep(0.85, 1.0, length(p - uSrc[i].xy) / uCupMap.z);
        float under = smoothstep(0.03, 0.25, min(h, h0)) * white * rim;
        st = mix(1.0, smoothstep(0.35, 0.75, n) * 1.6, uSrcStreak[i] * under);
        float sub = uCupSub * under;
        srcS = col * (1.0 - sub);
        srcU = col * sub;
        srcG = vec2(gold.x * (1.0 - sub), gold.x * sub);
      }
    }
    vec4 ss = srcS * st;
    vec2 gs = vec2(srcG.x * st, srcG.y);
    vec4 su = srcU + srcS - ss;
    gs.y += srcG.x - gs.x;
    // New paint lies on top of the wet paint: its colour covers the surface
    // fast, and the surface colour it covers goes under (the cells and the
    // torch can bring it up again). The amount of each pigment stays the same.
    // A poured stream covers by its own thickness, not by its share of the
    // paint: a thin fast line on thick paint still hides it, it does not look
    // like a glaze. (Summed over the steps a point gets paint, this does not
    // depend on the step size.)
    float opaque = i == 0 ? 0.0 : 1.0 - exp(-dh / ${POUR_OPAQUE});
    float cov = min(1.0, max(fr * (1.0 + 2.0 * fr), opaque));
    // white paint (no pigment) that goes under: it stays below, also when
    // more paint covers it
    float wasWhite = 1.0 - smoothstep(0.05, 0.3, dot(S, vec4(1.0)) + G.x);
    G.z += (1.0 - G.z) * wasWhite * cov * smoothstep(0.03, 0.2, min(h, h0));
    vec4 T = mix(S + U, ss + max(su, 0.0), fr);
    vec2 TG = vec2(mix(G.x + G.y, gs.x + max(gs.y, 0.0), fr));
    S = mix(S, ss, cov);
    U = max(T - S, 0.0);
    G.x = mix(G.x, gs.x, cov);
    G.y = max(TG.x - G.x, 0.0);
    h += dh;
  }

  // submerged paint rises back to the surface inside cells
  float m = texture(uMask, x).r;
  vec2 td = p - uTorch.xy;
  float tr = max(uTorch.z, 1e-4);
  float heat = uTorch.w * exp(-dot(td, td) / (tr * tr) * 2.0);
  // (under the flame a cell opens at once: its inside shows the paint below)
  float t = 1.0 - exp(-uRise * (1.0 + 3.0 * heat) * m * uDt);
  // Away from the flame a cell brings the covered colour up into the
  // surface. Under the flame the hot paint below breaks through: the hole
  // shows the paint below as it is (white below gives a white cell), and
  // the surface paint is pushed to the rim (cellPush). The paint below is
  // deep, so it does not run out.
  float hk = 1.0 - exp(-heat);
  vec4 U0 = U;
  float G0 = G.y;
  S += t * (1.0 - hk) * U0; U -= t * (1.0 - hk) * U0;
  G.x += t * (1.0 - hk) * G0; G.y -= t * (1.0 - hk) * G0;
  // What shows in the hole: the paint below, where it has pigment or is
  // white paint (white below gives a white cell). Else (only the surface
  // paint is there, or the same colour lies below) the hot paint pulls in
  // paint from around the cell: the colour on a ring around it that differs
  // most from the paint here.
  vec4 below = vec4(U0);
  float belowG = G0;
  if (t * hk > 0.001) {
    float real = max(smoothstep(0.1, 0.3, dot(U0, vec4(1.0)) + G0), smoothstep(0.3, 0.7, G.z));
    if (real < 1.0) {
      vec4 nS = S;
      float nG = G.x, best = 0.0;
      for (int k = 0; k < 8; k++) {
        float a = float(k) * 0.785398;
        vec2 q = x + vec2(cos(a), sin(a)) * ${TORCH_PULL} / uDom;
        vec4 cs = texture(uS, q);
        float cg = texture(uG, q).x;
        vec4 d4 = abs(cs - S);
        // (only paint with pigment: bare canvas or an open cell would make
        // a white cell too)
        float pig = cs.x + cs.y + cs.z + cs.w + cg;
        float d = (d4.x + d4.y + d4.z + d4.w + abs(cg - G.x)) * smoothstep(0.1, 0.3, pig) * smoothstep(0.03, 0.1, texture(uV, q).z);
        if (d > best) { best = d; nS = cs; nG = cg; }
      }
      below = mix(nS, U0, real);
      belowG = mix(nG, G0, real);
    }
  }
  S = mix(S, below, t * hk);
  G.x = mix(G.x, belowG, t * hk);

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

// Splats the cells into a mask: where submerged paint rises. A cell opens
// like a hole: it grows to its size in a short time and pushes the surface
// paint out of its way, which piles up at its rim (the lacing between cells).
// r: the hole. g: a potential whose downhill slope is that push (domain
// units / s, times CELL_PHI): inside the hole the surface moves out in
// proportion to the distance, outside the push falls off like the flow from
// a source (1 / distance) and stops at e times the radius.
export const MASK_VS = `#version 300 es
uniform sampler2D uP;
uniform int uPW;
uniform vec2 uDom;
uniform float uPxPerUnit, uTime;
out float vS;
out float vSize;
out float vR;    // the hole's radius / the sprite's radius
out float vPush; // R * dR/dt * CELL_PHI
void main() {
  vec4 p = texelFetch(uP, ivec2(gl_VertexID % uPW, gl_VertexID / uPW), 0);
  vS = smoothstep(0.0, 0.4, p.w - uTime);
  if (p.z <= 0.0 || vS <= 0.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; return; }
  float r = fract(p.z), life = floor(p.z) / 100.0;
  float age = uTime - (p.w - life);
  float open = min(0.3, 0.5 * life);
  float a = clamp(age / open, 0.0, 1.0);
  float R = r * (1.0 - (1.0 - a) * (1.0 - a) * (1.0 - a));
  float dR = a < 1.0 ? r * 3.0 * (1.0 - a) * (1.0 - a) / open : 0.0;
  float reach = dR > 0.0 ? 2.72 * R : R;
  vSize = 2.0 * reach * uPxPerUnit + 2.0;
  vR = R / reach;
  vPush = R * dR * ${CELL_PHI};
  gl_Position = vec4(p.xy / uDom * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = vSize;
}`;
export const MASK_FS = `#version 300 es
precision highp float;
in float vS;
in float vSize;
in float vR;
in float vPush;
out vec4 o;
void main() {
  float q = length(gl_PointCoord * 2.0 - 1.0) * vSize / max(vSize - 2.0, 1.0);
  float d = q / max(vR, 1e-4);
  float hole = (1.0 - smoothstep(0.75, 1.0, d)) * vS;
  float phi = d < 1.0 ? 1.0 + 0.5 * (1.0 - d * d) : max(0.0, 1.0 - log(d));
  o = vec4(hole, phi * vPush, 0.0, 0.0);
}`;

export const RENDER_FS = COMMON + HASH + FINISH + CUP_LABELS + `
uniform sampler2D uV, uS, uU, uG;
uniform vec2 uDom, uPSize;
uniform float uDx;       // thickness cell size (domain units)
uniform vec4 uTorch;     // x, y, radius, active
uniform vec2 uView;      // tilt of the board relative to the viewer
uniform float uPx;       // domain units per screen pixel
uniform vec4 uCup;       // x, y, radius, alpha
uniform vec2 uCupSlosh;  // tilt of the paint's surface in the cup (canvas axes)
uniform float uCupLift;  // 1: the cup is held above the canvas (a wider, softer shadow)
uniform usampler2D uCupTop; // the paint on top in the cup (see CUP_LABELS)
uniform vec3 uLabCol[8];
uniform vec4 uStream;    // x, y, radius, active
uniform vec3 uStreamCol;
out vec4 o;

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }

// The cup's paint like labelAt (CUP_LABELS), but soft: the paints near p mixed by their weights (liquid
// paint in the cup, seen from above). sharp > 1 makes the borders narrower.
vec3 labelMix(usampler2D t, vec2 p, vec2 centre, float sharp, out float full) {
  vec2 d = p - centre;
  float c = cos(-uCupMap.w), s = sin(-uCupMap.w);
  vec2 uv = vec2(c * d.x - s * d.y, s * d.x + c * d.y) / uCupMap.z;
  vec2 g = (uv * 0.5 + 0.5) * vec2(uCupSize);
  g += vec2(sin(g.y * 0.19 + 1.7) + 0.5 * sin(g.y * 0.47 + g.x * 0.13),
            sin(g.x * 0.17 + 0.4) + 0.5 * sin(g.x * 0.41 - g.y * 0.11)) * 0.7;
  g -= 0.5;
  ivec2 b = ivec2(floor(g)) - 1;
  vec3 col = vec3(0.0);
  float sum = 0.0, none = 0.0;
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) {
      ivec2 q = b + ivec2(i, j);
      vec2 e = vec2(q) - g;
      float w = exp(-dot(e, e) * 1.2 * sharp);
      uint m = texelFetch(t, clamp(q, ivec2(0), uCupSize - 1), 0).r;
      if (m == 7u) { none += w; continue; }
      col += w * toLin(uLabCol[m]);
      sum += w;
    }
  full = sum / max(sum + none, 1e-6);
  return col / max(sum, 1e-6);
}

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

// Thickness, smoothed with a cubic B-spline (4 linear taps): plain linear
// filtering shows the coarse thickness grid as steps wherever the paint
// ends abruptly (the wall of a groove a finger leaves)
float hS(vec2 uv) {
  vec2 sz = vec2(textureSize(uV, 0));
  vec2 t = uv * sz - 0.5, i = floor(t), f = t - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = 1.0 - g0;
  vec2 a = (i - 0.5 + w1 / g0) / sz, b = (i + 1.5 + w3 / g1) / sz;
  return g0.y * (g0.x * texture(uV, a).z + g1.x * texture(uV, vec2(b.x, a.y)).z)
       + g1.y * (g0.x * texture(uV, vec2(a.x, b.y)).z + g1.x * texture(uV, b).z);
}
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

  float cover = smoothstep(0.01, 0.08, h);
  vec3 n = normalize(vec3(-(grad * 0.0035 + pgrad * 0.25 * cover), 1.0));
  n = normalize(n + vec3(uView * 0.22, 0.0));

  vec3 P = vec3((p - 0.5 * uDom) / max(uDom.x, uDom.y), 0.0);
  vec3 cam = vec3(0.0, -0.15, 1.5);
  vec3 vdir = normalize(cam - P);
  vec3 r = reflect(-vdir, n);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, vdir), 0.0), 5.0);

  // pearl and metal: a broad sheen here; the glitter flakes are particles
  // that move with the paint (GLITTER_VS)
  vec3 L = normalize(vec3(-0.3, 0.42, 1.0));
  float irid, metal;
  vec3 sheen, mtint;
  finish(c, gold, irid, sheen, metal, mtint);
  float spec = pow(max(dot(r, L), 0.0), 10.0);
  base += metal * mtint * (0.12 + 0.35 * spec);
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
    vec2 so = mix(vec2(0.012, -0.018), vec2(0.04, -0.06), uCupLift);
    float sh = 1.0 - smoothstep(R * mix(0.95, 0.8, uCupLift), R * mix(1.35, 1.6, uCupLift), length(d2 - so));
    col *= 1.0 - mix(0.25, 0.18, uCupLift) * sh * step(R, d) * uCup.w;
    float inside = 1.0 - smoothstep(R * 0.93, R * 0.95, d);
    // contents: the paint on top, as seen in the fill view. Liquid paint
    // has no hard borders: the colours blend into each other.
    float full;
    vec3 contents = labelMix(uCupTop, p, uCupMap.xy, 0.8, full);
    full = smoothstep(0.08, 0.35, full);
    // the surface: tilted while the paint sloshes, and rising at the wall
    // (meniscus); it catches the light
    vec2 dl = d2 / (R * 0.93);
    // (capped at the rim below: far outside, exp() would give inf, and
    // inf * 0 = NaN blacks out the whole canvas)
    float rr = length(dl);
    vec2 sg = uCupSlosh * 3.0 + dl / max(rr, 1e-4) * 0.9 * exp(min(rr - 1.0, 0.0) / 0.07);
    vec3 ns = normalize(vec3(-sg, 1.0));
    contents *= (0.86 + 0.14 * max(dot(ns, L), 0.0) / L.z) * (0.92 + 0.08 * (1.0 - rr));
    // a soft window highlight that moves as the surface tilts
    vec2 hp = dl - vec2(-0.32, 0.36) + uCupSlosh * 4.0;
    float hl = exp(-dot(hp * vec2(1.0, 1.6), hp * vec2(1.0, 1.6)) / 0.035);
    // and a bright line where the meniscus faces the light
    float ml = exp(min(rr - 1.0, 0.0) / 0.035) * max(0.0, dot(dl / max(rr, 1e-4), normalize(L.xy)));
    contents += vec3(0.22) * hl + vec3(0.18) * ml;
    col = mix(col, contents, inside * min(full, 1.0) * uCup.w);
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

// The thickest paint in each block of 16 x 16 cells (for the time step).
export const MAXH_FS = `#version 300 es
precision highp float;
uniform sampler2D uH;
uniform ivec2 uN;
out vec4 o;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 16;
  float m = 0.0;
  for (int j = 0; j < 16; j++)
    for (int i = 0; i < 16; i++) {
      ivec2 c = b + ivec2(i, j);
      if (c.x < uN.x && c.y < uN.y) m = max(m, texelFetch(uH, c, 0).r);
    }
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

export const CLEAR_FS = `#version 300 es
precision highp float;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); }`;

// Glitter flakes: particles (x, y, birth, life) that ride on the surface of
// the paint. They are respawned at random places when their life ends, so the
// glitter stays evenly spread while the paint stretches.
export const GLIT_FS = COMMON + HASH + TORCH_FLOW + `
uniform sampler2D uP, uV;
uniform vec2 uDom;
uniform float uDt, uK, uTime;
out vec4 o;
void main() {
  vec4 q = texelFetch(uP, ivec2(gl_FragCoord.xy), 0);
  // same surface velocity as the surface pigments (PIG_FS), torch included
  vec2 v1 = uK * texture(uV, q.xy / uDom).xy + marangoni(q.xy);
  vec2 m = q.xy + 0.5 * uDt * v1;
  q.xy += uDt * (uK * texture(uV, m / uDom).xy + marangoni(m));
  bool out_ = q.x < 0.0 || q.y < 0.0 || q.x > uDom.x || q.y > uDom.y;
  if (q.w <= 0.0 || out_ || uTime > q.z + q.w) {
    vec3 r = hash3(gl_FragCoord.xy, floor(uTime * 97.0) + 17.0);
    float life = 2.5 + 4.0 * r.z;
    // the first time: spread the births so they do not all blink together
    float birth = q.w <= 0.0 ? uTime - r.z * life : uTime;
    q = vec4(r.xy * uDom, birth, life);
  }
  o = q;
}`;

export const GLITTER_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uP, uV, uS, uU, uG;
uniform int uPW;
uniform vec2 uDom;
uniform float uTime, uDx, uPtSize;
uniform vec2 uView;
uniform vec4 uCup; // x, y, radius, alpha
out vec3 vCol;
` + HASH + FINISH + `
void main() {
  int id = gl_VertexID;
  vec4 q = texelFetch(uP, ivec2(id % uPW, id / uPW), 0);
  gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
  gl_PointSize = 0.0;
  vCol = vec3(0.0);
  float age = uTime - q.z;
  float fade = smoothstep(0.0, 0.5, age) * smoothstep(0.0, 0.5, q.w - age);
  if (q.w <= 0.0 || fade <= 0.0) return;
  vec2 uv = q.xy / uDom;
  float h = texture(uV, uv).z;
  float cover = smoothstep(0.01, 0.08, h);
  if (cover <= 0.0) return;
  // under the cup: hidden
  if (uCup.w > 0.0 && length(q.xy - uCup.xy) < uCup.z) return;

  vec4 S = texture(uS, uv), U = texture(uU, uv), G = texture(uG, uv);
  float vis = mix(0.12, 0.035, smoothstep(0.3, 2.0, h));
  float irid, metal;
  vec3 sheen, mtint;
  finish(S + vis * U, G.x + vis * G.y, irid, sheen, metal, mtint);
  if (irid + metal < 0.02) return;

  // surface normal from the thickness, then a random tilt per flake
  vec2 e = uDx / uDom;
  vec2 grad = vec2(texture(uV, uv + vec2(e.x, 0.0)).z - texture(uV, uv - vec2(e.x, 0.0)).z,
                   texture(uV, uv + vec2(0.0, e.y)).z - texture(uV, uv - vec2(0.0, e.y)).z) / (2.0 * uDx);
  vec3 n = normalize(vec3(-grad * 0.0035, 1.0));
  n = normalize(n + vec3(uView * 0.22, 0.0));
  vec3 hs = hash3(vec2(float(id % uPW), float(id / uPW)), 3.0);
  vec3 fn = normalize(n + (hs - 0.5) * 0.9);
  vec3 P = vec3((q.xy - 0.5 * uDom) / max(uDom.x, uDom.y), 0.0);
  vec3 vdir = normalize(vec3(0.0, -0.15, 1.5) - P);
  vec3 L = normalize(vec3(-0.3, 0.42, 1.0));
  float glint = pow(max(dot(reflect(-vdir, fn), L), 0.0), 40.0);
  vec3 c = (irid * 0.9 * sheen + metal * 2.5 * mtint) * glint * cover * fade;
  if (max(c.r, max(c.g, c.b)) < 0.01) return;
  vCol = c;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uPtSize;
}`;

export const GLITTER_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 o;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  float a = 1.0 - smoothstep(0.3, 1.0, d);
  o = vec4(vCol * a, 1.0);
}`;
