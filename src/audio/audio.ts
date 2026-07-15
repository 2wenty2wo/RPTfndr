import type { ClassificationResult, SessionSettings } from '../types';

export type AudioMode = SessionSettings['audioMode'];

export interface AudioControllerOptions {
  mode?: AudioMode;
  volume?: number;
  muted?: boolean;
  forwardedAlert?: boolean;
  contextFactory?: () => AudioContext;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export interface ReceptionAudioInput {
  classification: Pick<ClassificationResult, 'kind' | 'confirmed'>;
  snr?: number;
  percent?: number;
}

export function clampSignalPercent(percent: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(percent) ? percent : 0));
}

export function snrToChimeFrequency(snr: number | undefined): number {
  const safeSnr = Math.max(-20, Math.min(20, snr ?? 0));
  return 700 * (2 ** (safeSnr / 10));
}

export function signalPercentToToneFrequency(percent: number): number {
  return 220 * (6 ** clampSignalPercent(percent));
}

export function signalPercentToGeigerRate(percent: number): number {
  return 0.5 + 11.5 * clampSignalPercent(percent);
}

export function isAudioSupported(): boolean {
  return getAudioContextConstructor() !== undefined;
}

/** Web Audio feedback for confirmed receptions and connection state. */
export class AudioController {
  private audioMode: AudioMode;
  private masterVolume: number;
  private isMuted: boolean;
  private alertForwarded: boolean;
  private readonly contextFactory?: () => AudioContext;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;

  private context?: AudioContext;
  private master?: GainNode;
  private toneOscillator?: OscillatorNode;
  private toneGain?: GainNode;
  private geigerTimer?: ReturnType<typeof globalThis.setTimeout>;
  private signalPercent = 0;
  private signalActive = false;
  private gestureCleanup?: () => void;

  constructor(options: AudioControllerOptions = {}) {
    this.audioMode = options.mode ?? 'chime';
    this.masterVolume = clampSignalPercent(options.volume ?? 1);
    this.isMuted = options.muted ?? false;
    this.alertForwarded = options.forwardedAlert ?? false;
    this.contextFactory = options.contextFactory;
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  get mode(): AudioMode {
    return this.audioMode;
  }

  get volume(): number {
    return this.masterVolume;
  }

  get muted(): boolean {
    return this.isMuted;
  }

  get forwardedAlert(): boolean {
    return this.alertForwarded;
  }

  /** Call directly inside a user gesture before sound is needed. */
  async resume(): Promise<boolean> {
    const context = this.ensureContext();
    if (!context) return false;
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        return false;
      }
    }
    this.applyMasterGain();
    if (context.state === 'running' && this.signalActive) this.startContinuousMode();
    return context.state === 'running';
  }

  /**
   * Resume on the first pointer/keyboard gesture. The returned cleanup function
   * should be called when the owning screen is destroyed.
   */
  bindGesture(target: EventTarget = document): () => void {
    this.gestureCleanup?.();
    const handler = (): void => { void this.resume(); };
    target.addEventListener('pointerdown', handler, { passive: true });
    target.addEventListener('keydown', handler);
    const cleanup = (): void => {
      target.removeEventListener('pointerdown', handler);
      target.removeEventListener('keydown', handler);
      if (this.gestureCleanup === cleanup) this.gestureCleanup = undefined;
    };
    this.gestureCleanup = cleanup;
    return cleanup;
  }

  setMode(mode: AudioMode): void {
    if (this.audioMode === mode) return;
    this.stopContinuousMode();
    this.audioMode = mode;
    if (this.signalActive) this.startContinuousMode();
  }

  setVolume(volume: number): void {
    this.masterVolume = clampSignalPercent(volume);
    this.applyMasterGain();
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.applyMasterGain();
  }

  setForwardedAlert(enabled: boolean): void {
    this.alertForwarded = enabled;
  }

  notifyReception(input: ReceptionAudioInput): void {
    if (this.audioMode === 'off') return;
    if (input.classification.confirmed) {
      if (this.audioMode === 'chime') this.playHitChime(input.snr);
      else this.updateSignal(input.percent ?? this.signalPercent, true);
      return;
    }
    if (input.classification.kind === 'TARGET_ORIGIN_BUT_FORWARDED' && this.alertForwarded) {
      this.playForwardedDoubleBlip();
    }
  }

  updateSignal(percent: number, active = true): void {
    const wasActive = this.signalActive;
    this.signalPercent = clampSignalPercent(percent);
    this.signalActive = active;
    if (!active) {
      this.stopContinuousMode();
      return;
    }
    if (this.audioMode === 'tone') this.startOrUpdateTone();
    if (this.audioMode === 'geiger' && (!wasActive || this.geigerTimer === undefined)) {
      this.restartGeigerScheduler();
    }
  }

  setSignalActive(active: boolean): void {
    this.updateSignal(this.signalPercent, active);
  }

  playHitChime(snr?: number): boolean {
    if (this.audioMode === 'off') return false;
    const context = this.runningContext();
    if (!context || !this.master) return false;
    const now = context.currentTime;
    const ring = 0.45;
    const output = context.createBiquadFilter();
    output.type = 'lowpass';
    output.frequency.value = 10_700;
    output.Q.value = 0.3;
    output.connect(this.master);

    this.scheduleBell(context, output, 700, now, ring * 0.5, 0.5);
    this.scheduleBell(
      context,
      output,
      snrToChimeFrequency(snr),
      now + ring * 0.18,
      ring,
      1,
    );
    this.scheduleDisconnect(output, (ring + 0.2) * 1_000);
    return true;
  }

  playForwardedDoubleBlip(): boolean {
    if (this.audioMode === 'off' || !this.alertForwarded) return false;
    const context = this.runningContext();
    if (!context || !this.master) return false;
    const now = context.currentTime;
    this.scheduleSimpleTone(context, this.master, 300, now, 0.07, 'sine', 0.09);
    this.scheduleSimpleTone(context, this.master, 300, now + 0.14, 0.07, 'sine', 0.09);
    return true;
  }

  playDisconnectAlarm(): boolean {
    if (this.audioMode === 'off') return false;
    const context = this.runningContext();
    if (!context || !this.master) return false;
    const frequencies = [880, 440, 880, 440, 880, 440];
    const duration = 0.16;
    const gap = 0.08;
    frequencies.forEach((frequency, index) => {
      this.scheduleSimpleTone(
        context,
        this.master!,
        frequency,
        context.currentTime + index * (duration + gap),
        duration,
        'square',
        0.13,
      );
    });
    return true;
  }

  async destroy(): Promise<void> {
    this.gestureCleanup?.();
    this.stopContinuousMode();
    const context = this.context;
    this.context = undefined;
    this.master = undefined;
    if (context && context.state !== 'closed') {
      try { await context.close(); } catch { /* already closing */ }
    }
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context) return this.context;
    try {
      const context = this.contextFactory?.() ?? (() => {
        const Constructor = getAudioContextConstructor();
        return Constructor ? new Constructor() : undefined;
      })();
      if (!context) return undefined;
      const master = context.createGain();
      master.connect(context.destination);
      this.context = context;
      this.master = master;
      this.applyMasterGain();
      return context;
    } catch {
      return undefined;
    }
  }

  private runningContext(): AudioContext | undefined {
    const context = this.ensureContext();
    if (!context) return undefined;
    if (context.state !== 'running') {
      // Ask to resume for the next event, but skip this one. Scheduling while a
      // suspended clock is frozen would cause queued sounds to burst on return.
      void context.resume().catch(() => undefined);
      return undefined;
    }
    return context;
  }

  private applyMasterGain(): void {
    if (!this.context || !this.master) return;
    const value = this.isMuted ? 0 : this.masterVolume;
    this.master.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
  }

  private startContinuousMode(): void {
    if (!this.signalActive || this.audioMode === 'off' || this.audioMode === 'chime') return;
    if (this.audioMode === 'tone') this.startOrUpdateTone();
    if (this.audioMode === 'geiger') this.restartGeigerScheduler();
  }

  private stopContinuousMode(): void {
    this.stopTone();
    if (this.geigerTimer !== undefined) this.clearTimeoutFn(this.geigerTimer);
    this.geigerTimer = undefined;
  }

  private startOrUpdateTone(): void {
    const context = this.runningContext();
    if (!context || !this.master || this.audioMode !== 'tone' || !this.signalActive) return;
    const frequency = signalPercentToToneFrequency(this.signalPercent);
    if (!this.toneOscillator || !this.toneGain) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.045, context.currentTime + 0.03);
      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start();
      this.toneOscillator = oscillator;
      this.toneGain = gain;
    } else {
      this.toneOscillator.frequency.setTargetAtTime(frequency, context.currentTime, 0.04);
    }
  }

  private stopTone(): void {
    const oscillator = this.toneOscillator;
    const gain = this.toneGain;
    const context = this.context;
    this.toneOscillator = undefined;
    this.toneGain = undefined;
    if (!oscillator || !gain || !context) return;
    try {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setTargetAtTime(0.0001, context.currentTime, 0.01);
      oscillator.stop(context.currentTime + 0.06);
    } catch {
      // A previously stopped oscillator may throw InvalidStateError.
    }
  }

  private restartGeigerScheduler(): void {
    if (this.geigerTimer !== undefined) this.clearTimeoutFn(this.geigerTimer);
    this.geigerTimer = undefined;
    if (!this.signalActive || this.audioMode !== 'geiger') return;
    const rate = signalPercentToGeigerRate(this.signalPercent);
    this.geigerTimer = this.setTimeoutFn(() => {
      this.geigerTimer = undefined;
      if (!this.signalActive || this.audioMode !== 'geiger') return;
      this.playGeigerBlip();
      this.restartGeigerScheduler();
    }, 1_000 / rate);
  }

  private playGeigerBlip(): void {
    const context = this.runningContext();
    if (!context || !this.master) return;
    this.scheduleSimpleTone(context, this.master, 1_000, context.currentTime, 0.025, 'square', 0.055);
  }

  private scheduleBell(
    context: AudioContext,
    output: AudioNode,
    frequency: number,
    start: number,
    duration: number,
    volume: number,
  ): void {
    const partials: ReadonlyArray<readonly [number, number]> = [
      [1, 1], [2, 0.5], [4.01, 0.13], [0.5, 0.38],
    ];
    for (const [multiplier, amplitude] of partials) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const partialDuration = duration / (1 + (multiplier - 1) * 0.05);
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency * multiplier;
      oscillator.connect(gain);
      gain.connect(output);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0002, volume * amplitude * 0.085),
        start + 0.001,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, start + partialDuration);
      oscillator.start(start);
      oscillator.stop(start + partialDuration + 0.05);
    }
  }

  private scheduleSimpleTone(
    context: AudioContext,
    output: AudioNode,
    frequency: number,
    start: number,
    duration: number,
    type: OscillatorType,
    volume: number,
  ): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.connect(output);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.setValueAtTime(volume, Math.max(start + 0.01, start + duration - 0.02));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }

  private scheduleDisconnect(node: AudioNode, delayMs: number): void {
    this.setTimeoutFn(() => {
      try { node.disconnect(); } catch { /* already disconnected */ }
    }, delayMs);
  }
}

function getAudioContextConstructor(): typeof AudioContext | undefined {
  const webkitGlobal = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  return globalThis.AudioContext ?? webkitGlobal.webkitAudioContext;
}
