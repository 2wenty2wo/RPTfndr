import { describe, expect, it } from 'vitest';
import type { GpsFix } from '../types';
import { GpsAssociator, GpsService, associateGpsFix } from './gps';

function acceptedFix(t: number, overrides: Partial<GpsFix> = {}): GpsFix {
  return {
    id: t,
    sessionId: 's',
    t,
    posT: t,
    lat: -33.86,
    lon: 151.2,
    accuracy: 5,
    accepted: true,
    acceptedNum: 1,
    quality: 'good',
    ...overrides,
  };
}

function position(accuracy: number, timestamp = 1_000): GeolocationPosition {
  return {
    timestamp,
    coords: {
      latitude: -33.86,
      longitude: 151.2,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    toJSON: () => ({}),
  };
}

describe('GPS association', () => {
  it('uses fresh, stale, and none boundaries exactly', () => {
    const fixes = [acceptedFix(1_000)];
    expect(associateGpsFix(fixes, 11_000).status).toBe('ok');
    expect(associateGpsFix(fixes, 11_001).status).toBe('stale');
    expect(associateGpsFix(fixes, 31_000).status).toBe('stale');
    expect(associateGpsFix(fixes, 31_001).status).toBe('none');
  });

  it('permits a fix up to one second in the future and ignores rejected fixes', () => {
    const rejected = acceptedFix(2_000, { accepted: false, acceptedNum: 0 });
    const future = acceptedFix(1_900);
    expect(associateGpsFix([rejected, future], 1_000)).toMatchObject({
      status: 'ok',
      fixId: 1_900,
      ageMs: 0,
    });
    expect(associateGpsFix([future], 899).status).toBe('none');
  });

  it('keeps only the 32 newest accepted fixes', () => {
    const associator = new GpsAssociator();
    for (let index = 0; index < 40; index += 1) associator.add(acceptedFix(index));
    expect(associator.values()).toHaveLength(32);
    expect(associator.values()[0]?.t).toBe(8);
    expect(associator.latest()?.t).toBe(39);
  });
});
describe('GpsService', () => {
  it('persists accepted and rejected raw fixes and reports clock skew', async () => {
    const written: GpsFix[] = [];
    const skews: number[] = [];
    const geolocation = {
      watchPosition: () => 7,
      clearWatch: () => undefined,
      getCurrentPosition: () => undefined,
    } as unknown as Geolocation;
    const service = new GpsService({
      geolocation,
      onFix: async (fix) => {
        written.push(fix);
        return written.length;
      },
      onClockSkew: (skew) => skews.push(skew),
    });
    service.start('session');
    const good = service.ingestPosition(position(5, 1_000), 10_000);
    const bad = service.ingestPosition(position(100, 11_000), 11_000);
    await service.flushWrites();
    expect(good).toMatchObject({ accepted: true, acceptedNum: 1, quality: 'good', id: 1 });
    expect(bad).toMatchObject({
      accepted: false,
      acceptedNum: 0,
      rejectReason: 'hard-accuracy',
      id: 2,
    });
    expect(written).toHaveLength(2);
    expect(skews).toEqual([-9_000]);
    expect(service.associate(10_500).status).toBe('ok');
  });

  it('reports unavailable when geolocation is missing', () => {
    const service = new GpsService({ geolocation: null });
    expect(service.start('session')).toBe(false);
    expect(service.getState()).toBe('unavailable');
  });
});
