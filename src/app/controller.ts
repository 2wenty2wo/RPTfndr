import { APP_COMMIT, APP_VERSION, DECODER_VERSION } from './version';
import { initialAppState, Store, type AppState, type Notice } from './store';
import { AudioController } from '../audio';
import {
  createJsonArchiveExport,
  createSessionArchive,
  buildReceptionCsv,
  stringifyGeoJson,
  buildTechnicalSummary,
  parseSessionArchive,
} from '../export';
import {
  aggregateReceptions,
  analyzeRemoteObservers,
  analyzeBearingConsensus,
  bearingEvent,
  combineRemoteObserverZone,
  deriveFinalApproach,
  estimateArea,
  GpsService,
  observationFromBearingEvent,
  type RemoteObserverObservation,
} from '../location';
import {
  DiscoveryCoordinator,
  GuestObserverCoordinator,
  IdentityUniverse,
  MeshCoreDevice,
  normalizeHex,
  targetBytes,
  type CompanionFrame,
  type DeviceSnapshot,
  type DiscoveryResponseFrame,
} from '../meshcore';
import { SessionRecorder, type RecorderSnapshot } from '../session';
import {
  acquireWriterLock,
  deleteFinderDatabase,
  FinderRepository,
  findResumableSessions,
  openFinderDatabase,
  type FinderDatabase,
  type WriterLease,
} from '../storage';
import {
  assertTransportSessionCompatibility,
  MockTransport,
  ReplayTransport,
  transportDataMode,
  WebBluetoothTransport,
  type ScriptEvent,
} from '../transports';
import {
  createDemoScenario,
  DEMO_TARGET_PUBKEY_HEX,
  type DemoScenarioId,
} from '../demo';
import type {
  AreaEstimate,
  GpsFix,
  ConnState,
  Reception,
  RemoteObserverEvidence,
  SearchSession,
  SessionEvent,
  SessionSettings,
  TargetProfile,
  Transport,
  VerifiedObserver,
} from '../types';
import { DEFAULT_SESSION_SETTINGS } from '../types';
import { SmartWardriveScheduler } from './smartWardrive';
import {
  candidateFromDiscoveryResponse,
  normalizeObserverCandidates,
  upsertObserverCandidates,
  type ObserverCandidate,
  type ObserverCandidateInput,
} from './observerCandidates';

export type ExportKind = 'json' | 'csv' | 'geojson' | 'summary';

export interface DownloadArtifact {
  name: string;
  blob: Blob;
  digest?: string;
}

export function deriveApproachState(
  events: readonly SessionEvent[],
  estimate: AreaEstimate | undefined,
  maximumGpsAccuracyM = DEFAULT_SESSION_SETTINGS.maxGpsAccuracyM,
  generatedAt = Date.now(),
  receptions: readonly Reception[] = [],
): Pick<AppState, 'bearingAnalysis' | 'bearingConsensus' | 'finalApproach'> {
  const receptionById = new Map(
    receptions
      .filter((reception): reception is Reception & { id: number } => reception.id !== undefined)
      .map((reception) => [reception.id, reception]),
  );
  const observations = events
    .map(observationFromBearingEvent)
    .filter((observation): observation is NonNullable<typeof observation> => observation !== undefined)
    .map((observation) => {
      const linked = observation.confirmedReceptionId === undefined
        ? undefined
        : receptionById.get(observation.confirmedReceptionId);
      if (!linked?.cls.confirmed || linked.conf !== 1) {
        return {
          ...observation,
          confirmedReceptionId: undefined,
          confirmedReceptionAgeMs: undefined,
        };
      }
      return {
        ...observation,
        confirmedReceptionAgeMs: observation.t - linked.t,
      };
    });
  const options = {
    maximumGpsAccuracyM,
    generatedAt,
    ...(estimate?.confidence ? { signalConfidence: estimate.confidence } : {}),
  };
  const bearingAnalysis = analyzeBearingConsensus(observations, options);
  const result = deriveFinalApproach(
    observations,
    estimate?.ready ? estimate.polygon : undefined,
    estimate?.cellCount ?? 0,
    options,
  );
  return {
    bearingAnalysis,
    bearingConsensus: result.consensus,
    finalApproach: result.estimate,
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function observedAtFromNeighbourAge(
  receivedAt: number,
  heardSecondsAgo: number,
): number | undefined {
  if (
    !Number.isFinite(receivedAt)
    || receivedAt < 0
    || !Number.isInteger(heardSecondsAgo)
    || heardSecondsAgo < 0
    || heardSecondsAgo > 0xffff_ffff
  ) return undefined;
  const ageMs = heardSecondsAgo * 1_000;
  return ageMs <= receivedAt ? receivedAt - ageMs : undefined;
}

export function observerEvidenceFromEvent(event: SessionEvent): RemoteObserverEvidence | undefined {
  if (event.type !== 'observer-evidence') return undefined;
  const data = event.data;
  const observerPubkeyHex = normalizeFullPubkey(
    typeof data.observerPubkeyHex === 'string' ? data.observerPubkeyHex : undefined,
  );
  const targetPubkeyHex = normalizeFullPubkey(
    typeof data.targetPubkeyHex === 'string' ? data.targetPubkeyHex : undefined,
  );
  if (!observerPubkeyHex || !targetPubkeyHex) return undefined;
  if (
    typeof data.observerId !== 'string'
    || !finiteNumber(data.observedAt)
    || !finiteNumber(data.receivedAt)
    || !finiteNumber(data.heardSecondsAgo)
    || !finiteNumber(data.snr)
    || !finiteNumber(data.anchorLat)
    || !finiteNumber(data.anchorLon)
    || !finiteNumber(data.anchorAccuracyM)
    || !finiteNumber(data.anchorVerifiedAt)
    || data.source !== 'guest-neighbour'
    || data.trust !== 'verified-observer'
    || (data.anchorVerification !== 'user-surveyed' && data.anchorVerification !== 'operator-confirmed')
    || !validCoordinate(data.anchorLat, data.anchorLon)
    || data.observedAt < 0
    || data.receivedAt < 0
    || data.observedAt > data.receivedAt
    || data.heardSecondsAgo < 0
    || Math.abs((data.receivedAt - data.observedAt) - data.heardSecondsAgo * 1_000) > 2_000
    || Math.abs(event.t - data.receivedAt) > 30_000
    || data.anchorAccuracyM < 1
    || data.anchorAccuracyM > 10_000
    || data.anchorVerifiedAt < 0
    || data.anchorVerifiedAt > data.receivedAt + 30_000
    || data.snr < -32
    || data.snr > 31.75
  ) return undefined;
  return {
    ...(typeof data.id === 'string' && data.id ? { id: data.id } : event.id === undefined ? {} : { id: `event-${event.id}` }),
    observerId: data.observerId,
    observerPubkeyHex,
    targetPubkeyHex,
    observedAt: data.observedAt,
    receivedAt: data.receivedAt,
    heardSecondsAgo: data.heardSecondsAgo,
    snr: data.snr,
    anchorLat: data.anchorLat,
    anchorLon: data.anchorLon,
    anchorAccuracyM: data.anchorAccuracyM,
    anchorVerifiedAt: data.anchorVerifiedAt,
    anchorVerification: data.anchorVerification,
    source: 'guest-neighbour',
    trust: 'verified-observer',
  };
}

export function deriveRemoteObserverState(
  events: readonly SessionEvent[],
  target: TargetProfile | undefined,
  estimate: AreaEstimate | undefined,
  finalApproach: ReturnType<typeof deriveApproachState>['finalApproach'],
  generatedAt = Date.now(),
  currentObservers?: readonly VerifiedObserver[],
): Pick<AppState, 'observerEvidence' | 'remoteObserverAnalysis' | 'communityAssistedZone'> {
  const allEvidence = events
    .map(observerEvidenceFromEvent)
    .filter((evidence): evidence is RemoteObserverEvidence => evidence !== undefined);
  const targetPublicKey = target?.identity.kind === 'full-pubkey'
    ? normalizeFullPubkey(target.identity.pubkeyHex) ?? ''
    : '';
  const targetEvidence = allEvidence.filter((evidence) => evidence.targetPubkeyHex === targetPublicKey);
  const currentObserverByKey = currentObservers === undefined
    ? undefined
    : new Map(currentObservers.map((observer) => [observer.repeaterPubkeyHex, observer]));
  const hasCurrentVerifiedAnchor = (evidence: RemoteObserverEvidence): boolean => {
    if (!currentObserverByKey) return true;
    const observer = currentObserverByKey.get(evidence.observerPubkeyHex);
    return observer !== undefined
      && observer.enabled
      && observer.permissionConfirmed
      && observer.trust === 'verified-observer'
      && observer.accuracyM <= MAX_OBSERVER_ANCHOR_ACCURACY_M
      && observer.lat === evidence.anchorLat
      && observer.lon === evidence.anchorLon
      && observer.accuracyM === evidence.anchorAccuracyM
      && observer.verifiedAt === evidence.anchorVerifiedAt
      && observer.verification === evidence.anchorVerification;
  };
  const observerEvidence = targetEvidence.filter(hasCurrentVerifiedAnchor);
  const observations: RemoteObserverObservation[] = allEvidence.map((evidence, index) => ({
    id: evidence.id ?? `${evidence.observerId}:${evidence.observedAt}:${index}`,
    observerId: evidence.observerPubkeyHex,
    targetPublicKey: evidence.targetPubkeyHex,
    observedAt: evidence.observedAt,
    snrDb: evidence.snr,
    lat: evidence.anchorLat,
    lon: evidence.anchorLon,
    coordinateVerified: evidence.trust === 'verified-observer' && hasCurrentVerifiedAnchor(evidence),
    coordinateAccuracyM: evidence.anchorAccuracyM,
    targetMatch: 'full-key',
    directNeighbour: true,
  }));
  const remoteObserverAnalysis = analyzeRemoteObservers(observations, {
    targetPublicKey,
    generatedAt,
  });
  const localPolygon = finalApproach?.ready && finalApproach.polygon?.length
    ? finalApproach.polygon
    : estimate?.ready && estimate.polygon?.length
      ? estimate.polygon
      : undefined;
  const localLabel = finalApproach?.ready
    ? 'directional final-approach zone'
    : 'confirmed-signal search zone';
  const localConfidence = finalApproach?.ready
    ? finalApproach.confidence
    : estimate?.confidence;
  const communityAssistedZone = combineRemoteObserverZone(
    remoteObserverAnalysis.zone,
    localPolygon,
    {
      generatedAt,
      otherZoneLabel: localLabel,
      ...(localConfidence ? { otherConfidence: localConfidence } : {}),
    },
  );
  return { observerEvidence, remoteObserverAnalysis, communityAssistedZone };
}

/** Imported observer claims are preserved for review but never regain live-analysis trust. */
export function eventForImportedSession(event: SessionEvent, sessionId: string): SessionEvent {
  const cloned = structuredClone(event);
  if (cloned.type !== 'observer-evidence') return { ...cloned, sessionId };
  return {
    ...(cloned.id === undefined ? {} : { id: cloned.id }),
    sessionId,
    t: cloned.t,
    type: 'note',
    data: {
      kind: 'imported-observer-evidence-audit',
      eligibility: 'audit-only',
      reason: 'Observer position and query provenance must be re-confirmed on this device before live analysis.',
      originalEventType: 'observer-evidence',
      evidence: cloned.data,
    },
  };
}

const ACK_SETTING = 'safety-ack-v1';
const ACTIVE_TARGET_SETTING = 'active-target';
const SESSION_SETTINGS_SETTING = 'session-settings';
const SHOW_UNTRUSTED_ADMIN_POSITION_SETTING = 'show-untrusted-admin-position';
const VERIFIED_OBSERVERS_SETTING = 'verified-observers-v1';
const OBSERVER_CANDIDATES_SETTING = 'observer-candidates-v1';
const MIN_OBSERVER_POLL_INTERVAL_MS = 5 * 60_000;
const REMOTE_OBSERVER_MAX_AGE_MS = 5 * 60_000;
const MAX_OBSERVER_ANCHOR_ACCURACY_M = 250;
const MAX_OBSERVERS_PER_POLL = 3;
const MAX_OBSERVER_PAGES_PER_POLL = 8;

class ObserverPollCancelledError extends Error {
  constructor(message = 'Observer poll cancelled because its live context changed.') {
    super(message);
    this.name = 'ObserverPollCancelledError';
  }
}

function uniqueId(prefix: string): string {
  const random = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function isConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'ConstraintError';
}

function hexBytes(value: string): Uint8Array {
  const hex = normalizeHex(value);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function emptyCounters(): SearchSession['counters'] {
  return {
    receptions: 0,
    confirmed: 0,
    located: 0,
    fixesAccepted: 0,
    fixesRejected: 0,
    decodeFailed: 0,
    discoveries: 0,
  };
}

function validAdvertisedPosition(lat: number | undefined, lon: number | undefined): lat is number {
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && (lat as number) >= -90
    && (lat as number) <= 90
    && (lon as number) >= -180
    && (lon as number) <= 180
    && (lat !== 0 || lon !== 0);
}

function normalizeFullPubkey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const normalized = normalizeHex(value);
    return normalized.length === 64 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function validCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function normalizeObservers(value: unknown): VerifiedObserver[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const observers: VerifiedObserver[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Partial<VerifiedObserver>;
    const repeaterPubkeyHex = normalizeFullPubkey(candidate.repeaterPubkeyHex);
    if (!repeaterPubkeyHex || seen.has(repeaterPubkeyHex)) continue;
    if (typeof candidate.label !== 'string' || !candidate.label.trim()) continue;
    if (!validCoordinate(Number(candidate.lat), Number(candidate.lon))) continue;
    if (!Number.isFinite(candidate.accuracyM) || (candidate.accuracyM as number) < 1 || (candidate.accuracyM as number) > 10_000) continue;
    if (candidate.verification !== 'user-surveyed' && candidate.verification !== 'operator-confirmed') continue;
    if (candidate.trust !== 'verified-observer') continue;
    if (!Number.isFinite(candidate.verifiedAt) || !Number.isFinite(candidate.createdAt) || !Number.isFinite(candidate.updatedAt)) continue;
    seen.add(repeaterPubkeyHex);
    observers.push({
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : `observer-${repeaterPubkeyHex}`,
      label: candidate.label.trim().slice(0, 80),
      repeaterPubkeyHex,
      lat: Number(candidate.lat),
      lon: Number(candidate.lon),
      accuracyM: Number(candidate.accuracyM),
      verifiedAt: Number(candidate.verifiedAt),
      verification: candidate.verification,
      trust: 'verified-observer',
      permissionConfirmed: candidate.permissionConfirmed === true,
      enabled: candidate.enabled === true,
      createdAt: Number(candidate.createdAt),
      updatedAt: Number(candidate.updatedAt),
    });
  }
  return observers.sort((left, right) => left.label.localeCompare(right.label));
}

function bounded(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function resolvePreferences(saved?: Partial<SessionSettings>): SessionSettings {
  const merged = { ...DEFAULT_SESSION_SETTINGS, ...saved };
  return {
    ...merged,
    cellSizeM: bounded(merged.cellSizeM, 8, 60, DEFAULT_SESSION_SETTINGS.cellSizeM),
    minSamples: Math.round(bounded(merged.minSamples, 3, 30, DEFAULT_SESSION_SETTINGS.minSamples)),
    minCells: Math.round(bounded(merged.minCells, 2, 12, DEFAULT_SESSION_SETTINGS.minCells)),
    smoothingWindow: Math.round(bounded(merged.smoothingWindow, 3, 11, DEFAULT_SESSION_SETTINGS.smoothingWindow)),
    emaAlpha: bounded(merged.emaAlpha, 0.2, 0.6, DEFAULT_SESSION_SETTINGS.emaAlpha),
    maxGpsAccuracyM: bounded(merged.maxGpsAccuracyM, 25, 200, DEFAULT_SESSION_SETTINGS.maxGpsAccuracyM),
    audioMode: ['chime', 'tone', 'geiger', 'off'].includes(merged.audioMode)
      ? merged.audioMode
      : DEFAULT_SESSION_SETTINGS.audioMode,
    audioVolume: bounded(merged.audioVolume, 0, 1, DEFAULT_SESSION_SETTINGS.audioVolume),
    audioMuted: merged.audioMuted === true,
    forwardedAlert: merged.forwardedAlert === true,
    smartWardriveEnabled: merged.smartWardriveEnabled === true,
    autoDiscoveryEnabled: merged.autoDiscoveryEnabled === true,
    autoDiscoveryIntervalSec: Math.round(bounded(
      merged.autoDiscoveryIntervalSec,
      60,
      900,
      DEFAULT_SESSION_SETTINGS.autoDiscoveryIntervalSec,
    )),
    observerAssistEnabled: merged.observerAssistEnabled === true,
    observerPollIntervalMin: Math.round(bounded(
      merged.observerPollIntervalMin,
      5,
      60,
      DEFAULT_SESSION_SETTINGS.observerPollIntervalMin,
    )),
  };
}

export function resolveSessionSettings(mode: 'walk' | 'drive', saved?: Partial<SessionSettings>): SessionSettings {
  const defaults: SessionSettings = {
    ...DEFAULT_SESSION_SETTINGS,
    cellSizeM: mode === 'drive' ? 45 : 12,
    smoothingWindow: mode === 'drive' ? 5 : 7,
    emaAlpha: mode === 'drive' ? 0.4 : 0.3,
  };
  const merged = { ...defaults, ...resolvePreferences(saved) };
  const usesWalkCellDefault = saved?.cellSizeM === undefined || saved.cellSizeM === DEFAULT_SESSION_SETTINGS.cellSizeM;
  const usesWalkWindowDefault = saved?.smoothingWindow === undefined || saved.smoothingWindow === DEFAULT_SESSION_SETTINGS.smoothingWindow;
  const usesWalkAlphaDefault = saved?.emaAlpha === undefined || saved.emaAlpha === DEFAULT_SESSION_SETTINGS.emaAlpha;
  const cellSize = mode === 'drive'
    ? (usesWalkCellDefault ? 45 : bounded(merged.cellSizeM, 30, 60, 45))
    : bounded(merged.cellSizeM, 8, 20, 12);
  return {
    ...merged,
    cellSizeM: cellSize,
    minSamples: merged.minSamples,
    minCells: merged.minCells,
    smoothingWindow: Math.round(bounded(
      mode === 'drive' && usesWalkWindowDefault ? 5 : merged.smoothingWindow,
      3,
      11,
      mode === 'drive' ? 5 : 7,
    )),
    emaAlpha: bounded(mode === 'drive' && usesWalkAlphaDefault ? 0.4 : merged.emaAlpha, 0.2, 0.6, mode === 'drive' ? 0.4 : 0.3),
    maxGpsAccuracyM: merged.maxGpsAccuracyM,
    audioMode: merged.audioMode,
    audioVolume: merged.audioVolume,
    audioMuted: merged.audioMuted,
    forwardedAlert: merged.forwardedAlert,
    smartWardriveEnabled: merged.smartWardriveEnabled,
    autoDiscoveryEnabled: merged.autoDiscoveryEnabled,
    autoDiscoveryIntervalSec: merged.autoDiscoveryIntervalSec,
    observerAssistEnabled: merged.observerAssistEnabled,
    observerPollIntervalMin: merged.observerPollIntervalMin,
  };
}

export class AppController {
  readonly store = new Store<AppState>(initialAppState);
  readonly audio = new AudioController({
    mode: DEFAULT_SESSION_SETTINGS.audioMode,
    volume: DEFAULT_SESSION_SETTINGS.audioVolume,
    muted: DEFAULT_SESSION_SETTINGS.audioMuted,
    forwardedAlert: DEFAULT_SESSION_SETTINGS.forwardedAlert,
  });
  repository!: FinderRepository;

  #database?: FinderDatabase;
  #lease?: WriterLease;
  #transport?: Transport;
  #device?: MeshCoreDevice;
  #protocolReady = false;
  #discovery?: DiscoveryCoordinator;
  #automaticDiscoveryAbort?: AbortController;
  #guestObservers?: GuestObserverCoordinator;
  #guestAttempted = new Set<string>();
  #observerPollGeneration = 0;
  #observerPollPromise?: Promise<void>;
  #lastObserverPollStartedAt = 0;
  #observerPollCursor = 0;
  #observerExpiryTimer?: ReturnType<typeof globalThis.setTimeout>;
  #recorder?: SessionRecorder;
  #gps?: GpsService;
  #gpsGeneration = 0;
  #targetMetadataChain: Promise<void> = Promise.resolve();
  #universe = new IdentityUniverse();
  #removeTransportState?: () => void;
  #removeDevicePush?: () => void;
  #removeReplayEvent?: () => void;
  #wakeLock?: WakeLockSentinel;
  #visibilityListener?: () => void;
  #mock?: MockTransport;
  #suppressAudio = false;
  #audioStaleTimer?: ReturnType<typeof globalThis.setTimeout>;
  #connectionLossAlerted = false;
  #expectedDisconnect = false;
  #automationVisibilityListener?: () => void;
  #smartWardriveSignature = '';
  readonly #smartWardrive = new SmartWardriveScheduler({
    onDiscovery: () => this.discover('automatic'),
    onObserverPoll: () => this.pollObservers(),
    onUpdate: (smartWardrive) => this.store.set({ smartWardrive }),
  });

  async init(): Promise<void> {
    this.#database = await openFinderDatabase({
      onBlocked: () => this.notice('warning', 'Another tab is blocking a local database upgrade.'),
    });
    this.repository = new FinderRepository(this.#database);
    this.#lease = await acquireWriterLock();
    const [acknowledged, targets, sessions, resumeCandidates, activeTargetId, savedSettings, showUntrustedAdminPosition, savedObservers, savedObserverCandidates] = await Promise.all([
      this.repository.getSetting<boolean>(ACK_SETTING),
      this.repository.listTargets(),
      this.repository.listSessions(),
      findResumableSessions(this.repository),
      this.repository.getSetting<string>(ACTIVE_TARGET_SETTING),
      this.repository.getSetting<Partial<SessionSettings>>(SESSION_SETTINGS_SETTING),
      this.repository.getSetting<boolean>(SHOW_UNTRUSTED_ADMIN_POSITION_SETTING),
      this.repository.getSetting<unknown>(VERIFIED_OBSERVERS_SETTING),
      this.repository.getSetting<unknown>(OBSERVER_CANDIDATES_SETTING),
    ]);
    const preferences = resolvePreferences(savedSettings);
    this.configureAudio(preferences);
    if (typeof document !== 'undefined') this.audio.bindGesture(document);
    if (typeof document !== 'undefined' && !this.#automationVisibilityListener) {
      this.#automationVisibilityListener = () => {
        this.refreshRemoteObserverState();
        if (document.visibilityState !== 'visible') {
          this.#discovery?.cancel('Discovery cancelled because the page is hidden.');
        }
        if (document.visibilityState === 'visible' && this.store.value.activeSession && !this.#wakeLock) {
          void this.acquireWakeLock();
        }
        this.syncSmartWardrive();
      };
      document.addEventListener('visibilitychange', this.#automationVisibilityListener);
    }
    for (const target of targets) this.#universe.addTarget(target);
    const activeTarget = targets.find((target) => target.id === activeTargetId);
    this.store.set({
      ready: true,
      acknowledged: acknowledged === true,
      targets,
      sessions,
      activeTarget,
      resumeCandidate: this.#lease.acquired ? resumeCandidates[0] : undefined,
      writer: this.#lease.acquired,
      preferences,
      showUntrustedAdminPosition: showUntrustedAdminPosition === true,
      observers: normalizeObservers(savedObservers),
      observerCandidates: normalizeObserverCandidates(savedObserverCandidates),
    });
    if (!this.#lease.acquired) {
      this.notice('warning', 'Another MeshCore Finder tab holds the writer lock. This tab is read-only.');
    } else if (!this.#lease.supported) {
      this.notice('warning', 'This browser cannot enforce a cross-tab writer lock. Keep only one capture tab open.');
    }
  }

  async acknowledge(): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    await this.repository.setSetting(ACK_SETTING, true);
    this.store.set({ acknowledged: true });
  }

  async connectReal(): Promise<void> {
    this.requireWriter();
    if (this.store.value.activeSession?.demo) {
      throw new Error('End the simulated session before connecting a real radio.');
    }
    if (!('bluetooth' in navigator)) throw new Error('Web Bluetooth is unavailable in this browser.');
    await this.replaceTransport(new WebBluetoothTransport());
    await this.connectDevice();
  }

  async connectMock(): Promise<void> {
    this.requireWriter();
    if (this.store.value.activeSession && !this.store.value.activeSession.demo) {
      throw new Error('End the real session before connecting a simulated companion.');
    }
    const targetBytes = hexBytes(DEMO_TARGET_PUBKEY_HEX);
    const mock = new MockTransport({
      responseDelayMs: 0,
      contacts: [{ pubkey: targetBytes, name: 'SIMULATED Lost Repeater', type: 2 }],
      discoveryResponses: [{ pubkey: targetBytes, pathLength: 0, rssi: -72, snr: 6, uplinkSnr: 4 }],
    });
    await this.replaceTransport(mock);
    this.#mock = mock;
    await this.connectDevice();
  }

  async disconnect(): Promise<void> {
    this.#expectedDisconnect = true;
    this.#protocolReady = false;
    this.#discovery?.cancel('Discovery cancelled because the radio was disconnected.');
    this.stopSmartWardrive('Radio disconnected.');
    try {
      await this.#device?.disconnect();
      if (!this.#device) await this.#transport?.disconnect();
      this.store.set({ connection: 'disconnected', deviceName: undefined });
      this.stopSignalAudio();
    } finally {
      this.#expectedDisconnect = false;
    }
  }

  async startDemo(id: DemoScenarioId = 'approach-and-pass'): Promise<void> {
    this.requireWriter();
    if (this.store.value.activeSession) await this.endSession();
    this.requireRepository();
    const scenario = createDemoScenario(id);
    const target = { ...scenario.target, createdAt: Date.now(), updatedAt: Date.now() };
    await this.repository.putTarget(target);
    this.#universe.addTarget(target);
    this.store.set((state) => ({
      targets: [target, ...state.targets.filter((item) => item.id !== target.id)],
      activeTarget: target,
    }));
    await this.repository.setSetting(ACTIVE_TARGET_SETTING, target.id);
    const replay = new ReplayTransport(scenario.events, { speed: 10 });
    await this.replaceTransport(replay);
    await this.startSession('walk', true);
    await replay.connect();
  }

  async saveTarget(label: string, identityInput: string, notes?: string): Promise<TargetProfile> {
    this.requireWriter();
    this.requireRepository();
    if (this.store.value.activeSession) throw new Error('End the current session before changing its target.');
    const normalized = normalizeHex(identityInput);
    if (normalized.length > 64) throw new Error('A MeshCore public key cannot exceed 32 bytes.');
    const now = Date.now();
    const identity: TargetProfile['identity'] = normalized.length === 64
      ? { kind: 'full-pubkey', pubkeyHex: normalized }
      : normalized.length === 8
        ? { kind: 'node-id', bytesHex: normalized }
        : { kind: 'prefix', bytesHex: normalized };
    const target: TargetProfile = {
      id: uniqueId('target'),
      label: label.trim(),
      identity,
      source: 'manual',
      notes: notes?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    if (!target.label) throw new Error('Target label is required.');
    await this.repository.putTarget(target);
    this.#universe.addTarget(target);
    await this.selectTarget(target.id, [target, ...this.store.value.targets]);
    return target;
  }

  async selectTarget(id: string, source = this.store.value.targets): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    if (this.store.value.activeSession) throw new Error('End the current session before changing its target.');
    const target = source.find((item) => item.id === id) ?? await this.repository.getTarget(id);
    if (!target) throw new Error('Target profile not found.');
    await this.repository.setSetting(ACTIVE_TARGET_SETTING, target.id);
    this.#universe.addTarget(target);
    this.store.set({ targets: source, activeTarget: target });
  }

  async pinTarget(pubkeyInput: string): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    const pubkeyHex = normalizeHex(pubkeyInput);
    if (pubkeyHex.length !== 64) throw new Error('Pinning requires a full 32-byte public key.');
    const current = this.store.value.activeSession?.targetSnapshot ?? this.store.value.activeTarget;
    if (!current) throw new Error('Choose a target before pinning an identity.');
    const observed = new Map<string, Set<string>>();
    const addCandidate = (pubkey: string | undefined, name?: string): void => {
      const normalized = normalizeFullPubkey(pubkey);
      if (!normalized) return;
      const names = observed.get(normalized) ?? new Set<string>();
      if (name?.trim()) names.add(name.trim());
      observed.set(normalized, names);
    };
    for (const target of this.store.value.targets) {
      if (target.source === 'contacts' && target.identity.pubkeyHex?.length === 64) {
        addCandidate(target.identity.pubkeyHex, target.identity.name ?? target.label);
      }
    }
    for (const reception of this.store.value.receptions) {
      addCandidate(reception.decoded?.advert?.pubkeyHex, reception.decoded?.advert?.name);
      addCandidate(reception.decoded?.anonSenderPubkeyHex);
      addCandidate(reception.cls.origin?.pubkeyHex, reception.cls.origin?.name);
    }
    if (!observed.has(pubkeyHex)) throw new Error('That full key has not been observed in this session or synced from contacts.');
    const currentBytes = targetBytes(current.identity);
    if (currentBytes && !pubkeyHex.startsWith(currentBytes)) {
      throw new Error('The observed public key does not match the selected target identity.');
    }
    if (current.identity.kind === 'name-only') {
      const expectedName = current.identity.name?.trim();
      const nameMatches = expectedName
        ? [...observed.entries()].filter(([, names]) => [...names].some((name) => name.localeCompare(expectedName, undefined, { sensitivity: 'accent' }) === 0))
        : [];
      if (nameMatches.length !== 1 || nameMatches[0]?.[0] !== pubkeyHex) {
        throw new Error('A name-only target can be pinned only when one unambiguous observed full key has the same name.');
      }
    }
    const previousIdentity = structuredClone(current.identity);
    const advertReferenceReception = [...this.store.value.receptions].reverse().find((reception) => {
      const advert = reception.decoded?.advert;
      return normalizeFullPubkey(advert?.pubkeyHex) === pubkeyHex
        && advert?.hasLocation
        && validAdvertisedPosition(advert.lat, advert.lon);
    });
    const advertReference = advertReferenceReception?.decoded?.advert;
    const contactReference = [...this.store.value.targets]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .find((target) => normalizeFullPubkey(target.identity.pubkeyHex) === pubkeyHex && target.advertisedReference)?.advertisedReference;
    const inheritedAdvertisedReference = advertReference?.lat !== undefined && advertReference.lon !== undefined
      ? {
          lat: advertReference.lat,
          lon: advertReference.lon,
          source: 'advert' as const,
          observedAt: advertReferenceReception?.t ?? Date.now(),
          trust: 'untrusted-admin' as const,
        }
      : contactReference;
    const updated: TargetProfile = {
      ...current,
      identity: { kind: 'full-pubkey', pubkeyHex },
      pinnedFrom: `${current.identity.kind}:${currentBytes ?? current.identity.name ?? 'observed'}`,
      advertisedReference: inheritedAdvertisedReference ?? current.advertisedReference,
      updatedAt: Date.now(),
    };
    await this.repository.putTarget(updated);
    if (this.#recorder) await this.#recorder.updateTarget(updated);
    else this.#universe.addTarget(updated);
    const event: SessionEvent | undefined = this.#recorder ? {
      sessionId: this.#recorder.session.id,
      t: Date.now(),
      type: 'identity-change',
      data: { action: 'pin-full-pubkey', previousIdentity, nextIdentity: updated.identity },
    } : undefined;
    if (event) event.id = await this.repository.addEvent(event);
    await this.repository.setSetting(ACTIVE_TARGET_SETTING, updated.id);
    this.store.set((state) => ({
      activeTarget: updated,
      targets: [updated, ...state.targets.filter((target) => target.id !== updated.id)],
      ...(event ? { events: [...state.events, event] } : {}),
    }));
    this.syncSmartWardrive();
    this.notice('success', 'Full public key pinned; stored receptions were reclassified conservatively.');
  }

  async startSession(mode: 'walk' | 'drive', demo = transportDataMode(this.requireTransport()) === 'simulated'): Promise<SearchSession> {
    this.requireWriter();
    this.requireRepository();
    const target = this.store.value.activeTarget;
    if (!target) throw new Error('Choose a target before starting a session.');
    const transport = this.requireTransport();
    assertTransportSessionCompatibility(transport, demo);
    if (this.store.value.activeSession) throw new Error('A session is already active.');
    const savedSettings = await this.repository.getSetting<Partial<SessionSettings>>(SESSION_SETTINGS_SETTING);
    const effectiveSettings = resolveSessionSettings(mode, savedSettings);
    this.configureAudio(effectiveSettings);
    this.stopSignalAudio();
    void this.audio.resume();
    const now = Date.now();
    const session: SearchSession = {
      id: uniqueId(demo ? 'demo' : 'session'),
      title: `${target.label} · ${new Date(now).toLocaleDateString()}`,
      createdAt: now,
      startedAt: now,
      state: 'active',
      targetSnapshot: structuredClone(target),
      app: { version: APP_VERSION, commit: APP_COMMIT, decoderVersion: DECODER_VERSION },
      mode,
      demo,
      settings: effectiveSettings,
      ...(this.store.value.device ? { device: { ...this.store.value.device } } : {}),
      counters: emptyCounters(),
    };
    await this.repository.putSession(session);
    await this.repository.addEvent({ sessionId: session.id, t: now, type: 'lifecycle', data: { state: 'active', transport: transport.kind } });
    this.createRecorder(session);
    this.clearObserverExpiryTimer();
    this.store.set((state) => ({
      activeSession: session,
      sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
      receptions: [],
      fixes: [],
      events: [],
      cells: [],
      estimate: undefined,
      bearingAnalysis: undefined,
      bearingConsensus: undefined,
      finalApproach: undefined,
      observerEvidence: [],
      remoteObserverAnalysis: undefined,
      communityAssistedZone: undefined,
      observerStatuses: state.observerStatuses.map((status) => ({ ...status, state: 'idle' as const })),
      signal: undefined,
    }));
    if (!demo) await this.startGps(session);
    void navigator.storage?.persist?.().catch(() => false);
    void this.acquireWakeLock();
    this.syncSmartWardrive();
    return session;
  }

  async endSession(): Promise<void> {
    const recorder = this.#recorder;
    if (!recorder) return;
    this.#discovery?.cancel('Discovery cancelled because the session ended.');
    this.stopSmartWardrive('No active Drive session.');
    this.clearObserverExpiryTimer();
    await this.stopGps();
    this.stopSignalAudio();
    await recorder.end();
    this.#recorder = undefined;
    await this.releaseWakeLock();
    await this.reloadSessions();
    this.store.set({
      activeSession: undefined,
      receptions: [],
      fixes: [],
      events: [],
      cells: [],
      estimate: undefined,
      bearingAnalysis: undefined,
      bearingConsensus: undefined,
      finalApproach: undefined,
      observerEvidence: [],
      remoteObserverAnalysis: undefined,
      communityAssistedZone: undefined,
      signal: undefined,
    });
  }

  async resumeSession(id: string): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    let session = await this.repository.getSession(id);
    if (!session || (session.state !== 'active' && session.state !== 'paused')) throw new Error('The session can no longer be resumed.');
    session = await this.repository.reconcileSessionCounters(id);
    const [receptions, fixes, events] = await Promise.all([
      this.repository.listReceptions(id),
      this.repository.listFixes(id),
      this.repository.listEvents(id),
    ]);
    session.state = 'active';
    session.endedAt = undefined;
    session.settings = resolveSessionSettings(session.mode, session.settings);
    this.configureAudio(session.settings);
    this.stopSignalAudio();
    void this.audio.resume();
    await this.repository.putSession(session);
    await this.repository.addEvent({ sessionId: id, t: Date.now(), type: 'lifecycle', data: { action: 'resumed' } });
    this.#universe.addTarget(session.targetSnapshot);
    this.rebuildIdentityUniverse(receptions);
    const resumedApproach = deriveApproachState(
      events,
      undefined,
      session.settings.maxGpsAccuracyM,
      Date.now(),
      receptions,
    );
    this.store.set({
      activeTarget: session.targetSnapshot,
      activeSession: session,
      resumeCandidate: undefined,
      receptions: [],
      fixes: [],
      events,
      cells: [],
      estimate: undefined,
      ...resumedApproach,
      ...deriveRemoteObserverState(
        events,
        session.targetSnapshot,
        undefined,
        resumedApproach.finalApproach,
        Date.now(),
        this.store.value.observers,
      ),
      signal: undefined,
    });
    this.armObserverExpiryTimer();
    this.createRecorder(session);
    this.#suppressAudio = true;
    try {
      await this.#recorder!.restore(receptions, fixes);
      await this.#recorder!.reclassifyStored();
    } finally {
      this.#suppressAudio = false;
      this.stopSignalAudio();
    }
    if (!session.demo) await this.startGps(session);
    void this.acquireWakeLock();
    this.syncSmartWardrive();
  }

  async endResumeCandidate(id: string): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    const session = await this.repository.getSession(id);
    if (!session) return;
    session.state = 'ended';
    session.endedAt = Date.now();
    await this.repository.putSession(session);
    await this.repository.addEvent({ sessionId: id, t: session.endedAt, type: 'lifecycle', data: { state: 'ended-on-launch' } });
    await this.reloadSessions();
    this.store.set({ resumeCandidate: undefined });
  }

  async addMark(note = 'Field mark'): Promise<void> {
    this.requireRepository();
    const recorder = this.requireRecorder();
    const latest = recorder.gps.latest();
    const event: SessionEvent = {
      sessionId: recorder.session.id,
      t: Date.now(),
      type: 'mark',
      data: { note, lat: latest?.lat, lon: latest?.lon, accuracy: latest?.accuracy },
    };
    event.id = await this.repository.addEvent(event);
    this.store.set((state) => ({ events: [...state.events, event] }));
    this.notice('success', 'Search mark saved to the local session.');
  }

  async calibrateSignal(point: 'weak' | 'strong'): Promise<void> {
    const recorder = this.requireRecorder();
    const applied = point === 'weak'
      ? await recorder.setCurrentAsWeak()
      : await recorder.setCurrentAsStrong();
    if (!applied) throw new Error('Wait for a confirmed target reception before calibrating.');
    this.notice('success', `Current confirmed signal saved as the ${point} calibration point.`);
  }

  async addBearing(degrees: number, uncertainty: number, note?: string): Promise<void> {
    this.requireRepository();
    const recorder = this.requireRecorder();
    const fix = recorder.gps.latest();
    if (!fix) throw new Error('An accepted GPS fix is needed to save a bearing.');
    if (!Number.isFinite(degrees)) throw new RangeError('Bearing direction must be a number.');
    if (!Number.isFinite(uncertainty) || uncertainty < 1 || uncertainty > 90) {
      throw new RangeError('Bearing uncertainty must be between 1 and 90 degrees.');
    }
    const now = Date.now();
    const gpsAgeMs = Math.max(0, now - fix.t, now - fix.posT);
    const latestConfirmed = [...this.store.value.receptions]
      .reverse()
      .find((reception) => reception.cls.confirmed && reception.t <= now);
    const event = bearingEvent(recorder.session.id, {
      t: now,
      lat: fix.lat,
      lon: fix.lon,
      bearingDeg: degrees,
      accuracyDeg: uncertainty,
      gpsAccuracyM: fix.accuracy,
      gpsAgeMs,
      ...(latestConfirmed?.id === undefined
        ? {}
        : { confirmedReceptionId: latestConfirmed.id }),
      ...(latestConfirmed
        ? { confirmedReceptionAgeMs: Math.max(0, now - latestConfirmed.t) }
        : {}),
      ...(note?.trim() ? { note: note.trim() } : {}),
    });
    event.id = await this.repository.addEvent(event);
    this.store.set((state) => {
      const events = [...state.events, event];
      const approach = deriveApproachState(
        events,
        state.estimate,
        recorder.session.settings.maxGpsAccuracyM,
        now,
        state.receptions,
      );
      return {
        events,
        ...approach,
        ...deriveRemoteObserverState(
          events,
          recorder.session.targetSnapshot,
          state.estimate,
          approach.finalApproach,
          now,
          state.observers,
        ),
      };
    });
    this.armObserverExpiryTimer();
    const recentConfirmed = latestConfirmed?.id !== undefined
      && now - latestConfirmed.t <= 30_000;
    const usableGps = gpsAgeMs <= 15_000
      && fix.accuracy <= recorder.session.settings.maxGpsAccuracyM;
    this.notice(
      recentConfirmed && usableGps ? 'success' : 'warning',
      recentConfirmed && usableGps
        ? 'Bearing saved for the approximate final-approach analysis.'
        : !usableGps
          ? 'Bearing saved as a note but excluded because its phone GPS was stale or outside the accuracy limit.'
          : 'Bearing saved as an excluded note. Take a new bearing immediately after a confirmed target reception.',
    );
  }

  async discover(trigger: 'manual' | 'automatic' = 'manual'): Promise<void> {
    this.requireRepository();
    const discovery = this.#discovery;
    const session = this.store.value.activeSession;
    if (!discovery || !session) throw new Error('Connect a radio and start a session before discovery.');
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      throw new Error('Discovery pauses while the page is hidden.');
    }
    const abortController = new AbortController();
    if (trigger === 'automatic') this.#automaticDiscoveryAbort = abortController;
    const run = discovery.start(0x04, { signal: abortController.signal });
    try {
      await this.appendSessionEvent('discovery-cmd', { tag: run.tag, trigger, filterMask: 0x04 });
      const result = await run.done;
      if (trigger === 'automatic') await this.recordObserverCandidatesFromDiscovery(result.responses, result.endedAt);
      if (trigger === 'manual') {
        this.notice('info', `Discovery window complete: ${result.responses.length} response${result.responses.length === 1 ? '' : 's'}.`);
      }
    } finally {
      if (this.#automaticDiscoveryAbort === abortController) this.#automaticDiscoveryAbort = undefined;
    }
  }

  async queryObservers(): Promise<void> {
    await this.pollObservers();
    this.notice('info', 'Authorised observer poll complete. Only target-matched direct-neighbour evidence was retained.');
  }

  async exportSession(id: string, kind: ExportKind): Promise<DownloadArtifact> {
    const bundle = await this.sessionBundle(id);
    const base = `meshcore-finder-${new Date(bundle.session.startedAt).toISOString().slice(0, 10)}-${bundle.session.demo ? 'simulated-' : ''}${bundle.session.id.slice(0, 8)}`;
    if (kind === 'json') {
      const exported = await createJsonArchiveExport(bundle);
      return { name: exported.filename, blob: new Blob([exported.json], { type: exported.mimeType }), digest: exported.sha256 };
    }
    if (kind === 'csv') {
      return { name: `${base}.csv`, blob: new Blob([buildReceptionCsv(bundle)], { type: 'text/csv;charset=utf-8' }) };
    }
    if (kind === 'geojson') {
      return { name: `${base}.geojson`, blob: new Blob([stringifyGeoJson(bundle)], { type: 'application/geo+json' }) };
    }
    const archive = createSessionArchive(bundle);
    return { name: `${base}-summary.txt`, blob: new Blob([buildTechnicalSummary(archive)], { type: 'text/plain;charset=utf-8' }) };
  }

  async importArchive(text: string): Promise<SearchSession> {
    this.requireWriter();
    this.requireRepository();
    const archive = parseSessionArchive(text);
    const importedObserverReportCount = archive.events.filter((event) => event.type === 'observer-evidence').length;
    const [existing, targetConflict] = await Promise.all([
      this.repository.getSession(archive.session.id),
      this.repository.getTarget(archive.session.targetSnapshot.id),
    ]);
    let newId = existing ? uniqueId('session-import') : archive.session.id;
    let targetId = targetConflict ? uniqueId('target-import') : archive.session.targetSnapshot.id;
    let reconciled: SearchSession | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const target: TargetProfile = { ...archive.session.targetSnapshot, id: targetId };
      const session: SearchSession = {
        ...archive.session,
        id: newId,
        title: existing || attempt > 0 ? `${archive.session.title} (imported)` : archive.session.title,
        state: 'ended',
        endedAt: archive.session.endedAt ?? Date.now(),
        targetSnapshot: target,
        counters: emptyCounters(),
        bestConfirmed: undefined,
      };
      const receptions = archive.receptions.map((reception) => ({
        ...structuredClone(reception),
        sessionId: newId,
      }));
      const fixes = archive.fixes.map((fix) => ({ ...fix, sessionId: newId }));
      const events = archive.events.map((event) => eventForImportedSession(event, newId));
      try {
        reconciled = await this.repository.importSessionBundle(target, session, receptions, fixes, events);
        break;
      } catch (error) {
        if (!isConstraintError(error) || attempt === 4) throw error;
        newId = uniqueId('session-import');
        targetId = uniqueId('target-import');
      }
    }
    if (!reconciled) throw new Error('Unable to allocate unique IDs for the imported session');
    await this.reloadTargets();
    await this.reloadSessions();
    this.notice(
      'success',
      `Imported ${archive.receptions.length} receptions for review.${importedObserverReportCount ? ` ${importedObserverReportCount} observer report${importedObserverReportCount === 1 ? '' : 's'} retained as audit-only.` : ''}`,
    );
    return reconciled;
  }

  async deleteSession(id: string): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    if (this.store.value.activeSession?.id === id) await this.endSession();
    await this.repository.deleteSession(id);
    await this.reloadSessions();
  }

  async deleteAll(): Promise<void> {
    this.requireWriter();
    this.clearObserverExpiryTimer();
    await this.stopGps();
    const recorder = this.#recorder;
    this.#recorder = undefined;
    if (recorder) await recorder.shutdown().catch(() => undefined);
    this.stopSignalAudio();
    await this.cleanupTransport();
    this.#database?.close();
    await deleteFinderDatabase();
    this.#database = await openFinderDatabase();
    this.repository = new FinderRepository(this.#database);
    this.#universe = new IdentityUniverse();
    this.store.set({
      ...initialAppState,
      ready: true,
      writer: true,
      acknowledged: false,
    });
    this.configureAudio(DEFAULT_SESSION_SETTINGS);
  }

  async saveSettings(
    settings: Partial<SessionSettings>,
    showUntrustedAdminPosition = this.store.value.showUntrustedAdminPosition,
  ): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    const previous = await this.repository.getSetting<Partial<SessionSettings>>(SESSION_SETTINGS_SETTING) ?? {};
    const merged = resolvePreferences({ ...previous, ...settings });
    await Promise.all([
      this.repository.setSetting(SESSION_SETTINGS_SETTING, merged),
      this.repository.setSetting(SHOW_UNTRUSTED_ADMIN_POSITION_SETTING, showUntrustedAdminPosition),
    ]);
    this.configureAudio(merged);
    this.store.set({ preferences: merged, showUntrustedAdminPosition });
    if (this.#recorder) {
      await this.#recorder.updateAutomationSettings({
        smartWardriveEnabled: merged.smartWardriveEnabled,
        autoDiscoveryEnabled: merged.autoDiscoveryEnabled,
        autoDiscoveryIntervalSec: merged.autoDiscoveryIntervalSec,
        observerAssistEnabled: merged.observerAssistEnabled,
        observerPollIntervalMin: merged.observerPollIntervalMin,
      });
    }
    this.syncSmartWardrive();
    this.notice('success', 'Settings saved. Automation changes apply now; aggregation changes apply to the next session.');
  }


  async reviewObserverCandidate(id: string): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    const now = Date.now();
    const candidates = this.store.value.observerCandidates.map((candidate) => (
      candidate.id === id ? { ...candidate, reviewed: true, updatedAt: now } : candidate
    ));
    if (!candidates.some((candidate) => candidate.id === id)) throw new Error('Observer candidate not found.');
    await this.repository.setSetting(OBSERVER_CANDIDATES_SETTING, candidates);
    this.store.set({ observerCandidates: candidates });
  }

  async authoriseObserverCandidate(id: string): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    const candidate = this.store.value.observerCandidates.find((item) => item.id === id);
    if (!candidate) throw new Error('Observer candidate not found.');
    const confirmed = typeof confirm === 'function'
      ? confirm(`Mark ${candidate.displayName} as authorised only for setup review? You must still enter independently verified coordinates before observer assist can use it.`)
      : true;
    if (!confirmed) return;
    const now = Date.now();
    const candidates = this.store.value.observerCandidates.map((item) => (
      item.id === id ? { ...item, reviewed: true, authorised: true, updatedAt: now } : item
    ));
    await this.repository.setSetting(OBSERVER_CANDIDATES_SETTING, candidates);
    this.store.set({ observerCandidates: candidates });
  }

  async setObserverCandidateAssist(id: string, enabled: boolean): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    const now = Date.now();
    const candidates = this.store.value.observerCandidates.map((candidate) => (
      candidate.id === id ? { ...candidate, observerAssistEnabled: enabled, updatedAt: now } : candidate
    ));
    if (!candidates.some((candidate) => candidate.id === id)) throw new Error('Observer candidate not found.');
    await this.repository.setSetting(OBSERVER_CANDIDATES_SETTING, candidates);
    this.store.set({ observerCandidates: candidates });
    this.notice('info', enabled
      ? 'Candidate flagged for observer-assist setup. It will not be polled until saved as a verified observer with independent coordinates.'
      : 'Candidate observer-assist setup disabled.');
  }

  async saveObserver(input: {
    label: string;
    repeaterPubkeyHex: string;
    lat: number;
    lon: number;
    accuracyM: number;
    verification: VerifiedObserver['verification'];
    permissionConfirmed: boolean;
  }): Promise<VerifiedObserver> {
    this.requireWriter();
    this.requireRepository();
    const label = input.label.trim();
    if (!label || label.length > 80) throw new Error('Observer label must contain 1 to 80 characters.');
    const repeaterPubkeyHex = normalizeFullPubkey(input.repeaterPubkeyHex);
    if (!repeaterPubkeyHex) throw new Error('Observer identity must be a full 32-byte public key.');
    if (!validCoordinate(input.lat, input.lon)) throw new Error('Observer coordinates are invalid.');
    if (!Number.isFinite(input.accuracyM) || input.accuracyM < 1 || input.accuracyM > MAX_OBSERVER_ANCHOR_ACCURACY_M) {
      throw new Error(`Observer coordinate accuracy must be between 1 and ${MAX_OBSERVER_ANCHOR_ACCURACY_M} metres.`);
    }
    if (input.verification !== 'user-surveyed' && input.verification !== 'operator-confirmed') {
      throw new Error('Choose how the observer coordinates were independently verified.');
    }
    if (!input.permissionConfirmed) {
      throw new Error('Confirm that you have permission to query this observer.');
    }
    const now = Date.now();
    const existing = this.store.value.observers.find((observer) => observer.repeaterPubkeyHex === repeaterPubkeyHex);
    const observer: VerifiedObserver = {
      id: existing?.id ?? `observer-${repeaterPubkeyHex}`,
      label,
      repeaterPubkeyHex,
      lat: input.lat,
      lon: input.lon,
      accuracyM: input.accuracyM,
      verifiedAt: now,
      verification: input.verification,
      trust: 'verified-observer',
      permissionConfirmed: true,
      enabled: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const observers = normalizeObservers([
      observer,
      ...this.store.value.observers.filter((item) => item.id !== observer.id),
    ]);
    await this.repository.setSetting(VERIFIED_OBSERVERS_SETTING, observers);
    this.store.set({ observers });
    this.refreshRemoteObserverState();
    this.syncSmartWardrive();
    this.notice('success', `${observer.label} saved as an authorised verified observer.`);
    return observer;
  }

  async setObserverEnabled(id: string, enabled: boolean): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    const now = Date.now();
    const observers = this.store.value.observers.map((observer) => (
      observer.id === id ? { ...observer, enabled, updatedAt: now } : observer
    ));
    if (!observers.some((observer) => observer.id === id)) throw new Error('Observer not found.');
    await this.repository.setSetting(VERIFIED_OBSERVERS_SETTING, observers);
    this.store.set({ observers });
    this.refreshRemoteObserverState();
    this.syncSmartWardrive();
  }

  async deleteObserver(id: string): Promise<void> {
    this.requireWriter();
    this.requireRepository();
    const observers = this.store.value.observers.filter((observer) => observer.id !== id);
    if (observers.length === this.store.value.observers.length) throw new Error('Observer not found.');
    await this.repository.setSetting(VERIFIED_OBSERVERS_SETTING, observers);
    this.store.set((state) => ({
      observers,
      observerStatuses: state.observerStatuses.filter((status) => status.observerId !== id),
    }));
    this.refreshRemoteObserverState();
    this.syncSmartWardrive();
  }

  storageEstimate(): Promise<StorageEstimate | undefined> {
    return navigator.storage?.estimate?.() ?? Promise.resolve(undefined);
  }

  injectMockFrame(frame: Uint8Array): void {
    if (!this.#mock) throw new Error('Mock transport is not connected.');
    this.#mock.injectFrame(frame);
  }

  dropMockConnection(): void {
    this.#mock?.dropConnection();
  }

  restoreMockConnection(): void {
    this.#mock?.restoreConnection();
  }

  async injectGps(fix: Omit<GpsFix, 'sessionId' | 'acceptedNum'>): Promise<void> {
    const recorder = this.requireRecorder();
    await recorder.addFix({ ...fix, sessionId: recorder.session.id, acceptedNum: fix.accepted ? 1 : 0 });
  }

  async injectObserverEvidenceForTest(evidence: RemoteObserverEvidence): Promise<void> {
    if (!this.#mock) throw new Error('Observer evidence injection is available only with the test mock transport.');
    const session = this.requireRecorder().session;
    const targetPubkeyHex = normalizeFullPubkey(session.targetSnapshot.identity.pubkeyHex);
    const candidate: SessionEvent = {
      sessionId: session.id,
      t: evidence.receivedAt,
      type: 'observer-evidence',
      data: { ...evidence, id: evidence.id ?? uniqueId('observer-evidence-test') },
    };
    const normalized = observerEvidenceFromEvent(candidate);
    if (!normalized || normalized.targetPubkeyHex !== targetPubkeyHex) {
      throw new Error('Injected observer evidence must be valid and match the active full target key.');
    }
    const existingObserver = this.store.value.observers.find(
      (observer) => observer.repeaterPubkeyHex === normalized.observerPubkeyHex,
    );
    if (!existingObserver) {
      const observer: VerifiedObserver = {
        id: normalized.observerId,
        label: `Test observer ${normalized.observerPubkeyHex.slice(0, 8)}`,
        repeaterPubkeyHex: normalized.observerPubkeyHex,
        lat: normalized.anchorLat,
        lon: normalized.anchorLon,
        accuracyM: normalized.anchorAccuracyM,
        verifiedAt: normalized.anchorVerifiedAt,
        verification: normalized.anchorVerification,
        trust: 'verified-observer',
        permissionConfirmed: true,
        enabled: true,
        createdAt: normalized.anchorVerifiedAt,
        updatedAt: normalized.anchorVerifiedAt,
      };
      const observers = normalizeObservers([...this.store.value.observers, observer]);
      await this.repository.setSetting(VERIFIED_OBSERVERS_SETTING, observers);
      this.store.set({ observers });
    }
    await this.appendSessionEvent('observer-evidence', { ...normalized }, normalized.receivedAt);
  }

  dismissNotice(id: string): void {
    this.store.set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
  }

  notice(kind: Notice['kind'], message: string, action?: Notice['action']): void {
    const notice: Notice = { id: uniqueId('notice'), kind, message, action };
    this.store.set((state) => ({ notices: [...state.notices.slice(-3), notice] }));
    if (kind === 'success' || kind === 'info') setTimeout(() => this.dismissNotice(notice.id), 5_000);
  }

  async destroy(): Promise<void> {
    this.stopSmartWardrive('Application closed.');
    this.clearObserverExpiryTimer();
    await this.stopGps();
    const recorder = this.#recorder;
    this.#recorder = undefined;
    if (recorder) {
      await recorder.flush().catch(() => undefined);
      recorder.dispose();
    }
    await this.cleanupTransport();
    await this.releaseWakeLock();
    this.stopSignalAudio();
    await this.audio.destroy();
    if (this.#automationVisibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#automationVisibilityListener);
      this.#automationVisibilityListener = undefined;
    }
    this.#lease?.release();
    this.#database?.close();
  }

  private async replaceTransport(transport: Transport, disconnectCurrent = true): Promise<void> {
    if (disconnectCurrent) await this.cleanupTransport();
    this.#transport = transport;
    this.store.set({ transportKind: transport.kind });
    this.#removeTransportState = transport.onState((connection) => this.handleTransportState(connection));
    if (transport instanceof ReplayTransport) {
      this.#removeReplayEvent = transport.onScriptEvent((event) => this.ingestReplayEvent(event));
    }
  }

  private async connectDevice(): Promise<void> {
    const transport = this.requireTransport();
    this.#protocolReady = false;
    const device = new MeshCoreDevice(transport);
    this.#device = device;
    this.#discovery = new DiscoveryCoordinator(async (command, signal) => {
      await device.commands.send(command, null, { label: 'DISCOVERY', signal });
    });
    this.#guestObservers = new GuestObserverCoordinator(device.commands);
    this.#guestAttempted.clear();
    this.#removeDevicePush = device.onPush((frame) => this.handleCompanionPush(frame));
    try {
      const snapshot = await device.connect();
      await this.applyDeviceSnapshot(snapshot);
      this.#protocolReady = true;
      this.syncSmartWardrive();
      this.notice('success', `Connected to ${snapshot.info?.model || 'MeshCore companion'}.`);
    } catch (error) {
      await this.cleanupTransport();
      throw error;
    }
  }

  private handleCompanionPush(frame: CompanionFrame): void {
    const discoveryValidated = frame.kind === 'discovery-response'
      ? this.#discovery?.ingest(frame) === true
      : false;
    if (this.#recorder) {
      void this.#recorder.ingestFrame(frame, undefined, discoveryValidated)
        .catch((error: unknown) => this.notice('error', this.errorMessage(error)));
    }
    if (this.#device && (frame.kind === 'battery' || frame.kind === 'device-info' || frame.kind === 'self-info')) {
      this.applyRuntimeDeviceSnapshot(this.#device.snapshot());
    }
    if (this.#device && frame.kind === 'contact') {
      void this.applyDeviceSnapshot(this.#device.snapshot())
        .catch((error: unknown) => this.notice('warning', `Contact update could not be saved: ${this.errorMessage(error)}`));
    }
  }

  private async applyDeviceSnapshot(snapshot: DeviceSnapshot): Promise<void> {
    this.requireRepository();
    const { targets, activeTarget } = await this.enqueueTargetMetadata(async () => {
      const nextTargets = [...this.store.value.targets];
      let nextActiveTarget = this.store.value.activeTarget;
      let sessionTargetUpdate: TargetProfile | undefined;
      for (const contact of snapshot.contacts.filter((item) => item.type === 2)) {
        const contactKey = normalizeFullPubkey(contact.pubkeyHex);
        if (!contactKey) continue;
        this.#universe.addContact({ ...contact, pubkeyHex: contactKey });
        const indexes = nextTargets
          .map((target, index) => normalizeFullPubkey(target.identity.pubkeyHex) === contactKey ? index : -1)
          .filter((index) => index >= 0);
        const hasLocation = validAdvertisedPosition(contact.lat, contact.lon);
        if (indexes.length) {
          for (const index of indexes) {
            const existing = nextTargets[index];
            if (!existing) continue;
            const contactName = contact.name?.trim();
            const nextLabel = existing.source === 'contacts' && contactName ? contactName : existing.label;
            const nextName = contactName || existing.identity.name;
            const nextAdvertisedReference = hasLocation
              ? {
                  lat: contact.lat,
                  lon: contact.lon,
                  source: 'contact' as const,
                  observedAt: Date.now(),
                  trust: 'untrusted-admin' as const,
                }
              : existing.advertisedReference;
            const unchanged = nextLabel === existing.label
              && nextName === existing.identity.name
              && existing.source === 'contacts'
              && normalizeFullPubkey(existing.identity.pubkeyHex) === contactKey
              && nextAdvertisedReference?.lat === existing.advertisedReference?.lat
              && nextAdvertisedReference?.lon === existing.advertisedReference?.lon
              && nextAdvertisedReference?.source === existing.advertisedReference?.source
              && nextAdvertisedReference?.observedAt === existing.advertisedReference?.observedAt;
            if (unchanged) continue;
            const updated: TargetProfile = {
              ...existing,
              label: nextLabel,
              identity: { ...existing.identity, pubkeyHex: contactKey, ...(nextName ? { name: nextName } : {}) },
              source: 'contacts',
              advertisedReference: nextAdvertisedReference,
              updatedAt: Date.now(),
            };
            await this.repository.putTarget(updated);
            nextTargets[index] = updated;
            if (nextActiveTarget?.id === updated.id) nextActiveTarget = updated;
            if (this.store.value.activeSession?.targetSnapshot.id === updated.id) sessionTargetUpdate = updated;
          }
          continue;
        }
        const now = Date.now();
        const target: TargetProfile = {
          id: `contact-${contactKey}`,
          label: contact.name || `Repeater ${contactKey.slice(0, 8)}`,
          identity: {
            kind: 'full-pubkey',
            pubkeyHex: contactKey,
            ...(contact.name?.trim() ? { name: contact.name.trim() } : {}),
          },
          source: 'contacts',
          advertisedReference: hasLocation
            ? {
                lat: contact.lat,
                lon: contact.lon,
                source: 'contact',
                observedAt: now,
                trust: 'untrusted-admin',
              }
            : undefined,
          createdAt: now,
          updatedAt: now,
        };
        await this.repository.putTarget(target);
        nextTargets.push(target);
      }
      if (sessionTargetUpdate && this.#recorder) {
        await this.#recorder.updateTargetMetadata(sessionTargetUpdate);
      }
      return { targets: nextTargets, activeTarget: nextActiveTarget ?? nextTargets[0] };
    });
    if (activeTarget) await this.repository.setSetting(ACTIVE_TARGET_SETTING, activeTarget.id);
    this.applyRuntimeDeviceSnapshot(snapshot);
    this.store.set({
      targets,
      activeTarget,
      connection: 'connected',
    });
  }

  private applyRuntimeDeviceSnapshot(snapshot: DeviceSnapshot): void {
    const device: NonNullable<SearchSession['device']> = {
      pubkeyHex: snapshot.self.pubkeyHex,
      ...(snapshot.info?.model ? { model: snapshot.info.model } : {}),
      ...(snapshot.info ? { fwVer: snapshot.info.fwVersion } : {}),
      ...(snapshot.info?.build ? { fwBuild: snapshot.info.build } : {}),
      ...(snapshot.batteryMilliVolts === undefined ? {} : { battMv: snapshot.batteryMilliVolts }),
    };
    this.store.set({ device, deviceName: device.model || 'MeshCore companion' });
    this.#recorder?.updateDevice(device);
  }

  private createRecorder(session: SearchSession): void {
    this.#recorder?.dispose();
    this.#universe.addTarget(session.targetSnapshot);
    this.#recorder = new SessionRecorder({
      repository: this.requireRepository(),
      session,
      universe: this.#universe,
      onUpdate: (snapshot) => this.applyRecorderSnapshot(snapshot),
      onCollision: (prefixes) => this.notice('warning', `A new identity collision (${prefixes.join(', ')}) triggered full reclassification.`),
    });
  }

  private applyRecorderSnapshot(snapshot: RecorderSnapshot): void {
    const previous = this.store.value.activeSession?.id === snapshot.session.id
      ? this.store.value.receptions
      : [];
    const additions = snapshot.receptions.slice(previous.length);
    const percent = snapshot.signal.strengthPercent ?? 0;
    if (this.#suppressAudio) {
      this.stopSignalAudio();
    } else {
      this.audio.updateSignal(percent, snapshot.signal.hasSignal && !snapshot.signal.stale);
      for (const reception of additions) {
        this.audio.notifyReception({ classification: reception.cls, snr: reception.snr, percent });
      }
      if (additions.some((reception) => reception.cls.confirmed)) this.armAudioStaleTimer();
    }
    const approach = deriveApproachState(
      this.store.value.events,
      snapshot.estimate,
      snapshot.session.settings.maxGpsAccuracyM,
      Date.now(),
      snapshot.receptions,
    );
    const remote = deriveRemoteObserverState(
      this.store.value.events,
      snapshot.session.targetSnapshot,
      snapshot.estimate,
      approach.finalApproach,
      Date.now(),
      this.store.value.observers,
    );
    this.store.set((state) => ({
      activeSession: snapshot.session,
      receptions: [...snapshot.receptions],
      fixes: [...snapshot.fixes],
      estimate: snapshot.estimate,
      ...approach,
      ...remote,
      cells: [...snapshot.cells],
      signal: snapshot.signal,
      sessions: state.sessions.map((session) => session.id === snapshot.session.id ? snapshot.session : session),
    }));
    this.armObserverExpiryTimer();
    const positionedAdvertReception = [...additions].reverse().find((reception) => {
      const advert = reception.decoded?.advert;
      return advert?.hasLocation
        && validAdvertisedPosition(advert.lat, advert.lon)
        && this.advertMatchesTargetExactly(snapshot.session.targetSnapshot, advert.pubkeyHex);
    });
    const positionedAdvert = positionedAdvertReception?.decoded?.advert;
    if (positionedAdvert?.lat !== undefined && positionedAdvert.lon !== undefined && positionedAdvertReception) {
      void this.enqueueTargetMetadata(() => this.updateTargetAdvertisedReferenceFromAdvert(
        snapshot.session.id,
        snapshot.session.targetSnapshot.id,
        positionedAdvert.pubkeyHex,
        positionedAdvert.lat as number,
        positionedAdvert.lon as number,
        positionedAdvertReception.t,
      )).catch((error: unknown) => {
        this.notice('warning', `The target's unverified admin position could not be saved: ${this.errorMessage(error)}`);
      });
    }
  }

  private advertMatchesTargetExactly(target: TargetProfile, pubkeyHex: string): boolean {
    return target.identity.kind === 'full-pubkey'
      && normalizeFullPubkey(target.identity.pubkeyHex) === normalizeFullPubkey(pubkeyHex);
  }

  private async updateTargetAdvertisedReferenceFromAdvert(
    sessionId: string,
    targetId: string,
    pubkeyHex: string,
    lat: number,
    lon: number,
    observedAt: number,
  ): Promise<void> {
    const state = this.store.value;
    if (state.activeSession?.id !== sessionId || state.activeSession.targetSnapshot.id !== targetId) return;
    const target = state.targets.find((candidate) => candidate.id === targetId)
      ?? state.activeSession.targetSnapshot;
    if (!this.advertMatchesTargetExactly(target, pubkeyHex)) return;
    if (target.advertisedReference?.lat === lat && target.advertisedReference.lon === lon
      && target.advertisedReference.source === 'advert'
      && target.advertisedReference.observedAt >= observedAt) return;
    const updated: TargetProfile = {
      ...target,
      advertisedReference: { lat, lon, source: 'advert', observedAt, trust: 'untrusted-admin' },
      updatedAt: Date.now(),
    };
    await this.repository.putTarget(updated);
    if (this.#recorder?.session.id === sessionId) await this.#recorder.updateTargetMetadata(updated);
    this.store.set((current) => ({
      activeTarget: current.activeTarget?.id === targetId ? updated : current.activeTarget,
      targets: current.targets.some((candidate) => candidate.id === targetId)
        ? current.targets.map((candidate) => candidate.id === targetId ? updated : candidate)
        : [updated, ...current.targets],
    }));
  }

  private enqueueTargetMetadata<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#targetMetadataChain.then(operation, operation);
    this.#targetMetadataChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startGps(session: SearchSession): Promise<void> {
    await this.stopGps();
    const recorder = this.#recorder;
    if (!recorder) return;
    const generation = ++this.#gpsGeneration;
    const gps = new GpsService({
      filterOptions: { maxAccuracyM: session.settings.maxGpsAccuracyM },
      onState: (gpsState) => {
        if (generation === this.#gpsGeneration && this.#recorder === recorder) this.store.set({ gpsState });
      },
      onFix: async (fix) => {
        if (generation !== this.#gpsGeneration || this.#recorder !== recorder) return undefined;
        const stored = await recorder.addFix(fix);
        return stored.id;
      },
      onClockSkew: (skewMs, fix) => {
        if (generation !== this.#gpsGeneration || this.#recorder !== recorder) return;
        this.notice('warning', `GPS timestamp differs from the arrival clock by ${Math.round(skewMs / 1_000)}s.`);
        void this.persistClockSkew(session.id, skewMs, fix);
      },
    });
    this.#gps = gps;
    gps.start(session.id);
  }

  private async stopGps(): Promise<void> {
    const gps = this.#gps;
    this.#gps = undefined;
    this.#gpsGeneration += 1;
    gps?.stop();
    await gps?.flushWrites();
  }

  private async persistClockSkew(sessionId: string, skewMs: number, fix: GpsFix): Promise<void> {
    const event: SessionEvent = {
      sessionId,
      t: fix.t,
      type: 'note',
      data: { kind: 'clock-skew', skewMs, positionTimestamp: fix.posT, arrivalTimestamp: fix.t },
    };
    event.id = await this.repository.addEvent(event);
    if (this.store.value.activeSession?.id === sessionId) {
      this.store.set((state) => ({ events: [...state.events, event] }));
    }
  }

  private ingestReplayEvent(event: ScriptEvent): void {
    const recorder = this.#recorder;
    if (!recorder) return;
    const t = recorder.session.startedAt + event.atMs;
    if (event.kind === 'frame') {
      void recorder.ingestRawFrame(event.frame, t, true).catch((error: unknown) => this.notice('error', this.errorMessage(error)));
    } else if (event.kind === 'gps') {
      const fix = { ...event.fix, t, posT: t, sessionId: recorder.session.id };
      void recorder.addFix(fix).catch((error: unknown) => this.notice('error', this.errorMessage(error)));
    }
  }

  private async sessionBundle(id: string) {
    this.requireRepository();
    const session = await this.repository.getSession(id);
    if (!session) throw new Error('Session not found.');
    const [receptions, fixes, events] = await Promise.all([
      this.repository.listReceptions(id),
      this.repository.listFixes(id),
      this.repository.listEvents(id),
    ]);
    const cells = this.store.value.activeSession?.id === id && this.#recorder
      ? this.#recorder.cells.values()
      : aggregateReceptions(receptions, {
        mode: session.mode,
        cellSizeM: session.settings.cellSizeM,
        maxGpsAccuracyM: session.settings.maxGpsAccuracyM,
      });
    const estimate = this.store.value.activeSession?.id === id
      ? this.store.value.estimate
      : estimateArea(cells, { minSamples: session.settings.minSamples, minCells: session.settings.minCells });
    const approach = deriveApproachState(
      events,
      estimate,
      session.settings.maxGpsAccuracyM,
      Date.now(),
      receptions,
    );
    const generatedAt = session.state === 'ended'
      ? events.reduce(
          (latest, event) => Math.max(latest, event.t),
          session.endedAt ?? session.startedAt,
        )
      : Date.now();
    const remote = deriveRemoteObserverState(
      events,
      session.targetSnapshot,
      estimate,
      approach.finalApproach,
      generatedAt,
      this.store.value.observers,
    );
    return {
      session,
      receptions,
      fixes,
      events,
      cells,
      estimate,
      bearingConsensus: approach.bearingConsensus,
      finalApproach: approach.finalApproach,
      observerEvidence: remote.observerEvidence,
      remoteObserverAnalysis: remote.remoteObserverAnalysis,
      communityAssistedZone: remote.communityAssistedZone,
    };
  }

  private async reloadSessions(): Promise<void> {
    this.requireRepository();
    this.store.set({ sessions: await this.repository.listSessions() });
  }

  private async reloadTargets(): Promise<void> {
    this.requireRepository();
    const targets = await this.repository.listTargets();
    for (const target of targets) this.#universe.addTarget(target);
    this.store.set({ targets });
  }

  private rebuildIdentityUniverse(receptions: readonly Reception[]): void {
    for (const reception of receptions) {
      const advert = reception.decoded?.advert;
      if (advert) this.#universe.observe(advert.pubkeyHex, advert.name);
      if (reception.decoded?.anonSenderPubkeyHex) {
        this.#universe.observe(reception.decoded.anonSenderPubkeyHex);
      }
      if (reception.source === 'discovery' && reception.cls.origin?.pubkeyHex) {
        this.#universe.observe(reception.cls.origin.pubkeyHex, reception.cls.origin.name, 'discovery');
      }
    }
  }


  private async recordObserverCandidatesFromDiscovery(responses: readonly DiscoveryResponseFrame[], heardAt: number): Promise<void> {
    this.requireRepository();
    const inputs: ObserverCandidateInput[] = [];
    for (const response of responses) {
      const metadata = this.discoveryCandidateMetadata(response.pubkeyHex, heardAt);
      const candidate = candidateFromDiscoveryResponse(response, heardAt, metadata);
      if (candidate) inputs.push(candidate);
    }
    if (!inputs.length) return;
    const observerCandidates = upsertObserverCandidates(this.store.value.observerCandidates, inputs);
    await this.repository.setSetting(OBSERVER_CANDIDATES_SETTING, observerCandidates);
    this.store.set({ observerCandidates });
  }

  private discoveryCandidateMetadata(pubkeyHex: string, heardAt: number): { displayName?: string; advertisedCoordinates?: Omit<NonNullable<ObserverCandidate['advertisedCoordinates']>, 'status'> } {
    const pubkey = normalizeFullPubkey(pubkeyHex);
    const contact = this.store.value.targets.find((target) => normalizeFullPubkey(target.identity.pubkeyHex) === pubkey && target.source === 'contacts');
    const advertReception = [...this.store.value.receptions].reverse().find((reception) => {
      const advert = reception.decoded?.advert;
      return advert !== undefined && normalizeFullPubkey(advert.pubkeyHex) === pubkey && advert.hasLocation && validAdvertisedPosition(advert.lat, advert.lon);
    });
    const advert = advertReception?.decoded?.advert;
    if (advert?.lat !== undefined && advert.lon !== undefined) {
      return {
        displayName: advert.name ?? contact?.label,
        advertisedCoordinates: { lat: advert.lat, lon: advert.lon, source: 'advert', observedAt: advertReception?.t ?? heardAt },
      };
    }
    const reference = contact?.advertisedReference;
    return {
      displayName: contact?.label,
      advertisedCoordinates: reference
        ? { lat: reference.lat, lon: reference.lon, source: reference.source, observedAt: reference.observedAt }
        : undefined,
    };
  }

  private async cleanupTransport(): Promise<void> {
    this.#protocolReady = false;
    this.stopSmartWardrive('Radio disconnected.');
    this.#removeReplayEvent?.();
    this.#removeReplayEvent = undefined;
    this.#removeDevicePush?.();
    this.#removeDevicePush = undefined;
    this.#removeTransportState?.();
    this.#removeTransportState = undefined;
    this.#discovery?.cancel('Transport replaced');
    this.#discovery = undefined;
    this.#guestObservers?.dispose('Transport replaced');
    this.#guestObservers = undefined;
    this.#guestAttempted.clear();
    this.#device?.dispose();
    this.#device = undefined;
    const transport = this.#transport;
    this.#transport = undefined;
    this.#mock = undefined;
    if (transport) await transport.disconnect().catch(() => undefined);
    this.store.set({ connection: 'disconnected', transportKind: null, deviceName: undefined, device: undefined });
  }

  private handleTransportState(connection: ConnState): void {
    const previous = this.store.value.connection;
    const pickerFreeReconnect = previous === 'reconnecting' && connection === 'connected';
    if (connection === 'connected') this.#connectionLossAlerted = false;
    else this.#protocolReady = false;
    const lostConnection = previous === 'connected'
      && (connection === 'reconnecting' || connection === 'disconnected');
    if (lostConnection) this.#discovery?.cancel('Discovery cancelled because the radio connection was lost.');
    if (
      lostConnection
      && this.store.value.activeSession
      && !this.#expectedDisconnect
      && !this.#connectionLossAlerted
    ) {
      this.#connectionLossAlerted = true;
      this.stopSignalAudio();
      this.audio.playDisconnectAlarm();
    }
    this.store.set({ connection });
    this.syncSmartWardrive();
    if (pickerFreeReconnect && this.#device) void this.rehydrateAfterReconnect(this.#device);
  }

  private async rehydrateAfterReconnect(device: MeshCoreDevice): Promise<void> {
    this.#protocolReady = false;
    const pendingObserverPoll = this.#observerPollPromise;
    this.cancelObserverPoll('Bluetooth protocol is being restored.');
    await pendingObserverPoll?.catch(() => undefined);
    try {
      const snapshot = await device.rehydrate();
      if (this.#device !== device) return;
      this.#guestObservers?.dispose('Bluetooth reconnected');
      this.#guestObservers = new GuestObserverCoordinator(device.commands);
      this.#guestAttempted.clear();
      await this.applyDeviceSnapshot(snapshot);
      this.#protocolReady = true;
      this.syncSmartWardrive();
      this.notice('success', 'Companion protocol restored after Bluetooth reconnect.');
    } catch (error) {
      if (this.#device !== device) return;
      this.notice('error', `Bluetooth reconnected, but the MeshCore session could not be restored: ${this.errorMessage(error)}`);
      await this.cleanupTransport();
    }
  }

  private pollObservers(): Promise<void> {
    if (this.#observerPollPromise) return this.#observerPollPromise;
    const session = this.store.value.activeSession;
    const coordinator = this.#guestObservers;
    if (!session || session.demo || session.mode !== 'drive') {
      throw new Error('Observer assist requires an active real Drive session.');
    }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      throw new Error('Observer assist pauses while the page is hidden.');
    }
    if (this.store.value.connection !== 'connected' || !coordinator) {
      throw new Error('Observer assist requires a connected companion.');
    }
    if (!this.#protocolReady) throw new Error('Observer assist is waiting for the companion protocol to be restored.');
    const targetPubkeyHex = normalizeFullPubkey(session.targetSnapshot.identity.pubkeyHex);
    if (!targetPubkeyHex) throw new Error('Pin the target full public key before querying observers.');
    const eligibleObservers = this.store.value.observers.filter((observer) => (
      observer.enabled
      && observer.permissionConfirmed
      && observer.trust === 'verified-observer'
      && observer.accuracyM <= MAX_OBSERVER_ANCHOR_ACCURACY_M
    ));
    if (!eligibleObservers.length) {
      throw new Error(`No enabled observer has permission and a verified anchor accurate to ${MAX_OBSERVER_ANCHOR_ACCURACY_M} metres or better.`);
    }

    const intervalMs = Math.max(
      MIN_OBSERVER_POLL_INTERVAL_MS,
      session.settings.observerPollIntervalMin * 60_000,
    );
    const remainingMs = this.#lastObserverPollStartedAt + intervalMs - Date.now();
    if (remainingMs > 0) {
      const waitMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
      throw new Error(
        `Observer polling is rate-limited. Wait about ${waitMinutes} more minute${waitMinutes === 1 ? '' : 's'}.`,
      );
    }

    const generation = ++this.#observerPollGeneration;
    this.#lastObserverPollStartedAt = Date.now();
    const observerCount = Math.min(MAX_OBSERVERS_PER_POLL, eligibleObservers.length);
    const observers = Array.from({ length: observerCount }, (_, offset) => (
      eligibleObservers[(this.#observerPollCursor + offset) % eligibleObservers.length]
    )).filter((observer): observer is VerifiedObserver => observer !== undefined);
    this.#observerPollCursor = (this.#observerPollCursor + observers.length) % eligibleObservers.length;
    const task = this.runObserverPoll(
      generation,
      session.id,
      targetPubkeyHex,
      coordinator,
      observers,
    ).finally(() => {
      this.#observerPollPromise = undefined;
    });
    this.#observerPollPromise = task;
    return task;
  }

  private async runObserverPoll(
    generation: number,
    sessionId: string,
    targetPubkeyHex: string,
    coordinator: GuestObserverCoordinator,
    observers: readonly VerifiedObserver[],
  ): Promise<void> {
    let remainingPageBudget = MAX_OBSERVER_PAGES_PER_POLL;
    for (const observer of observers) {
      if (observer.trust !== 'verified-observer') {
        throw new Error('Observer candidates cannot be used directly for polling; save an independently verified observer first.');
      }
      if (remainingPageBudget <= 0) break;
      this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
      const attemptedAt = Date.now();
      this.setObserverStatus(observer.id, {
        state: 'querying',
        lastAttemptAt: attemptedAt,
        detail: 'Requesting a rate-limited target-matched neighbour record.',
      });
      await this.appendSessionEvent('observer-query', {
        observerId: observer.id,
        observerPubkeyHex: observer.repeaterPubkeyHex,
        action: 'started',
        blankGuestOnly: true,
        permissionConfirmed: true,
      }, attemptedAt, sessionId);
      this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
      if (observer.repeaterPubkeyHex === targetPubkeyHex) {
        const detail = 'The target cannot also be used as its own observer.';
        this.setObserverStatus(observer.id, { state: 'error', detail });
        await this.appendSessionEvent('observer-query', {
          observerId: observer.id,
          action: 'rejected',
          reason: 'observer-is-target',
        }, Date.now(), sessionId);
        this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
        continue;
      }
      try {
        if (!coordinator.isAuthenticated(observer.repeaterPubkeyHex)) {
          if (this.#guestAttempted.has(observer.repeaterPubkeyHex)) {
            this.setObserverStatus(observer.id, {
              state: 'denied',
              detail: 'Blank guest login previously failed on this Bluetooth connection; no retry or password guessing was attempted.',
            });
            await this.appendSessionEvent('observer-query', {
              observerId: observer.id,
              observerPubkeyHex: observer.repeaterPubkeyHex,
              action: 'login-not-retried',
              blankGuestOnly: true,
            }, Date.now(), sessionId);
            this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
            continue;
          }
          this.#guestAttempted.add(observer.repeaterPubkeyHex);
          const login = await coordinator.loginBlankGuest(observer.repeaterPubkeyHex);
          this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
          if (!login.accepted) {
            const adminRefused = login.reason === 'admin-session-refused';
            const detail = adminRefused
              ? 'The blank login returned administrative permission, so MeshCore Finder refused the session without issuing a request.'
              : 'Blank guest access was denied. No password was requested, stored, or guessed.';
            this.setObserverStatus(observer.id, { state: 'denied', detail });
            await this.appendSessionEvent('observer-query', {
              observerId: observer.id,
              observerPubkeyHex: observer.repeaterPubkeyHex,
              action: adminRefused ? 'admin-session-refused' : 'login-denied',
              blankGuestOnly: true,
            }, Date.now(), sessionId);
            this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
            continue;
          }
          await this.appendSessionEvent('observer-query', {
            observerId: observer.id,
            observerPubkeyHex: observer.repeaterPubkeyHex,
            action: 'login-accepted',
            blankGuestOnly: true,
            route: login.route,
            legacy: login.legacy,
          }, Date.now(), sessionId);
          this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
        }

        const pageBudget = Math.min(3, remainingPageBudget);
        const result = await coordinator.fetchNeighbours(observer.repeaterPubkeyHex, {
          order: 'newest-to-oldest',
          pageSize: 3,
          maxPages: pageBudget,
          maxNeighbours: pageBudget * 3,
        });
        remainingPageBudget -= result.pagesFetched;
        this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
        const match = result.observations.find((item) => item.pubkeyHex === targetPubkeyHex);
        const receivedAt = Date.now();
        if (!match) {
          this.setObserverStatus(observer.id, {
            state: 'no-match',
            detail: `No full-key target match in ${result.observations.length} bounded neighbour record${result.observations.length === 1 ? '' : 's'}.`,
          });
          await this.appendSessionEvent('observer-query', {
            observerId: observer.id,
            observerPubkeyHex: observer.repeaterPubkeyHex,
            action: 'completed-no-match',
            recordsChecked: result.observations.length,
            pagesFetched: result.pagesFetched,
            complete: result.complete,
            ...(result.truncatedReason ? { truncatedReason: result.truncatedReason } : {}),
          }, receivedAt, sessionId);
          this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
          continue;
        }
        const observedAt = observedAtFromNeighbourAge(receivedAt, match.heardSecondsAgo);
        if (observedAt === undefined) {
          const detail = 'The observer returned an impossible neighbour age, so the record was kept out of evidence and exports.';
          this.setObserverStatus(observer.id, { state: 'error', detail });
          await this.appendSessionEvent('observer-query', {
            observerId: observer.id,
            observerPubkeyHex: observer.repeaterPubkeyHex,
            action: 'invalid-neighbour-age',
            heardSecondsAgo: match.heardSecondsAgo,
          }, receivedAt, sessionId);
          this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
          continue;
        }
        const evidence: RemoteObserverEvidence = {
          id: uniqueId('observer-evidence'),
          observerId: observer.id,
          observerPubkeyHex: observer.repeaterPubkeyHex,
          targetPubkeyHex,
          observedAt,
          receivedAt,
          heardSecondsAgo: match.heardSecondsAgo,
          snr: match.snrDb,
          anchorLat: observer.lat,
          anchorLon: observer.lon,
          anchorAccuracyM: observer.accuracyM,
          anchorVerifiedAt: observer.verifiedAt,
          anchorVerification: observer.verification,
          source: 'guest-neighbour',
          trust: 'verified-observer',
        };
        this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
        await this.appendSessionEvent('observer-evidence', { ...evidence }, receivedAt, sessionId);
        this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
        this.setObserverStatus(observer.id, {
          state: 'matched',
          lastMatchedAt: receivedAt,
          lastHeardAt: observedAt,
          lastSnr: match.snrDb,
          detail: match.heardSecondsAgo <= 300
            ? `Fresh full-key direct-neighbour match at ${match.snrDb.toFixed(1)} dB SNR.`
            : `Full-key match was ${Math.round(match.heardSecondsAgo / 60)} minutes old and is retained for audit but excluded from the live zone.`,
        });
        await this.appendSessionEvent('observer-query', {
          observerId: observer.id,
          observerPubkeyHex: observer.repeaterPubkeyHex,
          action: 'completed-match',
          evidenceId: evidence.id,
          recordsChecked: result.observations.length,
          pagesFetched: result.pagesFetched,
          complete: result.complete,
          ...(result.truncatedReason ? { truncatedReason: result.truncatedReason } : {}),
        }, receivedAt, sessionId);
        this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
      } catch (error) {
        if (error instanceof ObserverPollCancelledError) throw error;
        this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
        const detail = this.errorMessage(error);
        this.setObserverStatus(observer.id, { state: 'error', detail });
        await this.appendSessionEvent('observer-query', {
          observerId: observer.id,
          observerPubkeyHex: observer.repeaterPubkeyHex,
          action: 'error',
          detail,
        }, Date.now(), sessionId);
        this.assertObserverPollContext(generation, sessionId, targetPubkeyHex, coordinator, observer);
      }
    }
  }

  private assertObserverPollContext(
    generation: number,
    sessionId: string,
    targetPubkeyHex: string,
    coordinator: GuestObserverCoordinator,
    observer?: VerifiedObserver,
  ): void {
    const state = this.store.value;
    const session = state.activeSession;
    if (
      generation !== this.#observerPollGeneration
      || coordinator !== this.#guestObservers
      || !session
      || session.id !== sessionId
      || session.demo
      || session.mode !== 'drive'
      || normalizeFullPubkey(session.targetSnapshot.identity.pubkeyHex) !== targetPubkeyHex
      || state.connection !== 'connected'
      || !this.#protocolReady
      || (typeof document !== 'undefined' && document.visibilityState !== 'visible')
    ) {
      throw new ObserverPollCancelledError();
    }
    if (!observer) return;
    const live = state.observers.find((candidate) => candidate.id === observer.id);
    if (
      !live
      || !live.enabled
      || !live.permissionConfirmed
      || live.trust !== 'verified-observer'
      || live.updatedAt !== observer.updatedAt
      || live.repeaterPubkeyHex !== observer.repeaterPubkeyHex
      || live.lat !== observer.lat
      || live.lon !== observer.lon
      || live.accuracyM !== observer.accuracyM
      || live.verifiedAt !== observer.verifiedAt
      || live.verification !== observer.verification
    ) {
      throw new ObserverPollCancelledError('Observer poll cancelled because its permission or verified anchor changed.');
    }
  }

  private cancelObserverPoll(reason: string): void {
    if (!this.#observerPollPromise) return;
    this.#observerPollGeneration += 1;
    this.#guestObservers?.cancelPending(reason);
    this.store.set((state) => ({
      observerStatuses: state.observerStatuses.map((status) => (
        status.state === 'querying' || status.state === 'queued'
          ? { ...status, state: 'idle' as const, detail: `Poll stopped: ${reason}` }
          : status
      )),
    }));
  }

  private setObserverStatus(
    observerId: string,
    patch: Partial<AppState['observerStatuses'][number]>,
  ): void {
    this.store.set((state) => {
      const current = state.observerStatuses.find((status) => status.observerId === observerId);
      const next = { observerId, state: 'idle' as const, ...current, ...patch };
      return {
        observerStatuses: [
          ...state.observerStatuses.filter((status) => status.observerId !== observerId),
          next,
        ],
      };
    });
  }

  private syncSmartWardrive(): void {
    const state = this.store.value;
    const session = state.activeSession;
    const settings = session?.settings;
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    let reason: string | undefined;
    if (!session) reason = 'No active Drive session.';
    else if (session.demo) reason = 'Smart Wardrive never runs against simulated data.';
    else if (session.mode !== 'drive') reason = 'Smart Wardrive runs only during Drive sessions.';
    else if (!settings?.smartWardriveEnabled) reason = 'Smart Wardrive is disabled.';
    else if (!visible) reason = 'Smart Wardrive paused while the page is not visible.';
    else if (state.connection !== 'connected' || !this.#device || !this.#discovery) reason = 'Smart Wardrive paused until the radio is connected.';
    else if (!this.#protocolReady) reason = 'Smart Wardrive paused while the companion protocol is being restored.';

    const authorisedObservers = state.observers.filter((observer) => (
      observer.enabled
      && observer.permissionConfirmed
      && observer.trust === 'verified-observer'
    ));
    const eligibleObservers = authorisedObservers.filter(
      (observer) => observer.accuracyM <= MAX_OBSERVER_ANCHOR_ACCURACY_M,
    );
    const hasFullTargetKey = normalizeFullPubkey(session?.targetSnapshot.identity.pubkeyHex) !== undefined;
    const autoDiscovery = settings?.autoDiscoveryEnabled === true;
    const observerAssist = settings?.observerAssistEnabled === true
      && eligibleObservers.length > 0
      && hasFullTargetKey;
    if (!reason && !autoDiscovery && !observerAssist) {
      reason = settings?.observerAssistEnabled && !hasFullTargetKey
        ? 'Pin the target full public key for observer assist, or enable automatic discovery.'
        : settings?.observerAssistEnabled && authorisedObservers.length > 0
          ? `Verify an observer anchor to ${MAX_OBSERVER_ANCHOR_ACCURACY_M} metres or better, or enable automatic discovery.`
        : settings?.observerAssistEnabled
          ? 'Add and enable an authorised verified observer, or enable automatic discovery.'
        : 'Enable automatic discovery or observer assist to run Smart Wardrive.';
    }
    if (reason || !settings) {
      this.stopSmartWardrive(reason ?? 'Smart Wardrive stopped.');
      return;
    }
    const signature = JSON.stringify({
      sessionId: session.id,
      autoDiscovery,
      observerAssist,
      discoveryIntervalSec: settings.autoDiscoveryIntervalSec,
      observerPollIntervalMin: settings.observerPollIntervalMin,
      targetPubkeyHex: hasFullTargetKey ? session.targetSnapshot.identity.pubkeyHex : undefined,
      observers: eligibleObservers.map(({ id, updatedAt }) => [id, updatedAt]),
    });
    if (this.#smartWardriveSignature === signature && this.#smartWardrive.snapshot().active) return;
    const wasActive = this.#smartWardrive.snapshot().active;
    if (this.#smartWardriveSignature && this.#smartWardriveSignature !== signature) {
      this.#automaticDiscoveryAbort?.abort(new Error('Smart Wardrive configuration changed.'));
      this.#automaticDiscoveryAbort = undefined;
      this.cancelObserverPoll('Smart Wardrive configuration or target changed.');
    }
    this.#smartWardriveSignature = signature;
    this.#smartWardrive.start({
      enabled: true,
      autoDiscovery,
      discoveryIntervalMs: settings.autoDiscoveryIntervalSec * 1_000,
      observerAssist,
      observerPollIntervalMs: settings.observerPollIntervalMin * 60_000,
    });
    if (!wasActive) {
      void this.appendSessionEvent('smart-wardrive', {
        state: 'started',
        foregroundOnly: true,
        autoDiscovery,
        observerAssist,
        discoveryIntervalSec: settings.autoDiscoveryIntervalSec,
        observerPollIntervalMin: settings.observerPollIntervalMin,
      }).catch((error: unknown) => this.notice('warning', `Smart Wardrive audit event could not be saved: ${this.errorMessage(error)}`));
    }
  }

  private stopSmartWardrive(reason: string): void {
    this.#automaticDiscoveryAbort?.abort(new Error(reason));
    this.#automaticDiscoveryAbort = undefined;
    this.cancelObserverPoll(reason);
    const previous = this.#smartWardrive.snapshot();
    const signature = `stopped:${reason}`;
    if (this.#smartWardriveSignature === signature && !previous.active) return;
    this.#smartWardriveSignature = signature;
    this.#smartWardrive.stop(reason);
    if (previous.active) {
      void this.appendSessionEvent('smart-wardrive', { state: 'stopped', reason })
        .catch(() => undefined);
    }
  }

  private async appendSessionEvent(
    type: SessionEvent['type'],
    data: Record<string, unknown>,
    t = Date.now(),
    expectedSessionId?: string,
  ): Promise<SessionEvent | undefined> {
    const session = this.store.value.activeSession;
    if (expectedSessionId && session?.id !== expectedSessionId) {
      throw new ObserverPollCancelledError('Observer poll cancelled because the active session changed.');
    }
    if (!session || !this.repository) return undefined;
    const sessionId = expectedSessionId ?? session.id;
    const event: SessionEvent = { sessionId, t, type, data };
    event.id = await this.repository.addEvent(event);
    if (this.store.value.activeSession?.id === sessionId) {
      this.store.set((state) => {
        const events = [...state.events, event];
        return {
          events,
          ...deriveRemoteObserverState(
            events,
            state.activeSession?.targetSnapshot,
            state.estimate,
            state.finalApproach,
            t,
            state.observers,
          ),
        };
      });
      this.armObserverExpiryTimer();
    }
    return event;
  }

  private refreshRemoteObserverState(): void {
    const state = this.store.value;
    const session = state.activeSession;
    if (!session) {
      this.clearObserverExpiryTimer();
      if (state.observerEvidence.length || state.remoteObserverAnalysis || state.communityAssistedZone) {
        this.store.set({
          observerEvidence: [],
          remoteObserverAnalysis: undefined,
          communityAssistedZone: undefined,
        });
      }
      return;
    }
    this.store.set(deriveRemoteObserverState(
      state.events,
      session.targetSnapshot,
      state.estimate,
      state.finalApproach,
      Date.now(),
      state.observers,
    ));
    this.armObserverExpiryTimer();
  }

  private armObserverExpiryTimer(): void {
    this.clearObserverExpiryTimer();
    if (!this.store.value.activeSession) return;
    const now = Date.now();
    const nextExpiry = this.store.value.observerEvidence
      .map((evidence) => evidence.observedAt + REMOTE_OBSERVER_MAX_AGE_MS + 1)
      .filter((expiresAt) => expiresAt > now)
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    this.#observerExpiryTimer = globalThis.setTimeout(() => {
      this.#observerExpiryTimer = undefined;
      this.refreshRemoteObserverState();
    }, Math.max(0, nextExpiry - now));
  }

  private clearObserverExpiryTimer(): void {
    if (this.#observerExpiryTimer !== undefined) globalThis.clearTimeout(this.#observerExpiryTimer);
    this.#observerExpiryTimer = undefined;
  }

  private configureAudio(settings: SessionSettings): void {
    this.audio.setMode(settings.audioMode ?? DEFAULT_SESSION_SETTINGS.audioMode);
    this.audio.setVolume(settings.audioVolume ?? DEFAULT_SESSION_SETTINGS.audioVolume);
    this.audio.setMuted(settings.audioMuted ?? DEFAULT_SESSION_SETTINGS.audioMuted);
    this.audio.setForwardedAlert(settings.forwardedAlert ?? DEFAULT_SESSION_SETTINGS.forwardedAlert);
  }

  private armAudioStaleTimer(): void {
    if (this.#audioStaleTimer !== undefined) clearTimeout(this.#audioStaleTimer);
    this.#audioStaleTimer = setTimeout(() => {
      this.#audioStaleTimer = undefined;
      this.audio.setSignalActive(false);
    }, 20_000);
  }

  private stopSignalAudio(): void {
    if (this.#audioStaleTimer !== undefined) clearTimeout(this.#audioStaleTimer);
    this.#audioStaleTimer = undefined;
    this.audio.setSignalActive(false);
  }

  private async acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    try {
      this.#wakeLock = await navigator.wakeLock.request('screen');
      if (!this.#visibilityListener) {
        this.#visibilityListener = () => {
          if (document.visibilityState === 'visible' && this.store.value.activeSession && !this.#wakeLock) {
            void this.acquireWakeLock();
          }
        };
        document.addEventListener('visibilitychange', this.#visibilityListener);
      }
      this.#wakeLock.addEventListener('release', () => { this.#wakeLock = undefined; }, { once: true });
    } catch {
      this.notice('warning', 'Screen wake lock was unavailable; prevent auto-lock during capture.');
    }
  }

  private async releaseWakeLock(): Promise<void> {
    await this.#wakeLock?.release().catch(() => undefined);
    this.#wakeLock = undefined;
    if (this.#visibilityListener) document.removeEventListener('visibilitychange', this.#visibilityListener);
    this.#visibilityListener = undefined;
  }

  private requireRepository(): FinderRepository {
    return this.repository;
  }

  private requireWriter(): void {
    if (!this.store.value.writer) throw new Error('This tab is read-only because another tab holds the writer lock.');
  }

  private requireTransport(): Transport {
    if (!this.#transport) throw new Error('Connect a companion or start demo mode first.');
    return this.#transport;
  }

  private requireRecorder(): SessionRecorder {
    if (!this.#recorder) throw new Error('Start or resume a session first.');
    return this.#recorder;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
