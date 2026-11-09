// Sound effects (Web Audio).
// - torch: synthesised gas burner. Quiet while the Torch tool is on, louder
//   while the flame points at the canvas.
// - pour: a recording of pouring oil, played slower so it sounds thick.
//   Onto the canvas it is muffled and flat; into the cup it rings hollow.
// - cup: dragging the cup through the paint squelches, lower than a swipe.
// - swipe: single squelches cut from a recording of slippery jelly; the
//   faster the finger, the more of them.
// - lift: a short burst of the pour recording.
// Recordings (CC0, freesound.org): "Pouring oil.wav" by clement.bernardeau,
// "Guck, Slime, slippery Jelly" by breiti.
import swipeEvents from './swipe-events.json';

const POUR_RATE = 0.45; // onto the canvas
const CUP_POUR_RATE = 0.52; // into the cup
const SWIPE_RATE = 0.7;
const CUP_DRAG_RATE = 0.5;

export type SoundState = {
  torchTool: boolean;
  torchOn: boolean;
  pouring: boolean;
  intoCup: boolean;
  /** speed of the swiping finger (domain units / s), 0 when not swiping */
  swipe: number;
  /** speed of the cup while it is dragged (domain units / s) */
  cupDrag: number;
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Sound {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  // torch
  private torchGain!: GainNode;
  private roarLP!: BiquadFilterNode;
  private roarGain!: GainNode;
  private hissGain!: GainNode;
  private flutter = 1;
  private torchWasOn = false;
  // samples
  private pourBuf: AudioBuffer | null = null;
  private swipeBuf: AudioBuffer | null = null;
  private pourSrc: { s: AudioBufferSourceNode; g: GainNode } | null = null;
  private nextSquelch = 0;
  private nextCupSquelch = 0;
  // pour goes through two paths: muffled (canvas) and hollow (cup)
  private pourIn!: GainNode;
  private canvasPath!: GainNode;
  private cupPath!: GainNode;

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
    // make-up gain after the compressor, then a limiter so loud moments
    // (pour + swipe at once) do not clip
    const makeup = ctx.createGain();
    makeup.gain.value = 1.6;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -2;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.002;
    limit.release.value = 0.1;
    this.master = ctx.createGain();
    this.master.gain.value = 1.5;
    this.master.connect(comp).connect(makeup).connect(limit).connect(ctx.destination);

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

    // pour paths. Canvas: thick paint lands on a flat surface, muffled.
    this.pourIn = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;
    lp.Q.value = 0.5;
    this.canvasPath = ctx.createGain();
    this.pourIn.connect(lp).connect(this.canvasPath).connect(this.master);
    // Cup: the paint falls into a small cavity; a resonance and a short
    // feedback delay make it ring hollow.
    const res = ctx.createBiquadFilter();
    res.type = 'peaking';
    res.frequency.value = 850;
    res.Q.value = 3;
    res.gain.value = 9;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    const dl = ctx.createDelay(0.05);
    dl.delayTime.value = 0.0016;
    const fb = ctx.createGain();
    fb.gain.value = 0.45;
    this.cupPath = ctx.createGain();
    this.cupPath.gain.value = 0;
    this.pourIn.connect(hp).connect(res).connect(this.cupPath);
    res.connect(dl).connect(fb).connect(dl);
    fb.connect(this.cupPath);
    this.cupPath.connect(this.master);

    this.loadSamples();
  }

  private loop(offset: number) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, offset);
    return s;
  }

  private async loadSamples() {
    const ctx = this.ctx!;
    const get = async (name: string) => ctx.decodeAudioData(await (await fetch(`${import.meta.env.BASE_URL}sounds/${name}.mp3`)).arrayBuffer());
    try {
      [this.pourBuf, this.swipeBuf] = await Promise.all([get('pour'), get('swipe')]);
    } catch {
      /* offline before the first load: no sample sounds */
    }
  }

  /** Start the pour loop at a random place, so it never sounds the same. */
  private startPour(t: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.pourBuf!;
    s.loop = true;
    s.playbackRate.value = POUR_RATE;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.4, t + 0.08);
    s.connect(g).connect(this.pourIn);
    s.start(t, Math.random() * this.pourBuf!.duration);
    this.pourSrc = { s, g };
  }

  private stopPour(t: number) {
    const p = this.pourSrc;
    if (!p) return;
    p.g.gain.cancelScheduledValues(t);
    p.g.gain.setTargetAtTime(0, t, 0.08);
    p.s.stop(t + 0.5);
    this.pourSrc = null;
  }

  /** One squelch from the jelly recording. Returns its length in seconds. */
  private squelch(t: number, gain: number, rateK = SWIPE_RATE) {
    const ctx = this.ctx!;
    const [start, len] = swipeEvents[(Math.random() * swipeEvents.length) | 0];
    const rate = rateK * rnd(0.9, 1.1);
    const L = Math.max(0.06, len) / rate;
    const s = ctx.createBufferSource();
    s.buffer = this.swipeBuf!;
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.setValueAtTime(gain, t + L * 0.7);
    g.gain.linearRampToValueAtTime(0, t + L);
    s.connect(g).connect(this.master);
    s.start(t, start);
    s.stop(t + L + 0.01);
    return L;
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

  /** The paint lets go of the cup: a short, slow burst of the pour sound. */
  lift() {
    if (!this.ready() || !this.pourBuf) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.pourBuf;
    s.playbackRate.value = POUR_RATE * 0.85;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.45, t + 0.05);
    g.gain.setTargetAtTime(0, t + 0.5, 0.15);
    s.connect(g).connect(this.master);
    s.start(t, Math.random() * (this.pourBuf.duration - 2));
    s.stop(t + 1.3);
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

    // pour: the recording loops while paint is poured
    if (this.pourBuf) {
      if (s.pouring && !this.pourSrc) this.startPour(t);
      else if (!s.pouring && this.pourSrc) this.stopPour(t);
      this.pourSrc?.s.playbackRate.setTargetAtTime(s.intoCup ? CUP_POUR_RATE : POUR_RATE, t, 0.1);
      this.canvasPath.gain.setTargetAtTime(s.intoCup ? 0 : 1.3, t, 0.06);
      this.cupPath.gain.setTargetAtTime(s.intoCup ? 0.8 : 0, t, 0.06);
    }

    // swipe: squelches, more and louder the faster the finger moves
    const k = Math.min(1, s.swipe / 0.8);
    if (this.swipeBuf && k > 0.05 && t >= this.nextSquelch) {
      const L = this.squelch(t + 0.005, 0.6 * (0.4 + 0.6 * k));
      this.nextSquelch = t + Math.max(0.03, L * 0.5) / k;
    }

    // dragging the cup: slower, deeper squelches
    const c = Math.min(1, s.cupDrag / 0.4);
    if (this.swipeBuf && c > 0.08 && t >= this.nextCupSquelch) {
      const L = this.squelch(t + 0.005, 0.5 * (0.4 + 0.6 * c), CUP_DRAG_RATE);
      this.nextCupSquelch = t + Math.max(0.05, L * 0.6) / c;
    }
  }
}
