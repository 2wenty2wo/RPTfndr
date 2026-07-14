import { describe, expect, it } from 'vitest';
import {
  bearingEvent,
  consensusBearing,
  intersectBearings,
  observationFromBearingEvent,
  type BearingObservation,
} from './bearings';

const first: BearingObservation = { t: 1, lat: 0, lon: -0.001, bearingDeg: 90 };
const second: BearingObservation = { t: 2, lat: -0.001, lon: 0, bearingDeg: 0 };

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
});
