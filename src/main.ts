import './style.css';
import { CupFill } from './cupfill';
import { Demo } from './demo';
import { initInstall } from './install';
import { mountIcons } from './icons';
import { M as MODEL, Studio } from './model';
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
const paletteSheet = $('#palettes');
// filling the cup (see cupfill.ts); a filled cup waits to be set down
const cupFill = new CupFill($('#cupfill'), $('#cupfill canvas'), $('#cupfill .cupfill-actions'), () => paint);
let cupReady = false;
// the paint runs into the cup: the step 'touch the cup' is done
cupFill.onChange = () => cupFill.pouringM !== null && guideDone();
/** an empty cup to fill */
function newCup(announce = true) {
  studio.cup = null;
  cupReady = false;
  cupFill.content.empty();
  cupFill.open();
  if (announce) guide(toolHint());
}
$('#cupSet').addEventListener('click', () => {
  if (cupFill.content.level() < 0.02) {
    guide('Touch the cup to pour paint into it first');
    return;
  }
  // the cup turns to the view from above and moves over the middle of the
  // canvas; there the canvas takes it over (held up: a tap sets it down)
  const r = (MODEL.cupR / sim.dom[0]) * layout.w;
  cupFill.setDown(layout.left + layout.w / 2, layout.top + layout.h / 2, r, () => {
    studio.placeCup(sim.dom[0] / 2, sim.dom[1] / 2, cupFill.content, true);
    // draw the canvas with the cup now, in the same frame as the fill view
    // goes away (else the cup is gone for a frame or two)
    sim.render(studio.overlay(lastView), canvas.width, canvas.height);
    cupFill.close();
    cupReady = true;
    wake();
    guide(toolHint());
  });
});
const paintsBar = $('.dock .paints');
const sheet = $('#sheet');
const startEl = $('#start');

// ---------------------------------------------------------------- setup
const qs = new URLSearchParams(location.search);
const coarse = matchMedia('(pointer: coarse)').matches;
const quality: Quality = {
  n: +(qs.get('n') ?? 0) || (coarse ? 200 : 288),
  np: +(qs.get('np') ?? 0) || (coarse ? 512 : 720),
  glitter: qs.get('glitter') !== '0',
};
// (a mark from the crash guard of earlier versions: not needed any more)
try {
  localStorage.removeItem('pour.boot');
} catch {
  /* no storage */
}

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

const SETTLE_MS = 8000;
/** a cup keeps the simulation going only while it moves, turns or fades (standing, it pours nothing) */
function cupBusy() {
  const c = studio.cup;
  return !!c && (Math.hypot(c.vx, c.vy) > 1e-3 || Math.hypot(c.tx - c.x, c.ty - c.y) > 1e-4 || Math.abs(c.omega) > 0.05 || c.alpha < 1);
} // keep simulating this long after the last activity
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

/** aspect of the view; a just installed PWA can start with a zero size, then use the screen */
const viewAspect = () => {
  const a = innerWidth / innerHeight;
  const s = screen.width / screen.height;
  return Math.min(4, Math.max(0.25, a > 0 && isFinite(a) ? a : s > 0 && isFinite(s) ? s : 9 / 16));
};
let sim: Sim;
try {
  sim = new Sim(g, viewAspect(), quality);
} catch (e) {
  // a shader this GPU does not accept: say so instead of hanging
  const info = `(view ${innerWidth}×${innerHeight}, aspect ${viewAspect().toFixed(3)}, n ${quality.n}, np ${quality.np}${quality.glitter ? ', glitter' : ''})`;
  showError('Your browser could not set up the paint simulation. ' + (e as Error).message.split('\n')[0] + ' ' + info);
  throw e;
}
let studio = new Studio(sim);
let demo = new Demo(studio);
const tilt = new TiltInput();
// dev only: script the studio from the console (used to make the app icon)
if (import.meta.env.DEV) Object.assign(window, { dev: { studio: () => studio, demo: () => demo, sim: () => sim, palettes: PALETTES, palette: (i: number) => usePalette(i), wake: () => wake() } });

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
  // no size yet (e.g. the first start of an installed PWA): wait for the next resize
  if (!W || !H) return;
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
/** what to do next: it stays until it is done (guideDone) or another step replaces it */
let guideText: string | null = null;
function showHint(text: string) {
  hintEl.innerHTML = '';
  const s = document.createElement('span');
  // (*Label*: the name of a button, shown in bold)
  text.split('*').forEach((part, i) => {
    if (i % 2) {
      const b = document.createElement('b');
      b.textContent = part;
      s.append(b);
    } else s.append(part);
  });
  // a step of the tutorial: an x ends the tutorial
  if (tutorial && text === guideText) {
    const x = document.createElement('button');
    x.className = 'hint-close';
    x.setAttribute('aria-label', 'End the tutorial');
    x.textContent = '×';
    x.addEventListener('click', endTutorial);
    s.append(x);
  }
  hintEl.append(s);
  hintEl.classList.add('show');
  clearTimeout(hintTimer);
}
/** a short note; then the open step (if any) shows again */
function hint(text: string, ms = 4000) {
  showHint(text);
  hintTimer = window.setTimeout(() => (guideText && !tutorial?.hidden ? showHint(guideText) : hintEl.classList.remove('show')), ms);
}
/** the next step: it stays until the user does it (the tutorial has its own steps) */
function guide(text: string) {
  if (tutorial) return;
  guideText = text;
  showHint(text);
}
/** the user did what the open step asked */
function guideDone() {
  if (tutorial || guideText === null) return;
  guideText = null;
  // (it fades out a moment after the user began; a new step stops that)
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hintEl.classList.remove('show'), 500);
}

// ---------------------------------------------------------------- tutorial
// "How it works": one step after the other, on the canvas as it is. Each
// step looks at what goes on (every frame) and is done when the user did it.
// While the user is at it, the step's hint fades out; when they stop before
// the step is done, it comes back.
type Step = { text: string; done: (dt: number, s: StepState) => boolean; on?: (s: StepState) => boolean };
type StepState = { t: number; m: number; d: number };
let tutorial: { i: number; s: StepState; busy: number; idle: number; hidden: boolean } | null = null;
/** the user held the action on for `sec` seconds and has let go */
const heldFor = (on: boolean, sec: number, s: StepState, dt: number) => {
  if (on) s.t += dt;
  return !on && s.t >= sec;
};
const STEPS: Step[] = [
  {
    text: 'Choose a colour below, then hold a finger on the canvas to pour it',
    on: () => !!studio.pour,
    done: (dt, s) => {
      if (studio.pour) s.m = studio.pour.m;
      return tool === 'pour' && heldFor(!!studio.pour, 0.8, s, dt);
    },
  },
  {
    text: 'Take another colour and pour it into the first one',
    on: s => !!studio.pour && studio.pour.m !== s.m,
    done: (dt, s) => {
      return heldFor(!!studio.pour && studio.pour.m !== s.m, 0.8, s, dt);
    },
  },
  { text: 'Now tap *Cup*: you fill a cup with layers of paint', done: () => cupFill.isOpen },
  {
    text: 'Touch the cup to pour paint in · change the colour now and then for layers',
    on: () => cupFill.pouringM !== null,
    done: () => {
      const c = cupFill.content;
      return cupFill.pouringM === null && (c.level() > 0.4 || (c.level() > 0.15 && new Set(c.pours.map(p => p.m)).size > 1));
    },
  },
  { text: 'Tap *Done* when you like the layers', done: () => cupReady },
  { text: 'Tap the canvas where the cup should stand', done: () => !!studio.cup && !studio.cup.lifted },
  {
    text: 'Drag the cup slowly over the canvas: the paint runs out under its rim',
    on: () => !!drag && tool === 'cup',
    done: (dt, s) => {
      const c = studio.cup;
      if (!c) return true;
      s.d += Math.hypot(c.vx, c.vy) * dt;
      return s.d > 0.4 || c.content.level() < 0.01;
    },
  },
  { text: 'Tap *Swipe* and drag through the wet paint to push it', on: () => tool === 'swipe' && !!studio.push, done: (dt, s) => tool === 'swipe' && heldFor(!!studio.push && !!drag?.moved, 0.6, s, dt) },
  {
    text: coarse ? 'Tap *Tilt*, then tilt your phone: the paint runs downhill' : 'Tap *Tilt*, then drag the canvas (or use the arrow keys): the paint runs downhill',
    on: () => tool === 'tilt' && Math.hypot(studio.tilt.x, studio.tilt.y) > 0.25 * P.tiltMax,
    done: (dt, s) => {
      const t = studio.tilt;
      if (tool === 'tilt' && Math.hypot(t.x, t.y) > 0.25 * P.tiltMax) s.t += dt;
      return s.t > 1;
    },
  },
  { text: 'Tap *Torch* and move the flame over the paint: cells open and show the colours below', on: () => !!studio.torch, done: (dt, s) => heldFor(!!studio.torch, 2, s, dt) },
];
function startTutorial() {
  demo.stop();
  // (it starts with pouring)
  setTool('pour', false);
  tutorial = { i: -1, s: { t: 0, m: -1, d: 0 }, busy: 0, idle: 0, hidden: false };
  nextStep();
}
function nextStep() {
  if (!tutorial) return;
  tutorial.i++;
  tutorial.s = { t: 0, m: tutorial.s.m, d: 0 };
  tutorial.busy = tutorial.idle = 0;
  tutorial.hidden = false;
  if (tutorial.i >= STEPS.length) {
    tutorial = null;
    guideText = null;
    hint("That's it – have fun!", 4000);
    return;
  }
  guideText = STEPS[tutorial.i].text;
  showHint(guideText);
}
function endTutorial() {
  tutorial = null;
  guideText = null;
  clearTimeout(hintTimer);
  hintEl.classList.remove('show');
}
function tutorialTick(dt: number) {
  if (!tutorial || demo.active) return;
  const tu = tutorial,
    st = STEPS[tu.i];
  if (st.done(dt, tu.s)) {
    navigator.vibrate?.(10);
    nextStep();
    return;
  }
  if (st.on?.(tu.s)) {
    tu.busy += dt;
    tu.idle = 0;
  } else {
    tu.idle += dt;
    tu.busy = 0;
  }
  if (!tu.hidden && tu.busy > 0.4) {
    tu.hidden = true;
    clearTimeout(hintTimer);
    hintEl.classList.remove('show');
  } else if (tu.hidden && tu.idle > 1.2) {
    tu.hidden = false;
    showHint(guideText!);
  }
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
  // with the Cup tool the paints fill the cup (hold one to pour it in)
  if (tool === 'cup') return;
  if (tool !== 'pour') setTool('pour', false);
  if (announce) guide(`${MATS[m].name} – hold to pour`);
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
type Tool = 'pour' | 'cup' | 'swipe' | 'torch' | 'tilt' | 'none';
let tool: Tool = 'pour';
function toolHint() {
  switch (tool) {
    case 'pour':
      return `Hold to pour ${MATS[paint].name.toLowerCase()}`;
    case 'cup':
      if (cupFill.isOpen) return 'Choose a colour, then touch the cup: the paint runs down through your finger';
      if (cupReady) return 'Tap the canvas to set the cup down';
      if (studio.cup && studio.cup.content.level() <= 0.003) return 'Drag the empty cup to push the paint · tap *Cup* for a new one';
      if (studio.cup) return 'Drag the cup to pour · grab the rim to turn it';
      return 'Tap *Cup* to fill a new cup';
    case 'swipe':
      return 'Drag through wet paint to push it';
    case 'torch':
      return 'Move the flame over the paint: cells bring up the colours below';
    case 'none':
      return 'Pick a tool';
    case 'tilt':
      if (tilt.mode === 'sensor') return 'Tilt your phone · tap the canvas to level again';
      if (tilt.mode === 'pending') return 'Tilt your phone …';
      return coarse ? 'No tilt sensor: drag to tilt the canvas' : 'Drag or use the arrow keys to tilt the canvas';
  }
}
function setTool(t: Tool, announce = true) {
  if (t === 'tilt' && tool !== 'tilt') startTilt();
  // the cup is only there while the Cup tool is on
  if (t !== 'cup') {
    studio.cup = null;
    cupReady = false;
    cupFill.close();
  }
  const fresh = t === 'cup' && tool !== 'cup';
  tool = t;
  // a new cup: fill it first
  if (fresh) newCup(false);
  document.querySelectorAll<HTMLElement>('#tools button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
  // paints only matter while pouring or filling the cup
  paintsBar.classList.toggle('off', t !== 'pour' && t !== 'cup');
  if (t !== 'pour' && t !== 'cup') paletteSheet.hidden = true;
  if (announce) guide(toolHint());
}
document.querySelectorAll<HTMLElement>('#tools button').forEach(b =>
  b.addEventListener('click', () => {
    // a second tap turns the cup, the torch or tilt off: then no tool is on
    // (the cup goes away, filled or not)
    if ((b.dataset.tool === 'cup' || b.dataset.tool === 'torch' || b.dataset.tool === 'tilt') && tool === b.dataset.tool) {
      setTool('none', false);
      guideText = null;
      hint(b.dataset.tool === 'tilt' ? 'Tilt off – the canvas lies flat' : b.dataset.tool === 'cup' ? 'Cup put away' : 'Torch off');
    }
    else setTool(b.dataset.tool as Tool);
  }),
);

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
  /** started on the cup: drag to move it */
  onCup: boolean;
  /** from the finger to the middle of the cup */
  gx: number;
  gy: number;
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
  // (the canvas did what the hint asked; setting a held cup down gives the next step)
  guideDone();
  drag = { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), vx: 0, vy: 0, cx: 0, cy: 0, moved: false, onCup: false, gx: 0, gy: 0 };
  const cup = studio.cup;
  if (tool === 'cup') {
    drag.onCup = true;
    if (cupReady && cup) {
      // set the held cup down: where it is when it is touched (then drag it
      // on), else at the tap
      if (studio.hitsCup(p.x, p.y, 1.3)) {
        drag.gx = cup.tx - p.x;
        drag.gy = cup.ty - p.y;
      } else {
        cup.x = cup.tx = cup.mx = p.x;
        cup.y = cup.ty = cup.my = p.y;
        cup.vx = cup.vy = 0;
      }
      cup.lifted = false;
      cupReady = false;
      navigator.vibrate?.(12);
      guide('Drag the cup to pour · grab the rim to turn it');
    } else if (cup && studio.hitsCup(p.x, p.y, 1.3)) {
      // grabbed: where it was touched stays under the finger
      drag.gx = cup.tx - p.x;
      drag.gy = cup.ty - p.y;
    } else if (cup) {
      // somewhere else: the cup is lifted and set down there, no paint on the way
      cup.x = cup.tx = cup.mx = p.x;
      cup.y = cup.ty = cup.my = p.y;
      cup.vx = cup.vy = 0;
    } else {
      drag.onCup = false;
      newCup();
    }
  } else if (tool === 'pour') {
    studio.pour = { m: paint, x: p.x, y: p.y };
    markPouring(true);
  } else if (tool === 'swipe') {
    studio.push = { x: p.x, y: p.y, vx: 0, vy: 0, r: 0.055 };
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
    if (!cup) return;
    // Held near the middle, the cup only moves. Held at the rim, it is
    // pulled along by that point: the rest of it trails behind and turns.
    const g = Math.hypot(drag.gx, drag.gy);
    if (g > cup.R * 0.4) {
      const bx = cup.tx - p.x,
        by = cup.ty - p.y,
        l = Math.hypot(bx, by) || 1;
      const nx = (bx / l) * g,
        ny = (by / l) * g;
      let da = Math.atan2(ny, nx) - Math.atan2(drag.gy, drag.gx);
      da -= Math.round(da / (Math.PI * 2)) * Math.PI * 2;
      studio.turnCup(da);
      cup.omega = cup.omega * 0.5 + (da / dt) * 0.5;
      drag.gx = nx;
      drag.gy = ny;
    }
    const [W, H] = sim.dom;
    cup.tx = Math.min(W, Math.max(0, p.x + drag.gx));
    cup.ty = Math.min(H, Math.max(0, p.y + drag.gy));
  } else if (tool === 'pour' && studio.pour) {
    Object.assign(studio.pour, { x: p.x, y: p.y });
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
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function markPouring(on: boolean) {
  paintsEl.querySelector(`[data-m="${paint}"]`)?.classList.toggle('pouring', on);
}

// ---------------------------------------------------------------- actions
// install
const installHelp = $('#installHelp');
const install = initInstall([$('#installBtn'), $('[data-act="install"]')], text => {
  installHelp.textContent = text;
  installHelp.hidden = false;
  startEl.hidden = false;
  startEl.classList.remove('gone');
});
$('#installBtn').addEventListener('click', install);

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
  else if (act === 'install') install();
  else if (act === 'help') startTutorial();
});

function onDemoChange(active: boolean) {
  if (active) cupFill.close();
  // (the demo ends the tutorial)
  if (active) {
    tutorial = null;
    guideText = null;
  }
  if (active) hint('Demo – touch the canvas to take over', 3000);
}
demo.onChange = onDemoChange;

// keyboard (desktop): 1–6 paints, arrows tilt
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
  }
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
  if (tool === 'tilt') guide(toolHint());
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
  } else guide(toolHint());
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
    demo.active || !!drag || !!studio.pour || !!studio.push || !!studio.torch || cupBusy() ||
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
  tutorialTick(rdt);
  // tilted far enough: the step 'tilt …' is done
  if (tool === 'tilt' && Math.hypot(t.x, t.y) > 0.25 * P.tiltMax) guideDone();
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

  const pour = studio.pour;
  sound.update({
    torchTool: tool === 'torch' && started,
    torchOn: !!studio.torch,
    pouring: !!pour || cupFill.pouringM !== null,
    intoCup: cupFill.pouringM !== null,
    // only while the finger really moves (the velocity stays when it rests)
    swipe: studio.push && drag && now - drag.t < 80 ? Math.hypot(studio.push.vx, studio.push.vy) : 0,
    cupDrag: studio.cup ? Math.hypot(studio.cup.vx, studio.cup.vy) : 0,
  });
}

setTool('pour', false);
usePalette(paletteIdx);
selectPaint(0);
requestAnimationFrame(frame);

// debugging handle
Object.assign(window, { __pour: { get sim() { return sim; }, get studio() { return studio; }, get demo() { return demo; }, cupFill, tilt, sound, P } });
