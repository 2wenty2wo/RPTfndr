export const WRITER_LOCK_NAME = 'mcf-writer';

interface LockToken {
  readonly name?: string;
}
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true; signal?: AbortSignal },
    callback: (lock: LockToken | null) => Promise<T> | T,
  ): Promise<T>;
}

export interface WriterLease {
  readonly name: string;
  readonly acquired: boolean;
  readonly readOnly: boolean;
  /** False means this browser cannot enforce cross-tab exclusion. */
  readonly supported: boolean;
  readonly done: Promise<void>;
  release(): void;
}

export interface AcquireWriterLockOptions {
  name?: string;
  locks?: LockManagerLike | null;
  signal?: AbortSignal;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value): void {
      resolvePromise?.(value);
    },
    reject(reason): void {
      rejectPromise?.(reason);
    },
  };
}

function browserLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined' || !navigator.locks) return null;
  return navigator.locks as unknown as LockManagerLike;
}

/**
 * Acquires the app-wide writer lock without waiting. A contending tab gets a
 * read-only lease. Browsers without Web Locks remain writable but clearly
 * report `supported: false`, allowing the UI to surface the reduced guarantee.
 */
export async function acquireWriterLock(
  options: AcquireWriterLockOptions = {},
): Promise<WriterLease> {
  const name = options.name ?? WRITER_LOCK_NAME;
  const locks = options.locks === undefined ? browserLocks() : options.locks;
  if (!locks) {
    return {
      name,
      acquired: true,
      readOnly: false,
      supported: false,
      done: Promise.resolve(),
      release(): void {},
    };
  }
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('Writer lock request aborted', 'AbortError');
  }

  const acquired = deferred<boolean>();
  const releaseGate = deferred<void>();
  let settled = false;
  const request = locks
    .request(
      name,
      {
        mode: 'exclusive',
        ifAvailable: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      async (lock) => {
        settled = true;
        if (!lock) {
          acquired.resolve(false);
          return;
        }
        acquired.resolve(true);
        await releaseGate.promise;
      },
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      if (!settled) acquired.reject(error);
      throw error;
    });

  const hasLock = await acquired.promise;
  let released = false;
  return {
    name,
    acquired: hasLock,
    readOnly: !hasLock,
    supported: true,
    done: request,
    release(): void {
      if (hasLock && !released) {
        released = true;
        releaseGate.resolve();
      }
    },
  };
}

export class WriterLockCoordinator {
  private lease: WriterLease | undefined;

  async acquire(options: AcquireWriterLockOptions = {}): Promise<WriterLease> {
    if (this.lease) return this.lease;
    this.lease = await acquireWriterLock(options);
    return this.lease;
  }

  release(): void {
    this.lease?.release();
    this.lease = undefined;
  }
}
