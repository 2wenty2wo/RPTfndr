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
  analyzeBearingConsensus,
  bearingEvent,
  deriveFinalApproach,
  estimateArea,
  GpsService,
  observationFromBearingEvent,
} from '../location';
import {
  DiscoveryCoordinator,
  IdentityUniverse,
  MeshCoreDevice,
  normalizeHex,
  targetBytes,
  type CompanionFrame,
  type DeviceSnapshot,
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
  SearchSession,
  SessionEvent,
  SessionSettings,
  TargetProfile,
  Transport,
} from '../types';
import { DEFAULT_SESSION_SETTINGS } from '../types';

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

const ACK_SETTING = 'safety-ack-v1';
const ACTIVE_TARGET_SETTING = 'active-target';
const SESSION_SETTINGS_SETTING = 'session-settings';
const SHOW_UNTRUSTED_ADMIN_POSITION_SETTING = 'show-untrusted-admin-position';

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
  #discovery?: DiscoveryCoordinator;
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

  async init(): Promise<void> {
    this.#database = await openFinderDatabase({
      onBlocked: () => this.notice('warning', 'Another tab is blocking a local database upgrade.'),
    });
    this.repository = new FinderRepository(this.#database);
    this.#lease = await acquireWriterLock();
    const [acknowledged, targets, sessions, resumeCandidates, activeTargetId, savedSettings, showUntrustedAdminPosition] = await Promise.all([
      this.repository.getSetting<boolean>(ACK_SETTING),
      this.repository.listTargets(),
      this.repository.listSessions(),
      findResumableSessions(this.repository),
      this.repository.getSetting<string>(ACTIVE_TARGET_SETTING),
      this.repository.getSetting<Partial<SessionSettings>>(SESSION_SETTINGS_SETTING),
      this.repository.getSetting<boolean>(SHOW_UNTRUSTED_ADMIN_POSITION_SETTING),
    ]);
    const preferences = resolvePreferences(savedSettings);
    this.configureAudio(preferences);
    if (typeof document !== 'undefined') this.audio.bindGesture(document);
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
      signal: undefined,
    }));
    if (!demo) await this.startGps(session);
    void navigator.storage?.persist?.().catch(() => false);
    void this.acquireWakeLock();
    return session;
  }

  async endSession(): Promise<void> {
    const recorder = this.#recorder;
    if (!recorder) return;
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
    this.store.set({
      activeTarget: session.targetSnapshot,
      activeSession: session,
      resumeCandidate: undefined,
      receptions: [],
      fixes: [],
      events,
      cells: [],
      estimate: undefined,
      ...deriveApproachState(
        events,
        undefined,
        session.settings.maxGpsAccuracyM,
        Date.now(),
        receptions,
      ),
      signal: undefined,
    });
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
      return {
        events,
        ...deriveApproachState(
          events,
          state.estimate,
          recorder.session.settings.maxGpsAccuracyM,
          now,
          state.receptions,
        ),
      };
    });
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

  async discover(): Promise<void> {
    this.requireRepository();
    const discovery = this.#discovery;
    const session = this.store.value.activeSession;
    if (!discovery || !session) throw new Error('Connect a radio and start a session before discovery.');
    const run = discovery.start();
    await this.repository.addEvent({ sessionId: session.id, t: Date.now(), type: 'discovery-cmd', data: { tag: run.tag } });
    const result = await run.done;
    this.notice('info', `Discovery window complete: ${result.responses.length} response${result.responses.length === 1 ? '' : 's'}.`);
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
      const events = archive.events.map((event) => ({
        ...structuredClone(event),
        sessionId: newId,
      }));
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
    this.notice('success', `Imported ${archive.receptions.length} receptions for review.`);
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
    await this.stopGps();
    this.#recorder?.dispose();
    this.#recorder = undefined;
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
    this.notice('success', 'Settings saved. Cell-size changes apply to the next session.');
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

  dismissNotice(id: string): void {
    this.store.set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
  }

  notice(kind: Notice['kind'], message: string, action?: Notice['action']): void {
    const notice: Notice = { id: uniqueId('notice'), kind, message, action };
    this.store.set((state) => ({ notices: [...state.notices.slice(-3), notice] }));
    if (kind === 'success' || kind === 'info') setTimeout(() => this.dismissNotice(notice.id), 5_000);
  }

  async destroy(): Promise<void> {
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
    const device = new MeshCoreDevice(transport);
    this.#device = device;
    this.#discovery = new DiscoveryCoordinator(async (command) => {
      await device.commands.send(command, null, { label: 'DISCOVERY' });
    });
    this.#removeDevicePush = device.onPush((frame) => this.handleCompanionPush(frame));
    try {
      const snapshot = await device.connect();
      await this.applyDeviceSnapshot(snapshot);
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
    this.store.set((state) => ({
      activeSession: snapshot.session,
      receptions: [...snapshot.receptions],
      fixes: [...snapshot.fixes],
      estimate: snapshot.estimate,
      ...approach,
      cells: [...snapshot.cells],
      signal: snapshot.signal,
      sessions: state.sessions.map((session) => session.id === snapshot.session.id ? snapshot.session : session),
    }));
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
    return {
      session,
      receptions,
      fixes,
      events,
      cells,
      estimate,
      bearingConsensus: approach.bearingConsensus,
      finalApproach: approach.finalApproach,
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

  private async cleanupTransport(): Promise<void> {
    this.#removeReplayEvent?.();
    this.#removeReplayEvent = undefined;
    this.#removeDevicePush?.();
    this.#removeDevicePush = undefined;
    this.#removeTransportState?.();
    this.#removeTransportState = undefined;
    this.#discovery?.cancel('Transport replaced');
    this.#discovery = undefined;
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
    const lostConnection = previous === 'connected'
      && (connection === 'reconnecting' || connection === 'disconnected');
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
    if (pickerFreeReconnect && this.#device) void this.rehydrateAfterReconnect(this.#device);
  }

  private async rehydrateAfterReconnect(device: MeshCoreDevice): Promise<void> {
    try {
      const snapshot = await device.rehydrate();
      if (this.#device !== device) return;
      await this.applyDeviceSnapshot(snapshot);
      this.notice('success', 'Companion protocol restored after Bluetooth reconnect.');
    } catch (error) {
      if (this.#device !== device) return;
      this.notice('error', `Bluetooth reconnected, but the MeshCore session could not be restored: ${this.errorMessage(error)}`);
      await this.cleanupTransport();
    }
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
