import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_SETTINGS,
  type CellAggregate,
  type Reception,
  type RemoteObserverEvidence,
  type SearchSession,
} from '../types';
import type {
  BearingConsensus,
  FinalApproachEstimate,
  RemoteObserverAnalysis,
  RemoteObserverCombinedZone,
} from '../location';
import { buildReceptionCsv, parseCsv, parseReceptionCsv, stringifyCsv } from './csv';
import { buildGeoJson } from './geojson';
import { sha256Hex, verifySha256 } from './hash';
import {
  ArchiveValidationError,
  createJsonArchiveExport,
  createSessionArchive,
  parseSessionArchive,
  serializeSessionArchive,
  validateSessionArchive,
} from './json';
import { buildTechnicalSummary } from './summary';

const session: SearchSession = {
  id: 'session-1',
  title: 'Creek, "north"',
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_010_000,
  state: 'ended',
  targetSnapshot: {
    id: 'target-1',
    label: 'Test repeater',
    identity: { kind: 'full-pubkey', pubkeyHex: 'aa'.repeat(32) },
    source: 'manual',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
  app: { version: '1.0.0', commit: 'test', decoderVersion: '0.3.0' },
  mode: 'walk',
  demo: false,
  settings: { ...DEFAULT_SESSION_SETTINGS },
  counters: {
    receptions: 1,
    confirmed: 1,
    located: 1,
    fixesAccepted: 1,
    fixesRejected: 0,
    decodeFailed: 0,
    discoveries: 0,
  },
};

const reception: Reception = {
  id: 1,
  sessionId: session.id,
  t: 1_700_000_001_000,
  source: 'rx',
  opcode: 0x88,
  frameHex: '8804b0aa',
  loraHex: 'aa',
  rssi: -80,
  snr: 1,
  decoded: {
    hashHex: 'cafe',
    routeType: 'flood',
    payloadType: 7,
    payloadTypeName: 'AnonRequest',
    payloadVersion: 0,
    pathHashSize: 1,
    path: [],
    anonSenderPubkeyHex: 'aa'.repeat(32),
    warnings: [],
    totalBytes: 1,
    rawDecoded: {},
  },
  cls: {
    kind: 'DIRECT_TARGET',
    confirmed: true,
    explanation: 'Full origin public key matches the target.\nConfirmed.',
    identityTier: 'full-pubkey',
    origin: { pubkeyHex: 'aa'.repeat(32) },
    flags: { originIsTarget: true, zeroHop: true },
  },
  conf: 1,
  gps: { status: 'ok', fixId: 1, lat: -33.86, lon: 151.2, accuracy: 7, ageMs: 500, quality: 'good' },
};

const archiveInput = {
  session,
  receptions: [reception],
  fixes: [{
    id: 1,
    sessionId: session.id,
    t: 1_700_000_000_500,
    posT: 1_700_000_000_500,
    lat: -33.86,
    lon: 151.2,
    accuracy: 7,
    speed: 1.2,
    heading: 45,
    accepted: true,
    acceptedNum: 1 as const,
    quality: 'good' as const,
  }],
  events: [],
  exportedAt: '2024-01-01T00:00:00.000Z',
};

describe('SHA-256 export hashing', () => {
  it('matches the standard abc vector and verifies case-insensitively', async () => {
    const digest = await sha256Hex('abc');
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await expect(verifySha256('abc', digest.toUpperCase())).resolves.toBe(true);
    await expect(verifySha256('abd', digest)).resolves.toBe(false);
  });
});

describe('JSON archive', () => {
  it('round-trips a validated archive and hashes the exact exported bytes', async () => {
    const exported = await createJsonArchiveExport(archiveInput);
    expect(exported.archive.simulatedData).toBe(false);
    await expect(verifySha256(exported.json, exported.sha256)).resolves.toBe(true);
    expect(parseSessionArchive(exported.json)).toEqual(exported.archive);
    expect(exported.filename).toContain('creek-north');
  });

  it('serializes canonically regardless of object insertion order', () => {
    const archive = createSessionArchive(archiveInput);
    const clone = JSON.parse(JSON.stringify(archive)) as typeof archive;
    expect(serializeSessionArchive(archive)).toBe(serializeSessionArchive(clone));
  });

  it('rejects provenance mismatches and records from another session', () => {
    const archive = createSessionArchive(archiveInput);
    const mismatched = { ...archive, simulatedData: true };
    const result = validateSessionArchive(mismatched);
    expect(result.ok).toBe(false);

    const wrongSession = structuredClone(archive);
    wrongSession.receptions[0]!.sessionId = 'other';
    expect(() => parseSessionArchive(JSON.stringify(wrongSession))).toThrow(ArchiveValidationError);
  });

  it('rejects malformed session settings, counters, and target identities before persistence', () => {
    const malformed = structuredClone(createSessionArchive(archiveInput)) as unknown as {
      session: Record<string, unknown>;
    };
    malformed.session.settings = { audioMode: 'chime' };
    malformed.session.counters = { receptions: -1 };
    malformed.session.targetSnapshot = {
      id: 'bad-target',
      label: 'Bad target',
      source: 'manual',
      createdAt: 1,
      updatedAt: 1,
      identity: { kind: 'full-pubkey', pubkeyHex: 'abcd' },
    };

    expect(() => parseSessionArchive(JSON.stringify(malformed))).toThrow(ArchiveValidationError);
  });

  it('rejects malformed target names and advertised reference metadata', () => {
    const malformedName = structuredClone(createSessionArchive(archiveInput));
    malformedName.session.targetSnapshot.identity.name = '';
    expect(() => parseSessionArchive(JSON.stringify(malformedName))).toThrow(ArchiveValidationError);

    const malformedLocation = structuredClone(createSessionArchive(archiveInput));
    malformedLocation.session.targetSnapshot.advertisedReference = {
      lat: 91,
      lon: 151.2,
      source: 'advert',
      observedAt: 1_700_000_000_000,
      trust: 'untrusted-admin',
    };
    expect(() => parseSessionArchive(JSON.stringify(malformedLocation))).toThrow(ArchiveValidationError);
  });

  it('normalizes v1 lastKnown targets and legacy bearing fields to archive v3', () => {
    const current = createSessionArchive(archiveInput);
    const legacy = structuredClone(current) as unknown as {
      version: number;
      session: { targetSnapshot: Record<string, unknown> };
      events: Array<Record<string, unknown>>;
    };
    legacy.version = 1;
    legacy.session.targetSnapshot.lastKnown = {
      lat: -33.86,
      lon: 151.2,
      label: 'Last self-reported contact position',
    };
    legacy.events = [{
      id: 9,
      sessionId: session.id,
      t: 1_700_000_001_000,
      type: 'bearing',
      data: {
        lat: -33.86,
        lon: 151.2,
        degrees: -270,
        uncertainty: 15,
        accuracy: 7,
      },
    }];

    const imported = parseSessionArchive(JSON.stringify(legacy));
    expect(imported.version).toBe(3);
    expect(imported.session.targetSnapshot.advertisedReference).toEqual({
      lat: -33.86,
      lon: 151.2,
      source: 'contact',
      observedAt: session.targetSnapshot.updatedAt,
      trust: 'untrusted-admin',
    });
    expect(imported.session.targetSnapshot).not.toHaveProperty('lastKnown');
    expect(imported.events[0]?.data).toMatchObject({
      bearingDeg: 90,
      accuracyDeg: 15,
      gpsAccuracyM: 7,
    });
    expect(imported.events[0]?.data).not.toHaveProperty('degrees');
    expect(imported.events[0]?.data).not.toHaveProperty('uncertainty');
  });

  it('normalizes archive v2 sessions with conservative Smart Wardrive defaults', () => {
    const legacy = structuredClone(createSessionArchive(archiveInput)) as unknown as {
      version: number;
      session: { settings: Record<string, unknown> };
    };
    legacy.version = 2;
    delete legacy.session.settings.smartWardriveEnabled;
    delete legacy.session.settings.autoDiscoveryEnabled;
    delete legacy.session.settings.autoDiscoveryIntervalSec;
    delete legacy.session.settings.observerAssistEnabled;
    delete legacy.session.settings.observerPollIntervalMin;

    const imported = parseSessionArchive(JSON.stringify(legacy));
    expect(imported.version).toBe(3);
    expect(imported.session.settings).toMatchObject({
      smartWardriveEnabled: false,
      autoDiscoveryEnabled: false,
      autoDiscoveryIntervalSec: 90,
      observerAssistEnabled: false,
      observerPollIntervalMin: 10,
    });
  });

  it('round-trips approximate bearing and final-approach metadata in archive v3', () => {
    const bearingConsensus: BearingConsensus = {
      point: { lat: -33.86, lon: 151.2 },
      observationCount: 2,
      rmsCrossTrackErrorM: 12,
      confidence: 'medium',
      radiusM: 45,
      polygon: [[-33.86, 151.2], [-33.861, 151.201], [-33.861, 151.2]],
      geometryQuality: 'fair',
      contributingObservationIds: [1, 2],
      exclusionReasons: [],
      approximate: true,
    };
    const finalApproach: FinalApproachEstimate = {
      ready: false,
      reason: 'The inputs do not overlap.',
      confidence: 'low',
      bearingCount: 2,
      signalCellCount: 3,
      contributingObservationIds: [1, 2],
      exclusionReasons: [],
      approximate: true,
      disagreement: true,
      generatedAt: reception.t,
    };
    const archive = createSessionArchive({ ...archiveInput, bearingConsensus, finalApproach });
    const parsed = parseSessionArchive(serializeSessionArchive(archive));
    expect(parsed.derived?.bearingConsensus).toMatchObject({ approximate: true, radiusM: 45 });
    expect(parsed.derived?.finalApproach).toMatchObject({
      approximate: true,
      ready: false,
      disagreement: true,
    });
  });

  it('rejects unsafe decoded shapes, impossible dates, and false confirmed invariants', () => {
    const malformed = structuredClone(createSessionArchive(archiveInput));
    (malformed.receptions[0]!.decoded as unknown as { path: unknown }).path = 'not-an-array';
    malformed.receptions[0]!.t = Number.MAX_VALUE;
    malformed.receptions[0]!.cls.kind = 'NON_TARGET';
    malformed.receptions[0]!.cls.confirmed = true;
    malformed.receptions[0]!.conf = 1;
    expect(() => parseSessionArchive(JSON.stringify(malformed))).toThrow(ArchiveValidationError);
  });

  it('requires complete GPS snapshots and protocol-sized path hashes', () => {
    const missingGps = structuredClone(createSessionArchive(archiveInput));
    missingGps.receptions[0]!.gps = { status: 'ok' };
    expect(() => parseSessionArchive(JSON.stringify(missingGps))).toThrow(ArchiveValidationError);

    const wrongPathSize = structuredClone(createSessionArchive(archiveInput));
    wrongPathSize.receptions[0]!.decoded!.pathHashSize = 2;
    wrongPathSize.receptions[0]!.decoded!.path = ['aa'];
    expect(() => parseSessionArchive(JSON.stringify(wrongPathSize))).toThrow(ArchiveValidationError);
  });

  it('round-trips verified observer reports and approximate remote/local zones', () => {
    const observerEvent = {
      sessionId: session.id,
      t: reception.t,
      type: 'observer-evidence' as const,
      data: {
        id: 'report-1',
        observerId: 'ridge-observer',
        observerPubkeyHex: 'bb'.repeat(32),
        targetPubkeyHex: 'aa'.repeat(32),
        observedAt: reception.t - 30_000,
        receivedAt: reception.t,
        heardSecondsAgo: 30,
        snr: -4.25,
        anchorLat: -33.85,
        anchorLon: 151.19,
        anchorAccuracyM: 8,
        anchorVerifiedAt: reception.t - 86_400_000,
        anchorVerification: 'operator-confirmed',
        source: 'guest-neighbour',
        trust: 'verified-observer',
      },
    };
    const remoteObserverAnalysis: RemoteObserverAnalysis = {
      ready: true,
      reason: 'Approximate remote-observer likelihood zone.',
      eligibleObserverCount: 2,
      eligibleObservationCount: 2,
      exclusions: [],
      zone: {
        polygon: [[-33.85, 151.19], [-33.86, 151.21], [-33.87, 151.19]],
        areaM2: 1_250_000,
        confidence: 'low',
        geometryQuality: 'fair',
        observerCount: 2,
        observationCount: 2,
        relativeConstraintCount: 1,
        contributingObservationIds: ['report-1', 'report-2'],
        contributingObserverIds: ['bb'.repeat(32), 'cc'.repeat(32)],
        exclusionReasons: [],
        terrainUncertaintyDb: 10,
        generatedAt: reception.t,
        approximate: true,
        method: 'relative-snr-envelope',
      },
    };
    const communityAssistedZone: RemoteObserverCombinedZone = {
      ready: true,
      reason: 'Approximate overlap between remote observers and the local search zone.',
      polygon: [[-33.855, 151.195], [-33.86, 151.2], [-33.865, 151.195]],
      areaM2: 350_000,
      confidence: 'low',
      observerCount: 2,
      contributingObservationIds: ['report-1', 'report-2'],
      contributingObserverIds: ['bb'.repeat(32), 'cc'.repeat(32)],
      approximate: true,
      generatedAt: reception.t,
    };
    const archive = createSessionArchive({
      ...archiveInput,
      events: [observerEvent],
      remoteObserverAnalysis,
      communityAssistedZone,
    });
    const parsed = parseSessionArchive(serializeSessionArchive(archive));
    expect(parsed.events[0]?.type).toBe('observer-evidence');
    expect(parsed.derived?.remoteObserverAnalysis?.zone).toMatchObject({
      approximate: true,
      method: 'relative-snr-envelope',
      observerCount: 2,
    });
    expect(parsed.derived?.communityAssistedZone).toMatchObject({
      approximate: true,
      ready: true,
    });

    const untrusted = structuredClone(archive);
    untrusted.events[0]!.data.trust = 'untrusted-admin';
    expect(() => parseSessionArchive(JSON.stringify(untrusted))).toThrow(ArchiveValidationError);

    const invalidAnchor = structuredClone(archive);
    invalidAnchor.events[0]!.data.anchorLat = 120;
    try {
      parseSessionArchive(JSON.stringify(invalidAnchor));
      throw new Error('Expected invalid observer latitude to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as ArchiveValidationError).issues).toContainEqual({
        path: '$.events[0].data.anchorLat',
        message: 'must be between -90 and 90',
      });
    }

    const inconsistentAge = structuredClone(archive);
    inconsistentAge.events[0]!.data.observedAt = reception.t - 1_000;
    inconsistentAge.events[0]!.data.heardSecondsAgo = 300;
    expect(() => parseSessionArchive(JSON.stringify(inconsistentAge))).toThrowError(
      /heardSecondsAgo: must agree with observedAt and receivedAt/,
    );
  });
});

describe('CSV export', () => {
  it('round-trips quotes, commas, and embedded newlines using RFC 4180', () => {
    const rows = [['plain', 'comma,value', 'quote"value', 'two\nlines', '']];
    expect(parseCsv(stringifyCsv(rows))).toEqual(rows);
  });

  it('exports the stable reception schema and imports it review-only', () => {
    const text = buildReceptionCsv(archiveInput);
    expect(text).toContain('raw_frame_hex');
    expect(text).toContain('"Full origin public key matches the target.\nConfirmed."');
    const parsed = parseReceptionCsv(text);
    expect(parsed.reviewOnly).toBe(true);
    expect(parsed.rows[0]?.classification).toBe('DIRECT_TARGET');
    expect(parsed.rows[0]?.speed_mps).toBe('1.2');
    expect(parsed.simulatedData).toBe(false);
  });
});

describe('GeoJSON and technical summary', () => {
  it('exports reception, signal, bearing, and final-approach zones in lon/lat order', () => {
    const cell: CellAggregate = {
      key: '12:1:2',
      centerLat: -33.86,
      centerLon: 151.2,
      sizeM: 12,
      count: 5,
      medianRssi: -80,
      maxRssi: -70,
      madRssi: 2,
      medianSnr: 1,
      maxSnr: 4,
      medianGpsAcc: 7,
      passes: 2,
      octants: 2,
      firstT: reception.t,
      lastT: reception.t,
      minIdentityTier: 'full-pubkey',
      confidence: 0.7,
    };
    const bearingConsensus: BearingConsensus = {
      point: { lat: -33.8602, lon: 151.2002 },
      observationCount: 3,
      rmsCrossTrackErrorM: 8,
      confidence: 'high',
      radiusM: 35,
      polygon: [[-33.86, 151.2], [-33.8605, 151.201], [-33.861, 151.2]],
      geometryQuality: 'good',
      contributingObservationIds: [1, 2, 3],
      exclusionReasons: [],
      approximate: true,
    };
    const finalApproach: FinalApproachEstimate = {
      ready: true,
      reason: 'Approximate overlap',
      polygon: [[-33.8601, 151.2001], [-33.8604, 151.2007], [-33.8608, 151.2002]],
      areaM2: 120,
      confidence: 'medium',
      bearingCount: 3,
      signalCellCount: 3,
      rmsCrossTrackErrorM: 8,
      geometryQuality: 'good',
      bearingRadiusM: 35,
      contributingObservationIds: [1, 2, 3],
      exclusionReasons: [],
      approximate: true,
      generatedAt: reception.t,
    };
    const geojson = buildGeoJson({
      ...archiveInput,
      cells: [cell],
      estimate: {
        ready: true,
        reason: 'Relative strength window',
        sampleCount: 5,
        cellCount: 3,
        polygon: [[-33.86, 151.2], [-33.861, 151.2], [-33.861, 151.201]],
        areaM2: 200,
        confidence: 'medium',
        generatedAt: reception.t,
      },
      bearingConsensus,
      finalApproach,
      events: [{
        sessionId: session.id,
        t: reception.t,
        type: 'bearing',
        data: { lat: -33.86, lon: 151.2, bearingDeg: 90, accuracyDeg: 8, gpsAccuracyM: 7 },
      }],
    });
    expect(geojson.features.map((feature) => feature.properties.featureType)).toEqual([
      'reception', 'signal-cell', 'search-area-estimate', 'bearing-consensus-zone', 'final-approach-zone', 'bearing',
    ]);
    expect(geojson.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [151.2, -33.86] });
    expect(geojson.metadata.finalApproach).toMatchObject({ ready: true, approximate: true });
    expect(JSON.stringify(geojson).toLowerCase()).not.toMatch(/\b(exact|pinpoint(?:ed)?)\b/);
  });

  it('exports verified observer anchors and approximate remote and combined zones', () => {
    const report: RemoteObserverEvidence = {
      id: 'report-1',
      observerId: 'ridge-observer',
      observerPubkeyHex: 'bb'.repeat(32),
      targetPubkeyHex: 'aa'.repeat(32),
      observedAt: reception.t - 20_000,
      receivedAt: reception.t,
      heardSecondsAgo: 20,
      snr: -3,
      anchorLat: -33.85,
      anchorLon: 151.19,
      anchorAccuracyM: 7,
      anchorVerifiedAt: reception.t - 86_400_000,
      anchorVerification: 'user-surveyed',
      source: 'guest-neighbour',
      trust: 'verified-observer',
    };
    const remoteObserverAnalysis: RemoteObserverAnalysis = {
      ready: true,
      reason: 'Approximate remote-observer likelihood zone.',
      eligibleObserverCount: 2,
      eligibleObservationCount: 2,
      exclusions: [],
      zone: {
        polygon: [[-33.85, 151.19], [-33.86, 151.21], [-33.87, 151.19]],
        areaM2: 1_250_000,
        confidence: 'low',
        geometryQuality: 'fair',
        observerCount: 2,
        observationCount: 2,
        relativeConstraintCount: 1,
        contributingObservationIds: ['report-1', 'report-2'],
        contributingObserverIds: ['bb'.repeat(32), 'cc'.repeat(32)],
        exclusionReasons: [],
        terrainUncertaintyDb: 10,
        generatedAt: reception.t,
        approximate: true,
        method: 'relative-snr-envelope',
      },
    };
    const communityAssistedZone: RemoteObserverCombinedZone = {
      ready: true,
      reason: 'Approximate overlap between remote observers and the local search zone.',
      polygon: [[-33.855, 151.195], [-33.86, 151.2], [-33.865, 151.195]],
      areaM2: 350_000,
      confidence: 'low',
      observerCount: 2,
      contributingObservationIds: ['report-1', 'report-2'],
      contributingObserverIds: ['bb'.repeat(32), 'cc'.repeat(32)],
      approximate: true,
      generatedAt: reception.t,
    };
    const observerEvent = {
      sessionId: session.id,
      t: reception.t,
      type: 'observer-evidence' as const,
      data: { ...report },
    };
    const geojson = buildGeoJson({
      ...archiveInput,
      events: [observerEvent],
      observerEvidence: [report],
      remoteObserverAnalysis,
      communityAssistedZone,
    });
    expect(geojson.features.map((feature) => feature.properties.featureType)).toContain('remote-observer-report');
    expect(geojson.features.map((feature) => feature.properties.featureType)).toContain('remote-observer-zone');
    expect(geojson.features.map((feature) => feature.properties.featureType)).toContain('community-assisted-zone');
    const anchor = geojson.features.find((feature) => feature.properties.featureType === 'remote-observer-report');
    expect(anchor?.geometry).toEqual({ type: 'Point', coordinates: [151.19, -33.85] });
    expect(anchor?.properties.positionRole).toBe('verified-observer-anchor');
    expect(anchor?.properties.analysisEligibility).toBe('contributing');
    expect(geojson.metadata.remoteObservers).toMatchObject({ approximate: true, observerCount: 2 });
    expect(geojson.metadata.communityAssistedZone).toMatchObject({ approximate: true, ready: true });

    const summary = buildTechnicalSummary(createSessionArchive({
      ...archiveInput,
      events: [observerEvent],
      remoteObserverAnalysis,
      communityAssistedZone,
    }));
    expect(summary).toContain('Target-matched guest neighbour reports: 1');
    expect(summary).toContain('Community-assisted search zone');
    expect(summary.toLowerCase()).not.toMatch(/\b(exact|pinpoint(?:ed)?)\b/);
    expect(JSON.stringify(geojson).toLowerCase()).not.toMatch(/\b(exact|pinpoint(?:ed)?)\b/);

    const wrongTargetReport = { ...report, id: 'wrong-target', targetPubkeyHex: 'dd'.repeat(32) };
    const wrongTargetGeoJson = buildGeoJson({
      ...archiveInput,
      events: [{ ...observerEvent, data: { ...wrongTargetReport } }],
      observerEvidence: [wrongTargetReport],
    });
    expect(wrongTargetGeoJson.features.some((feature) => (
      feature.properties.featureType === 'remote-observer-report'
    ))).toBe(false);
    const wrongTargetSummary = buildTechnicalSummary(createSessionArchive({
      ...archiveInput,
      events: [{ ...observerEvent, data: { ...wrongTargetReport } }],
    }));
    expect(wrongTargetSummary).toContain('Target-matched guest neighbour reports: 0');

    const nonContributingGeoJson = buildGeoJson({
      ...archiveInput,
      events: [observerEvent],
      observerEvidence: [report],
    });
    const nonContributing = nonContributingGeoJson.features.find((feature) => (
      feature.properties.featureType === 'remote-observer-report'
    ));
    expect(nonContributing?.properties.analysisEligibility).toBe('not-contributing');

    const importedAuditEvent = {
      sessionId: session.id,
      t: reception.t,
      type: 'note' as const,
      data: {
        kind: 'imported-observer-evidence-audit',
        eligibility: 'audit-only',
        originalEventType: 'observer-evidence',
        evidence: { ...report },
      },
    };
    const auditGeoJson = buildGeoJson({
      ...archiveInput,
      events: [importedAuditEvent],
    });
    expect(auditGeoJson.metadata.importedObserverAudit).toEqual({
      reportCount: 1,
      analysisEligibility: 'audit-only',
      geometryExported: false,
    });
    expect(auditGeoJson.features.some((feature) => (
      feature.properties.featureType === 'remote-observer-report'
    ))).toBe(false);
    const auditSummary = buildTechnicalSummary(createSessionArchive({
      ...archiveInput,
      events: [importedAuditEvent],
    }));
    expect(auditSummary).toContain('Imported audit-only observer reports: 1');
    expect(auditSummary).toContain('excluded from every location calculation');
  });

  it('uses approximate technical-search wording and never labels the log as evidence', () => {
    const summary = buildTechnicalSummary(createSessionArchive(archiveInput));
    expect(summary).toContain('technical search log');
    expect(summary).toContain('Every mapped zone is approximate');
    expect(summary.toLowerCase()).not.toMatch(/\b(exact|pinpoint(?:ed)?)\b/);
    expect(summary.toLowerCase()).not.toContain('evidence');
  });
});
