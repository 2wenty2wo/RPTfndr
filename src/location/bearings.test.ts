import { describe, expect, it } from 'vitest';
import {
  analyzeBearingConsensus,
  bearingEvent,
  consensusBearing,
  deriveFinalApproach,
  intersectConvexPolygons,
  intersectBearings,
  observationFromBearingEvent,
  type BearingObservation,
} from './bearings';

const first: BearingObservation = { t: 1, lat: 0, lon: -0.001, bearingDeg: 90 };
const second: BearingObservation = { t: 2, lat: -0.001, lon: 0, bearingDeg: 0 };

function eligible(
  observation: BearingObservation,
  id: string,
  overrides: Partial<BearingObservation> = {},
): BearingObservation {
  return {
    ...observation,
    id,
    accuracyDeg: 4,
    gpsAccuracyM: 4,
    gpsAgeMs: 500,
    confirmedReceptionId: 1,
    confirmedReceptionAgeMs: 2_000,
    ...overrides,
  };
}

describe('manual bearings', () => {
  it('intersects well-separated forward rays', () => {
    const intersection = intersectBearings(first, second);
    expect(intersection?.point.lat).toBeCloseTo(0, 5);
    expect(intersection?.point.lon).toBeCloseTo(0, 5);
    expect(intersection?.crossingAngleDeg).toBeCloseTo(90, 5);
  });

  it('rejects parallel or backward intersections', () => {
    expect(intersectBearings(first, { ...first, lat: 0.001 })).toBeUndefined();
    expect(intersectBearings(first, { ...second, bearingDeg: 180 })).toBeUndefined();
  });

  it('forms a least-squares consensus and round-trips storage events', () => {
    const third: BearingObservation = {
      t: 3,
      lat: 0.001,
      lon: 0.001,
      bearingDeg: 225,
      accuracyDeg: 5,
      note: 'ridge',
    };
    const consensus = consensusBearing([first, second, third]);
    expect(consensus?.point.lat).toBeCloseTo(0, 4);
    expect(consensus?.point.lon).toBeCloseTo(0, 4);
    expect(consensus?.observationCount).toBe(3);
    const event = bearingEvent('s', third);
    expect(observationFromBearingEvent(event)).toEqual(third);
  });

  it('writes canonical fields and accepts legacy bearing records', () => {
    const canonical = eligible(first, 'first', { note: 'gate' });
    const stored = bearingEvent('s', canonical);
    expect(stored.data).toMatchObject({
      bearingDeg: 90,
      accuracyDeg: 4,
      gpsAccuracyM: 4,
      gpsAgeMs: 500,
      confirmedReceptionId: 1,
      confirmedReceptionAgeMs: 2_000,
    });
    expect(stored.data).not.toHaveProperty('degrees');
    expect(stored.data).not.toHaveProperty('uncertainty');

    expect(observationFromBearingEvent({
      id: 7,
      sessionId: 's',
      t: 10,
      type: 'bearing',
      data: { lat: 1, lon: 2, degrees: -10, uncertainty: 12, accuracy: 18 },
    })).toEqual({
      id: 7,
      t: 10,
      lat: 1,
      lon: 2,
      bearingDeg: 350,
      accuracyDeg: 12,
      gpsAccuracyM: 18,
    });
  });

  it('requires fresh, accurate GPS and a recent confirmed reception', () => {
    const observations = [
      eligible(first, 'stale', { gpsAgeMs: 20_000 }),
      eligible(second, 'poor', { gpsAccuracyM: 100 }),
      eligible({ ...first, lat: 0.001 }, 'unconfirmed', {
        confirmedReceptionAgeMs: 60_000,
      }),
    ];
    const analysis = analyzeBearingConsensus(observations);
    expect(analysis.ready).toBe(false);
    expect(analysis.exclusions.map(({ reason }) => reason)).toEqual([
      'stale-gps',
      'poor-gps',
      'no-recent-confirmed-reception',
    ]);
  });

  it('rejects inadequate separation, near-parallel geometry, and backward rays', () => {
    const tooClose = analyzeBearingConsensus([
      eligible(first, 'a'),
      eligible({ ...first, lon: -0.00095, bearingDeg: 80 }, 'b'),
    ]);
    expect(tooClose.exclusions.some(({ reason }) => reason === 'insufficient-separation')).toBe(true);

    const parallel = analyzeBearingConsensus([
      eligible(first, 'a'),
      eligible({ ...first, lat: 0.001 }, 'b'),
    ]);
    expect(parallel.exclusions.some(({ reason }) => reason === 'near-parallel')).toBe(true);

    const backward = analyzeBearingConsensus([
      eligible(first, 'a'),
      eligible({ ...second, bearingDeg: 180 }, 'b'),
    ]);
    expect(backward.exclusions.some(({ reason }) => reason === 'backward-intersection')).toBe(true);
  });

  it('forms a weighted approximate zone and expands it for poorer inputs', () => {
    const tight = analyzeBearingConsensus([
      eligible(first, 'west', { accuracyDeg: 2, gpsAccuracyM: 3 }),
      eligible(second, 'south', { accuracyDeg: 2, gpsAccuracyM: 3 }),
    ]);
    const broad = analyzeBearingConsensus([
      eligible(first, 'west', { accuracyDeg: 20, gpsAccuracyM: 30 }),
      eligible(second, 'south', { accuracyDeg: 20, gpsAccuracyM: 30 }),
    ]);
    expect(tight.ready).toBe(true);
    expect(tight.consensus?.approximate).toBe(true);
    expect(tight.consensus?.polygon).toHaveLength(32);
    expect(tight.consensus?.geometryQuality).toBe('good');
    expect(broad.consensus?.radiusM).toBeGreaterThan(tight.consensus?.radiusM ?? Infinity);
  });

  it('keeps a consistent three-bearing consensus and excludes an outlier', () => {
    const correctThird: BearingObservation = {
      t: 3,
      lat: 0.001,
      lon: 0.001,
      bearingDeg: 225,
    };
    const outlier: BearingObservation = {
      t: 4,
      lat: 0.001,
      lon: 0,
      bearingDeg: 90,
    };
    const analysis = analyzeBearingConsensus([
      eligible(first, 'west'),
      eligible(second, 'south'),
      eligible(correctThird, 'north-east'),
      eligible(outlier, 'outlier'),
    ]);
    expect(analysis.consensus?.point.lat).toBeCloseTo(0, 4);
    expect(analysis.consensus?.point.lon).toBeCloseTo(0, 4);
    expect(analysis.consensus?.contributingObservationIds).toEqual(
      expect.arrayContaining(['west', 'south', 'north-east']),
    );
    expect(analysis.consensus?.confidence).toBe('high');
    expect(analysis.exclusions.some(({ reason, observationIds }) =>
      reason === 'outlier' && observationIds.includes('outlier'))).toBe(true);
  });

  it('bounds consensus work and reports older observations omitted by the safety cap', () => {
    const observations = Array.from({ length: 20 }, (_, index) => eligible({
      t: index,
      lat: 0,
      lon: -0.002 + index * 0.00001,
      bearingDeg: 90,
    }, `old-${index}`));
    observations.push(eligible(first, 'west'), eligible(second, 'south'));
    const analysis = analyzeBearingConsensus(observations, { maximumObservations: 2 });
    expect(analysis.ready).toBe(true);
    expect(analysis.consensus?.contributingObservationIds).toEqual(['west', 'south']);
    expect(analysis.exclusions).toContainEqual(expect.objectContaining({
      reason: 'analysis-limit',
      detail: expect.stringContaining('20 older bearing observations omitted'),
    }));
  });

  it('intersects convex latitude/longitude polygons', () => {
    const overlap = intersectConvexPolygons(
      [[0, 0], [0, 0.002], [0.002, 0.002], [0.002, 0]],
      [[0.001, 0.001], [0.001, 0.003], [0.003, 0.003], [0.003, 0.001]],
    );
    expect(overlap).toHaveLength(4);
    expect(Math.min(...overlap.map(([lat]) => lat))).toBeCloseTo(0.001, 6);
    expect(Math.max(...overlap.map(([, lon]) => lon))).toBeCloseTo(0.002, 6);
    expect(intersectConvexPolygons(
      [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0]],
      [[1, 1], [1, 1.001], [1.001, 1.001], [1.001, 1]],
    )).toEqual([]);
  });

  it('derives an overlap zone and reports signal/bearing disagreement', () => {
    const observations = [eligible(first, 'west'), eligible(second, 'south')];
    const overlappingSignal: Array<[number, number]> = [
      [-0.0002, -0.0002],
      [-0.0002, 0.0002],
      [0.0002, 0.0002],
      [0.0002, -0.0002],
    ];
    const result = deriveFinalApproach(observations, overlappingSignal, 4, {
      generatedAt: 123,
      signalConfidence: 'high',
    });
    expect(result.estimate).toMatchObject({
      ready: true,
      approximate: true,
      bearingCount: 2,
      signalCellCount: 4,
      generatedAt: 123,
    });
    expect(result.estimate.polygon?.length).toBeGreaterThanOrEqual(3);
    expect(result.estimate.areaM2).toBeGreaterThan(0);

    const disagreement = deriveFinalApproach(observations, [
      [0.01, 0.01],
      [0.01, 0.011],
      [0.011, 0.011],
      [0.011, 0.01],
    ], 4);
    expect(disagreement.estimate.ready).toBe(false);
    expect(disagreement.estimate.disagreement).toBe(true);
    expect(disagreement.estimate.reason).toContain('do not overlap');
  });
});
