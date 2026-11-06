// Synthesised sound effects (Web Audio, no samples).
// - torch: a gas burner. Quiet while the Torch tool is on, a full roar while
//   the flame points at the canvas.
// - pour: slow, viscous glugs (no stream noise: the paint is thick).
// - lift: a slurp when the cup comes off.

export type SoundState = {
  torchTool: boolean;
  torchOn: boolean;
  pouring: boolean;
  intoCup: boolean;
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Sound {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private glugBus!: GainNode;
  private noise!: AudioBuffer;
  // torch
  private torchGain!: GainNode;
  private roarLP!: BiquadFilterNode;
  private roarGain!: GainNode;
  private hissGain!: GainNode;
  private flutter = 1;
  private torchWasOn = false;
  // pour
  private nextGlug = 0;

  /** Call from a user gesture: browsers only start audio after one. */
  unlock() {
    if (!this.enabled) return;
    if (!this.ctx) {
      try {
        this.build();
      } catch {
        this.enabled = false;
        return;
      }
    }
    if (this.ctx!.state === 'suspended') this.ctx!.resume().catch(() => {});
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.unlock();
    else this.ctx?.suspend().catch(() => {});
  }

  /** Pause audio while the page is hidden. */
  setVisible(v: boolean) {
    if (!this.ctx || !this.enabled) return;
    if (v) this.ctx.resume().catch(() => {});
    else this.ctx.suspend().catch(() => {});
  }

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp).connect(ctx.destination);

    // 3 s of pink-ish noise, looped
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + 0.029591 * w;
      b1 = 0.985 * b1 + 0.032534 * w;
      b2 = 0.95 * b2 + 0.048056 * w;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 1.6;
    }

    // --- torch: low roar + hiss, both from noise
    this.torchGain = ctx.createGain();
    this.torchGain.gain.value = 0;
    this.torchGain.connect(this.master);
    this.roarLP = ctx.createBiquadFilter();
    this.roarLP.type = 'lowpass';
    this.roarLP.frequency.value = 350;
    this.roarLP.Q.value = 0.8;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 1;
    this.loop(0).connect(this.roarLP).connect(this.roarGain).connect(this.torchGain);
    const hissBP = ctx.createBiquadFilter();
    hissBP.type = 'bandpass';
    hissBP.frequency.value = 3200;
    hissBP.Q.value = 0.6;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0.12;
    this.loop(1.1).connect(hissBP).connect(this.hissGain).connect(this.torchGain);

    // glugs go through a soft low-pass: thick paint, not water
    const glugLP = ctx.createBiquadFilter();
    glugLP.type = 'lowpass';
    glugLP.frequency.value = 900;
    this.glugBus = ctx.createGain();
    this.glugBus.gain.value = 0.9;
    this.glugBus.connect(glugLP).connect(this.master);
  }

  private loop(offset: number) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, offset);
    return s;
  }

  /** One bubble: a sine whose pitch rises while it decays. */
  private glug(t: number, f: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.018);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.glugBus);
    // thick paint: the bubble rises slowly in pitch, with a quiet second partial
    const rise = rnd(1.25, 1.6);
    for (const [k, a] of [
      [1, 1],
      [2.4, 0.18],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * k, t);
      o.frequency.exponentialRampToValueAtTime(f * k * rise, t + dur);
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
  }

  /** Ignition: a short gas puff when the torch comes on. */
  private ignite(t: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(1800, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    s.connect(bp).connect(g).connect(this.master);
    s.start(t, rnd(0, 2));
    s.stop(t + 0.4);
  }

  /** Slurp when the cup is lifted off the canvas. */
  lift() {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    for (let i = 0; i < 4; i++) this.glug(t + i * rnd(0.08, 0.14), rnd(90, 140) - i * 8, rnd(0.18, 0.28), 0.4);
  }

  private ready() {
    return this.enabled && !!this.ctx && this.ctx.state === 'running';
  }

  /** Call once per frame with what is going on. */
  update(s: SoundState) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    // torch
    const torchLevel = s.torchOn ? 0.22 : s.torchTool ? 0.05 : 0;
    if (s.torchTool && !this.torchWasOn) this.ignite(t);
    this.torchWasOn = s.torchTool;
    // a burner flutters: small random changes of loudness and colour
    this.flutter += (rnd(0.75, 1.25) - this.flutter) * 0.5;
    // fades in slowly, so turning it on does not startle
    this.torchGain.gain.setTargetAtTime(torchLevel * this.flutter, t, s.torchOn ? 0.08 : 0.25);
    this.roarLP.frequency.setTargetAtTime((s.torchOn ? 900 : 380) * rnd(0.85, 1.15), t, 0.05);
    this.roarGain.gain.setTargetAtTime(s.torchOn ? 1.4 : 1, t, 0.08);
    this.hissGain.gain.setTargetAtTime(s.torchOn ? 0.22 : 0.1, t, 0.08);

    // pour: slow, viscous glugs
    if (s.pouring && t >= this.nextGlug) {
      const base = s.intoCup ? 150 : 105;
      this.glug(t + 0.01, rnd(base, base * 1.6), rnd(0.14, 0.26), rnd(0.3, 0.5));
      this.nextGlug = t + rnd(0.16, 0.42);
    }
  }
}
