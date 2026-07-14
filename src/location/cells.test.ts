import { describe, expect, it } from 'vitest';
import type { Reception } from '../types';
import {
  CellAggregator,
  aggregateCells,
  medianAbsoluteDeviation,
  receptionToCellSample,
  type CellSample,
} from './cells';

function sample(overrides: Partial<CellSample> = {}): CellSample {
  return {
    t: 0,
    lat: 0,
    lon: 0,
    gpsAccuracy: 10,
    rssi: -80,
    snr: 2,
    identityTier: 'full-pubkey',
    ...overrides,
  };
}

function reception(confirmed: boolean, status: 'ok' | 'stale' = 'ok'): Reception {
  return {
    sessionId: 's',
    t: 1,
    source: 'rx',
    opcode: 0x88,
    frameHex: '88',
    rssi: -80,
    snr: 2,
    cls: {
      kind: confirmed ? 'DIRECT_TARGET' : 'TARGET_ORIGIN_BUT_FORWARDED',
      confirmed,
      explanation: 'test',
      identityTier: 'full-pubkey',
      flags: {},
    },
    conf: confirmed ? 1 : 0,
    gps: {
      status,
      lat: 0,
      lon: 0,
      accuracy: 5,
      quality: 'good',
      ageMs: 0,
    },
  };
}

describe('cell aggregation', () => {
  it('computes median, MAD, extrema, passes, octants, and weakest tier', () => {
    const values = [
      sample({ t: 0, rssi: -90, snr: -2, heading: 0 }),
      sample({ t: 1_000, rssi: -80, snr: 2, heading: 90, identityTier: 'node-id' }),
      sample({ t: 181_001, rssi: -70, snr: 6, heading: 180 }),
    ];
    const [cell] = aggregateCells(values, { mode: 'walk', now: 181_001 });
    expect(cell).toMatchObject({
      count: 3,
      medianRssi: -80,
      maxRssi: -70,
      madRssi: 10,
      medianSnr: 2,
      maxSnr: 6,
      medianGpsAcc: 10,
      passes: 2,
      octants: 3,
      minIdentityTier: 'node-id',
    });
    expect(cell?.confidence).toBeGreaterThan(0);
    expect(medianAbsoluteDeviation([-90, -80, -70])).toBe(10);
  });

  it('counts a drive pass after 120 seconds and applies live staleness only on request', () => {
    const samples = [sample({ t: 0 }), sample({ t: 120_001 })];
    const live = aggregateCells(samples, {
      mode: 'drive',
      now: 120_001 + 31 * 60_000,
      liveView: true,
    })[0];
    const historical = aggregateCells(samples, {
      mode: 'drive',
      now: 120_001 + 31 * 60_000,
      liveView: false,
    })[0];
    expect(live?.passes).toBe(2);
    expect(live?.confidence).toBeCloseTo((historical?.confidence ?? 0) * 0.8, 8);
  });

  it('structurally excludes forwarded and stale receptions', () => {
    expect(receptionToCellSample(reception(false))).toBeUndefined();
    expect(receptionToCellSample(reception(true, 'stale'))).toBeUndefined();
    expect(receptionToCellSample(reception(true))).toBeDefined();
    const aggregator = new CellAggregator();
    expect(aggregator.addReception(reception(false))).toBe(false);
    expect(aggregator.addReception(reception(true))).toBe(true);
    expect(aggregator.values()[0]?.count).toBe(1);
  });
});
