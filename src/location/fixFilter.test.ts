import { describe, expect, it } from 'vitest';
import { GpsFixFilter } from './fixFilter';

const metresToLongitude = (metres: number): number => metres / 111_320;

describe('GpsFixFilter', () => {
  it('hard-rejects fixes above 75 m accuracy without letting them force acceptance', () => {
    const filter = new GpsFixFilter();
    for (let index = 0; index < 8; index += 1) {
      expect(
        filter.process({ lat: 0, lon: 0, accuracy: 76, t: index * 1_000 }),
      ).toMatchObject({ accepted: false, rejectReason: 'hard-accuracy', forced: false });
    }
    expect(filter.getLastAccepted()).toBeUndefined();
  });

  it('holds an implausible jump while stationary and force-accepts after four rejects', () => {
    const filter = new GpsFixFilter();
    expect(filter.process({ lat: 0, lon: 0, accuracy: 1, t: 0 }).accepted).toBe(true);
    for (let index = 1; index <= 4; index += 1) {
      const decision = filter.process({
        lat: 0,
        lon: metresToLongitude(2_000),
        accuracy: 1,
        t: index * 1_000,
      });
      expect(decision).toMatchObject({
        accepted: false,
        rejectReason: 'filter-hold',
        consecutiveRejects: index,
      });
      expect(decision.effectivePosition).toBeUndefined();
    }
    expect(
      filter.process({ lat: 0, lon: metresToLongitude(2_000), accuracy: 1, t: 5_000 }),
    ).toMatchObject({ accepted: true, forced: true, cause: 'jump' });
  });

  it('dead-reckons for at most two seconds once sustained movement is established', () => {
    const filter = new GpsFixFilter();
    for (let index = 0; index <= 3; index += 1) {
      expect(
        filter.process({
          lat: 0,
          lon: metresToLongitude(index * 10),
          accuracy: 1,
          t: index * 1_000,
        }).accepted,
      ).toBe(true);
    }
    const decision = filter.process({
      lat: 0,
      lon: metresToLongitude(1_000),
      accuracy: 1,
      t: 6_000,
    });
    expect(decision).toMatchObject({ accepted: false, rejectReason: 'jump', moving: true });
    expect(decision.effectivePosition?.deadReckoned).toBe(true);
    expect(decision.effectivePosition?.lon).toBeLessThan(metresToLongitude(60));
  });
});
