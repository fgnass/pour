import './style.css';
import { Demo } from './demo';
import { Studio } from './model';
import { GL } from './sim/gl';
import { MATS } from './sim/materials';
import { P, Sim, type Quality } from './sim/sim';
import { TiltInput } from './tilt';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const canvas = $<HTMLCanvasElement>('#gl');
const hintEl = $('#hint');
const paintsEl = $('#paints');
const liftBtn = $<HTMLButtonElement>('#liftBtn');
const torchBtn = $<HTMLButtonElement>('#torchBtn');
const levelBtn = $<HTMLButtonElement>('#levelBtn');
const sheet = $('#sheet');
const startEl = $('#start');

// ---------------------------------------------------------------- setup
const qs = new URLSearchParams(location.search);
const coarse = matchMedia('(pointer: coarse)').matches;
const quality: Quality = {
  n: +(qs.get('n') ?? 0) || (coarse ? 200 : 288),
  np: +(qs.get('np') ?? 0) || (coarse ? 512 : 720),
};

let g: GL;
try {
  g = new GL(canvas);
} catch (e) {
  showError((e as Error).message);
  throw e;
}

function showError(msg: string) {
  $('#errorMsg').textContent = msg;
  $('#error').hidden = false;
  startEl.hidden = true;
}

const SETTLE_MS = 8000; // keep simulating this long after the last activity
let lastBusy = -Infinity;
let lastView: [number, number] = [NaN, NaN];
let needsDraw = true;

/** Draw again on the next frame (after resize, reset …). */
function wake() {
  needsDraw = true;
  lastBusy = performance.now();
}

const viewAspect = () => innerWidth / innerHeight;
let sim = new Sim(g, viewAspect(), quality);
let studio = new Studio(sim);
let demo = new Demo(studio);
const tilt = new TiltInput();

function rebuild() {
  demo.stop();
  sim.dispose();
  sim = new Sim(g, viewAspect(), quality);
  studio = new Studio(sim);
  demo = new Demo(studio);
  demo.onChange = onDemoChange;
}

// ---------------------------------------------------------------- layout
// The canvas keeps the aspect ratio of the simulation and fits the screen.
const layout = { left: 0, top: 0, w: 1, h: 1 };
function resize() {
  const W = innerWidth,
    H = innerHeight;
  const a = sim.dom[0] / sim.dom[1];
  if (!studio.dirty && Math.abs(Math.log(a / (W / H))) > 0.03) {
    rebuild();
    return resize();
  }
  let w = W,
    h = W / a;
  if (h > H) {
    h = H;
    w = H * a;
  }
  // tiny differences (e.g. browser bars): cover instead of letterbox
  if (Math.abs(Math.log(a / (W / H))) < 0.06) {
    w = Math.max(W, H * a);
    h = w / a;
  }
  Object.assign(layout, { w, h, left: (W - w) / 2, top: (H - h) / 2 });
  Object.assign(canvas.style, { width: w + 'px', height: h + 'px', left: layout.left + 'px', top: layout.top + 'px' });
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  wake();
}
addEventListener('resize', resize);
resize();

function toDomain(e: { clientX: number; clientY: number }) {
  return {
    x: ((e.clientX - layout.left) / layout.w) * sim.dom[0],
    y: (1 - (e.clientY - layout.top) / layout.h) * sim.dom[1],
  };
}

// ---------------------------------------------------------------- hint
let hintTimer = 0;
function hint(text: string, ms = 4000) {
  hintEl.innerHTML = '';
  const s = document.createElement('span');
  s.textContent = text;
  hintEl.append(s);
  hintEl.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hintEl.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- paints
let paint = 0;
const PAINT_ORDER = [0, 1, 2, 3, 4, 5];
for (const m of PAINT_ORDER) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', MATS[m].name);
  b.dataset.m = String(m);
  b.innerHTML = `<i style="background:${MATS[m].hex}"></i>`;
  b.addEventListener('click', () => selectPaint(m, true));
  paintsEl.append(b);
}
function selectPaint(m: number, announce = false) {
  paint = m;
  paintsEl.querySelectorAll<HTMLElement>('.swatch').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.m! === m)));
  if (tool !== 'pour') setTool('pour', false);
  if (announce) hint(studio.cup && !studio.cup.lifting ? `${MATS[m].name} – hold on the cup to pour it in` : `${MATS[m].name} – hold to pour`);
}

// ---------------------------------------------------------------- tools
type Tool = 'pour' | 'cup' | 'swipe' | 'tilt';
let tool: Tool = 'pour';
function toolHint() {
  switch (tool) {
    case 'pour':
      return studio.cup && !studio.cup.lifting ? 'Hold on the cup to pour paint into it' : `Hold to pour ${MATS[paint].name.toLowerCase()}`;
    case 'cup':
      if (studio.cup?.lifting) return 'Lifting the cup …';
      return studio.cup ? 'Drag anywhere to move the cup · double-tap to lift' : 'Tap to set the cup into the paint';
    case 'swipe':
      return 'Drag through wet paint to push it';
    case 'tilt':
      return 'Drag to tilt the canvas';
  }
}
function setTool(t: Tool, announce = true) {
  tool = t;
  document.querySelectorAll<HTMLElement>('#tools button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
  if (announce) hint(toolHint());
}
document.querySelectorAll<HTMLElement>('#tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));

// ---------------------------------------------------------------- canvas gestures
type Drag = { id: number; x: number; y: number; sx: number; sy: number; t: number; vx: number; vy: number; cx: number; cy: number; moved: boolean };
let drag: Drag | null = null;
let lastTap = { t: 0, x: 0, y: 0 };
const manualTilt = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', e => {
  wake();
  if (drag) return;
  demo.stop();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* pointer already gone */
  }
  const p = toDomain(e);
  drag = { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), vx: 0, vy: 0, cx: 0, cy: 0, moved: false };
  if (tool === 'pour') {
    studio.pour = { m: paint, x: p.x, y: p.y };
    markPouring(true);
  } else if (tool === 'cup') {
    const cup = studio.cup;
    if (!cup) {
      studio.placeCup(p.x, p.y);
      navigator.vibrate?.(12);
      drag.cx = p.x;
      drag.cy = p.y;
    } else if (!cup.lifting) {
      drag.cx = cup.tx;
      drag.cy = cup.ty;
    }
  } else if (tool === 'swipe') {
    studio.push = { x: p.x, y: p.y, vx: 0, vy: 0, r: 0.045 };
  }
});

canvas.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const p = toDomain(e);
  const now = performance.now();
  const dt = Math.max(1, now - drag.t) / 1000;
  drag.vx = drag.vx * 0.6 + ((p.x - drag.x) / dt) * 0.4;
  drag.vy = drag.vy * 0.6 + ((p.y - drag.y) / dt) * 0.4;
  drag.x = p.x;
  drag.y = p.y;
  drag.t = now;
  if (Math.hypot(p.x - drag.sx, p.y - drag.sy) * (layout.w / sim.dom[0]) > 10) drag.moved = true;
  if (tool === 'pour' && studio.pour) {
    studio.pour.x = p.x;
    studio.pour.y = p.y;
  } else if (tool === 'cup' && studio.cup && !studio.cup.lifting) {
    const [W, H] = sim.dom;
    studio.cup.tx = Math.min(W, Math.max(0, drag.cx + p.x - drag.sx));
    studio.cup.ty = Math.min(H, Math.max(0, drag.cy + p.y - drag.sy));
  } else if (tool === 'swipe' && studio.push) {
    Object.assign(studio.push, { x: p.x, y: p.y, vx: drag.vx, vy: drag.vy });
  } else if (tool === 'tilt') {
    let x = ((p.x - drag.sx) / sim.dom[0]) * 3,
      y = ((p.y - drag.sy) / sim.dom[0]) * 3;
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    manualTilt.x = x * P.tiltMax;
    manualTilt.y = y * P.tiltMax;
  }
});

function endDrag(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  studio.pour = null;
  studio.push = null;
  markPouring(false);
  if (tool === 'tilt') manualTilt.x = manualTilt.y = 0;
  if (tool === 'cup' && !d.moved) {
    const now = performance.now();
    const near = Math.hypot(d.x - lastTap.x, d.y - lastTap.y) < 0.08;
    if (now - lastTap.t < 350 && near) {
      lift();
      lastTap.t = 0;
      return;
    }
    lastTap = { t: now, x: d.x, y: d.y };
  }
  if (tool === 'cup' && studio.cup && !studio.cup.lifting && studio.cupVolume() < 1e-6) {
    // freshly placed and still empty: next step is pouring into it
    setTool('pour', false);
    hint('Now hold on the cup to pour paint into it');
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function markPouring(on: boolean) {
  paintsEl.querySelector(`[data-m="${paint}"]`)?.classList.toggle('pouring', on);
}

// ---------------------------------------------------------------- actions
function lift() {
  if (!studio.cup || studio.cup.lifting) return;
  demo.stop();
  studio.liftCup();
  navigator.vibrate?.([8, 40, 8]);
}
liftBtn.addEventListener('click', lift);

const torch = (on: boolean) => {
  studio.torch = on;
  torchBtn.classList.toggle('on', on);
};
torchBtn.addEventListener('pointerdown', e => {
  torchBtn.setPointerCapture(e.pointerId);
  demo.stop();
  torch(true);
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) torchBtn.addEventListener(ev, () => torch(false));
torchBtn.addEventListener('contextmenu', e => e.preventDefault());

levelBtn.addEventListener('click', () => {
  wake();
  tilt.level();
  navigator.vibrate?.(10);
  hint('Level: this pose is flat now');
});

// menu
$('#menuBtn').addEventListener('click', () => (sheet.hidden = false));
sheet.addEventListener('click', e => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  sheet.hidden = true;
  if (act === 'new') {
    demo.stop();
    rebuild();
    resize();
    setTool('pour', false);
    selectPaint(0);
    hint('Fresh canvas');
  } else if (act === 'demo') {
    rebuild();
    resize();
    demo.start();
  } else if (act === 'save') saveRequested = true;
  else if (act === 'level') levelBtn.click();
  else if (act === 'help') {
    startEl.hidden = false;
    startEl.classList.remove('gone');
  }
});

function onDemoChange(active: boolean) {
  if (active) hint('Demo – touch the canvas to take over', 3000);
}
demo.onChange = onDemoChange;

// keyboard (desktop): 1–6 paints, arrows tilt, L lift
const keysTilt: Record<string, boolean> = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false };
addEventListener('keydown', e => {
  wake();
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = +e.key;
  if (n >= 1 && n <= PAINT_ORDER.length) selectPaint(PAINT_ORDER[n - 1], true);
  else if (e.key in keysTilt) {
    demo.stop();
    keysTilt[e.key] = true;
    e.preventDefault();
  } else if (e.key.toLowerCase() === 'l') lift();
});
addEventListener('keyup', e => {
  if (e.key in keysTilt) keysTilt[e.key] = false;
});
addEventListener('blur', () => {
  for (const k in keysTilt) keysTilt[k] = false;
  studio.pour = null;
  studio.push = null;
  torch(false);
});

// ---------------------------------------------------------------- tilt + start
tilt.onMode = mode => {
  const sensor = mode === 'sensor';
  document.body.classList.toggle('sensor', sensor);
  levelBtn.hidden = !sensor;
  $('#tools [data-tool="tilt"]').hidden = sensor;
  if (mode === 'sensor') hint('Tilt your phone to make the paint flow');
  if (mode === 'manual') hint(coarse ? 'No tilt sensor: use the Tilt tool' : 'Tilt with the arrow keys or the Tilt tool');
};

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake() {
  try {
    wakeLock = await (navigator as any).wakeLock?.request('screen');
  } catch {
    /* not allowed or not supported */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) keepAwake();
});

let started = false;
function begin(withDemo: boolean) {
  startEl.classList.add('gone');
  setTimeout(() => (startEl.hidden = true), 400);
  if (!started) {
    started = true;
    tilt.start();
    keepAwake();
  } else if (tilt.mode === 'sensor') tilt.level();
  if (withDemo) {
    rebuild();
    resize();
    demo.start();
  } else hint(toolHint());
}
$('#startBtn').addEventListener('click', () => begin(false));
$('#demoBtn').addEventListener('click', () => begin(true));

// ---------------------------------------------------------------- save image
let saveRequested = false;
async function saveImage() {
  const img = sim.readImage(canvas.width, canvas.height);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
  if (!blob) return;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `pour-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (coarse && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch {
      /* cancelled: fall back to a download */
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- loop
const DEAD = 0.03; // ~2° of hand jitter does nothing
const GAIN = 1.7; // full tilt at about 19°
let last = performance.now();
let liftWasEnabled = false;

function frame(now: number) {
  const rdt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  // never exceed the stable step: slow the simulation down instead
  const dt = Math.max(1e-4, Math.min(rdt, sim.maxDt()));
  demo.tick();

  const t = studio.tilt;
  let view: [number, number];
  if (!demo.tilting) {
    if (tilt.mode === 'sensor') {
      const { x, y } = tilt.value;
      const m = Math.hypot(x, y);
      const k = m > DEAD ? Math.min(P.tiltMax, (m - DEAD) * GAIN) / m : 0;
      t.tx = x * k;
      t.ty = y * k;
    } else {
      const kx = (keysTilt.ArrowRight ? 1 : 0) - (keysTilt.ArrowLeft ? 1 : 0);
      const ky = (keysTilt.ArrowUp ? 1 : 0) - (keysTilt.ArrowDown ? 1 : 0);
      t.tx = kx ? kx * P.tiltMax * 0.75 : manualTilt.x;
      t.ty = ky ? ky * P.tiltMax * 0.75 : manualTilt.y;
    }
  }

  // Idle: when nothing moves, the paint stops (yield stress). Then skip the
  // simulation and draw only when the view changes. Saves GPU and battery.
  const busy =
    demo.active || !!drag || !!studio.pour || !!studio.push || studio.torch || !!studio.cup ||
    Math.hypot(t.tx, t.ty) > 0 || Math.hypot(t.x, t.y) > 1e-3;
  if (busy) lastBusy = now;
  const simulate = (busy || studio.dirty) && now - lastBusy < SETTLE_MS;
  if (simulate) {
    const forces = studio.update(dt);
    sim.step(dt, forces);
  } else if (Math.hypot(t.tx - t.x, t.ty - t.y) > 0) studio.update(dt);

  if (tilt.mode === 'sensor' && !demo.tilting) {
    view = [tilt.value.x, tilt.value.y];
    canvas.style.transform = '';
  } else {
    view = [t.x, t.y];
    const s = 1 - 0.12 * Math.min(1, Math.hypot(t.x, t.y) / P.tiltMax);
    canvas.style.transform = `scale(${s}) rotateX(${t.y * 22}deg) rotateY(${t.x * 22}deg)`;
  }
  const viewMoved = Math.hypot(view[0] - lastView[0], view[1] - lastView[1]) > 0.003;
  if (simulate || viewMoved || saveRequested || needsDraw) {
    sim.render(studio.overlay(view), canvas.width, canvas.height);
    lastView = view;
    needsDraw = false;
  }
  if (saveRequested) {
    saveRequested = false;
    saveImage();
  }

  const canLift = !!studio.cup && !studio.cup.lifting;
  if (canLift !== liftWasEnabled) {
    liftBtn.disabled = !canLift;
    liftWasEnabled = canLift;
  }
  requestAnimationFrame(frame);
}

setTool('pour', false);
selectPaint(0);
requestAnimationFrame(frame);

// debugging handle
Object.assign(window, { __pour: { get sim() { return sim; }, get studio() { return studio; }, get demo() { return demo; }, tilt, P } });
