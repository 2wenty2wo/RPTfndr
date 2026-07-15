import { describe, expect, it } from 'vitest';
import {
  analyzeRemoteObservers,
  combineRemoteObserverZone,
  type RemoteObserverObservation,
} from './remoteObservers';

const NOW = 1_000_000;
const TARGET = 'aa'.repeat(32);

function observation(
  id: string,
  lat: number,
  lon: number,
  snrDb: number,
  overrides: Partial<RemoteObserverObservation> = {},
): RemoteObserverObservation {
  return {
    id,
    observerId: `observer-${id}`,
    targetPublicKey: TARGET,
    observedAt: NOW - 1_000,
    lat,
    lon,
    snrDb,
    coordinateVerified: true,
    coordinateAccuracyM: 10,
    targetMatch: 'full-key',
    directNeighbour: true,
    ...overrides,
  };
}

const threeObservers = (): RemoteObserverObservation[] => [
  observation('a', -33.86, 151.19, -3),
  observation('b', -33.86, 151.22, -20),
  observation('c', -33.84, 151.205, -9),
];

describe('analyzeRemoteObservers', () => {
  it('refuses a short target identity even when observations claim a full-key match', () => {
    const analysis = analyzeRemoteObservers(
      threeObservers().map((item) => ({ ...item, targetPublicKey: 'aabbccdd' })),
      { targetPublicKey: 'aabbccdd', generatedAt: NOW },
    );

    expect(analysis).toMatchObject({
      ready: false,
      eligibleObserverCount: 0,
      eligibleObservationCount: 0,
    });
    expect(analysis.reason).toContain('full target public key');
  });

  it('produces only a conservative polygon from three verified, target-matched observers', () => {
    const analysis = analyzeRemoteObservers(threeObservers(), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
    });

    expect(analysis.ready).toBe(true);
    expect(analysis.reason).toContain('Approximate');
    expect(analysis.zone).toMatchObject({
      approximate: true,
      method: 'relative-snr-envelope',
      confidence: 'medium',
      observerCount: 3,
      observationCount: 3,
      contributingObservationIds: ['a', 'b', 'c'],
    });
    expect(analysis.zone?.polygon.length).toBeGreaterThanOrEqual(3);
    expect(analysis.zone?.areaM2).toBeGreaterThan(1);
    expect(analysis.zone?.relativeConstraintCount).toBeGreaterThan(0);
    expect(analysis.zone).not.toHaveProperty('point');
    expect(analysis.zone?.confidence).not.toBe('high');
  });

  it('allows two separated observers at low confidence and recommends a third', () => {
    const analysis = analyzeRemoteObservers(threeObservers().slice(0, 2), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
    });

    expect(analysis.ready).toBe(true);
    expect(analysis.reason).toContain('add a third');
    expect(analysis.zone).toMatchObject({ confidence: 'low', observerCount: 2 });
  });

  it('requires at least two eligible observers', () => {
    const analysis = analyzeRemoteObservers(threeObservers().slice(0, 1), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
    });

    expect(analysis.ready).toBe(false);
    expect(analysis.zone).toBeUndefined();
    expect(analysis.reason).toContain('At least two');
  });

  it('rejects untrusted, stale, mismatched, indirect, ambiguous, future, and invalid records', () => {
    const observations = [
      ...threeObservers().slice(0, 2),
      observation('untrusted', -33.85, 151.2, -8, { coordinateVerified: false }),
      observation('stale', -33.85, 151.2, -8, { observedAt: NOW - 600_000 }),
      observation('future', -33.85, 151.2, -8, { observedAt: NOW + 60_000 }),
      observation('mismatch', -33.85, 151.2, -8, { targetPublicKey: 'bb'.repeat(32) }),
      observation('short', -33.85, 151.2, -8, { targetMatch: 'short-id' }),
      observation('collision', -33.85, 151.2, -8, { identityCollision: true }),
      observation('indirect', -33.85, 151.2, -8, { directNeighbour: false }),
      observation('invalid', -33.85, 181, -8),
    ];
    const analysis = analyzeRemoteObservers(observations, {
      targetPublicKey: TARGET,
      generatedAt: NOW,
    });
    const reasons = analysis.exclusions.map(({ reason }) => reason);

    expect(analysis.ready).toBe(true);
    expect(analysis.eligibleObserverCount).toBe(2);
    expect(analysis.zone?.contributingObservationIds).toEqual(['a', 'b']);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'unverified-observer-position',
        'stale-observation',
        'future-observation',
        'target-mismatch',
        'unverified-target-match',
        'identity-collision',
        'indirect-neighbour',
        'invalid-observation',
      ]),
    );
  });

  it('rejects colliding observation IDs instead of silently choosing one', () => {
    const analysis = analyzeRemoteObservers(
      [
        observation('duplicate', -33.86, 151.19, -3),
        observation('duplicate', -33.86, 151.22, -20, { observerId: 'another-observer' }),
        observation('good', -33.84, 151.205, -9),
      ],
      { targetPublicKey: TARGET, generatedAt: NOW },
    );

    expect(analysis.ready).toBe(false);
    expect(analysis.eligibleObserverCount).toBe(1);
    expect(analysis.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'observation-id-collision',
          observationIds: ['duplicate', 'duplicate'],
        }),
      ]),
    );
  });

  it('rejects one observer identity reported at incompatible verified positions', () => {
    const analysis = analyzeRemoteObservers(
      [
        observation('a1', -33.86, 151.19, -3, { observerId: 'observer-a' }),
        observation('a2', -33.8, 151.3, -4, { observerId: 'observer-a' }),
        observation('b', -33.84, 151.205, -9),
      ],
      { targetPublicKey: TARGET, generatedAt: NOW },
    );

    expect(analysis.ready).toBe(false);
    expect(analysis.exclusions.some(({ reason }) => reason === 'observer-position-collision')).toBe(true);
  });

  it('uses only relative SNR and is invariant to a common SNR offset', () => {
    const original = analyzeRemoteObservers(threeObservers(), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
    });
    const shifted = analyzeRemoteObservers(
      threeObservers().map((item) => ({ ...item, snrDb: item.snrDb + 5 })),
      { targetPublicKey: TARGET, generatedAt: NOW },
    );

    expect(shifted.zone?.polygon).toEqual(original.zone?.polygon);
    expect(shifted.zone?.areaM2).toBe(original.zone?.areaM2);
  });

  it('widens constraints when terrain and fading uncertainty is larger', () => {
    const broad = analyzeRemoteObservers(threeObservers(), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
      terrainUncertaintyDb: 10,
    });
    const tighter = analyzeRemoteObservers(threeObservers(), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
      terrainUncertaintyDb: 2,
    });

    expect(broad.zone?.areaM2).toBeGreaterThanOrEqual(tighter.zone?.areaM2 ?? Number.POSITIVE_INFINITY);
    expect(broad.zone?.terrainUncertaintyDb).toBe(10);
    expect(tighter.zone?.terrainUncertaintyDb).toBe(2);
  });

  it('rejects observers without useful physical separation', () => {
    const analysis = analyzeRemoteObservers(
      [
        observation('a', -33.86, 151.2, -3),
        observation('b', -33.86001, 151.20001, -12),
      ],
      { targetPublicKey: TARGET, generatedAt: NOW },
    );

    expect(analysis.ready).toBe(false);
    expect(analysis.exclusions.some(({ reason }) => reason === 'insufficient-separation')).toBe(true);
  });

  it('caps imported observations before doing pairwise work', () => {
    const analysis = analyzeRemoteObservers(threeObservers(), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
      maximumObservations: 2,
    });

    expect(analysis.ready).toBe(true);
    expect(analysis.zone?.observerCount).toBe(2);
    expect(analysis.exclusions.some(({ reason }) => reason === 'analysis-limit')).toBe(true);
  });
});

describe('combineRemoteObserverZone', () => {
  it('intersects the likelihood polygon with an existing convex search zone', () => {
    const remote = analyzeRemoteObservers(threeObservers(), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
    }).zone;
    const combined = combineRemoteObserverZone(remote, remote?.polygon, {
      otherConfidence: 'high',
      otherZoneLabel: 'confirmed RSSI zone',
      generatedAt: NOW,
    });

    expect(combined).toMatchObject({
      ready: true,
      approximate: true,
      confidence: 'medium',
      observerCount: 3,
    });
    expect(combined.polygon?.length).toBeGreaterThanOrEqual(3);
    expect(combined.areaM2).toBeGreaterThan(1);
  });

  it('reports disagreement when zones do not overlap', () => {
    const remote = analyzeRemoteObservers(threeObservers(), {
      targetPublicKey: TARGET,
      generatedAt: NOW,
    }).zone;
    const farAway: Array<[number, number]> = [
      [0, 0],
      [0, 0.01],
      [0.01, 0.01],
      [0.01, 0],
    ];
    const combined = combineRemoteObserverZone(remote, farAway, { generatedAt: NOW });

    expect(combined).toMatchObject({ ready: false, disagreement: true, confidence: 'low' });
    expect(combined.polygon).toBeUndefined();
  });
});
