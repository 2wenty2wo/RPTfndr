export type MatcherDecision = 'consume' | 'done' | 'no';

export interface ResponseMatcher {
  accept(frame: Uint8Array): MatcherDecision;
}
export interface SendOptions {
  label: string;
  timeoutMs: number;
}

export interface CommandQueueState {
  activeLabel?: string;
  activeSince?: number;
  queued: number;
  matchedFrames: number;
}

interface PendingCommand {
  command: Uint8Array;
  matcher: ResponseMatcher | null;
  options: SendOptions;
  frames: Uint8Array[];
  resolve: (frames: Uint8Array[]) => void;
  reject: (error: Error) => void;
  activeSince?: number;
  timeout?: ReturnType<typeof setTimeout>;
  writeDone: boolean;
  responseDone: boolean;
  cancelled: boolean;
}

export class CommandTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} timed out after ${timeoutMs} ms`);
    this.name = 'CommandTimeoutError';
  }
}

export class CommandCancelledError extends Error {
  constructor(message = 'Command queue cancelled') {
    super(message);
    this.name = 'CommandCancelledError';
  }
}

/**
 * Serializes companion commands while allowing unsolicited pushes to continue
 * through the same notification channel.
 */
export class CommandQueue {
  private readonly waiting: PendingCommand[] = [];
  private readonly pushListeners = new Set<(frame: Uint8Array) => void>();
  private active?: PendingCommand;

  constructor(private readonly write: (command: Uint8Array) => Promise<void>) {}

  send(
    command: Uint8Array,
    matcher: ResponseMatcher | null,
    options: Partial<SendOptions> & Pick<SendOptions, 'label'>,
  ): Promise<Uint8Array[]> {
    const normalizedOptions: SendOptions = {
      label: options.label,
      timeoutMs: options.timeoutMs ?? 5_000,
    };
    if (!Number.isFinite(normalizedOptions.timeoutMs) || normalizedOptions.timeoutMs <= 0) {
      return Promise.reject(new RangeError('Command timeout must be greater than zero'));
    }

    return new Promise<Uint8Array[]>((resolve, reject) => {
      this.waiting.push({
        command: command.slice(),
        matcher,
        options: normalizedOptions,
        frames: [],
        resolve,
        reject,
        writeDone: false,
        responseDone: false,
        cancelled: false,
      });
      this.pump();
    });
  }

  /** Route every transport notification through this method exactly once. */
  handleFrame(input: Uint8Array): void {
    const frame = input.slice();
    const active = this.active;
    if (!active || active.cancelled || !active.matcher || active.responseDone) {
      this.emitPush(frame);
      return;
    }

    let decision: MatcherDecision;
    try {
      decision = active.matcher.accept(frame);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.fail(active, new Error(`${active.options.label} response matcher failed: ${message}`));
      return;
    }

    if (decision === 'no') {
      this.emitPush(frame);
      return;
    }

    active.frames.push(frame);
    if (decision === 'done') {
      active.responseDone = true;
      if (active.writeDone) this.succeed(active);
    }
  }

  onPush(listener: (frame: Uint8Array) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  state(): CommandQueueState {
    return {
      activeLabel: this.active?.options.label,
      activeSince: this.active?.activeSince,
      queued: this.waiting.length,
      matchedFrames: this.active?.frames.length ?? 0,
    };
  }

  cancelAll(reason: string | Error = 'Command queue cancelled'): void {
    const error =
      reason instanceof Error
        ? reason
        : new CommandCancelledError(reason);
    const active = this.active;
    this.active = undefined;
    if (active) {
      active.cancelled = true;
      if (active.timeout) clearTimeout(active.timeout);
      active.reject(error);
    }
    for (const pending of this.waiting.splice(0)) {
      pending.cancelled = true;
      pending.reject(error);
    }
  }

  private pump(): void {
    if (this.active) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.active = next;
    next.activeSince = Date.now();

    void this.write(next.command.slice()).then(
      () => {
        if (next.cancelled || this.active !== next) return;
        next.writeDone = true;
        if (!next.matcher || next.responseDone) {
          this.succeed(next);
          return;
        }
        next.timeout = setTimeout(() => {
          this.fail(next, new CommandTimeoutError(next.options.label, next.options.timeoutMs));
        }, next.options.timeoutMs);
      },
      (cause: unknown) => {
        if (next.cancelled || this.active !== next) return;
        const detail = cause instanceof Error ? cause.message : String(cause);
        this.fail(next, new Error(`${next.options.label} write failed: ${detail}`));
      },
    );
  }

  private succeed(command: PendingCommand): void {
    if (this.active !== command || command.cancelled) return;
    if (command.timeout) clearTimeout(command.timeout);
    this.active = undefined;
    command.resolve(command.frames.map((frame) => frame.slice()));
    this.pump();
  }

  private fail(command: PendingCommand, error: Error): void {
    if (this.active !== command || command.cancelled) return;
    command.cancelled = true;
    if (command.timeout) clearTimeout(command.timeout);
    this.active = undefined;
    command.reject(error);
    this.pump();
  }

  private emitPush(frame: Uint8Array): void {
    for (const listener of this.pushListeners) listener(frame.slice());
  }
}

export function opcodeMatcher(opcode: number): ResponseMatcher {
  return {
    accept: (frame) => (frame[0] === opcode ? 'done' : 'no'),
  };
}

/** Matches 0x02 start, zero or more 0x03 records, then 0x04 end. */
export function contactsStreamMatcher(): ResponseMatcher {
  let started = false;
  return {
    accept(frame) {
      if (frame[0] === 0x02) {
        started = true;
        return 'consume';
      }
      if (!started) return 'no';
      if (frame[0] === 0x03) return 'consume';
      if (frame[0] === 0x04) return 'done';
      return 'no';
    },
  };
}
