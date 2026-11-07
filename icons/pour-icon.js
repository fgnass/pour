// Pours the app icon with the app itself: the demo as background, a P in
// Matemasie poured in white along its middle line, then swiped along it.
// Run in the dev server's page (it needs `window.dev`, see src/main.ts):
//   await iconSetup(); await makeBackground(); await makeIcon(); await exportIcons();
// makeIcon starts from the background snapshot, so it can run again and again.
// The app icons use the Sunset palette: icon.jpg with iconOpts and crop centre
// y 0.65; maskable.jpg with a smaller P (h 0.56, cy 0.66, crop centre y 0.64),
// so it fits the safe circle. Then `npm run icons`.
// banner.jpg (start dialog) has a smaller P, see bannerOpts:
//   await makeIcon(bannerOpts); await exportImage(7, 0.5, 0.66, 0.96, 0.96 * 230 / 380, 1000);
// Domain coordinates: x 0..1, y 0..dom[1], y points up.

{
// a block, so the script can be loaded again into the same page
const wait = s => new Promise(r => setTimeout(r, s * 1000));
const frame = () => new Promise(r => requestAnimationFrame(r));

/** Loads Matemasie and the model constants of the running app. */
window.iconSetup = async () => {
  const css = await (await fetch('https://fonts.googleapis.com/css2?family=Matemasie&text=P')).text();
  const ff = new FontFace('Matemasie', `url(${css.match(/url\((.*?)\)/)[1]})`);
  await ff.load();
  document.fonts.add(ff);
  // the app may use a module URL with a ?t= stamp: import that same instance
  const url = performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/src/model.ts')).pop();
  window.M = (await import(url)).M;
  // glyph mask and the distance of each inside pixel to the outside
  const N = 400, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  g.font = '300px Matemasie';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('P', N / 2, N / 2);
  const a = g.getImageData(0, 0, N, N).data;
  const m = new Uint8Array(N * N);
  let x0 = N, x1 = 0, y0 = N, y1 = 0;
  for (let i = 0; i < N * N; i++)
    if (a[i * 4 + 3] > 127) {
      m[i] = 1;
      const x = i % N, y = (i / N) | 0;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  const edge = [];
  for (let i = 0; i < N * N; i++) if (!m[i] && (m[i - 1] || m[i + 1] || m[i - N] || m[i + N])) edge.push([i % N, (i / N) | 0]);
  const dist = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++)
    if (m[i]) {
      const x = i % N, y = (i / N) | 0;
      let d = 1e9;
      for (const [ex, ey] of edge) d = Math.min(d, (ex - x) ** 2 + (ey - y) ** 2);
      dist[i] = Math.sqrt(d);
    }
  window.glyph = { N, dist, box: [x0, y0, x1, y1] };
};

/** Rows that fill the glyph, kept `inset` away from its edge; thin parts get a row on their middle line. */
window.glyphStrokes = (cx, cy, h, inset, sp) => {
  const { N, dist, box } = glyph;
  const k = h / (box[3] - box[1]);
  const gx = (box[0] + box[2]) / 2, gy = (box[1] + box[3]) / 2;
  const toDom = (x, y) => [cx + (x - gx) * k, cy - (y - gy) * k];
  const e = inset / k, cs = Math.max(2, Math.round(sp / k));
  const D = i => dist[i] || 0;
  const ok = i => D(i) >= e || (D(i) >= 3 && ((D(i) >= D(i - N) && D(i) >= D(i + N)) || (D(i) >= D(i - 1) && D(i) >= D(i + 1))));
  const strokes = [];
  let dir = 1;
  for (let cy0 = 0; cy0 < N; cy0 += cs) {
    const row = [];
    for (let cx0 = 0; cx0 < N; cx0 += cs) {
      let best = -1, bd = -1;
      for (let y = cy0; y < Math.min(N, cy0 + cs); y++)
        for (let x = cx0; x < Math.min(N, cx0 + cs); x++) {
          const i = y * N + x;
          if (ok(i) && D(i) > bd) { bd = D(i); best = i; }
        }
      row.push(best >= 0 ? toDom(best % N, (best / N) | 0) : null);
    }
    if (dir < 0) row.reverse();
    let cur = [];
    for (const p of row) {
      if (p) cur.push(p);
      else if (cur.length) { strokes.push(cur); cur = []; }
    }
    if (cur.length) strokes.push(cur);
    dir = -dir;
  }
  return strokes;
};

/** Joins strokes whose ends are close, so the stream does not stop and start. */
window.linkStrokes = (st, maxGap) => {
  const out = [];
  for (const s of st) {
    const p = out[out.length - 1];
    if (p) {
      const a = p[p.length - 1], b = s[0];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < maxGap) { p.push(...s); continue; }
    }
    out.push([...s]);
  }
  return out;
};

const along = (pl, d) => {
  let acc = 0;
  for (let i = 1; i < pl.length; i++) {
    const l = Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
    if (acc + l >= d || i === pl.length - 1) {
      const f = l ? Math.min(1, (d - acc) / l) : 1;
      return [pl[i - 1][0] + (pl[i][0] - pl[i - 1][0]) * f, pl[i - 1][1] + (pl[i][1] - pl[i - 1][1]) * f];
    }
    acc += l;
  }
  return pl[0];
};
const length = pl => pl.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pl[i][0], p[1] - pl[i][1]), 0);

/** Pours paint m along polylines; a single point is poured for `stamp` seconds. */
window.pourStrokes = async (strokes, speed, m = 0, stamp = 0.04) => {
  const s = dev.studio();
  for (const pl of strokes) {
    const tot = length(pl), t0 = performance.now();
    for (;;) {
      const el = (performance.now() - t0) / 1000;
      const p = pl.length === 1 ? pl[0] : along(pl, el * speed);
      s.pour = { m, x: p[0], y: p[1] };
      await frame();
      if (pl.length === 1 ? el >= stamp : el * speed >= tot) break;
    }
    s.pour = null;
    await frame();
  }
};

/** Swipes along a polyline. */
window.swipe = async (pl, speed, r = 0.045) => {
  const s = dev.studio(), tot = length(pl), t0 = performance.now();
  let last = null;
  for (;;) {
    const now = performance.now(), d = Math.min(tot, ((now - t0) / 1000) * speed);
    const [x, y] = along(pl, d);
    const dt = last ? (now - last.t) / 1000 || 0.016 : 0.016;
    s.push = { x, y, vx: last ? (x - last.x) / dt : 0, vy: last ? (y - last.y) / dt : 0, r };
    last = { x, y, t: now };
    await frame();
    if (d >= tot) break;
  }
  await wait(0.05);
  s.push = null;
};

window.runDemo = async () => {
  for (const id of ['hud', 'sheet', 'palettes', 'error', 'start']) document.getElementById(id).style.display = 'none';
  document.querySelector('#demoBtn').click();
  await wait(1);
  while (dev.demo().active) await wait(0.3);
};

// ---------------------------------------------------------------- snapshot
// Copies of all simulation textures, so tries start from the same background
// without running the demo again. Only in memory: a reload loses it.
const simTextures = sim => {
  const gl = sim.g.gl, PW = 256, GW = 256, GH = 512;
  return [
    ...sim.H.map(t => [t, sim.NX, sim.NY, gl.R32F]),
    [sim.V, sim.NX, sim.NY, gl.RGBA16F],
    ...sim.PS.flat().map(t => [t, sim.PX, sim.PY, gl.RGBA16F]),
    ...sim.PT.map(t => [t, PW, PW, gl.RGBA32F]),
    ...sim.GT.map(t => [t, GW, GH, gl.RGBA32F]),
  ];
};
const blit = (gl, from, to, w, h) => {
  const a = gl.createFramebuffer(), b = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, a);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, from, 0);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, b);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, to, 0);
  gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.deleteFramebuffer(a);
  gl.deleteFramebuffer(b);
};
// on window, so loading this script again keeps them
const snaps = (window.iconSnaps ||= {});
window.snapshot = (name = 'bg') => {
  const sim = dev.sim(), gl = sim.g.gl;
  const tex = simTextures(sim).map(([t, w, h, f]) => {
    const c = sim.g.tex(w, h, f, false);
    blit(gl, t, c, w, h);
    return c;
  });
  const { hi, pi, ppi, pRing, gi, time } = sim;
  snaps[name] = { sim, tex, scalars: { hi, pi, ppi, pRing, gi, time } };
};
window.restore = async (name = 'bg') => {
  const s = snaps[name], sim = dev.sim(), gl = sim.g.gl;
  if (!s || s.sim !== sim) throw new Error('no snapshot ' + name + ' for this simulation');
  const st = dev.studio();
  st.pour = st.push = st.torch = null;
  st.tilt.tx = st.tilt.ty = st.tilt.x = st.tilt.y = 0;
  simTextures(sim).forEach(([t, w, h], i) => blit(gl, s.tex[i], t, w, h));
  Object.assign(sim, s.scalars);
  dev.wake();
  await frame();
};

/** Tilts the canvas (x, y in -1..1 of the maximum) for `secs`, then lays it flat again. */
window.tiltFor = async (x, y, secs, settle = 3) => {
  const demo = dev.demo(), t = dev.studio().tilt, max = 0.5;
  demo.tilting = true; // else the app sets the tilt back every frame
  t.tx = x * max;
  t.ty = y * max;
  await wait(secs);
  t.tx = t.ty = 0;
  await wait(settle);
  demo.tilting = false;
};

// ---------------------------------------------------------------- skeleton
/**
 * Middle line of the P with the half thickness at each point (glyph pixels):
 * from the tip of the stem up into the bowl, then once around the counter.
 */
window.glyphSkeleton = () => {
  const { N, dist, box } = glyph;
  const D = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? 0 : dist[(y | 0) * N + (x | 0)]);
  // the counter: outside pixels that the outside flood fill cannot reach
  const seen = new Uint8Array(N * N), q = [0];
  seen[0] = 1;
  while (q.length) {
    const i = q.pop(), x = i % N, y = (i / N) | 0;
    for (const j of [x > 0 && i - 1, x < N - 1 && i + 1, y > 0 && i - N, y < N - 1 && i + N])
      if (j !== false && !seen[j] && !dist[j]) { seen[j] = 1; q.push(j); }
  }
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < N * N; i++) if (!seen[i] && !dist[i]) { cx += i % N; cy += (i / N) | 0; n++; }
  cx /= n; cy /= n;
  // loop: on each ray from the counter centre, the first ridge (local maximum of dist)
  const ray = a => {
    let best = null;
    for (let r = 1; r < N; r += 0.5) {
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, d = D(x, y);
      if (d > 0 && (!best || d >= best[2])) best = [x, y, d];
      else if (best && (d === 0 || d < best[2] - 1)) break;
    }
    return best;
  };
  const raw = [];
  for (let k = 0; k < 180; k++) { const p = ray((k / 180) * Math.PI * 2); if (p) raw.push(p); }
  // smooth it a little (it is a closed loop)
  const loop = raw.map((_, i) => {
    const w = [-3, -2, -1, 0, 1, 2, 3].map(o => raw[(i + o + raw.length) % raw.length]);
    return [0, 1, 2].map(c => w.reduce((s, p) => s + p[c], 0) / w.length);
  });
  // stem: its tip is the lowest point of the letter; walk up the ridge
  let tip = null;
  for (let i = 0; i < N * N; i++) if (dist[i] && (!tip || ((i / N) | 0) > tip[1])) tip = [i % N, (i / N) | 0];
  tip[1] -= 4;
  const near = (x, y) => loop.reduce((b, p, i) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; return d < b[1] ? [i, d] : b; }, [0, 1e9]);
  const stem = [];
  let [x, y] = tip;
  for (let k = 0; k < 400; k++) {
    // step towards the counter, then slide sideways onto the ridge
    const l = Math.hypot(cx - x, cy - y), ux = (cx - x) / l, uy = (cy - y) / l;
    x += ux * 2; y += uy * 2;
    let bx = x, by = y, bd = D(x, y);
    for (let s = -12; s <= 12; s += 0.5) { const d = D(x - uy * s, y + ux * s); if (d > bd) { bd = d; bx = x - uy * s; by = y + ux * s; } }
    x = bx; y = by;
    stem.push([x, y, bd]);
    const [li, ld] = near(x, y);
    if (Math.sqrt(ld) < loop[li][2] * 0.6) break;
  }
  // start the loop where the stem meets it
  const j = near(x, y)[0];
  const ring = [...loop.slice(j), ...loop.slice(0, j), loop[j]];
  return { pts: [...stem, ...ring], stem: stem.length, counter: [cx, cy], box };
};

/** The skeleton in domain coordinates: [x, y, half thickness]. */
window.skeletonDom = (cx, cy, h) => {
  const { pts, stem, box } = glyphSkeleton();
  const k = h / (box[3] - box[1]), gx = (box[0] + box[2]) / 2, gy = (box[1] + box[3]) / 2;
  const sk = pts.map(([x, y, d]) => [cx + (x - gx) * k, cy - (y - gy) * k, d * k]);
  sk.stem = stem; // the first `stem` points are the stem, from its tip up
  return sk;
};

/**
 * Pours one continuous stream along the skeleton. The stream gets wider and
 * pours more where the letter is thicker. `width`: stream radius per half
 * thickness, `fill`: paint per unit of length and width.
 */
window.pourSkeleton = async (sk, { speed = 0.35, width = 0.6, fill = 0.55, minHalf = 0, m = 0 } = {}) => {
  const s = dev.studio(), orig = { whiteRate: M.whiteRate, whiteR: M.whiteR };
  const pl = sk.map(p => [p[0], p[1]]), L = [0];
  for (let i = 1; i < pl.length; i++) L.push(L[i - 1] + Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]));
  const tot = L[L.length - 1], t0 = performance.now();
  try {
    for (;;) {
      const d = Math.min(tot, ((performance.now() - t0) / 1000) * speed);
      let i = Math.max(1, L.findIndex(l => l >= d));
      const f = (d - L[i - 1]) / (L[i] - L[i - 1] || 1), a = sk[i - 1], b = sk[i];
      // thin parts still get enough paint to close up
      const half = Math.max(minHalf, a[2] + (b[2] - a[2]) * f);
      M.whiteR = Math.max(0.01, half * width);
      M.whiteRate = fill * half * 2 * speed;
      s.pour = { m, x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f };
      await frame();
      if (d >= tot) break;
    }
  } finally {
    s.pour = null;
    Object.assign(M, orig);
  }
};

window.iconOpts = {
  // [x, y, seconds]: tilt after the demo, so the paint flows into the bright top right
  bgTilt: [0.75, 0.85, 4.5],
  // the P: centre and height
  cx: 0.5, cy: 0.68, h: 0.8,
  pour: { speed: 0.3, width: 0.5, fill: 1.8, minHalf: 0.05 },
  // swipe along the skeleton afterwards (null: none)
  swipe: { speed: 0.12, r: 0.006 },
};

// the P for the banner of the start dialog: smaller, so there is room left and right.
// The paint must not grow with the area, so fill, swipe and minHalf are a bit smaller.
window.bannerOpts = {
  ...iconOpts,
  h: 0.44,
  pour: { ...iconOpts.pour, fill: 1.35, minHalf: 0.04 },
  swipe: { speed: 0.066, r: 0.0033 },
};

/** Demo as background (snapshot 'demo'), tilted so the paint covers the bright top right (snapshot 'bg'). */
window.makeBackground = async (o = iconOpts) => {
  await runDemo();
  await wait(1);
  snapshot('demo');
  await tiltBackground(o);
};

window.tiltBackground = async (o = iconOpts) => {
  await restore('demo');
  await tiltFor(...o.bgTilt);
  snapshot('bg');
};

/** From the background snapshot: pour the P, then swipe along its skeleton. */
window.makeIcon = async (o = iconOpts) => {
  await restore('bg');
  const sk = skeletonDom(o.cx, o.cy, o.h);
  await pourSkeleton(sk, o.pour);
  await wait(0.8);
  if (o.swipe) {
    // start in the white, so no other colour is dragged into the letter:
    // once around the bowl, then from the bowl down the stem
    const xy = sk.map(p => [p[0], p[1]]);
    await swipe(xy.slice(sk.stem), o.swipe.speed, o.swipe.r);
    await wait(0.2);
    await swipe(xy.slice(0, sk.stem + 1).reverse(), o.swipe.speed, o.swipe.r);
  }
  await wait(1);
};

/** Renders the canvas in palette i; returns a crop (w × h, domain units, centred at cx, cy) as a JPEG data URL. */
window.exportImage = async (i, cx, cy, w, h, outW = 1024) => {
  const sim = dev.sim(), cv = document.querySelector('canvas');
  dev.palette(i);
  await frame();
  await frame();
  const ow = cv.width, oh = cv.height, W = 1600, H = Math.round((W * oh) / ow);
  cv.width = W; cv.height = H;
  sim.render(dev.studio().overlay([0, 0]), W, H);
  const img = sim.readImage(W, H);
  cv.width = ow; cv.height = oh;
  const full = document.createElement('canvas');
  full.width = W; full.height = H;
  full.getContext('2d').putImageData(img, 0, 0);
  const sw = w * W, sh = h * W, px = cx * W, py = (1 - cy / sim.dom[1]) * H;
  const c = document.createElement('canvas');
  c.width = outW; c.height = Math.round((outW * h) / w);
  c.getContext('2d').drawImage(full, px - sw / 2, py - sh / 2, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
};

/** Renders the picture in every palette; returns square crops (side = crop × width) as JPEG data URLs. */
window.exportIcons = async (o = iconOpts, crop = 1, size = 1024) => {
  const out = [];
  for (let i = 0; i < dev.palettes.length; i++)
    out.push({ name: dev.palettes[i].name, url: await exportImage(i, o.cx, o.cy, crop, crop, size) });
  dev.palette(0);
  return out;
};
}
