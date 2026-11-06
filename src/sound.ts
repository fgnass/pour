// Synthesised sound effects (Web Audio, no samples).
// - torch: a gas burner. Quiet while the Torch tool is on, a full roar while
//   the flame points at the canvas.
// - pour: a cloud of viscous bubbles (bubble model after van den Doel).
// - swipe: a wet squelch that follows the finger speed.
// - lift: a slurp when the cup comes off.

export type SoundState = {
  torchTool: boolean;
  torchOn: boolean;
  pouring: boolean;
  intoCup: boolean;
  /** speed of the swiping finger (domain units / s), 0 when not swiping */
  swipe: number;
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
  private nextSquelch = 0;

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
    this.master.gain.value = 0.6;
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

    // bubbles go through a soft low-pass: thick paint, not water
    const glugLP = ctx.createBiquadFilter();
    glugLP.type = 'lowpass';
    glugLP.frequency.value = 2200;
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

  /**
   * One bubble (van den Doel): a sine at the bubble's resonance f, damped with
   * the rate d of a real bubble, and its pitch rises while it decays. Thick
   * paint damps more (visc > 1).
   */
  private bubble(t: number, f: number, gain: number, visc = 1.6, rise = 0.35) {
    const ctx = this.ctx!;
    const d = (0.13 * f + 0.0072 * f ** 1.5) * visc;
    const dur = 5 / d;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * (1 + rise * d * dur * 0.2), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.003, 1 / d);
    o.connect(g).connect(this.glugBus);
    o.start(t);
    o.stop(t + dur + 0.01);
  }

  /** A short wet squelch: band-passed noise whose pitch drops, sometimes with a tiny bubble. */
  private squelch(t: number, gain: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = rnd(2.5, 5);
    const f = rnd(500, 1300);
    const dur = rnd(0.04, 0.09);
    bp.frequency.setValueAtTime(f, t);
    bp.frequency.exponentialRampToValueAtTime(f * rnd(0.45, 0.7), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp).connect(g).connect(this.master);
    s.start(t, rnd(0, 2.5));
    s.stop(t + dur + 0.01);
    if (Math.random() < 0.35) this.bubble(t + rnd(0, dur), rnd(900, 1800), gain * 0.5, 2.5, 0.5);
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
    // the paint lets go of the cup: a few large bubbles, then smaller ones
    for (let i = 0; i < 9; i++) this.bubble(t + i * rnd(0.03, 0.08), rnd(220, 420) * (1 + i * 0.12), rnd(0.12, 0.25));
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
    const torchLevel = s.torchOn ? 0.08 : s.torchTool ? 0.03 : 0;
    if (s.torchTool && !this.torchWasOn) this.ignite(t);
    this.torchWasOn = s.torchTool;
    // a burner flutters: small random changes of loudness and colour
    this.flutter += (rnd(0.75, 1.25) - this.flutter) * 0.5;
    // fades in slowly, so turning it on does not startle
    this.torchGain.gain.setTargetAtTime(torchLevel * this.flutter, t, s.torchOn ? 0.08 : 0.25);
    this.roarLP.frequency.setTargetAtTime((s.torchOn ? 900 : 380) * rnd(0.85, 1.15), t, 0.05);
    this.roarGain.gain.setTargetAtTime(s.torchOn ? 1.15 : 1, t, 0.08);
    this.hissGain.gain.setTargetAtTime(s.torchOn ? 0.22 : 0.1, t, 0.08);

    // pour: bubbles in small clusters, like thick paint folding over itself
    if (s.pouring && t >= this.nextGlug) {
      const base = s.intoCup ? 380 : 300;
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) this.bubble(t + 0.01 + i * rnd(0.012, 0.04), rnd(base, base * 2.2), rnd(0.08, 0.22));
      this.nextGlug = t + rnd(0.05, 0.16);
    }

    // swipe: squelches, more and louder the faster the finger moves
    const k = Math.min(1, s.swipe / 0.8);
    if (k > 0.05 && t >= this.nextSquelch) {
      this.squelch(t + 0.005, 0.05 + 0.12 * k);
      this.nextSquelch = t + rnd(0.03, 0.09) / k;
    }
  }
}
