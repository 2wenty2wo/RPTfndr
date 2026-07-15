import {
  classify,
  classifyDiscovery,
  CompanionOpcode,
  decoderAdapter,
  hexToBytes,
  parseCompanionFrame,
  signedByte,
  targetBytes,
  bytesToHex,
  type CompanionFrame,
  type IdentityUniverse,
} from '../meshcore';
import { AreaEstimator, CellAggregator, GpsAssociator } from '../location';
import { SignalPipeline, type SignalSnapshot } from '../signal';
import { DebouncedSessionWriter, type FinderRepository } from '../storage';
import type {
  AreaEstimate,
  CellAggregate,
  GpsFix,
  Reception,
  SearchSession,
  TargetProfile,
} from '../types';

export interface RecorderSnapshot {
  session: SearchSession;
  receptions: readonly Reception[];
  fixes: readonly GpsFix[];
  estimate?: AreaEstimate;
  cells: readonly CellAggregate[];
  signal: SignalSnapshot;
}

export interface SessionRecorderOptions {
  repository: FinderRepository;
  session: SearchSession;
  universe: IdentityUniverse;
  now?: () => number;
  onUpdate?: (snapshot: RecorderSnapshot) => void;
  onCollision?: (prefixes: readonly string[]) => void;
}

interface DuplicateEntry {
  t: number;
  id?: number;
}

const DUPLICATE_TTL_MS = 10 * 60_000;
const DUPLICATE_LIMIT = 512;

/**
 * Lossless frame-to-storage fan-out. Classification failures are data, not
 * control-flow failures: every RX/discovery frame is appended immediately.
 */
export class SessionRecorder {
  readonly universe: IdentityUniverse;
  readonly gps = new GpsAssociator();
  readonly signal: SignalPipeline;
  readonly cells: CellAggregator;
  readonly estimator: AreaEstimator;

  #session: SearchSession;
  readonly #repository: FinderRepository;
  readonly #writer: DebouncedSessionWriter;
  readonly #now: () => number;
  readonly #onUpdate?: SessionRecorderOptions['onUpdate'];
  readonly #onCollision?: SessionRecorderOptions['onCollision'];
  readonly #receptions: Reception[] = [];
  readonly #fixes: GpsFix[] = [];
  readonly #duplicates = new Map<string, DuplicateEntry>();
  #estimate?: AreaEstimate;
  #lastArrival?: number;
  #closed = false;
  #disposed = false;
  #reclassifying = false;
  #suppressUniverseGrowth = false;
  #operationChain: Promise<void> = Promise.resolve();
  readonly #removeGrowthListener: () => void;
  readonly #removeEstimateListener: () => void;

  constructor(options: SessionRecorderOptions) {
    this.#repository = options.repository;
    this.#session = structuredClone(options.session);
    this.universe = options.universe;
    this.#now = options.now ?? Date.now;
    this.#onUpdate = options.onUpdate;
    this.#onCollision = options.onCollision;
    this.#writer = new DebouncedSessionWriter(this.#repository);
    this.signal = new SignalPipeline({
      mode: this.#session.mode,
      smoothingWindow: this.#session.settings.smoothingWindow,
      emaAlpha: this.#session.settings.emaAlpha,
      calibration: this.#session.calibration,
    });
    this.cells = new CellAggregator({
      mode: this.#session.mode,
      cellSizeM: this.#session.settings.cellSizeM,
      maxGpsAccuracyM: this.#session.settings.maxGpsAccuracyM,
      liveView: true,
    });
    this.estimator = new AreaEstimator({
      minSamples: this.#session.settings.minSamples,
      minCells: this.#session.settings.minCells,
    });
    this.#removeEstimateListener = this.estimator.subscribe((estimate) => {
      this.#estimate = estimate;
      this.emit();
    });
    this.#removeGrowthListener = this.universe.onGrowth((change) => {
      if (change.newCollisionPrefixes.length === 0 || this.#suppressUniverseGrowth) return;
      this.#onCollision?.(change.newCollisionPrefixes);
      void this.reclassifyStored().catch((error: unknown) => {
        this.#writer.lastError = error;
      });
    });
  }

  get session(): SearchSession {
    return structuredClone(this.#session);
  }

  snapshot(): RecorderSnapshot {
    return {
      session: this.session,
      receptions: this.#receptions.map((item) => structuredClone(item)),
      fixes: this.#fixes.map((item) => ({ ...item })),
      estimate: this.#estimate ? structuredClone(this.#estimate) : undefined,
      cells: this.cells.values(),
      signal: this.signal.snapshot(this.#now()),
    };
  }

  async restore(receptions: readonly Reception[], fixes: readonly GpsFix[]): Promise<void> {
    return this.enqueue(() => this.restoreNow(receptions, fixes));
  }

  private async restoreNow(receptions: readonly Reception[], fixes: readonly GpsFix[]): Promise<void> {
    if (this.#closed) throw new Error('Cannot restore into a closed session');
    this.#receptions.length = 0;
    this.#fixes.length = 0;
    this.#duplicates.clear();
    this.cells.clear();
    this.signal.reset();
    for (const fix of fixes) {
      const clone = { ...fix };
      this.#fixes.push(clone);
      this.gps.add(clone);
    }
    for (const reception of receptions) {
      const clone = structuredClone(reception);
      this.#receptions.push(clone);
      if (clone.decoded?.hashHex) this.rememberDuplicate(clone.decoded.hashHex, clone.t, clone.id);
      this.signal.addReception(clone);
      this.cells.addReception(clone);
    }
    this.estimator.update(this.cells.values());
    this.emit();
  }

  async ingestRawFrame(
    raw: Uint8Array,
    arrivalTime = this.#now(),
    discoveryValidated = false,
  ): Promise<Reception | undefined> {
    return this.ingestFrame(parseCompanionFrame(raw), arrivalTime, discoveryValidated);
  }

  async ingestFrame(
    frame: CompanionFrame,
    arrivalTime = this.#now(),
    discoveryValidated = false,
  ): Promise<Reception | undefined> {
    return this.enqueue(() => this.ingestFrameNow(frame, arrivalTime, discoveryValidated));
  }

  private async ingestFrameNow(
    frame: CompanionFrame,
    arrivalTime: number,
    discoveryValidated: boolean,
  ): Promise<Reception | undefined> {
    if (this.#closed) throw new Error('Cannot record into a closed session');
    await this.recordSuspensionGap(arrivalTime);
    this.#lastArrival = arrivalTime;
    const invalidRadioFrame = frame.kind === 'invalid' && [
      CompanionOpcode.RxLog,
      CompanionOpcode.RxPacket,
      CompanionOpcode.ControlData,
    ].includes(frame.opcode as 0x84 | 0x88 | 0x8e);
    if (frame.kind !== 'rx' && frame.kind !== 'discovery-response' && !invalidRadioFrame) return undefined;

    let reception: Reception;
    if (frame.kind === 'invalid') {
      const cls = classify({
        decodeError: `Invalid companion radio frame: ${frame.reason}`,
        target: this.#session.targetSnapshot,
        universe: this.universe,
      });
      reception = {
        sessionId: this.#session.id,
        t: arrivalTime,
        source: 'rx',
        opcode: frame.opcode,
        frameHex: bytesToHex(frame.raw),
        rssi: signedByte(frame.raw[2] ?? 0),
        snr: signedByte(frame.raw[1] ?? 0) / 4,
        companionPathLen: frame.raw[3],
        decodeError: frame.reason,
        cls,
        conf: 0,
        gps: this.gps.associate(arrivalTime),
      };
    } else if (frame.kind === 'rx') {
      const decoded = decoderAdapter.decode(frame.loraHex);
      if (decoded.ok) {
        const packet = decoded.packet;
        if (frame.companionPathLen !== undefined && frame.companionPathLen !== packet.path.length) {
          packet.warnings.push(`Companion path length ${frame.companionPathLen} differs from decoded path length ${packet.path.length}; decoder path used.`);
        }
        if (packet.advert) this.universe.observe(packet.advert.pubkeyHex, packet.advert.name);
        if (packet.anonSenderPubkeyHex) this.universe.observe(packet.anonSenderPubkeyHex);
      }
      const cls = decoded.ok
        ? classify({ packet: decoded.packet, target: this.#session.targetSnapshot, universe: this.universe })
        : classify({ decodeError: decoded.error, target: this.#session.targetSnapshot, universe: this.universe });
      const dupOf = decoded.ok ? this.duplicateOf(decoded.packet.hashHex, arrivalTime) : undefined;
      reception = {
        sessionId: this.#session.id,
        t: arrivalTime,
        source: 'rx',
        opcode: frame.opcode,
        frameHex: bytesToHex(frame.raw),
        loraHex: frame.loraHex,
        rssi: frame.rssi,
        snr: frame.snr,
        companionPathLen: frame.companionPathLen,
        decoded: decoded.ok ? decoded.packet : undefined,
        decodeError: decoded.ok ? undefined : decoded.error,
        cls,
        conf: cls.confirmed ? 1 : 0,
        gps: this.gps.associate(arrivalTime),
        dupOf,
      };
    } else {
      if (discoveryValidated) this.universe.observe(frame.pubkeyHex, undefined, 'discovery');
      const cls = discoveryValidated
        ? classifyDiscovery({ response: frame, target: this.#session.targetSnapshot, universe: this.universe })
        : {
            kind: 'UNKNOWN_TRANSMITTER' as const,
            confirmed: false,
            explanation: 'The discovery response did not match an active request tag and time window, so it is retained only as raw diagnostic data.',
            identityTier: 'none' as const,
            flags: {},
          };
      reception = {
        sessionId: this.#session.id,
        t: arrivalTime,
        source: 'discovery',
        opcode: frame.opcode,
        frameHex: bytesToHex(frame.raw),
        rssi: frame.rssi,
        snr: frame.snr,
        uplinkSnr: frame.uplinkSnr,
        companionPathLen: frame.pathLength,
        cls,
        conf: cls.confirmed ? 1 : 0,
        gps: this.gps.associate(arrivalTime),
      };
    }

    const id = await this.#repository.addReception(reception);
    reception.id = id;
    this.#receptions.push(reception);
    if (reception.decoded?.hashHex) this.rememberDuplicate(reception.decoded.hashHex, arrivalTime, id);
    this.updateSessionForReception(reception);
    this.signal.addReception(reception);
    this.cells.addReception(reception);
    this.estimator.update(this.cells.values());
    this.#writer.queue(this.#session);
    this.emit();
    return reception;
  }

  async addFix(fix: GpsFix): Promise<GpsFix> {
    return this.enqueue(() => this.addFixNow(fix));
  }

  private async addFixNow(fix: GpsFix): Promise<GpsFix> {
    if (this.#closed) throw new Error('Cannot add GPS fixes to a closed session');
    const stored: GpsFix = { ...fix, sessionId: this.#session.id, acceptedNum: fix.accepted ? 1 : 0 };
    stored.id = await this.#repository.addFix(stored);
    this.#fixes.push(stored);
    if (stored.accepted) this.gps.add(stored);
    if (stored.accepted) this.#session.counters.fixesAccepted += 1;
    else this.#session.counters.fixesRejected += 1;
    this.#writer.queue(this.#session);
    this.emit();
    return stored;
  }

  async setCurrentAsWeak(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.#closed || !this.signal.setCurrentAsWeak()) return false;
      this.#session.calibration = this.signal.getCalibration();
      this.#writer.queue(this.#session);
      this.emit();
      return true;
    });
  }

  async setCurrentAsStrong(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.#closed || !this.signal.setCurrentAsStrong()) return false;
      this.#session.calibration = this.signal.getCalibration();
      this.#writer.queue(this.#session);
      this.emit();
      return true;
    });
  }

  updateDevice(device: NonNullable<SearchSession['device']>): void {
    void this.enqueue(async () => {
      if (this.#closed) return;
      this.#session.device = { ...device };
      this.#writer.queue(this.#session);
      this.emit();
    }).catch((error: unknown) => {
      this.#writer.lastError = error;
    });
  }

  async updateAutomationSettings(settings: Pick<
    SearchSession['settings'],
    | 'smartWardriveEnabled'
    | 'autoDiscoveryEnabled'
    | 'autoDiscoveryIntervalSec'
    | 'observerAssistEnabled'
    | 'observerPollIntervalMin'
  >): Promise<void> {
    return this.enqueue(async () => {
      if (this.#closed) return;
      this.#session.settings = { ...this.#session.settings, ...settings };
      this.#writer.queue(this.#session);
      this.emit();
    });
  }

  async updateTargetMetadata(target: TargetProfile): Promise<void> {
    return this.enqueue(async () => {
      const current = this.#session.targetSnapshot;
      const identityChanged = current.identity.kind !== target.identity.kind
        || targetBytes(current.identity) !== targetBytes(target.identity)
        || (current.identity.kind === 'name-only' && current.identity.name !== target.identity.name);
      if (target.id !== current.id || identityChanged) {
        throw new Error('Metadata updates cannot change the active session target identity');
      }
      this.#session.targetSnapshot = structuredClone(target);
      this.#writer.queue(this.#session);
      this.emit();
    });
  }

  async updateTarget(target: TargetProfile): Promise<void> {
    return this.enqueue(() => this.updateTargetNow(target));
  }

  private async updateTargetNow(target: TargetProfile): Promise<void> {
    await this.#writer.flush();
    this.#session.targetSnapshot = structuredClone(target);
    await this.#repository.putSession(this.#session);
    this.#suppressUniverseGrowth = true;
    try {
      this.universe.addTarget(target);
    } finally {
      this.#suppressUniverseGrowth = false;
    }
    await this.reclassifyStoredNow();
  }

  async pause(): Promise<void> {
    return this.enqueue(async () => {
      if (this.#closed) return;
      this.#session.state = 'paused';
      await this.#repository.addEvent({ sessionId: this.#session.id, t: this.#now(), type: 'lifecycle', data: { state: 'paused' } });
      await this.flushWriter();
      this.emit();
    });
  }

  async resume(): Promise<void> {
    return this.enqueue(async () => {
      if (this.#closed) return;
      this.#session.state = 'active';
      await this.#repository.addEvent({ sessionId: this.#session.id, t: this.#now(), type: 'lifecycle', data: { state: 'active' } });
      await this.flushWriter();
      this.emit();
    });
  }

  async end(): Promise<void> {
    return this.enqueue(() => this.endNow());
  }

  private async endNow(): Promise<void> {
    if (this.#closed) return;
    this.#session.state = 'ended';
    this.#session.endedAt = this.#now();
    await this.#repository.addEvent({ sessionId: this.#session.id, t: this.#session.endedAt, type: 'lifecycle', data: { state: 'ended' } });
    this.#closed = true;
    await this.flushWriter();
    this.dispose();
  }

  async flush(): Promise<void> {
    return this.enqueue(() => this.flushWriter());
  }

  /**
   * Stop accepting capture work and drain the debounced session snapshot before
   * its database connection is closed or replaced.
   */
  async shutdown(): Promise<void> {
    return this.enqueue(async () => {
      this.#closed = true;
      try {
        await this.#writer.close();
      } finally {
        this.dispose();
      }
    });
  }

  private async flushWriter(): Promise<void> {
    await this.#writer.flush();
    await this.#repository.putSession(this.#session);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeGrowthListener();
    this.#removeEstimateListener();
    this.estimator.cancel();
  }

  async reclassifyStored(): Promise<void> {
    return this.enqueue(() => this.reclassifyStoredNow());
  }

  private async reclassifyStoredNow(): Promise<void> {
    if (this.#reclassifying) return;
    this.#reclassifying = true;
    try {
      // Drain any older debounced snapshot before counters are reconciled so
      // it cannot overwrite the reconciled session after reclassification.
      await this.#writer.flush();
      const reclassified = this.#receptions.map((stored) => {
        const reception = structuredClone(stored);
        if (reception.source === 'rx') {
          reception.cls = classify({
            packet: reception.decoded,
            decodeError: reception.decodeError,
            target: this.#session.targetSnapshot,
            universe: this.universe,
          });
        } else if (reception.cls.flags.viaDiscovery) {
          const parsed = parseCompanionFrame(hexToBytes(reception.frameHex));
          if (parsed.kind === 'discovery-response') {
            reception.cls = classifyDiscovery({
              response: parsed,
              target: this.#session.targetSnapshot,
              universe: this.universe,
            });
          }
        }
        reception.conf = reception.cls.confirmed ? 1 : 0;
        return reception;
      });
      const nextSession = this.reconcileInMemory(reclassified);
      await this.#repository.replaceSessionClassifications(nextSession, reclassified);

      this.#session = nextSession;
      this.#receptions.splice(0, this.#receptions.length, ...reclassified);
      this.cells.clear();
      this.signal.reset();
      for (const reception of this.#receptions) {
        this.signal.addReception(reception);
        this.cells.addReception(reception);
      }
      this.estimator.update(this.cells.values());
      this.emit();
    } finally {
      this.#reclassifying = false;
    }
  }

  private updateSessionForReception(reception: Reception): void {
    const counters = this.#session.counters;
    counters.receptions += 1;
    if (reception.cls.confirmed) {
      counters.confirmed += 1;
      if (reception.gps.status === 'ok') counters.located += 1;
      const best = this.#session.bestConfirmed;
      if (!best || reception.rssi > best.rssi) {
        this.#session.bestConfirmed = { t: reception.t, rssi: reception.rssi, snr: reception.snr, receptionId: reception.id };
      }
    }
    if (reception.cls.kind === 'DECODE_FAILED') counters.decodeFailed += 1;
    if (reception.source === 'discovery') counters.discoveries += 1;
  }

  private reconcileInMemory(receptions: readonly Reception[]): SearchSession {
    let confirmed = 0;
    let located = 0;
    let decodeFailed = 0;
    let discoveries = 0;
    let bestConfirmed: SearchSession['bestConfirmed'];
    for (const reception of receptions) {
      if (reception.conf === 1 && reception.cls.confirmed) {
        confirmed += 1;
        if (reception.gps.status === 'ok') located += 1;
        if (
          !bestConfirmed
          || reception.rssi > bestConfirmed.rssi
          || (reception.rssi === bestConfirmed.rssi && reception.t < bestConfirmed.t)
        ) {
          bestConfirmed = {
            t: reception.t,
            rssi: reception.rssi,
            snr: reception.snr,
            ...(reception.id === undefined ? {} : { receptionId: reception.id }),
          };
        }
      }
      if (reception.cls.kind === 'DECODE_FAILED' || reception.decodeError !== undefined) decodeFailed += 1;
      if (reception.source === 'discovery') discoveries += 1;
    }
    const fixesAccepted = this.#fixes.filter((fix) => fix.acceptedNum === 1 && fix.accepted).length;
    return {
      ...this.#session,
      counters: {
        receptions: receptions.length,
        confirmed,
        located,
        fixesAccepted,
        fixesRejected: this.#fixes.length - fixesAccepted,
        decodeFailed,
        discoveries,
      },
      ...(bestConfirmed ? { bestConfirmed } : { bestConfirmed: undefined }),
    };
  }

  private duplicateOf(hash: string, t: number): number | undefined {
    this.pruneDuplicates(t);
    const previous = this.#duplicates.get(hash);
    return previous && t - previous.t <= DUPLICATE_TTL_MS ? previous.id : undefined;
  }

  private rememberDuplicate(hash: string, t: number, id?: number): void {
    this.#duplicates.delete(hash);
    this.#duplicates.set(hash, { t, id });
    this.pruneDuplicates(t);
  }

  private pruneDuplicates(now: number): void {
    for (const [hash, entry] of this.#duplicates) {
      if (now - entry.t <= DUPLICATE_TTL_MS && this.#duplicates.size <= DUPLICATE_LIMIT) break;
      this.#duplicates.delete(hash);
    }
  }

  private async recordSuspensionGap(now: number): Promise<void> {
    if (this.#lastArrival !== undefined && now - this.#lastArrival > 60_000) {
      await this.#repository.addEvent({
        sessionId: this.#session.id,
        t: now,
        type: 'suspension-gap',
        data: { durationMs: now - this.#lastArrival },
      });
    }
  }

  private emit(): void {
    this.#onUpdate?.(this.snapshot());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationChain.then(operation, operation);
    this.#operationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export default SessionRecorder;
