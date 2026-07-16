import { describe, expect, it } from 'vitest';
import type { AreaEstimate, CellAggregate, GpsFix, VerifiedObserver } from '../types';
import type { BearingConsensusAnalysis, FinalApproachEstimate } from './bearings';
import { recommendNextObservations } from './nextObservation';
import type { RemoteObserverAnalysis } from './remoteObservers';

const cell: CellAggregate = {
  key: 'strong',
  centerLat: 0,
  centerLon: 0,
  sizeM: 12,
  count: 8,
  medianRssi: -55,
  maxRssi: -53,
  madRssi: 1,
  medianSnr: 8,
  maxSnr: 9,
  medianGpsAcc: 5,
  passes: 3,
  octants: 4,
  firstT: 1,
  lastT: 2,
  minIdentityTier: 'full-pubkey',
  confidence: 0.8,
};

function estimate(overrides: Partial<AreaEstimate> = {}): AreaEstimate {
  return {
    ready: true,
    reason: 'Strongest confirmed cells define an approximate search area.',
    sampleCount: 12,
    cellCount: 3,
    polygon: [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0]],
    areaM2: 12_000,
    confidence: 'medium',
    cellsUsed: ['a', 'b', 'c'],
    strongest: cell,
    generatedAt: 10,
    ...overrides,
  };
}

function fix(lat: number, lon: number): GpsFix {
  return {
    sessionId: 's',
    t: 1,
    posT: 1,
    lat,
    lon,
    accuracy: 5,
    accepted: true,
    acceptedNum: 1,
    quality: 'good',
  };
}

const observer: VerifiedObserver = {
  id: 'ridge',
  label: 'Ridge repeater',
  repeaterPubkeyHex: 'abc',
  lat: 0.01,
  lon: 0.01,
  accuracyM: 10,
  verifiedAt: 1,
  verification: 'operator-confirmed',
  trust: 'verified-observer',
  permissionConfirmed: true,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

describe('next observation guidance', () => {
  it('asks for confirmed direct samples when there are no confirmed samples', () => {
    const actions = recommendNextObservations({
      estimate: { ready: false, reason: 'No provably direct target receptions yet.', sampleCount: 0, cellCount: 0, generatedAt: 1 },
    });
    expect(actions[0]).toMatchObject({ kind: 'collect-confirmed-samples' });
    expect(actions[0]?.evidence).toContain('confirmed samples: 0');
  });

  it('prioritizes sampling an under-covered polygon edge for one strong local cluster', () => {
    const actions = recommendNextObservations({
      estimate: estimate({ confidence: 'low', cellsUsed: ['strong'], strongest: cell }),
      recentGpsTrack: [fix(0, 0), fix(0, 0.0001)],
    });
    expect(actions.map((action) => action.kind)).toContain('sample-polygon-edge');
    expect(actions.find((action) => action.kind === 'different-approach-pass')).toBeDefined();
  });

  it('explains that two near-parallel bearings need a separated bearing', () => {
    const bearingAnalysis: BearingConsensusAnalysis = {
      ready: false,
      reason: 'No crossing bearing consensus yet.',
      eligibleObservationCount: 2,
      exclusions: [{ reason: 'near-parallel', observationIds: ['a', 'b'], detail: 'Crossing angle is too shallow.' }],
    };
    const actions = recommendNextObservations({ estimate: estimate(), bearingAnalysis });
    expect(actions[0]).toMatchObject({ kind: 'take-separated-bearing' });
    expect(actions[0]?.detail).toContain('near-parallel');
  });

  it('polls a verified observer when remote observers disagree', () => {
    const remoteObserverAnalysis: RemoteObserverAnalysis = {
      ready: false,
      reason: 'Remote observer evidence disagrees with local signal evidence.',
      eligibleObserverCount: 2,
      eligibleObservationCount: 2,
      exclusions: [{ reason: 'inconsistent-relative-signal', observationIds: ['r1', 'r2'], observerIds: ['ridge'], detail: 'SNR order conflicts.' }],
    };
    const actions = recommendNextObservations({
      estimate: estimate(),
      remoteObserverAnalysis,
      observers: [observer],
      observerStatuses: [{ observerId: 'ridge', state: 'idle' }],
    });
    expect(actions[0]).toMatchObject({ kind: 'poll-verified-observer', observerId: 'ridge' });
  });

  it('suggests close-range visual search when the final zone is small and consistent', () => {
    const finalApproach: FinalApproachEstimate = {
      ready: true,
      reason: 'Directional bearings overlap the confirmed-signal search area.',
      polygon: [[0, 0], [0, 0.0002], [0.0002, 0.0002], [0.0002, 0]],
      areaM2: 500,
      confidence: 'medium',
      bearingCount: 3,
      signalCellCount: 4,
      contributingObservationIds: ['a', 'b', 'c'],
      exclusionReasons: [],
      approximate: true,
      generatedAt: 1,
    };
    const actions = recommendNextObservations({ estimate: estimate({ confidence: 'high' }), finalApproach });
    expect(actions[0]).toMatchObject({ kind: 'close-range-visual-search' });
    expect(actions[0]?.detail).toContain('visually verify');
  });
});
