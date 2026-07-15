import type {
  AreaEstimate,
  CellAggregate,
  ClassificationKind,
  GpsFix,
  Reception,
  SearchSession,
  SessionEvent,
} from '../types';
import type {
  BearingConsensus,
  FinalApproachEstimate,
  RemoteObserverAnalysis,
  RemoteObserverCombinedZone,
} from '../location';
import {
  normalizeSearchSessionRecord,
  normalizeSessionEventRecord,
} from '../normalize';
import { sha256Hex } from './hash';

export const ARCHIVE_FORMAT = 'meshcore-finder-session' as const;
export const ARCHIVE_VERSION = 3 as const;
export const JSON_ARCHIVE_MIME = 'application/vnd.meshcore-finder.session+json';
export const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export interface SessionArchiveV3 {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  exportedAt: string;
  simulatedData: boolean;
  session: SearchSession;
  receptions: Reception[];
  fixes: GpsFix[];
  events: SessionEvent[];
  derived?: {
    cells?: CellAggregate[];
    estimate?: AreaEstimate;
    bearingConsensus?: BearingConsensus;
    finalApproach?: FinalApproachEstimate;
    remoteObserverAnalysis?: RemoteObserverAnalysis;
    communityAssistedZone?: RemoteObserverCombinedZone;
  };
}

export type SessionArchive = SessionArchiveV3;
/** @deprecated Use SessionArchive; retained as a source-compatible alias. */
export type SessionArchiveV2 = SessionArchiveV3;
/** @deprecated Use SessionArchive; retained as a source-compatible alias. */
export type SessionArchiveV1 = SessionArchiveV3;

export interface SessionArchiveInput {
  session: SearchSession;
  receptions: Reception[];
  fixes: GpsFix[];
  events: SessionEvent[];
  cells?: CellAggregate[];
  estimate?: AreaEstimate;
  bearingConsensus?: BearingConsensus;
  finalApproach?: FinalApproachEstimate;
  remoteObserverAnalysis?: RemoteObserverAnalysis;
  communityAssistedZone?: RemoteObserverCombinedZone;
  exportedAt?: Date | string;
}

export interface JsonArchiveExport {
  archive: SessionArchive;
  json: string;
  sha256: string;
  filename: string;
  mimeType: typeof JSON_ARCHIVE_MIME;
}

export interface ArchiveValidationIssue {
  path: string;
  message: string;
}

export type ArchiveValidationResult =
  | { ok: true; archive: SessionArchive }
  | { ok: false; issues: ArchiveValidationIssue[] };

export interface ArchiveParseOptions {
  maxBytes?: number;
  maxReceptions?: number;
  maxFixes?: number;
  maxEvents?: number;
}

export class ArchiveValidationError extends Error {
  constructor(readonly issues: ArchiveValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'ArchiveValidationError';
  }
}

export function createSessionArchive(input: SessionArchiveInput): SessionArchive {
  const exportedAt = input.exportedAt instanceof Date
    ? input.exportedAt.toISOString()
    : input.exportedAt ?? new Date().toISOString();
  const archive: SessionArchive = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt,
    simulatedData: input.session.demo,
    session: input.session,
    receptions: input.receptions,
    fixes: input.fixes,
    events: input.events,
  };
  if (
    input.cells
    || input.estimate
    || input.bearingConsensus
    || input.finalApproach
    || input.remoteObserverAnalysis
    || input.communityAssistedZone
  ) {
    archive.derived = {
      ...(input.cells ? { cells: input.cells } : {}),
      ...(input.estimate ? { estimate: input.estimate } : {}),
      ...(input.bearingConsensus ? { bearingConsensus: input.bearingConsensus } : {}),
      ...(input.finalApproach ? { finalApproach: input.finalApproach } : {}),
      ...(input.remoteObserverAnalysis ? { remoteObserverAnalysis: input.remoteObserverAnalysis } : {}),
      ...(input.communityAssistedZone ? { communityAssistedZone: input.communityAssistedZone } : {}),
    };
  }
  // Clone through JSON so the exported snapshot cannot be mutated by live
  // session state and cannot contain unsupported values such as BigInt/cycles.
  return normalizeArchive(cloneJson(archive)) as SessionArchive;
}

export function serializeSessionArchive(
  archive: SessionArchive,
  options: { pretty?: boolean; canonical?: boolean } = {},
): string {
  const value = options.canonical === false ? archive : sortObjectKeys(archive);
  return JSON.stringify(value, null, options.pretty === false ? undefined : 2);
}

export async function createJsonArchiveExport(
  input: SessionArchiveInput,
  options: { pretty?: boolean; canonical?: boolean } = {},
): Promise<JsonArchiveExport> {
  const archive = createSessionArchive(input);
  const validation = validateSessionArchive(archive);
  if (!validation.ok) throw new ArchiveValidationError(validation.issues);
  const json = serializeSessionArchive(validation.archive, options);
  return {
    archive: validation.archive,
    json,
    sha256: await sha256Hex(json),
    filename: archiveFilename(validation.archive),
    mimeType: JSON_ARCHIVE_MIME,
  };
}

export function parseSessionArchive(
  text: string,
  options: ArchiveParseOptions = {},
): SessionArchive {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ArchiveValidationError([{ path: '$', message: `archive exceeds ${maxBytes} bytes` }]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ArchiveValidationError([{
      path: '$',
      message: `invalid JSON (${error instanceof Error ? error.message : 'parse failed'})`,
    }]);
  }
  const result = validateSessionArchive(value, options);
  if (!result.ok) throw new ArchiveValidationError(result.issues);
  return result.archive;
}

export const importSessionArchive = parseSessionArchive;

/**
 * Upgrade legacy archive records in memory before validation. Imports always
 * return the canonical v3 shape, so re-exporting never perpetuates legacy
 * coordinate trust semantics or bearing field names.
 */
function normalizeArchive(value: unknown): unknown {
  if (!isRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = { ...value };
  if (value.version === 1 || value.version === 2) {
    next.version = ARCHIVE_VERSION;
    changed = true;
  }

  const session = normalizeSearchSessionRecord(value.session);
  if (session.changed) {
    next.session = session.value;
    changed = true;
  }

  if (Array.isArray(value.events)) {
    const events = value.events.map((event) => normalizeSessionEventRecord(event));
    if (events.some((event) => event.changed)) {
      next.events = events.map((event) => event.value);
      changed = true;
    }
  }
  return changed ? next : value;
}

export function validateSessionArchive(
  value: unknown,
  options: ArchiveParseOptions = {},
): ArchiveValidationResult {
  value = normalizeArchive(value);
  const issues: ArchiveValidationIssue[] = [];
  const issue = (path: string, message: string): void => { issues.push({ path, message }); };
  if (!isRecord(value)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] };

  if (value.format !== ARCHIVE_FORMAT) issue('$.format', `must equal "${ARCHIVE_FORMAT}"`);
  if (value.version !== ARCHIVE_VERSION) issue('$.version', `unsupported archive version ${String(value.version)}`);
  if (!isIsoDate(value.exportedAt)) issue('$.exportedAt', 'must be an ISO timestamp');
  if (typeof value.simulatedData !== 'boolean') issue('$.simulatedData', 'must be a boolean');

  const session = value.session;
  validateSession(session, issue);
  if (isRecord(session) && typeof session.demo === 'boolean'
      && typeof value.simulatedData === 'boolean' && session.demo !== value.simulatedData) {
    issue('$.simulatedData', 'must match session.demo');
  }

  const receptions = validateArray(value.receptions, '$.receptions', options.maxReceptions ?? 1_000_000, issue);
  const fixes = validateArray(value.fixes, '$.fixes', options.maxFixes ?? 1_000_000, issue);
  const events = validateArray(value.events, '$.events', options.maxEvents ?? 250_000, issue);
  const sessionId = isRecord(session) && typeof session.id === 'string' ? session.id : undefined;

  receptions?.forEach((reception, index) => validateReception(reception, index, sessionId, issue));
  fixes?.forEach((fix, index) => validateFix(fix, index, sessionId, issue));
  events?.forEach((event, index) => validateEvent(event, index, sessionId, issue));

  if (value.derived !== undefined && !isRecord(value.derived)) issue('$.derived', 'must be an object');
  if (isRecord(value.derived)) {
    if (value.derived.cells !== undefined && !Array.isArray(value.derived.cells)) {
      issue('$.derived.cells', 'must be an array');
    }
    if (value.derived.estimate !== undefined && !isRecord(value.derived.estimate)) {
      issue('$.derived.estimate', 'must be an object');
    }
    if (value.derived.bearingConsensus !== undefined && !isRecord(value.derived.bearingConsensus)) {
      issue('$.derived.bearingConsensus', 'must be an object');
    } else if (isRecord(value.derived.bearingConsensus)) {
      validateApproximateZone(value.derived.bearingConsensus, '$.derived.bearingConsensus', issue, false);
    }
    if (value.derived.finalApproach !== undefined && !isRecord(value.derived.finalApproach)) {
      issue('$.derived.finalApproach', 'must be an object');
    } else if (isRecord(value.derived.finalApproach)) {
      validateApproximateZone(value.derived.finalApproach, '$.derived.finalApproach', issue, true);
    }
    if (value.derived.remoteObserverAnalysis !== undefined
        && !isRecord(value.derived.remoteObserverAnalysis)) {
      issue('$.derived.remoteObserverAnalysis', 'must be an object');
    } else if (isRecord(value.derived.remoteObserverAnalysis)) {
      validateRemoteObserverAnalysis(
        value.derived.remoteObserverAnalysis,
        '$.derived.remoteObserverAnalysis',
        issue,
      );
    }
    if (value.derived.communityAssistedZone !== undefined
        && !isRecord(value.derived.communityAssistedZone)) {
      issue('$.derived.communityAssistedZone', 'must be an object');
    } else if (isRecord(value.derived.communityAssistedZone)) {
      validateCommunityAssistedZone(
        value.derived.communityAssistedZone,
        '$.derived.communityAssistedZone',
        issue,
      );
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, archive: cloneJson(value) as unknown as SessionArchive };
}

function validateRemoteObserverAnalysis(
  value: Record<string, unknown>,
  path: string,
  issue: (path: string, message: string) => void,
): void {
  if (typeof value.ready !== 'boolean') issue(`${path}.ready`, 'must be a boolean');
  if (!isNonEmptyString(value.reason, 10_000)) issue(`${path}.reason`, 'must be text');
  for (const field of ['eligibleObserverCount', 'eligibleObservationCount'] as const) {
    if (!isNonNegativeInteger(value[field])) {
      issue(`${path}.${field}`, 'must be a non-negative integer');
    }
  }
  if (!Array.isArray(value.exclusions)) issue(`${path}.exclusions`, 'must be an array');
  if (value.zone !== undefined && !isRecord(value.zone)) {
    issue(`${path}.zone`, 'must be an object');
  } else if (isRecord(value.zone)) {
    validateRemoteObserverZone(value.zone, `${path}.zone`, issue);
  }
  if (value.ready === true && !isRecord(value.zone)) {
    issue(`${path}.zone`, 'is required when remote-observer analysis is ready');
  }
}

function validateRemoteObserverZone(
  value: Record<string, unknown>,
  path: string,
  issue: (path: string, message: string) => void,
): void {
  validateApproximateZone(value, path, issue, false);
  if (value.confidence === 'high') {
    issue(`${path}.confidence`, 'remote-observer confidence cannot exceed medium');
  }
  if (!Array.isArray(value.polygon)) {
    issue(`${path}.polygon`, 'is required for a remote-observer zone');
  }
  if (value.method !== 'relative-snr-envelope') {
    issue(`${path}.method`, 'must identify the relative-SNR envelope method');
  }
  if (!['limited', 'fair', 'good'].includes(String(value.geometryQuality))) {
    issue(`${path}.geometryQuality`, 'must be limited, fair, or good');
  }
  for (const field of ['observerCount', 'observationCount', 'relativeConstraintCount'] as const) {
    if (!isNonNegativeInteger(value[field])) {
      issue(`${path}.${field}`, 'must be a non-negative integer');
    }
  }
  if (!isFiniteNumber(value.areaM2) || value.areaM2 < 0) {
    issue(`${path}.areaM2`, 'must be a non-negative number');
  }
  if (!isFiniteNumber(value.terrainUncertaintyDb) || value.terrainUncertaintyDb < 0) {
    issue(`${path}.terrainUncertaintyDb`, 'must be a non-negative number');
  }
  if (!isTimestamp(value.generatedAt)) issue(`${path}.generatedAt`, 'must be a valid timestamp');
  if (!Array.isArray(value.contributingObserverIds)) {
    issue(`${path}.contributingObserverIds`, 'must be an array');
  }
  if (!Array.isArray(value.exclusionReasons)) {
    issue(`${path}.exclusionReasons`, 'must be an array');
  }
}

function validateCommunityAssistedZone(
  value: Record<string, unknown>,
  path: string,
  issue: (path: string, message: string) => void,
): void {
  validateApproximateZone(value, path, issue, true);
  if (value.confidence === 'high') {
    issue(`${path}.confidence`, 'community-assisted confidence cannot exceed medium');
  }
  if (!isNonEmptyString(value.reason, 10_000)) issue(`${path}.reason`, 'must be text');
  if (!isNonNegativeInteger(value.observerCount)) {
    issue(`${path}.observerCount`, 'must be a non-negative integer');
  }
  if (!Array.isArray(value.contributingObserverIds)) {
    issue(`${path}.contributingObserverIds`, 'must be an array');
  }
  if (!isTimestamp(value.generatedAt)) issue(`${path}.generatedAt`, 'must be a valid timestamp');
  if (value.areaM2 !== undefined && (!isFiniteNumber(value.areaM2) || value.areaM2 < 0)) {
    issue(`${path}.areaM2`, 'must be a non-negative number');
  }
  if (value.ready === true && !Array.isArray(value.polygon)) {
    issue(`${path}.polygon`, 'is required when the combined zone is ready');
  }
  if (value.ready === true && !isFiniteNumber(value.areaM2)) {
    issue(`${path}.areaM2`, 'is required when the combined zone is ready');
  }
  if (value.disagreement !== undefined && typeof value.disagreement !== 'boolean') {
    issue(`${path}.disagreement`, 'must be a boolean');
  }
}

function validateApproximateZone(
  value: Record<string, unknown>,
  path: string,
  issue: (path: string, message: string) => void,
  requireReady: boolean,
): void {
  if (value.approximate !== true) issue(`${path}.approximate`, 'must be true');
  if (!['low', 'medium', 'high'].includes(String(value.confidence))) {
    issue(`${path}.confidence`, 'must be low, medium, or high');
  }
  if (requireReady && typeof value.ready !== 'boolean') issue(`${path}.ready`, 'must be a boolean');
  if (value.polygon !== undefined) {
    if (!Array.isArray(value.polygon) || value.polygon.length < 3) {
      issue(`${path}.polygon`, 'must contain at least three coordinate pairs');
    } else {
      value.polygon.forEach((coordinate, index) => {
        if (!Array.isArray(coordinate) || coordinate.length !== 2) {
          issue(`${path}.polygon[${index}]`, 'must be a [latitude, longitude] pair');
          return;
        }
        validateCoordinates(coordinate[0], coordinate[1], `${path}.polygon[${index}]`, issue);
      });
    }
  }
  if (!Array.isArray(value.contributingObservationIds)) {
    issue(`${path}.contributingObservationIds`, 'must be an array');
  }
}

export function archiveFilename(archive: Pick<SessionArchive, 'session'>): string {
  const date = new Date(archive.session.startedAt).toISOString().slice(0, 10);
  const title = archive.session.title
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'session';
  return `meshcore-finder-${date}-${title}${archive.session.demo ? '-simulated' : ''}.json`;
}

const CLASSIFICATION_KINDS = new Set<ClassificationKind>([
  'DECODE_FAILED',
  'UNKNOWN_TRANSMITTER',
  'DIRECT_TARGET',
  'TARGET_IS_IMMEDIATE_TRANSMITTER',
  'AMBIGUOUS_PREFIX',
  'NON_TARGET',
  'TARGET_ORIGIN_BUT_FORWARDED',
  'TARGET_IN_PATH_BUT_NOT_IMMEDIATE',
]);
const CONFIRMED_KINDS = new Set<ClassificationKind>([
  'DIRECT_TARGET',
  'TARGET_IS_IMMEDIATE_TRANSMITTER',
]);

function validateSession(value: unknown, issue: (path: string, message: string) => void): void {
  if (!isRecord(value)) {
    issue('$.session', 'must be an object');
    return;
  }
  if (!isNonEmptyString(value.id, 200)) issue('$.session.id', 'must be a non-empty string');
  if (!isNonEmptyString(value.title, 500)) issue('$.session.title', 'must be a non-empty string');
  if (!isTimestamp(value.startedAt)) issue('$.session.startedAt', 'must be a valid timestamp');
  if (!isTimestamp(value.createdAt)) issue('$.session.createdAt', 'must be a valid timestamp');
  if (!['active', 'paused', 'ended'].includes(String(value.state))) issue('$.session.state', 'is invalid');
  if (!['walk', 'drive'].includes(String(value.mode))) issue('$.session.mode', 'must be walk or drive');
  if (typeof value.demo !== 'boolean') issue('$.session.demo', 'must be a boolean');
  if (value.endedAt !== undefined && !isTimestamp(value.endedAt)) issue('$.session.endedAt', 'must be a valid timestamp');
  validateTarget(value.targetSnapshot, issue);
  validateSettings(value.settings, value.mode, issue);
  validateCounters(value.counters, issue);
  if (!isRecord(value.app)
      || !isNonEmptyString(value.app.version, 100)
      || !isNonEmptyString(value.app.commit, 200)
      || !isNonEmptyString(value.app.decoderVersion, 100)) {
    issue('$.session.app', 'must include app, commit, and decoder versions');
  }
  if (value.device !== undefined) {
    if (!isRecord(value.device)) issue('$.session.device', 'must be an object');
    else {
      validateHex(value.device.pubkeyHex, '$.session.device.pubkeyHex', issue, true);
      if (typeof value.device.pubkeyHex === 'string' && value.device.pubkeyHex.length !== 64) {
        issue('$.session.device.pubkeyHex', 'must contain a 32-byte public key');
      }
      if (value.device.battMv !== undefined && !isFiniteNumber(value.device.battMv)) {
        issue('$.session.device.battMv', 'must be finite');
      }
    }
  }
  if (value.calibration !== undefined) {
    if (!isRecord(value.calibration)) issue('$.session.calibration', 'must be an object');
    else for (const key of ['weakRssi', 'strongRssi', 'weakSnr', 'strongSnr']) {
      if (!isFiniteNumber(value.calibration[key])) issue(`$.session.calibration.${key}`, 'must be finite');
    }
  }
}

function validateTarget(value: unknown, issue: (path: string, message: string) => void): void {
  const path = '$.session.targetSnapshot';
  if (!isRecord(value)) { issue(path, 'must be an object'); return; }
  if (!isNonEmptyString(value.id, 200)) issue(`${path}.id`, 'must be a non-empty string');
  if (!isNonEmptyString(value.label, 500)) issue(`${path}.label`, 'must be a non-empty string');
  if (!['manual', 'contacts', 'observed'].includes(String(value.source))) issue(`${path}.source`, 'is invalid');
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) issue(`${path}.createdAt`, 'timestamps must be valid');
  if (!isRecord(value.identity)) { issue(`${path}.identity`, 'must be an object'); return; }
  const kind = String(value.identity.kind);
  if (value.identity.name !== undefined && !isNonEmptyString(value.identity.name, 500)) {
    issue(`${path}.identity.name`, 'must be a non-empty name when present');
  }
  if (!['full-pubkey', 'node-id', 'prefix', 'name-only'].includes(kind)) {
    issue(`${path}.identity.kind`, 'is invalid');
    return;
  }
  if (kind === 'full-pubkey') {
    validateHex(value.identity.pubkeyHex, `${path}.identity.pubkeyHex`, issue, true);
    if (typeof value.identity.pubkeyHex === 'string' && value.identity.pubkeyHex.length !== 64) {
      issue(`${path}.identity.pubkeyHex`, 'must contain a 32-byte public key');
    }
  } else if (kind === 'node-id') {
    validateHex(value.identity.bytesHex, `${path}.identity.bytesHex`, issue, true);
    if (typeof value.identity.bytesHex === 'string' && value.identity.bytesHex.length !== 8) {
      issue(`${path}.identity.bytesHex`, 'must contain a 4-byte node ID');
    }
  } else if (kind === 'prefix') {
    validateHex(value.identity.bytesHex, `${path}.identity.bytesHex`, issue, true);
    if (typeof value.identity.bytesHex === 'string' && value.identity.bytesHex.length >= 64) {
      issue(`${path}.identity.bytesHex`, 'must be shorter than a full public key');
    }
  } else if (value.identity.name === undefined) {
    issue(`${path}.identity.name`, 'must be a non-empty name');
  }
  if (value.advertisedReference !== undefined) {
    if (!isRecord(value.advertisedReference)) {
      issue(`${path}.advertisedReference`, 'must be an object');
    }
    else {
      const reference = value.advertisedReference;
      validateCoordinates(reference.lat, reference.lon, `${path}.advertisedReference`, issue);
      if (!['advert', 'contact'].includes(String(reference.source))) {
        issue(`${path}.advertisedReference.source`, 'must be advert or contact');
      }
      if (!isTimestamp(reference.observedAt)) {
        issue(`${path}.advertisedReference.observedAt`, 'must be a valid timestamp');
      }
      if (reference.trust !== 'untrusted-admin') {
        issue(`${path}.advertisedReference.trust`, 'must identify untrusted admin metadata');
      }
    }
  }
  if (value.lastKnown !== undefined) {
    issue(`${path}.lastKnown`, 'could not be migrated to an advertised reference position');
  }
}

function validateSettings(
  value: unknown,
  mode: unknown,
  issue: (path: string, message: string) => void,
): void {
  const path = '$.session.settings';
  if (!isRecord(value)) { issue(path, 'must be an object'); return; }
  const ranges: ReadonlyArray<readonly [string, number, number, boolean?]> = [
    ['cellSizeM', mode === 'drive' ? 30 : 8, mode === 'drive' ? 60 : 20],
    ['minSamples', 3, 30, true],
    ['minCells', 2, 12, true],
    ['smoothingWindow', 3, 11, true],
    ['emaAlpha', 0.2, 0.6],
    ['maxGpsAccuracyM', 25, 200],
    ['audioVolume', 0, 1],
    ['autoDiscoveryIntervalSec', 60, 900, true],
    ['observerPollIntervalMin', 5, 60, true],
  ];
  for (const [key, minimum, maximum, integer] of ranges) {
    const field = value[key];
    if (!isFiniteNumber(field) || field < minimum || field > maximum || (integer === true && !Number.isInteger(field))) {
      issue(`${path}.${key}`, `must be ${integer ? 'an integer ' : ''}between ${minimum} and ${maximum}`);
    }
  }
  if (!['chime', 'tone', 'geiger', 'off'].includes(String(value.audioMode))) issue(`${path}.audioMode`, 'is invalid');
  if (typeof value.audioMuted !== 'boolean') issue(`${path}.audioMuted`, 'must be a boolean');
  if (typeof value.forwardedAlert !== 'boolean') issue(`${path}.forwardedAlert`, 'must be a boolean');
  for (const key of ['smartWardriveEnabled', 'autoDiscoveryEnabled', 'observerAssistEnabled']) {
    if (typeof value[key] !== 'boolean') issue(`${path}.${key}`, 'must be a boolean');
  }
}

function validateCounters(value: unknown, issue: (path: string, message: string) => void): void {
  const path = '$.session.counters';
  if (!isRecord(value)) { issue(path, 'must be an object'); return; }
  for (const key of ['receptions', 'confirmed', 'located', 'fixesAccepted', 'fixesRejected', 'decodeFailed', 'discoveries']) {
    const count = value[key];
    if (!isFiniteNumber(count) || !Number.isInteger(count) || count < 0) issue(`${path}.${key}`, 'must be a non-negative integer');
  }
}

function validateReception(
  value: unknown,
  index: number,
  sessionId: string | undefined,
  issue: (path: string, message: string) => void,
): void {
  const path = `$.receptions[${index}]`;
  if (!isRecord(value)) { issue(path, 'must be an object'); return; }
  if (value.sessionId !== sessionId) issue(`${path}.sessionId`, 'must match the archive session');
  if (!['rx', 'discovery'].includes(String(value.source))) issue(`${path}.source`, 'is invalid');
  if (!isFiniteNumber(value.opcode) || !Number.isInteger(value.opcode)) issue(`${path}.opcode`, 'must be an integer');
  if (!isTimestamp(value.t)) issue(`${path}.t`, 'must be a valid timestamp');
  if (!isFiniteNumber(value.rssi) || value.rssi < -200 || value.rssi > 100) issue(`${path}.rssi`, 'is out of range');
  if (!isFiniteNumber(value.snr) || value.snr < -100 || value.snr > 100) issue(`${path}.snr`, 'is out of range');
  validateHex(value.frameHex, `${path}.frameHex`, issue, true);
  if (value.loraHex !== undefined) validateHex(value.loraHex, `${path}.loraHex`, issue, false);
  if (!isRecord(value.cls)) {
    issue(`${path}.cls`, 'must be an object');
  } else {
    if (!CLASSIFICATION_KINDS.has(value.cls.kind as ClassificationKind)) issue(`${path}.cls.kind`, 'is invalid');
    if (typeof value.cls.confirmed !== 'boolean') issue(`${path}.cls.confirmed`, 'must be a boolean');
    if (!isNonEmptyString(value.cls.explanation, 10_000)) issue(`${path}.cls.explanation`, 'must be text');
    if (!['full-pubkey', 'node-id', 'prefix', 'name', 'none'].includes(String(value.cls.identityTier))) issue(`${path}.cls.identityTier`, 'is invalid');
    if (!isRecord(value.cls.flags)) issue(`${path}.cls.flags`, 'must be an object');
    if (
      CLASSIFICATION_KINDS.has(value.cls.kind as ClassificationKind)
      && typeof value.cls.confirmed === 'boolean'
      && value.cls.confirmed !== CONFIRMED_KINDS.has(value.cls.kind as ClassificationKind)
    ) {
      issue(`${path}.cls.confirmed`, 'must be true only for a confirmed classification kind');
    }
  }
  if (value.conf !== 0 && value.conf !== 1) issue(`${path}.conf`, 'must be 0 or 1');
  if (isRecord(value.cls) && typeof value.cls.confirmed === 'boolean' && value.conf !== (value.cls.confirmed ? 1 : 0)) {
    issue(`${path}.conf`, 'must match cls.confirmed');
  }
  if (value.id !== undefined && !isPositiveInteger(value.id)) issue(`${path}.id`, 'must be a positive integer');
  if (value.dupOf !== undefined && !isPositiveInteger(value.dupOf)) issue(`${path}.dupOf`, 'must be a positive integer');
  if (!isRecord(value.gps) || !['ok', 'stale', 'none'].includes(String(value.gps.status))) {
    issue(`${path}.gps`, 'must contain a valid status');
  } else {
    if (value.gps.fixId !== undefined && !isPositiveInteger(value.gps.fixId)) {
      issue(`${path}.gps.fixId`, 'must be a positive integer');
    }
    if (value.gps.status === 'ok' || value.gps.status === 'stale') {
      validateCoordinates(value.gps.lat, value.gps.lon, `${path}.gps`, issue);
      if (!isFiniteNumber(value.gps.accuracy) || value.gps.accuracy < 0 || value.gps.accuracy > 100_000) {
        issue(`${path}.gps.accuracy`, 'must be between 0 and 100000');
      }
      if (!isFiniteNumber(value.gps.ageMs) || value.gps.ageMs < 0) {
        issue(`${path}.gps.ageMs`, 'must be a non-negative number');
      }
      if (!['good', 'degraded'].includes(String(value.gps.quality))) {
        issue(`${path}.gps.quality`, 'must be good or degraded');
      }
    } else if (value.gps.lat !== undefined || value.gps.lon !== undefined) {
      validateCoordinates(value.gps.lat, value.gps.lon, `${path}.gps`, issue);
    }
  }
  if (value.decoded !== undefined) validateDecodedPacket(value.decoded, path, issue);
}

function validateDecodedPacket(
  value: unknown,
  receptionPath: string,
  issue: (path: string, message: string) => void,
): void {
  const path = `${receptionPath}.decoded`;
  if (!isRecord(value)) { issue(path, 'must be an object'); return; }
  validateHex(value.hashHex, `${path}.hashHex`, issue, true);
  if (!['flood', 'direct', 'transport-flood', 'transport-direct'].includes(String(value.routeType))) {
    issue(`${path}.routeType`, 'is invalid');
  }
  if (!isFiniteNumber(value.payloadType) || !Number.isInteger(value.payloadType)) issue(`${path}.payloadType`, 'must be an integer');
  if (!isNonEmptyString(value.payloadTypeName, 500)) issue(`${path}.payloadTypeName`, 'must be text');
  if (!isFiniteNumber(value.payloadVersion) || !Number.isInteger(value.payloadVersion)) issue(`${path}.payloadVersion`, 'must be an integer');
  const validPathHashSize = isFiniteNumber(value.pathHashSize)
    && Number.isInteger(value.pathHashSize)
    && value.pathHashSize >= 1
    && value.pathHashSize <= 3;
  if (!validPathHashSize) {
    issue(`${path}.pathHashSize`, 'must be an integer between 1 and 3');
  }
  validateHexArray(
    value.path,
    `${path}.path`,
    issue,
    validPathHashSize && typeof value.pathHashSize === 'number' ? value.pathHashSize : undefined,
  );
  if (value.traceHops !== undefined) validateHexArray(value.traceHops, `${path}.traceHops`, issue);
  if (value.anonSenderPubkeyHex !== undefined) {
    validateHex(value.anonSenderPubkeyHex, `${path}.anonSenderPubkeyHex`, issue, true);
    if (typeof value.anonSenderPubkeyHex === 'string' && value.anonSenderPubkeyHex.length !== 64) {
      issue(`${path}.anonSenderPubkeyHex`, 'must contain a 32-byte public key');
    }
  }
  if (value.srcHashHex !== undefined) validateHex(value.srcHashHex, `${path}.srcHashHex`, issue, true);
  if (value.destHashHex !== undefined) validateHex(value.destHashHex, `${path}.destHashHex`, issue, true);
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) {
    issue(`${path}.warnings`, 'must be an array of strings');
  }
  if (!isFiniteNumber(value.totalBytes) || !Number.isInteger(value.totalBytes) || value.totalBytes < 0) {
    issue(`${path}.totalBytes`, 'must be a non-negative integer');
  }
  if (value.advert !== undefined) {
    if (!isRecord(value.advert)) issue(`${path}.advert`, 'must be an object');
    else {
      validateHex(value.advert.pubkeyHex, `${path}.advert.pubkeyHex`, issue, true);
      if (typeof value.advert.pubkeyHex === 'string' && value.advert.pubkeyHex.length !== 64) {
        issue(`${path}.advert.pubkeyHex`, 'must contain a 32-byte public key');
      }
      if (typeof value.advert.isRepeater !== 'boolean' || typeof value.advert.hasLocation !== 'boolean') {
        issue(`${path}.advert`, 'must include boolean repeater/location flags');
      }
      if (value.advert.hasLocation === true) validateCoordinates(value.advert.lat, value.advert.lon, `${path}.advert`, issue);
    }
  }
}

function validateHexArray(
  value: unknown,
  path: string,
  issue: (path: string, message: string) => void,
  expectedBytes?: number,
): void {
  if (!Array.isArray(value) || value.length > 512) { issue(path, 'must be a bounded array'); return; }
  value.forEach((entry, index) => {
    validateHex(entry, `${path}[${index}]`, issue, true);
    if (expectedBytes !== undefined && typeof entry === 'string' && entry.length !== expectedBytes * 2) {
      issue(`${path}[${index}]`, `must contain exactly ${expectedBytes} byte${expectedBytes === 1 ? '' : 's'}`);
    }
  });
}

function validateFix(
  value: unknown,
  index: number,
  sessionId: string | undefined,
  issue: (path: string, message: string) => void,
): void {
  const path = `$.fixes[${index}]`;
  if (!isRecord(value)) { issue(path, 'must be an object'); return; }
  if (value.id !== undefined && !isPositiveInteger(value.id)) issue(`${path}.id`, 'must be a positive integer');
  if (value.sessionId !== sessionId) issue(`${path}.sessionId`, 'must match the archive session');
  if (!isTimestamp(value.t) || !isTimestamp(value.posT)) issue(`${path}.t`, 'timestamps must be valid');
  validateCoordinates(value.lat, value.lon, path, issue);
  if (!isFiniteNumber(value.accuracy) || value.accuracy < 0 || value.accuracy > 100_000) {
    issue(`${path}.accuracy`, 'is out of range');
  }
  if (typeof value.accepted !== 'boolean' || (value.acceptedNum !== 0 && value.acceptedNum !== 1)) {
    issue(`${path}.accepted`, 'accepted and acceptedNum are inconsistent or invalid');
  } else if ((value.accepted ? 1 : 0) !== value.acceptedNum) {
    issue(`${path}.acceptedNum`, 'must match accepted');
  }
  if (!['good', 'degraded'].includes(String(value.quality))) issue(`${path}.quality`, 'is invalid');
}

function validateEvent(
  value: unknown,
  index: number,
  sessionId: string | undefined,
  issue: (path: string, message: string) => void,
): void {
  const path = `$.events[${index}]`;
  if (!isRecord(value)) { issue(path, 'must be an object'); return; }
  if (value.id !== undefined && !isPositiveInteger(value.id)) issue(`${path}.id`, 'must be a positive integer');
  if (value.sessionId !== sessionId) issue(`${path}.sessionId`, 'must match the archive session');
  if (!isTimestamp(value.t)) issue(`${path}.t`, 'must be a valid timestamp');
  if (![
    'note',
    'mark',
    'bearing',
    'discovery-cmd',
    'lifecycle',
    'identity-change',
    'suspension-gap',
    'observer-query',
    'observer-evidence',
    'smart-wardrive',
  ].includes(String(value.type))) issue(`${path}.type`, 'is invalid');
  if (!isRecord(value.data)) {
    issue(`${path}.data`, 'must be an object');
  } else if (value.type === 'bearing') {
    validateCoordinates(value.data.lat, value.data.lon, `${path}.data`, issue);
    if (!isFiniteNumber(value.data.bearingDeg)
        || value.data.bearingDeg < 0
        || value.data.bearingDeg >= 360) {
      issue(`${path}.data.bearingDeg`, 'must be between 0 and less than 360');
    }
    if (value.data.accuracyDeg !== undefined
        && (!isFiniteNumber(value.data.accuracyDeg)
          || value.data.accuracyDeg <= 0
          || value.data.accuracyDeg > 180)) {
      issue(`${path}.data.accuracyDeg`, 'must be greater than 0 and at most 180');
    }
    if (value.data.gpsAccuracyM !== undefined
        && (!isFiniteNumber(value.data.gpsAccuracyM)
          || value.data.gpsAccuracyM < 0
          || value.data.gpsAccuracyM > 100_000)) {
      issue(`${path}.data.gpsAccuracyM`, 'must be between 0 and 100000');
    }
    for (const field of ['gpsAgeMs', 'confirmedReceptionAgeMs'] as const) {
      const age = value.data[field];
      if (age !== undefined && (!isFiniteNumber(age) || age < 0)) {
        issue(`${path}.data.${field}`, 'must be a non-negative number');
      }
    }
    if (value.data.confirmedReceptionId !== undefined
        && !isPositiveInteger(value.data.confirmedReceptionId)) {
      issue(`${path}.data.confirmedReceptionId`, 'must be a positive integer');
    }
    if (value.data.note !== undefined && typeof value.data.note !== 'string') {
      issue(`${path}.data.note`, 'must be text');
    }
  } else if (value.type === 'observer-evidence') {
    validateObserverEvidenceEvent(
      value.data,
      `${path}.data`,
      issue,
      isTimestamp(value.t) ? value.t : undefined,
    );
  }
}

function validateObserverEvidenceEvent(
  value: Record<string, unknown>,
  path: string,
  issue: (path: string, message: string) => void,
  eventTime?: number,
): void {
  if (value.id !== undefined && !isNonEmptyString(value.id, 500)) {
    issue(`${path}.id`, 'must be text when present');
  }
  if (!isNonEmptyString(value.observerId, 500)) issue(`${path}.observerId`, 'must be text');
  for (const field of ['observerPubkeyHex', 'targetPubkeyHex'] as const) {
    validateHex(value[field], `${path}.${field}`, issue, true);
    if (typeof value[field] === 'string' && value[field].length !== 64) {
      issue(`${path}.${field}`, 'must contain a 32-byte public key');
    }
  }
  if (!isTimestamp(value.observedAt) || value.observedAt < 0) issue(`${path}.observedAt`, 'must be a valid timestamp');
  if (!isTimestamp(value.receivedAt) || value.receivedAt < 0) issue(`${path}.receivedAt`, 'must be a valid timestamp');
  if (!isTimestamp(value.anchorVerifiedAt) || value.anchorVerifiedAt < 0) {
    issue(`${path}.anchorVerifiedAt`, 'must be a valid timestamp');
  }
  if (!isFiniteNumber(value.heardSecondsAgo) || value.heardSecondsAgo < 0) {
    issue(`${path}.heardSecondsAgo`, 'must be a non-negative number');
  }
  if (
    isTimestamp(value.observedAt)
    && isTimestamp(value.receivedAt)
    && isFiniteNumber(value.heardSecondsAgo)
    && value.heardSecondsAgo >= 0
  ) {
    if (value.observedAt > value.receivedAt) {
      issue(`${path}.observedAt`, 'must not be later than the report receipt time');
    }
    const reportedAgeMs = value.receivedAt - value.observedAt;
    const encodedAgeMs = value.heardSecondsAgo * 1_000;
    if (Math.abs(reportedAgeMs - encodedAgeMs) > 2_000) {
      issue(`${path}.heardSecondsAgo`, 'must agree with observedAt and receivedAt within 2 seconds');
    }
    if (eventTime !== undefined && Math.abs(eventTime - value.receivedAt) > 30_000) {
      issue(`${path}.receivedAt`, 'must be within 30 seconds of the containing event time');
    }
  }
  if (
    isTimestamp(value.anchorVerifiedAt)
    && isTimestamp(value.receivedAt)
    && value.anchorVerifiedAt > value.receivedAt + 30_000
  ) {
    issue(`${path}.anchorVerifiedAt`, 'must not be materially later than the report receipt time');
  }
  if (!isFiniteNumber(value.snr) || value.snr < -32 || value.snr > 31.75) {
    issue(`${path}.snr`, 'must be between -32 and 31.75 dB');
  }
  if (!isFiniteNumber(value.anchorLat) || value.anchorLat < -90 || value.anchorLat > 90) {
    issue(`${path}.anchorLat`, 'must be between -90 and 90');
  }
  if (!isFiniteNumber(value.anchorLon) || value.anchorLon < -180 || value.anchorLon > 180) {
    issue(`${path}.anchorLon`, 'must be between -180 and 180');
  }
  if (!isFiniteNumber(value.anchorAccuracyM)
      || value.anchorAccuracyM < 1
      || value.anchorAccuracyM > 10_000) {
    issue(`${path}.anchorAccuracyM`, 'must be between 1 and 10000');
  }
  if (!['user-surveyed', 'operator-confirmed'].includes(String(value.anchorVerification))) {
    issue(`${path}.anchorVerification`, 'must describe an independent verification method');
  }
  if (value.source !== 'guest-neighbour') {
    issue(`${path}.source`, 'must identify a guest neighbour report');
  }
  if (value.trust !== 'verified-observer') {
    issue(`${path}.trust`, 'must identify a verified observer anchor');
  }
}

function validateCoordinates(
  lat: unknown,
  lon: unknown,
  path: string,
  issue: (path: string, message: string) => void,
): void {
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) issue(`${path}.lat`, 'must be between -90 and 90');
  if (!isFiniteNumber(lon) || lon < -180 || lon > 180) issue(`${path}.lon`, 'must be between -180 and 180');
}

function validateHex(
  value: unknown,
  path: string,
  issue: (path: string, message: string) => void,
  requireNonEmpty: boolean,
): void {
  if (typeof value !== 'string'
      || (requireNonEmpty && value.length === 0)
      || value.length > 2 * 1024 * 1024
      || !/^(?:[0-9a-f]{2})*$/i.test(value)) {
    issue(path, 'must be even-length hexadecimal data');
  }
}

function validateArray(
  value: unknown,
  path: string,
  maximum: number,
  issue: (path: string, message: string) => void,
): unknown[] | undefined {
  if (!Array.isArray(value)) { issue(path, 'must be an array'); return undefined; }
  if (value.length > maximum) issue(path, `exceeds the ${maximum} item safety limit`);
  return value.slice(0, maximum + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]),
  );
}
