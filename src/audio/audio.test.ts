import { describe, expect, it, vi } from 'vitest';

import {
  AudioController,
  clampSignalPercent,
  signalPercentToGeigerRate,
  signalPercentToToneFrequency,
  snrToChimeFrequency,
} from './audio';

describe('audio mappings', () => {
  it('maps signal percent to the specified tone and geiger ranges', () => {
    expect(signalPercentToToneFrequency(0)).toBe(220);
    expect(signalPercentToToneFrequency(1)).toBe(1_320);
    expect(signalPercentToGeigerRate(0)).toBe(0.5);
    expect(signalPercentToGeigerRate(1)).toBe(12);
    expect(clampSignalPercent(-1)).toBe(0);
    expect(clampSignalPercent(2)).toBe(1);
  });

  it('pitches the second chime note one octave per 10 dB', () => {
    expect(snrToChimeFrequency(0)).toBe(700);
    expect(snrToChimeFrequency(10)).toBe(1_400);
    expect(snrToChimeFrequency(-10)).toBe(350);
  });

  it('does not create audio for off mode or unrelated classifications', () => {
    const factory = vi.fn(() => { throw new Error('must not be called'); });
    const controller = new AudioController({ mode: 'off', contextFactory: factory });
    controller.notifyReception({
      classification: { kind: 'DIRECT_TARGET', confirmed: true },
      snr: 5,
      percent: 0.8,
    });
    controller.setMode('chime');
    controller.notifyReception({
      classification: { kind: 'NON_TARGET', confirmed: false },
      snr: 5,
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not postpone a running geiger schedule on unrelated recorder updates', () => {
    const schedule = vi.fn(() => 1 as unknown as ReturnType<typeof globalThis.setTimeout>);
    const cancel = vi.fn();
    const controller = new AudioController({
      mode: 'geiger',
      contextFactory: () => { throw new Error('audio context is unnecessary for scheduling'); },
      setTimeout: schedule as unknown as typeof globalThis.setTimeout,
      clearTimeout: cancel as unknown as typeof globalThis.clearTimeout,
    });
    controller.updateSignal(0.1, true);
    controller.updateSignal(0.8, true);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });
});
