import { describe, expect, it } from 'vitest';
import type { Reception } from '../types';
import {
  SignalPipeline,
  calibrationPercent,
  rollingMedian,
} from './pipeline';

describe('signal pipeline', () => {
  it('applies a time-bounded rolling median followed by EMA smoothing', () => {
    const pipeline = new SignalPipeline({ smoothingWindow: 3, emaAlpha: 0.2 });
    expect(pipeline.add({ t: 0, rssi: -100, snr: -10 })?.rssi).toBe(-100);
    expect(pipeline.add({ t: 1_000, rssi: -80, snr: 0 })?.rssi).toBeCloseTo(-98, 8);
    const third = pipeline.add({ t: 2_000, rssi: -60, snr: 10 });
    expect(third?.medianRssi).toBe(-80);
    expect(third?.rssi).toBeCloseTo(-94.4, 8);

    const aged = pipeline.add({ t: 63_001, rssi: -50, snr: 5 });
    expect(aged?.medianRssi).toBe(-50);
    expect(aged?.sampleCount).toBe(1);
  });

  it('tracks permanent session-best and 120 second rolling peaks', () => {
    const pipeline = new SignalPipeline({ smoothingWindow: 3, emaAlpha: 0.6 });
    pipeline.add({ t: 0, rssi: -60, snr: 5 });
    pipeline.add({ t: 121_000, rssi: -100, snr: -10 });
    const snapshot = pipeline.snapshot(121_000);
    expect(snapshot.sessionPeak?.rssi).toBe(-60);
    expect(snapshot.rollingPeak?.t).toBe(121_000);
    expect(pipeline.snapshot(142_001)).toMatchObject({ stale: true, lastHitSeconds: 21.001 });
  });

  it('ignores unconfirmed samples and forwarded receptions structurally', () => {
    const pipeline = new SignalPipeline();
    expect(pipeline.add({ t: 1, rssi: -70, snr: 1, confirmed: false })).toBeUndefined();
    const forwarded = {
      t: 2,
      rssi: -60,
      snr: 2,
      conf: 0,
      cls: { confirmed: false },
    } as unknown as Reception;
    expect(pipeline.addReception(forwarded)).toBeUndefined();
    expect(pipeline.snapshot()).toMatchObject({ hasSignal: false, sampleCount: 0 });
  });

  it('clamps smoothing controls and switches mode presets', () => {
    const pipeline = new SignalPipeline();
    pipeline.setSmoothing(99, 0.01);
    expect(pipeline.getSmoothing()).toEqual({ smoothingWindow: 11, emaAlpha: 0.2 });
    pipeline.setMode('drive');
    expect(pipeline.getSmoothing()).toEqual({ smoothingWindow: 5, emaAlpha: 0.4 });
  });

  it('calibrates RSSI/SNR percentages and can pin the current sample', () => {
    expect(calibrationPercent(-125, -125, -60)).toBe(0);
    expect(calibrationPercent(-60, -125, -60)).toBe(1);
    expect(calibrationPercent(-92.5, -125, -60)).toBeCloseTo(0.5, 8);
    const pipeline = new SignalPipeline();
    pipeline.add({ t: 1, rssi: -90, snr: -5 });
    expect(pipeline.setCurrentAsWeak()).toBe(true);
    expect(pipeline.snapshot(1).rssiPercent).toBe(0);
    pipeline.add({ t: 2, rssi: -70, snr: 5 });
    expect(pipeline.setCurrentAsStrong()).toBe(true);
    expect(pipeline.snapshot(2).rssiPercent).toBe(1);
  });

  it('uses a true median for odd and even windows', () => {
    expect(rollingMedian([3, 1, 2])).toBe(2);
    expect(rollingMedian([4, 1, 3, 2])).toBe(2.5);
  });
});
