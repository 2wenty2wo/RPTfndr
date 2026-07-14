import type { ResponseMatcher } from './commands';
import {
  parseCompanionFrame,
  type CompanionFrame,
  type DiscoveryResponseFrame,
} from './frames';

export const DISCOVERY_WINDOW_MS = 2_000;
export const DISCOVERY_COOLDOWN_MS = 5_000;

export function buildDiscoveryCommand(filterMask: number, tag: number): Uint8Array {
  const normalizedTag = tag >>> 0;
  return Uint8Array.of(
    0x37,
    0x80,
    filterMask & 0x0f,
    normalizedTag & 0xff,
    (normalizedTag >>> 8) & 0xff,
    (normalizedTag >>> 16) & 0xff,
    (normalizedTag >>> 24) & 0xff,
  );
}
export function randomDiscoveryTag(): number {
  const values = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(values);
    return values[0] ?? 0;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

export interface DiscoveryResult {
  tag: number;
  startedAt: number;
  endedAt: number;
  responses: DiscoveryResponseFrame[];
}

export interface DiscoveryRun {
  tag: number;
  command: Uint8Array;
  done: Promise<DiscoveryResult>;
}

export interface DiscoveryCoordinatorOptions {
  windowMs?: number;
  cooldownMs?: number;
  now?: () => number;
  nextTag?: () => number;
}

interface ActiveDiscovery {
  tag: number;
  command: Uint8Array;
  startedAt: number;
  deadline: number;
  responses: DiscoveryResponseFrame[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: DiscoveryResult) => void;
  reject: (error: Error) => void;
}

export class DiscoveryCooldownError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Discovery is cooling down; retry in ${Math.ceil(retryAfterMs)} ms`);
    this.name = 'DiscoveryCooldownError';
  }
}

/** Owns tag correlation and the finite discovery response window. */
export class DiscoveryCoordinator {
  private readonly now: () => number;
  private readonly nextTag: () => number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private active?: ActiveDiscovery;
  private nextAllowedAt = 0;

  constructor(
    private readonly send: (command: Uint8Array) => Promise<unknown>,
    options: DiscoveryCoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.nextTag = options.nextTag ?? randomDiscoveryTag;
    this.windowMs = options.windowMs ?? DISCOVERY_WINDOW_MS;
    this.cooldownMs = options.cooldownMs ?? DISCOVERY_COOLDOWN_MS;
  }

  start(filterMask = 0x0f): DiscoveryRun {
    const startedAt = this.now();
    if (this.active) throw new Error('A discovery window is already active');
    if (startedAt < this.nextAllowedAt) {
      throw new DiscoveryCooldownError(this.nextAllowedAt - startedAt);
    }

    const tag = this.nextTag() >>> 0;
    const command = buildDiscoveryCommand(filterMask, tag);
    let resolve!: (result: DiscoveryResult) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<DiscoveryResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(() => this.finish(tag), this.windowMs);
    this.active = {
      tag,
      command,
      startedAt,
      deadline: startedAt + this.windowMs,
      responses: [],
      timer,
      resolve,
      reject,
    };

    void this.send(command.slice()).catch((cause: unknown) => {
      if (this.active?.tag !== tag) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.abort(new Error(`Discovery command failed: ${message}`));
    });
    return { tag, command: command.slice(), done };
  }

  /** Returns true only when a valid response belongs to the active tag/window. */
  ingest(input: Uint8Array | CompanionFrame): boolean {
    const parsed = input instanceof Uint8Array ? parseCompanionFrame(input) : input;
    const active = this.active;
    if (!active || parsed.kind !== 'discovery-response') return false;
    if (this.now() > active.deadline || parsed.tag !== active.tag) return false;
    active.responses.push({ ...parsed, raw: parsed.raw.slice() });
    return true;
  }

  state(): { activeTag?: number; responseCount: number; nextAllowedAt: number } {
    return {
      activeTag: this.active?.tag,
      responseCount: this.active?.responses.length ?? 0,
      nextAllowedAt: this.nextAllowedAt,
    };
  }

  cancel(reason = 'Discovery cancelled'): void {
    this.abort(new Error(reason));
  }

  private finish(tag: number): void {
    const active = this.active;
    if (!active || active.tag !== tag) return;
    clearTimeout(active.timer);
    this.active = undefined;
    const endedAt = this.now();
    this.nextAllowedAt = endedAt + this.cooldownMs;
    active.resolve({
      tag,
      startedAt: active.startedAt,
      endedAt,
      responses: active.responses.map((response) => ({ ...response, raw: response.raw.slice() })),
    });
  }

  private abort(error: Error): void {
    const active = this.active;
    if (!active) return;
    clearTimeout(active.timer);
    this.active = undefined;
    this.nextAllowedAt = this.now() + this.cooldownMs;
    active.reject(error);
  }
}

/** Useful when discovery is routed through a queue controlled by a higher layer. */
export function discoveryTagMatcher(tag: number): ResponseMatcher {
  const expected = tag >>> 0;
  return {
    accept(frame) {
      const parsed = parseCompanionFrame(frame);
      return parsed.kind === 'discovery-response' && parsed.tag === expected ? 'consume' : 'no';
    },
  };
}
