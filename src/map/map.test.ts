import { describe, expect, it } from 'vitest';
import type { Reception, TargetProfile } from '../types';
import { finderViewportPoints } from './map';

describe('finder map trust boundary', () => {
  it('never uses an untrusted admin coordinate for viewport bounds', () => {
    const reception = {
      gps: { status: 'ok', lat: -33.8688, lon: 151.2093 },
    } as Reception;
    const falseAdvertisedReference: TargetProfile = {
      id: 'target',
      label: 'Target',
      identity: { kind: 'full-pubkey', pubkeyHex: '11'.repeat(32) },
      source: 'contacts',
      advertisedReference: {
        lat: 51.5074,
        lon: -0.1278,
        source: 'contact',
        observedAt: 1,
        trust: 'untrusted-admin',
      },
      createdAt: 1,
      updatedAt: 1,
    };

    expect(finderViewportPoints([reception], falseAdvertisedReference)).toEqual([
      [-33.8688, 151.2093],
    ]);
    expect(finderViewportPoints([], falseAdvertisedReference)).toEqual([]);
  });
});
