// Device tilt -> tilt of the canvas.
//
// The gravity vector comes from `deviceorientation` (consistent across
// browsers, unlike the sign of `accelerationIncludingGravity`). People hold a
// phone at an angle, so the tilt is relative to a reference pose: "level"
// stores the current pose as flat.

type V3 = [number, number, number];

const DEG = Math.PI / 180;
const norm = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rotates v by the shortest rotation that takes `from` to `to` (unit vectors). */
function rotateBetween(v: V3, from: V3, to: V3): V3 {
  const c = dot(from, to);
  if (c > 1 - 1e-9) return v;
  let axis = cross(from, to);
  if (c < -1 + 1e-9) axis = Math.abs(from[0]) < 0.9 ? cross(from, [1, 0, 0]) : cross(from, [0, 1, 0]);
  const k = norm(axis);
  const s = Math.sqrt(Math.max(0, 1 - c * c));
  // Rodrigues
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

export type TiltMode = 'pending' | 'sensor' | 'manual';

export class TiltInput {
  mode: TiltMode = 'pending';
  /** gravity direction in device coordinates (x right, y up, z out of the screen) */
  private g: V3 = [0, 0, -1];
  private ref: V3 = [0, 0, -1];
  private hasRef = false;
  /** tilt in screen coordinates: direction in which paint flows, |v| = sin(angle) */
  readonly value = { x: 0, y: 0 };
  onMode?: (m: TiltMode) => void;

  /** Call from a user gesture (iOS asks for permission). */
  async start() {
    const DOE = (window as any).DeviceOrientationEvent;
    if (!DOE) return this.setMode('manual');
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return this.setMode('manual');
      } catch {
        return this.setMode('manual');
      }
    }
    addEventListener('deviceorientation', this.onOrientation);
    // desktop browsers have the event but never send real values
    setTimeout(() => {
      if (this.mode === 'pending') this.setMode('manual');
    }, 1500);
  }

  private setMode(m: TiltMode) {
    if (m === 'manual') removeEventListener('deviceorientation', this.onOrientation);
    this.mode = m;
    this.onMode?.(m);
  }

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    const b = e.beta * DEG,
      c = e.gamma * DEG;
    // world "down" in device coordinates for intrinsic Z-X'-Y'' angles
    this.g = norm([Math.sin(c) * Math.cos(b), -Math.sin(b), -Math.cos(c) * Math.cos(b)]);
    if (!this.hasRef) this.level();
    if (this.mode === 'pending') this.setMode('sensor');
    this.compute();
  };

  /** Takes the current pose as flat. */
  level() {
    this.ref = this.g;
    this.hasRef = true;
    this.compute();
  }

  private compute() {
    const r = rotateBetween(this.g, this.ref, [0, 0, -1]);
    // device -> screen coordinates
    const a = ((screen.orientation?.angle ?? (window as any).orientation ?? 0) as number) * DEG;
    const ca = Math.cos(a),
      sa = Math.sin(a);
    this.value.x = ca * r[0] - sa * r[1];
    this.value.y = sa * r[0] + ca * r[1];
  }
}
