// Synthesised sound effects (Web Audio, no samples).
// - torch: a gas burner. Quiet while the Torch tool is on, a full roar while
//   the flame points at the canvas.
// - pour: a thick stream with viscous glugs.
// - flow: soft slosh and the odd glug while the paint runs (tilt).
// - lift: a slurp when the cup comes off.

export type SoundState = {
  torchTool: boolean;
  torchOn: boolean;
  pouring: boolean;
  intoCup: boolean;
  /** 0..1 how much the paint flows */
  flow: number;
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
  // pour + flow
  private streamGain!: GainNode;
  private streamBP!: BiquadFilterNode;
  private sloshGain!: GainNode;
  private nextGlug = 0;
  private nextFlowGlug = 0;

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

    // --- pour stream + flow slosh
    this.streamBP = ctx.createBiquadFilter();
    this.streamBP.type = 'bandpass';
    this.streamBP.frequency.value = 500;
    this.streamBP.Q.value = 0.9;
    this.streamGain = ctx.createGain();
    this.streamGain.gain.value = 0;
    this.loop(2.0).connect(this.streamBP).connect(this.streamGain).connect(this.master);
    const sloshLP = ctx.createBiquadFilter();
    sloshLP.type = 'lowpass';
    sloshLP.frequency.value = 260;
    this.sloshGain = ctx.createGain();
    this.sloshGain.gain.value = 0;
    this.loop(0.6).connect(sloshLP).connect(this.sloshGain).connect(this.master);

    // glugs go through a soft low-pass: thick paint, not water
    const glugLP = ctx.createBiquadFilter();
    glugLP.type = 'lowpass';
    glugLP.frequency.value = 1400;
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
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rnd(1.4, 2.0), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.glugBus);
    o.start(t);
    o.stop(t + dur + 0.02);
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
    g.gain.exponentialRampToValueAtTime(1.1, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    s.connect(bp).connect(g).connect(this.master);
    s.start(t, rnd(0, 2));
    s.stop(t + 0.4);
  }

  /** Slurp when the cup is lifted off the canvas. */
  lift() {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    for (let i = 0; i < 5; i++) this.glug(t + i * rnd(0.05, 0.09), rnd(110, 180) - i * 12, rnd(0.12, 0.2), 0.5);
    this.streamGain.gain.setTargetAtTime(0.35, t, 0.03);
    this.streamGain.gain.setTargetAtTime(0, t + 0.3, 0.15);
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
    const torchLevel = s.torchOn ? 0.75 : s.torchTool ? 0.22 : 0;
    if (s.torchTool && !this.torchWasOn) this.ignite(t);
    this.torchWasOn = s.torchTool;
    // a burner flutters: small random changes of loudness and colour
    this.flutter += (rnd(0.75, 1.25) - this.flutter) * 0.5;
    this.torchGain.gain.setTargetAtTime(torchLevel * this.flutter, t, s.torchTool ? 0.04 : 0.12);
    this.roarLP.frequency.setTargetAtTime((s.torchOn ? 900 : 380) * rnd(0.85, 1.15), t, 0.05);
    this.roarGain.gain.setTargetAtTime(s.torchOn ? 1.4 : 1, t, 0.08);
    this.hissGain.gain.setTargetAtTime(s.torchOn ? 0.22 : 0.1, t, 0.08);

    // pour: stream noise and glugs
    this.streamGain.gain.setTargetAtTime(s.pouring ? 0.16 : 0, t, s.pouring ? 0.05 : 0.12);
    this.streamBP.frequency.setTargetAtTime(s.intoCup ? 700 : 480, t, 0.1);
    if (s.pouring && t >= this.nextGlug) {
      const base = s.intoCup ? 230 : 160;
      this.glug(t + 0.01, rnd(base, base * 1.8), rnd(0.06, 0.14), rnd(0.25, 0.5));
      this.nextGlug = t + rnd(0.05, 0.22);
    }

    // flow: slosh + rare deep glugs
    const f = Math.max(0, Math.min(1, s.flow));
    this.sloshGain.gain.setTargetAtTime(f * 0.3 * rnd(0.7, 1.3), t, 0.15);
    if (f > 0.15 && t >= this.nextFlowGlug) {
      this.glug(t + 0.01, rnd(80, 150), rnd(0.12, 0.22), 0.25 * f);
      this.nextFlowGlug = t + rnd(0.25, 0.9) / f;
    }
  }
}
