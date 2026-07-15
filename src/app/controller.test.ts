import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_SETTINGS } from '../types';
import type { AreaEstimate, Reception, SessionEvent } from '../types';
import { deriveApproachState, resolveSessionSettings } from './controller';

describe('session mode settings', () => {
  it('retains drive presets when persisted values are unchanged walk defaults', () => {
    const settings = resolveSessionSettings('drive', { ...DEFAULT_SESSION_SETTINGS });
    expect(settings).toMatchObject({ cellSizeM: 45, smoothingWindow: 5, emaAlpha: 0.4 });
  });

  it('honours valid custom aggregation values while enforcing the drive cell minimum', () => {
    const settings = resolveSessionSettings('drive', {
      ...DEFAULT_SESSION_SETTINGS,
      cellSizeM: 35,
      smoothingWindow: 9,
      emaAlpha: 0.5,
    });
    expect(settings).toMatchObject({ cellSizeM: 35, smoothingWindow: 9, emaAlpha: 0.5 });
  });
});

describe('final-approach state', () => {
  it('derives an approximate overlap only from canonical bearing and signal inputs', () => {
    const events: SessionEvent[] = [
      {
        id: 1,
        sessionId: 's',
        t: 1,
        type: 'bearing',
        data: {
          lat: 0,
          lon: -0.001,
          bearingDeg: 90,
          accuracyDeg: 4,
          gpsAccuracyM: 4,
          gpsAgeMs: 500,
          confirmedReceptionId: 10,
          confirmedReceptionAgeMs: 1_000,
        },
      },
      {
        id: 2,
        sessionId: 's',
        t: 2,
        type: 'bearing',
        data: {
          lat: -0.001,
          lon: 0,
          bearingDeg: 0,
          accuracyDeg: 4,
          gpsAccuracyM: 4,
          gpsAgeMs: 500,
          confirmedReceptionId: 11,
          confirmedReceptionAgeMs: 1_000,
        },
      },
    ];
    const estimate: AreaEstimate = {
      ready: true,
      reason: 'confirmed signal area',
      sampleCount: 8,
      cellCount: 3,
      polygon: [[-0.0002, -0.0002], [-0.0002, 0.0002], [0.0002, 0.0002], [0.0002, -0.0002]],
      areaM2: 1_500,
      confidence: 'high',
      generatedAt: 3,
    };

    const receptions = [
      { id: 10, t: 0, conf: 1, cls: { confirmed: true } },
      { id: 11, t: 1, conf: 1, cls: { confirmed: true } },
    ] as Reception[];
    const state = deriveApproachState(events, estimate, 75, 4, receptions);
    expect(state.finalApproach).toMatchObject({
      ready: true,
      approximate: true,
      bearingCount: 2,
      signalCellCount: 3,
    });
    expect(state.bearingConsensus?.contributingObservationIds).toEqual([1, 2]);
  });
});
