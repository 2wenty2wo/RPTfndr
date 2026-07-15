import { describe, expect, it } from 'vitest';
import { deriveApproachState } from '../app/controller';
import { finderViewportPoints } from '../map/map';
import type { Reception, SessionEvent, TargetProfile } from '../types';
import { aggregateReceptions } from './cells';
import { estimateArea } from './estimate';

function confirmedReception(id: number, lat: number, lon: number, rssi: number): Reception {
  return {
    id,
    sessionId: 's',
    t: 1_000 + id,
    source: 'rx',
    opcode: 0x88,
    frameHex: '88',
    rssi,
    snr: 5,
    cls: {
      kind: 'DIRECT_TARGET',
      confirmed: true,
      explanation: 'full-key match',
      identityTier: 'full-pubkey',
      flags: { originIsTarget: true, zeroHop: true },
    },
    conf: 1,
    gps: { status: 'ok', lat, lon, accuracy: 4, ageMs: 200, quality: 'good' },
  };
}

describe('untrusted advertised-position isolation', () => {
  it('cannot influence bounds, signal cells, area, or final-approach output', () => {
    const target: TargetProfile = {
      id: 'target',
      label: 'Target',
      identity: { kind: 'full-pubkey', pubkeyHex: 'aa'.repeat(32) },
      source: 'contacts',
      advertisedReference: {
        lat: 51.5074,
        lon: -0.1278,
        source: 'advert',
        observedAt: 900,
        trust: 'untrusted-admin',
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const receptions = [
      confirmedReception(1, 0, -0.0002, -66),
      confirmedReception(2, 0, 0, -65),
      confirmedReception(3, 0, 0.0002, -67),
      confirmedReception(4, 0.0002, 0, -66),
      confirmedReception(5, -0.0002, 0, -66),
    ];
    const cells = aggregateReceptions(receptions, { cellSizeM: 12, mode: 'walk' });
    const estimate = estimateArea(cells, { minSamples: 5, minCells: 3, generatedAt: 2_000 });
    const events: SessionEvent[] = [
      {
        id: 10,
        sessionId: 's',
        t: 1_500,
        type: 'bearing',
        data: { lat: 0, lon: -0.001, bearingDeg: 90, accuracyDeg: 4, gpsAccuracyM: 4, gpsAgeMs: 500, confirmedReceptionId: 1, confirmedReceptionAgeMs: 1_000 },
      },
      {
        id: 11,
        sessionId: 's',
        t: 1_600,
        type: 'bearing',
        data: { lat: -0.001, lon: 0, bearingDeg: 0, accuracyDeg: 4, gpsAccuracyM: 4, gpsAgeMs: 500, confirmedReceptionId: 2, confirmedReceptionAgeMs: 1_000 },
      },
    ];
    const approach = deriveApproachState(events, estimate, 75, 2_000, receptions);

    expect(finderViewportPoints(receptions, target)).toHaveLength(5);
    expect(cells.every((cell) => Math.abs(cell.centerLat) < 0.01)).toBe(true);
    expect(estimate.ready).toBe(true);
    expect(estimate.polygon?.every(([lat]) => Math.abs(lat) < 0.01)).toBe(true);
    expect(approach.finalApproach?.ready).toBe(true);
    expect(approach.finalApproach?.polygon?.every(([lat]) => Math.abs(lat) < 0.01)).toBe(true);
  });
});
