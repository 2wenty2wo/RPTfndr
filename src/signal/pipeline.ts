import type { Reception } from '../types';
import { clamp, clamp01 } from '../location/geo';

export type SignalMode = 'walk' | 'drive';

export interface SignalSample {
  t: number;
  rssi: number;
  snr: number;
  confirmed?: boolean;
  receptionId?: number;
}

export interface SignalCalibration {
  weakRssi: number;
  strongRssi: number;
  weakSnr: number;
  strongSnr: number;
}

export interface SignalPeak {
  t: number;
  rssi: number;
  snr: number;
  rssiPercent: number;
  snrPercent: number;
}

export interface SignalSnapshot {
  hasSignal: boolean;
  t?: number;
  sampleCount: number;
  medianRssi?: number;
  medianSnr?: number;
  rssi?: number;
  snr?: number;
  rssiPercent?: number;
  snrPercent?: number;
  strengthPercent?: number;
  sessionPeak?: SignalPeak;
  rollingPeak?: SignalPeak;
  stale: boolean;
  lastHitSeconds?: number;
}

export interface SignalPipelineOptions {
  mode?: SignalMode;
  smoothingWindow?: number;
  emaAlpha?: number;
  medianMaxAgeMs?: number;
  rollingPeakMs?: number;
  staleAfterMs?: number;
  calibration?: Partial<SignalCalibration>;
}

export const SIGNAL_MODE_DEFAULTS = {
  walk: { smoothingWindow: 7, emaAlpha: 0.3 },
  drive: { smoothingWindow: 5, emaAlpha: 0.4 },
} as const;

export const DEFAULT_SIGNAL_CALIBRATION: Readonly<SignalCalibration> = {
  weakRssi: -125,
  strongRssi: -60,
  weakSnr: -18,
  strongSnr: 10,
};

export function rollingMedian(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return Number.NaN;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

export function calibrationPercent(value: number, weak: number, strong: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(weak) || !Number.isFinite(strong)) return 0;
  if (strong === weak) return value >= strong ? 1 : 0;
  return clamp01((value - weak) / (strong - weak));
}

function normalizeWindow(value: number): number {
  return Math.round(clamp(value, 3, 11));
}

function normalizeAlpha(value: number): number {
  return clamp(value, 0.2, 0.6);
}

interface ProcessedSignal extends SignalPeak {
  medianRssi: number;
  medianSnr: number;
}

export class SignalPipeline {
  private mode: SignalMode;
  private windowSize: number;
  private alpha: number;
  private readonly medianMaxAgeMs: number;
  private readonly rollingPeakMs: number;
  private readonly staleAfterMs: number;
  private calibration: SignalCalibration;
  private readonly raw: SignalSample[] = [];
  private readonly processed: ProcessedSignal[] = [];
  private latestSignal: ProcessedSignal | undefined;
  private bestSignal: ProcessedSignal | undefined;

  constructor(options: SignalPipelineOptions = {}) {
    this.mode = options.mode ?? 'walk';
    const defaults = SIGNAL_MODE_DEFAULTS[this.mode];
    this.windowSize = normalizeWindow(options.smoothingWindow ?? defaults.smoothingWindow);
    this.alpha = normalizeAlpha(options.emaAlpha ?? defaults.emaAlpha);
    this.medianMaxAgeMs = options.medianMaxAgeMs ?? 60_000;
    this.rollingPeakMs = options.rollingPeakMs ?? 120_000;
    this.staleAfterMs = options.staleAfterMs ?? 20_000;
    this.calibration = { ...DEFAULT_SIGNAL_CALIBRATION, ...options.calibration };
  }

  add(sample: SignalSample): SignalSnapshot | undefined {
    if (
      sample.confirmed === false ||
      !Number.isFinite(sample.t) ||
      !Number.isFinite(sample.rssi) ||
      !Number.isFinite(sample.snr) ||
      (this.latestSignal !== undefined && sample.t < this.latestSignal.t)
    ) {
      return undefined;
    }
    this.raw.push(sample);
    const oldestMedianSample = sample.t - this.medianMaxAgeMs;
    while (this.raw[0] && this.raw[0].t < oldestMedianSample) this.raw.shift();
    const window = this.raw.slice(-this.windowSize);
    const medianRssi = rollingMedian(window.map((entry) => entry.rssi));
    const medianSnr = rollingMedian(window.map((entry) => entry.snr));
    const previous = this.latestSignal;
    const rssi = previous
      ? this.alpha * medianRssi + (1 - this.alpha) * previous.rssi
      : medianRssi;
    const snr = previous ? this.alpha * medianSnr + (1 - this.alpha) * previous.snr : medianSnr;
    const processed: ProcessedSignal = {
      t: sample.t,
      medianRssi,
      medianSnr,
      rssi,
      snr,
      rssiPercent: calibrationPercent(
        rssi,
        this.calibration.weakRssi,
        this.calibration.strongRssi,
      ),
      snrPercent: calibrationPercent(
        snr,
        this.calibration.weakSnr,
        this.calibration.strongSnr,
      ),
    };
    this.latestSignal = processed;
    this.processed.push(processed);
    while (this.processed[0] && this.processed[0].t < sample.t - this.rollingPeakMs) {
      this.processed.shift();
    }
    if (!this.bestSignal || processed.rssi > this.bestSignal.rssi) this.bestSignal = processed;
    return this.snapshot(sample.t);
  }

  ingest(sample: SignalSample): SignalSnapshot | undefined {
    return this.add(sample);
  }

  addReception(reception: Reception): SignalSnapshot | undefined {
    if (reception.conf !== 1 || !reception.cls.confirmed) return undefined;
    return this.add({
      t: reception.t,
      rssi: reception.rssi,
      snr: reception.snr,
      confirmed: true,
      ...(reception.id === undefined ? {} : { receptionId: reception.id }),
    });
  }

  snapshot(now = Date.now()): SignalSnapshot {
    const latest = this.latestSignal;
    if (!latest) return { hasSignal: false, sampleCount: 0, stale: true };
    const ageMs = Math.max(0, now - latest.t);
    const rollingCandidates = this.processed.filter(
      (entry) => entry.t >= now - this.rollingPeakMs && entry.t <= now,
    );
    const rollingPeak = rollingCandidates.reduce<ProcessedSignal | undefined>(
      (best, entry) => (!best || entry.rssi > best.rssi ? entry : best),
      undefined,
    );
    return {
      hasSignal: true,
      t: latest.t,
      sampleCount: this.raw.length,
      medianRssi: latest.medianRssi,
      medianSnr: latest.medianSnr,
      rssi: latest.rssi,
      snr: latest.snr,
      rssiPercent: latest.rssiPercent,
      snrPercent: latest.snrPercent,
      strengthPercent: latest.rssiPercent,
      ...(this.bestSignal ? { sessionPeak: this.asPeak(this.bestSignal) } : {}),
      ...(rollingPeak ? { rollingPeak: this.asPeak(rollingPeak) } : {}),
      stale: ageMs > this.staleAfterMs,
      lastHitSeconds: ageMs / 1_000,
    };
  }

  setMode(mode: SignalMode, useModeDefaults = true): void {
    this.mode = mode;
    if (useModeDefaults) {
      this.windowSize = SIGNAL_MODE_DEFAULTS[mode].smoothingWindow;
      this.alpha = SIGNAL_MODE_DEFAULTS[mode].emaAlpha;
    }
  }

  getMode(): SignalMode {
    return this.mode;
  }

  setSmoothing(smoothingWindow: number, emaAlpha: number): void {
    this.windowSize = normalizeWindow(smoothingWindow);
    this.alpha = normalizeAlpha(emaAlpha);
  }

  getSmoothing(): { smoothingWindow: number; emaAlpha: number } {
    return { smoothingWindow: this.windowSize, emaAlpha: this.alpha };
  }

  setCalibration(calibration: Partial<SignalCalibration>): void {
    this.calibration = { ...this.calibration, ...calibration };
    this.refreshPercentages();
  }

  getCalibration(): SignalCalibration {
    return { ...this.calibration };
  }

  setCurrentAsWeak(): boolean {
    if (!this.latestSignal) return false;
    this.calibration.weakRssi = this.latestSignal.rssi;
    this.calibration.weakSnr = this.latestSignal.snr;
    if (this.calibration.strongRssi <= this.calibration.weakRssi) {
      this.calibration.strongRssi = this.calibration.weakRssi + 1;
    }
    if (this.calibration.strongSnr <= this.calibration.weakSnr) {
      this.calibration.strongSnr = this.calibration.weakSnr + 1;
    }
    this.refreshPercentages();
    return true;
  }

  setCurrentAsStrong(): boolean {
    if (!this.latestSignal) return false;
    this.calibration.strongRssi = this.latestSignal.rssi;
    this.calibration.strongSnr = this.latestSignal.snr;
    if (this.calibration.weakRssi >= this.calibration.strongRssi) {
      this.calibration.weakRssi = this.calibration.strongRssi - 1;
    }
    if (this.calibration.weakSnr >= this.calibration.strongSnr) {
      this.calibration.weakSnr = this.calibration.strongSnr - 1;
    }
    this.refreshPercentages();
    return true;
  }

  reset(): void {
    this.raw.length = 0;
    this.processed.length = 0;
    this.latestSignal = undefined;
    this.bestSignal = undefined;
  }

  private refreshPercentages(): void {
    for (const signal of this.processed) {
      signal.rssiPercent = calibrationPercent(
        signal.rssi,
        this.calibration.weakRssi,
        this.calibration.strongRssi,
      );
      signal.snrPercent = calibrationPercent(
        signal.snr,
        this.calibration.weakSnr,
        this.calibration.strongSnr,
      );
    }
    if (this.bestSignal && !this.processed.includes(this.bestSignal)) {
      this.bestSignal.rssiPercent = calibrationPercent(
        this.bestSignal.rssi,
        this.calibration.weakRssi,
        this.calibration.strongRssi,
      );
      this.bestSignal.snrPercent = calibrationPercent(
        this.bestSignal.snr,
        this.calibration.weakSnr,
        this.calibration.strongSnr,
      );
    }
  }

  private asPeak(signal: ProcessedSignal): SignalPeak {
    return {
      t: signal.t,
      rssi: signal.rssi,
      snr: signal.snr,
      rssiPercent: signal.rssiPercent,
      snrPercent: signal.snrPercent,
    };
  }
}

export const Pipeline = SignalPipeline;
