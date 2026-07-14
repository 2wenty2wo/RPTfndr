import { describe, expect, it } from 'vitest';

import { DEFAULT_SESSION_SETTINGS, type CellAggregate, type Reception, type SearchSession } from '../types';
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

  it('rejects malformed optional target names and last-known labels', () => {
    const malformedName = structuredClone(createSessionArchive(archiveInput));
    malformedName.session.targetSnapshot.identity.name = '';
    expect(() => parseSessionArchive(JSON.stringify(malformedName))).toThrow(ArchiveValidationError);

    const malformedLocation = structuredClone(createSessionArchive(archiveInput));
    malformedLocation.session.targetSnapshot.lastKnown = {
      lat: -33.86,
      lon: 151.2,
      label: '',
    };
    expect(() => parseSessionArchive(JSON.stringify(malformedLocation))).toThrow(ArchiveValidationError);
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
  it('exports reception, cell, hull, and bearing features in lon/lat order', () => {
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
      events: [{
        sessionId: session.id,
        t: reception.t,
        type: 'bearing',
        data: { lat: -33.86, lon: 151.2, degrees: 90 },
      }],
    });
    expect(geojson.features.map((feature) => feature.properties.featureType)).toEqual([
      'reception', 'signal-cell', 'search-area-estimate', 'bearing',
    ]);
    expect(geojson.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [151.2, -33.86] });
    expect(geojson.metadata.caveat).toContain('does not identify an exact');
  });

  it('uses technical-search wording and never labels the log as evidence', () => {
    const summary = buildTechnicalSummary(createSessionArchive(archiveInput));
    expect(summary).toContain('technical search log');
    expect(summary).toContain('does not identify or claim an exact transmitter position');
    expect(summary.toLowerCase()).not.toContain('evidence');
  });
});
