import type { GpsFix } from '../types';
import { ObservableTransport } from './transport';

export type ReplaySpeed = 1 | 2 | 10 | 'max';

export type ScriptEvent =
  | { atMs: number; kind: 'frame'; frame: Uint8Array }
  | { atMs: number; kind: 'gps'; fix: GpsFix }
  | { atMs: number; kind: 'drop'; reason?: string }
  | { atMs: number; kind: 'reconnect' };

export interface ReplayTransportOptions {
  speed?: ReplaySpeed;
  loop?: boolean;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export type ReplayGpsListener = (fix: GpsFix) => void;
export type ReplayEventListener = (event: ScriptEvent) => void;
export type ReplayWriteListener = (bytes: Uint8Array) => void;

export class ReplayTransport extends ObservableTransport {
  readonly kind = 'replay' as const;
  readonly dataMode = 'simulated' as const;
  readonly capabilities = { silentReconnect: true } as const;

  private readonly events: ScriptEvent[];
  private readonly loop: boolean;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private readonly gpsListeners = new Set<ReplayGpsListener>();
  private readonly eventListeners = new Set<ReplayEventListener>();
  private readonly completeListeners = new Set<() => void>();
  private readonly writeListeners = new Set<ReplayWriteListener>();

  private playbackSpeed: ReplaySpeed;
  private cursor = 0;
  private virtualPositionMs = 0;
  private anchorRealMs = 0;
  private anchorVirtualMs = 0;
  private playing = false;
  private timer?: ReturnType<typeof globalThis.setTimeout>;

  readonly writes: Uint8Array[] = [];

  constructor(events: readonly ScriptEvent[] = [], options: ReplayTransportOptions = {}) {
    super();
    this.events = normalizeEvents(events);
    this.playbackSpeed = options.speed ?? 1;
    this.loop = options.loop ?? false;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  get speed(): ReplaySpeed {
    return this.playbackSpeed;
  }

  get durationMs(): number {
    return this.events.at(-1)?.atMs ?? 0;
  }

  get positionMs(): number {
    if (!this.playing || this.playbackSpeed === 'max') return this.virtualPositionMs;
    return Math.min(
      this.durationMs,
      this.anchorVirtualMs + (this.now() - this.anchorRealMs) * this.playbackSpeed,
    );
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async connect(): Promise<void> {
    if (this.currentState !== 'connected') {
      this.emitState('connecting');
      await Promise.resolve();
      this.emitState('connected');
    }
    if (this.cursor >= this.events.length) this.seek(0);
    this.resume();
  }

  async disconnect(): Promise<void> {
    this.pause();
    this.emitState('disconnected');
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.currentState !== 'connected') {
      throw new Error('Cannot write: replay transport is not connected.');
    }
    const copy = bytes.slice();
    this.writes.push(copy);
    for (const listener of this.writeListeners) listener(copy.slice());
  }

  onGps(callback: ReplayGpsListener): () => void {
    this.gpsListeners.add(callback);
    return () => this.gpsListeners.delete(callback);
  }

  onScriptEvent(callback: ReplayEventListener): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  onComplete(callback: () => void): () => void {
    this.completeListeners.add(callback);
    return () => this.completeListeners.delete(callback);
  }

  onWrite(callback: ReplayWriteListener): () => void {
    this.writeListeners.add(callback);
    return () => this.writeListeners.delete(callback);
  }

  pause(): void {
    if (!this.playing) return;
    this.virtualPositionMs = this.positionMs;
    this.playing = false;
    this.cancelTimer();
  }

  resume(): void {
    if (this.playing || this.cursor >= this.events.length) return;
    this.playing = true;
    this.reanchor();
    this.scheduleNext();
  }

  restart(): void {
    this.seek(0);
    this.resume();
  }

  seek(atMs: number): void {
    const wasPlaying = this.playing;
    this.cancelTimer();
    this.virtualPositionMs = Math.max(0, Math.min(this.durationMs, atMs));
    this.cursor = lowerBoundEvent(this.events, this.virtualPositionMs);
    this.playing = wasPlaying;
    this.reanchor();
    if (wasPlaying) this.scheduleNext();
  }

  setSpeed(speed: ReplaySpeed): void {
    if (speed !== 'max' && speed !== 1 && speed !== 2 && speed !== 10) {
      throw new RangeError('Replay speed must be 1, 2, 10, or "max".');
    }
    const wasPlaying = this.playing;
    if (wasPlaying) this.virtualPositionMs = this.positionMs;
    this.cancelTimer();
    this.playbackSpeed = speed;
    this.reanchor();
    if (wasPlaying) this.scheduleNext();
  }

  private reanchor(): void {
    this.anchorRealMs = this.now();
    this.anchorVirtualMs = this.virtualPositionMs;
  }

  private scheduleNext(): void {
    if (!this.playing) return;
    const next = this.events[this.cursor];
    if (!next) {
      this.finishPass();
      return;
    }

    const delayMs = this.playbackSpeed === 'max'
      ? 0
      : Math.max(0, (next.atMs - this.positionMs) / this.playbackSpeed);
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      this.dispatchDueEvents();
    }, delayMs);
  }

  private dispatchDueEvents(): void {
    if (!this.playing) return;
    if (this.playbackSpeed === 'max') {
      // Preserve ordering while yielding once per batch to avoid a long replay
      // monopolising the UI thread.
      const end = Math.min(this.events.length, this.cursor + 500);
      while (this.cursor < end) this.dispatch(this.events[this.cursor++]!);
      this.virtualPositionMs = this.events[this.cursor - 1]?.atMs ?? this.virtualPositionMs;
    } else {
      const dueAt = this.events[this.cursor]?.atMs;
      if (dueAt === undefined) {
        this.finishPass();
        return;
      }
      this.virtualPositionMs = dueAt;
      while (this.events[this.cursor]?.atMs === dueAt) {
        this.dispatch(this.events[this.cursor++]!);
      }
    }
    this.reanchor();
    this.scheduleNext();
  }

  private dispatch(event: ScriptEvent): void {
    for (const listener of this.eventListeners) listener(cloneEvent(event));
    switch (event.kind) {
      case 'frame':
        if (this.currentState === 'connected') this.emitFrame(event.frame);
        break;
      case 'gps':
        for (const listener of this.gpsListeners) listener({ ...event.fix });
        break;
      case 'drop':
        this.emitState('disconnected');
        break;
      case 'reconnect':
        this.emitState('reconnecting');
        this.emitState('connected');
        break;
    }
  }

  private finishPass(): void {
    if (this.loop && this.events.length > 0) {
      this.cursor = 0;
      this.virtualPositionMs = 0;
      this.reanchor();
      this.scheduleNext();
      return;
    }
    this.playing = false;
    this.virtualPositionMs = this.durationMs;
    for (const listener of this.completeListeners) listener();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
    this.timer = undefined;
  }
}

export interface ReplayArchiveLike {
  session?: { startedAt?: number };
  receptions?: Array<{ t: number; frameHex: string }>;
  fixes?: GpsFix[];
  events?: Array<{ t: number; type: string; data?: Record<string, unknown> }>;
}

export function replayEventsFromArchive(archive: ReplayArchiveLike): ScriptEvent[] {
  const timestamps = [
    ...(archive.receptions ?? []).map((reception) => reception.t),
    ...(archive.fixes ?? []).map((fix) => fix.t),
  ].filter(Number.isFinite);
  const origin = Number.isFinite(archive.session?.startedAt)
    ? archive.session!.startedAt!
    : timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const result: ScriptEvent[] = [];

  for (const fix of archive.fixes ?? []) {
    result.push({ atMs: Math.max(0, fix.t - origin), kind: 'gps', fix: { ...fix } });
  }
  for (const reception of archive.receptions ?? []) {
    const frame = hexToBytes(reception.frameHex);
    if (frame) result.push({ atMs: Math.max(0, reception.t - origin), kind: 'frame', frame });
  }
  for (const event of archive.events ?? []) {
    if (event.type !== 'lifecycle') continue;
    const action = event.data?.action;
    if (action === 'drop') result.push({ atMs: Math.max(0, event.t - origin), kind: 'drop' });
    if (action === 'reconnect') result.push({ atMs: Math.max(0, event.t - origin), kind: 'reconnect' });
  }
  return normalizeEvents(result);
}

export function createReplayTransportFromArchive(
  archive: ReplayArchiveLike,
  options?: ReplayTransportOptions,
): ReplayTransport {
  return new ReplayTransport(replayEventsFromArchive(archive), options);
}

function normalizeEvents(events: readonly ScriptEvent[]): ScriptEvent[] {
  return events
    .map((event, sequence) => ({ event: cloneEvent(event), sequence }))
    .filter(({ event }) => Number.isFinite(event.atMs) && event.atMs >= 0)
    .sort((a, b) => a.event.atMs - b.event.atMs || a.sequence - b.sequence)
    .map(({ event }) => event);
}

function cloneEvent(event: ScriptEvent): ScriptEvent {
  switch (event.kind) {
    case 'frame': return { ...event, frame: event.frame.slice() };
    case 'gps': return { ...event, fix: { ...event.fix } };
    default: return { ...event };
  }
}

function lowerBoundEvent(events: readonly ScriptEvent[], atMs: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.atMs < atMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}
