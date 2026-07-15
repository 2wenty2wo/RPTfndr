import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_SETTINGS } from '../types';
import type { AreaEstimate, Reception, SessionEvent, TargetProfile, VerifiedObserver } from '../types';
import {
  deriveApproachState,
  deriveRemoteObserverState,
  eventForImportedSession,
  observedAtFromNeighbourAge,
  resolveSessionSettings,
} from './controller';

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

describe('remote observer state', () => {
  it('uses only verified event anchors and ignores the target admin reference', () => {
    const targetKey = 'aa'.repeat(32);
    const target: TargetProfile = {
      id: 'target',
      label: 'Missing repeater',
      identity: { kind: 'full-pubkey', pubkeyHex: targetKey },
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
    const events: SessionEvent[] = [
      ['north', '11'.repeat(32), 0, 0.005, 8],
      ['south', '22'.repeat(32), 0, -0.005, -5],
    ].map(([observerId, observerPubkeyHex, anchorLat, anchorLon, snr], index) => ({
      id: index + 1,
      sessionId: 's',
      t: 1_000_000,
      type: 'observer-evidence' as const,
      data: {
        id: `e-${index}`,
        observerId,
        observerPubkeyHex,
        targetPubkeyHex: targetKey,
        observedAt: 990_000,
        receivedAt: 1_000_000,
        heardSecondsAgo: 10,
        snr,
        anchorLat,
        anchorLon,
        anchorAccuracyM: 10,
        anchorVerifiedAt: 900_000,
        anchorVerification: 'operator-confirmed',
        source: 'guest-neighbour',
        trust: 'verified-observer',
      },
    }));
    const estimate: AreaEstimate = {
      ready: true,
      reason: 'local search',
      sampleCount: 10,
      cellCount: 4,
      polygon: [[-0.002, -0.002], [-0.002, 0.002], [0.002, 0.002], [0.002, -0.002]],
      confidence: 'medium',
      generatedAt: 1_000_000,
    };

    const withFalseReference = deriveRemoteObserverState(events, target, estimate, undefined, 1_000_000);
    const withoutReference = deriveRemoteObserverState(
      events,
      { ...target, advertisedReference: undefined },
      estimate,
      undefined,
      1_000_000,
    );

    expect(withFalseReference.observerEvidence).toHaveLength(2);
    expect(withFalseReference.remoteObserverAnalysis).toMatchObject({ ready: true, eligibleObserverCount: 2 });
    expect(withFalseReference.remoteObserverAnalysis?.zone?.polygon)
      .toEqual(withoutReference.remoteObserverAnalysis?.zone?.polygon);
    expect(withFalseReference.communityAssistedZone?.approximate).toBe(true);
  });

  it('downgrades imported observer claims to audit-only notes', () => {
    const imported = eventForImportedSession({
      id: 9,
      sessionId: 'source',
      t: 100,
      type: 'observer-evidence',
      data: {
        trust: 'verified-observer',
        source: 'guest-neighbour',
        anchorLat: 51.5074,
        anchorLon: -0.1278,
      },
    }, 'imported');

    expect(imported).toMatchObject({
      id: 9,
      sessionId: 'imported',
      type: 'note',
      data: {
        kind: 'imported-observer-evidence-audit',
        eligibility: 'audit-only',
        originalEventType: 'observer-evidence',
      },
    });
    expect(deriveRemoteObserverState([imported], undefined, undefined, undefined, 100).observerEvidence)
      .toEqual([]);
  });

  it('immediately excludes evidence after its observer anchor is changed or revoked', () => {
    const now = 1_000_000;
    const targetKey = 'aa'.repeat(32);
    const target: TargetProfile = {
      id: 'target',
      label: 'Missing repeater',
      identity: { kind: 'full-pubkey', pubkeyHex: targetKey },
      source: 'manual',
      createdAt: 1,
      updatedAt: 1,
    };
    const observer = (id: string, key: string, lon: number): VerifiedObserver => ({
      id,
      label: id,
      repeaterPubkeyHex: key,
      lat: 0,
      lon,
      accuracyM: 10,
      verifiedAt: 900_000,
      verification: 'operator-confirmed',
      trust: 'verified-observer',
      permissionConfirmed: true,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const observers = [
      observer('north', '11'.repeat(32), 0.005),
      observer('south', '22'.repeat(32), -0.005),
    ];
    const events: SessionEvent[] = observers.map((item, index) => ({
      id: index + 1,
      sessionId: 'session',
      t: now,
      type: 'observer-evidence',
      data: {
        id: `report-${index}`,
        observerId: item.id,
        observerPubkeyHex: item.repeaterPubkeyHex,
        targetPubkeyHex: targetKey,
        observedAt: now - 10_000,
        receivedAt: now,
        heardSecondsAgo: 10,
        snr: index === 0 ? 8 : -5,
        anchorLat: item.lat,
        anchorLon: item.lon,
        anchorAccuracyM: item.accuracyM,
        anchorVerifiedAt: item.verifiedAt,
        anchorVerification: item.verification,
        source: 'guest-neighbour',
        trust: 'verified-observer',
      },
    }));

    expect(deriveRemoteObserverState(events, target, undefined, undefined, now, observers))
      .toMatchObject({ remoteObserverAnalysis: { ready: true }, observerEvidence: { length: 2 } });

    const corrected = [{ ...observers[0]!, lon: 0.01, verifiedAt: now }, { ...observers[1]!, enabled: false }];
    const revoked = deriveRemoteObserverState(events, target, undefined, undefined, now, corrected);
    expect(revoked.observerEvidence).toEqual([]);
    expect(revoked.remoteObserverAnalysis).toMatchObject({ ready: false, eligibleObserverCount: 0 });
    expect(revoked.remoteObserverAnalysis?.exclusions.map(({ reason }) => reason))
      .toEqual(['unverified-observer-position', 'unverified-observer-position']);
  });

  it('rejects a neighbour age that predates the Unix epoch instead of creating invalid evidence', () => {
    expect(observedAtFromNeighbourAge(1_000_000, 10)).toBe(990_000);
    expect(observedAtFromNeighbourAge(Date.now(), 0xffff_ffff)).toBeUndefined();
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
