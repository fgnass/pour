import './style.css';
import { Demo } from './demo';
import { mountIcons } from './icons';
import { Studio } from './model';
import { GL } from './sim/gl';
import { MATS, PALETTES, setPalette, type Material } from './sim/materials';
import { P, Sim, type Quality } from './sim/sim';
import { Sound } from './sound';
import { TiltInput } from './tilt';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

mountIcons();

const canvas = $<HTMLCanvasElement>('#gl');
const hintEl = $('#hint');
const paintsEl = $('#paints');
const cupBtn = $<HTMLButtonElement>('#tools [data-tool="cup"]');
const paletteSheet = $('#palettes');
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

// sound: on by default, the choice is kept
const SOUND_KEY = 'pour.sound';
const sound = new Sound();
try {
  sound.enabled = localStorage.getItem(SOUND_KEY) !== 'off';
} catch {
  /* no storage */
}
// browsers start audio only after a user gesture
for (const ev of ['pointerdown', 'keydown'] as const) addEventListener(ev, () => sound.unlock(), { capture: true });
const soundBtn = $<HTMLButtonElement>('[data-act="sound"]');
const syncSoundBtn = () => (soundBtn.textContent = sound.enabled ? 'Sound: on' : 'Sound: off');
syncSoundBtn();

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
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
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

/** swatch background: metal gets a highlight, pearl a shimmer in its sheen colour */
function swatchBg(m: Material) {
  if (m.finish === 'metal') return `linear-gradient(135deg, rgba(255,255,255,0.6), transparent 45%, rgba(0,0,0,0.25)), ${m.hex}`;
  if (m.finish === 'pearl') return `linear-gradient(135deg, ${m.sheen}aa, transparent 55%), ${m.hex}`;
  return m.hex;
}

function buildSwatches() {
  paintsEl.innerHTML = '';
  for (const m of PAINT_ORDER) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', MATS[m].name);
    b.dataset.m = String(m);
    const i = document.createElement('i');
    i.style.background = swatchBg(MATS[m]);
    b.append(i);
    b.addEventListener('click', () => selectPaint(m, true));
    paintsEl.append(b);
  }
}
function selectPaint(m: number, announce = false) {
  paint = m;
  paintsEl.querySelectorAll<HTMLElement>('.swatch').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.m! === m)));
  if (tool !== 'pour') setTool('pour', false);
  if (announce) hint(studio.cup && !studio.cup.lifting ? `${MATS[m].name} – hold on the cup to pour it in` : `${MATS[m].name} – hold to pour`);
}

// palettes: the choice is kept for the next visit. Paint on the canvas takes
// the new colours too, so you can compare palettes on the same picture.
const PALETTE_KEY = 'pour.palette';
let paletteIdx = 0;
try {
  paletteIdx = Math.max(0, PALETTES.findIndex(p => p.name === localStorage.getItem(PALETTE_KEY)));
} catch {
  /* no storage */
}
function usePalette(i: number, announce = false) {
  paletteIdx = i;
  setPalette(PALETTES[i]);
  buildSwatches();
  paintsEl.querySelector(`[data-m="${paint}"]`)?.setAttribute('aria-checked', 'true');
  wake();
  try {
    localStorage.setItem(PALETTE_KEY, PALETTES[i].name);
  } catch {
    /* no storage */
  }
  if (announce) hint(PALETTES[i].name, 2000);
}
const palettePanel = paletteSheet.querySelector('.sheet-panel')!;
function buildPaletteSheet() {
  palettePanel.innerHTML = '';
  PALETTES.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pal';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(i === paletteIdx));
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (const d of p.paints) {
      const [name, hex, finish = 'matte', sheen = '#ffffff'] = d;
      const dot = document.createElement('i');
      dot.style.background = swatchBg({ name, hex, finish, sheen } as Material);
      dots.append(dot);
    }
    const label = document.createElement('span');
    label.textContent = p.name;
    b.append(label, dots);
    b.addEventListener('click', () => usePalette(i, true));
    palettePanel.append(b);
  });
}
$('#paletteBtn').addEventListener('click', () => {
  buildPaletteSheet();
  paletteSheet.hidden = false;
});
paletteSheet.addEventListener('click', () => (paletteSheet.hidden = true));

// ---------------------------------------------------------------- tools
type Tool = 'pour' | 'cup' | 'swipe' | 'torch' | 'tilt';
let tool: Tool = 'pour';
function toolHint() {
  switch (tool) {
    case 'pour':
      return studio.cup && !studio.cup.lifting
        ? 'Hold on the cup to pour into it · drag the cup to move it'
        : `Hold to pour ${MATS[paint].name.toLowerCase()}`;
    case 'cup':
      if (studio.cup?.lifting) return 'Lifting the cup …';
      return 'Tap to set the cup into the paint';
    case 'swipe':
      return 'Drag through wet paint to push it';
    case 'torch':
      return 'Move the flame over the paint to make cells';
    case 'tilt':
      if (tilt.mode === 'sensor') return 'Tilt your phone · tap the canvas to level again';
      if (tilt.mode === 'pending') return 'Tilt your phone …';
      return coarse ? 'No tilt sensor: drag to tilt the canvas' : 'Drag or use the arrow keys to tilt the canvas';
  }
}
function setTool(t: Tool, announce = true) {
  if (t === 'tilt' && tool !== 'tilt') startTilt();
  tool = t;
  document.querySelectorAll<HTMLElement>('#tools button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
  if (announce) hint(toolHint());
}
document.querySelectorAll<HTMLElement>('#tools button').forEach(b =>
  b.addEventListener('click', () => {
    // with a cup on the canvas, the cup button lifts it
    if (b === cupBtn && cupOnCanvas) lift();
    else setTool(b.dataset.tool as Tool);
  }),
);

// The cup button is the Cup tool, or Lift while a cup is on the canvas.
let cupOnCanvas = false;
const CUP_HTML = cupBtn.innerHTML;
const LIFT_HTML = '<span class="icon" data-icon="upload"></span><span>Lift</span>';
function syncCupBtn() {
  const on = !!studio.cup && !studio.cup.lifting;
  if (on === cupOnCanvas) return;
  cupOnCanvas = on;
  cupBtn.innerHTML = on ? LIFT_HTML : CUP_HTML;
  cupBtn.setAttribute('role', on ? 'button' : 'radio');
  cupBtn.classList.toggle('lift', on);
  mountIcons(cupBtn);
  if (on && tool === 'cup') setTool('pour', false);
  cupBtn.setAttribute('aria-checked', String(tool === 'cup'));
}

// ---------------------------------------------------------------- canvas gestures
type Drag = {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  t: number;
  vx: number;
  vy: number;
  cx: number;
  cy: number;
  moved: boolean;
  /** started on the cup: hold to pour into it, drag to move it */
  onCup: boolean;
};
let drag: Drag | null = null;
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
  drag = { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), vx: 0, vy: 0, cx: 0, cy: 0, moved: false, onCup: false };
  const cup = studio.cup;
  if (cup && tool !== 'tilt' && studio.hitsCup(p.x, p.y, 1.3)) {
    drag.onCup = true;
    drag.cx = cup.tx;
    drag.cy = cup.ty;
    if (tool === 'pour') {
      studio.pour = { m: paint, x: cup.x, y: cup.y };
      markPouring(true);
    }
  } else if (tool === 'pour') {
    studio.pour = { m: paint, x: p.x, y: p.y };
    markPouring(true);
  } else if (tool === 'cup' && !cup) {
    studio.placeCup(p.x, p.y);
    navigator.vibrate?.(12);
    drag.onCup = true;
    drag.cx = p.x;
    drag.cy = p.y;
  } else if (tool === 'swipe') {
    studio.push = { x: p.x, y: p.y, vx: 0, vy: 0, r: 0.045 };
  } else if (tool === 'torch') {
    studio.torch = { x: p.x, y: p.y };
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
  if (drag.onCup) {
    const cup = studio.cup;
    if (!cup || cup.lifting) return;
    if (drag.moved) {
      // dragging moves the cup; pouring stops while it moves
      if (studio.pour) {
        studio.pour = null;
        markPouring(false);
      }
      const [W, H] = sim.dom;
      cup.tx = Math.min(W, Math.max(0, drag.cx + p.x - drag.sx));
      cup.ty = Math.min(H, Math.max(0, drag.cy + p.y - drag.sy));
    } else if (studio.pour) {
      studio.pour.x = cup.x;
      studio.pour.y = cup.y;
    }
  } else if (tool === 'pour' && studio.pour) {
    studio.pour.x = p.x;
    studio.pour.y = p.y;
  } else if (tool === 'swipe' && studio.push) {
    Object.assign(studio.push, { x: p.x, y: p.y, vx: drag.vx, vy: drag.vy });
  } else if (tool === 'torch' && studio.torch) {
    studio.torch.x = p.x;
    studio.torch.y = p.y;
  } else if (tool === 'tilt' && tilt.mode !== 'sensor') {
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
  studio.torch = null;
  markPouring(false);
  if (tool === 'tilt') {
    manualTilt.x = manualTilt.y = 0;
    if (tilt.mode === 'sensor' && !d.moved) levelNow();
  }
  if (tool === 'cup' && d.onCup && studio.cup && !studio.cup.lifting) {
    // freshly placed: next step is pouring into it
    setTool('pour', false);
    syncCupBtn();
    hint('Hold on the cup to pour colours into it');
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
  else if (act === 'sound') {
    sound.setEnabled(!sound.enabled);
    syncSoundBtn();
    try {
      localStorage.setItem(SOUND_KEY, sound.enabled ? 'on' : 'off');
    } catch {
      /* no storage */
    }
  }
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
  studio.torch = null;
});

// ---------------------------------------------------------------- tilt + start
// Tilt acts only while the Tilt tool is on. Turning it on (or tapping the
// canvas) takes the current pose as flat. The sensor permission is asked on
// the first use (iOS needs a user gesture).
let tiltStarted = false;
function startTilt() {
  wake();
  if (!tiltStarted) {
    tiltStarted = true;
    tilt.start();
  } else if (tilt.mode === 'sensor') tilt.level();
}
function levelNow() {
  wake();
  tilt.level();
  navigator.vibrate?.(10);
  hint('Level: this pose is flat now', 2000);
}
tilt.onMode = () => {
  if (tool === 'tilt') hint(toolHint());
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
  const visible = document.visibilityState === 'visible';
  if (visible && wakeLock) keepAwake();
  sound.setVisible(visible);
});

let started = false;
function begin(withDemo: boolean) {
  startEl.classList.add('gone');
  setTimeout(() => (startEl.hidden = true), 400);
  if (!started) {
    started = true;
    keepAwake();
  }
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

// 30 fps is enough for flowing paint and halves the GPU load
const FRAME_MS = 1000 / (+(qs.get('fps') ?? 0) || 30);

function frame(now: number) {
  requestAnimationFrame(frame);
  if (now - last < FRAME_MS - 2) return;
  const rdt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  // never exceed the stable step: slow the simulation down instead
  const dt = Math.max(1e-4, Math.min(rdt, sim.maxDt()));
  demo.tick();

  const t = studio.tilt;
  let view: [number, number];
  if (!demo.tilting) {
    if (tool !== 'tilt') {
      // tilt is off: the canvas lies flat (arrow keys still work on desktop)
      const kx = (keysTilt.ArrowRight ? 1 : 0) - (keysTilt.ArrowLeft ? 1 : 0);
      const ky = (keysTilt.ArrowUp ? 1 : 0) - (keysTilt.ArrowDown ? 1 : 0);
      t.tx = kx * P.tiltMax * 0.75;
      t.ty = ky * P.tiltMax * 0.75;
    } else if (tilt.mode === 'sensor') {
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
    demo.active || !!drag || !!studio.pour || !!studio.push || !!studio.torch || !!studio.cup ||
    Math.hypot(t.tx, t.ty) > 0 || Math.hypot(t.x, t.y) > 1e-3;
  if (busy) lastBusy = now;
  const simulate = (busy || studio.dirty) && now - lastBusy < SETTLE_MS;
  if (simulate) {
    const forces = studio.update(dt);
    sim.step(dt, forces);
  } else if (Math.hypot(t.tx - t.x, t.ty - t.y) > 0) studio.update(dt);

  if (tilt.mode === 'sensor' && tool === 'tilt' && !demo.tilting) {
    view = [tilt.value.x, tilt.value.y];
    canvas.style.transform = '';
  } else {
    view = [t.x, t.y];
    // 3D transform only while tilted: a permanent one keeps the canvas on a 3D layer
    const m = Math.hypot(t.x, t.y);
    const s = 1 - 0.12 * Math.min(1, m / P.tiltMax);
    canvas.style.transform = m > 1e-3 ? `scale(${s}) rotateX(${t.y * 22}deg) rotateY(${t.x * 22}deg)` : '';
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

  syncCupBtn();

  const pour = studio.pour;
  sound.update({
    torchTool: tool === 'torch' && started,
    torchOn: !!studio.torch,
    pouring: !!pour,
    intoCup: !!pour && studio.hitsCup(pour.x, pour.y, 1.15),
    flow: simulate ? Math.hypot(t.x, t.y) / P.tiltMax : 0,
  });
  const lifting = !!studio.cup?.lifting;
  if (lifting && !wasLifting) sound.lift();
  wasLifting = lifting;
}
let wasLifting = false;

setTool('pour', false);
usePalette(paletteIdx);
selectPaint(0);
requestAnimationFrame(frame);

// debugging handle
Object.assign(window, { __pour: { get sim() { return sim; }, get studio() { return studio; }, get demo() { return demo; }, tilt, sound, P } });
