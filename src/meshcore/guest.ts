import type { CommandQueue, ResponseMatcher } from './commands';
import { bytesToHex, hexToBytes, signedByte } from './frames';

/**
 * Companion and repeater opcodes used by the conservative guest-observer flow.
 *
 * These values follow MeshCore companion firmware v1.16.0 (main, June 2026).
 * Login deliberately exposes no password-bearing builder: this module can only
 * request the repeater's blank-password guest path.
 */
export const GuestObserverOpcode = {
  Sent: 0x06,
  Error: 0x01,
  Disabled: 0x0f,
  SendLogin: 0x1a,
  SendBinaryRequest: 0x32,
  LoginSuccess: 0x85,
  LoginFail: 0x86,
  BinaryResponse: 0x8c,
} as const;

export const RepeaterRequestType = {
  GetNeighbours: 0x06,
} as const;

export const REPEATER_PUBLIC_KEY_BYTES = 32;
export const NEIGHBOUR_REQUEST_VERSION = 0;
export const NEIGHBOUR_FULL_KEY_BYTES = 32;
export const NEIGHBOUR_RESPONSE_BUFFER_BYTES = 130;
export const NEIGHBOUR_ENTRY_BYTES = NEIGHBOUR_FULL_KEY_BYTES + 4 + 1;
export const MAX_NEIGHBOURS_PER_PAGE = Math.floor(
  NEIGHBOUR_RESPONSE_BUFFER_BYTES / NEIGHBOUR_ENTRY_BYTES,
);

const NEIGHBOUR_REQUEST_PAYLOAD_BYTES = 11;
const BINARY_RESPONSE_HEADER_BYTES = 10;
const MAX_REPORTED_NEIGHBOURS = 4_096;
const MAX_BUFFERED_PUSHES = 16;
const MAX_PUSH_FRAME_BYTES = 512;
const MAX_FETCH_PAGES = 64;
const MAX_FETCH_NEIGHBOURS = 256;

export type RepeaterPublicKey = string | Uint8Array;
export type NeighbourOrder =
  | 'newest-to-oldest'
  | 'oldest-to-newest'
  | 'strongest-to-weakest'
  | 'weakest-to-strongest';

const ORDER_VALUE: Readonly<Record<NeighbourOrder, number>> = {
  'newest-to-oldest': 0,
  'oldest-to-newest': 1,
  'strongest-to-weakest': 2,
  'weakest-to-strongest': 3,
};

export interface ParseSuccess<T> {
  ok: true;
  value: T;
}

export interface ParseFailure {
  ok: false;
  reason: string;
}

export type ProtocolParseResult<T> = ParseSuccess<T> | ParseFailure;

export interface CompanionSentFrame {
  route: 'direct' | 'flood';
  tag: number;
  suggestedTimeoutMs: number;
  raw: Uint8Array;
}

export interface ModernGuestLoginSuccessPush {
  kind: 'login-success';
  legacy: false;
  admin: boolean;
  pubkeyPrefixHex: string;
  serverTimestamp: number;
  aclPermissions: number;
  firmwareLevel: number;
  raw: Uint8Array;
}

export interface LegacyGuestLoginSuccessPush {
  kind: 'login-success';
  legacy: true;
  admin: boolean;
  pubkeyPrefixHex: string;
  raw: Uint8Array;
}

export interface GuestLoginFailPush {
  kind: 'login-fail';
  pubkeyPrefixHex: string;
  raw: Uint8Array;
}

export type GuestLoginPush =
  | ModernGuestLoginSuccessPush
  | LegacyGuestLoginSuccessPush
  | GuestLoginFailPush;

export interface NeighbourObservation {
  /** Full 32-byte public key reported by the observing repeater. */
  pubkeyHex: string;
  /** Age of the repeater's direct observation, in seconds. */
  heardSecondsAgo: number;
  /** Signed quarter-dB wire value converted to dB. */
  snrDb: number;
  rawSnr: number;
}

export interface NeighbourResponsePush {
  tag: number;
  totalCount: number;
  observations: NeighbourObservation[];
  raw: Uint8Array;
}

export interface NeighbourRequestOptions {
  count?: number;
  offset?: number;
  order?: NeighbourOrder;
  /** Four random bytes used by firmware only for packet-hash uniqueness. */
  nonce?: Uint8Array;
}

export interface GuestLoginAccepted {
  accepted: true;
  repeaterPubkeyHex: string;
  route: CompanionSentFrame['route'];
  suggestedTimeoutMs: number;
  /** Successful coordinator authentication is always constrained to guest. */
  admin: false;
  legacy: boolean;
  serverTimestamp?: number;
  aclPermissions?: number;
  firmwareLevel?: number;
}

export interface GuestLoginRejected {
  accepted: false;
  repeaterPubkeyHex: string;
  route: CompanionSentFrame['route'];
  suggestedTimeoutMs: number;
  reason: 'login-denied' | 'admin-session-refused';
  admin?: boolean;
  legacy?: boolean;
}

export type GuestLoginResult = GuestLoginAccepted | GuestLoginRejected;

export interface NeighbourPage {
  repeaterPubkeyHex: string;
  offset: number;
  requestedCount: number;
  order: NeighbourOrder;
  totalCount: number;
  observations: NeighbourObservation[];
  route: CompanionSentFrame['route'];
  suggestedTimeoutMs: number;
  responseTag: number;
}

export type NeighbourFetchTruncation =
  | 'max-pages'
  | 'max-neighbours'
  | 'empty-page'
  | 'offset-limit';

export interface NeighbourFetchResult {
  repeaterPubkeyHex: string;
  order: NeighbourOrder;
  reportedTotalCount: number;
  observations: NeighbourObservation[];
  pagesFetched: number;
  complete: boolean;
  truncatedReason?: NeighbourFetchTruncation;
}

export interface FetchNeighboursOptions {
  pageSize?: number;
  maxPages?: number;
  maxNeighbours?: number;
  order?: NeighbourOrder;
}

export interface GuestObserverCoordinatorOptions {
  commandTimeoutMs?: number;
  pushTimeoutMs?: number;
  maximumPushTimeoutMs?: number;
  randomBytes?: (length: number) => Uint8Array;
}

interface PushWaiter {
  predicate: (frame: Uint8Array) => boolean;
  resolve: (frame: Uint8Array) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class GuestProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestProtocolError';
  }
}

export class GuestCommandError extends GuestProtocolError {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'GuestCommandError';
  }
}

export class GuestPushTimeoutError extends GuestProtocolError {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs} ms`);
    this.name = 'GuestPushTimeoutError';
  }
}

function success<T>(value: T): ParseSuccess<T> {
  return { ok: true, value };
}

function failure(reason: string): ParseFailure {
  return { ok: false, reason };
}

function uint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function uint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function putUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function requireInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Validate and copy a full 32-byte repeater identity. Prefixes are rejected. */
export function requireFullRepeaterPublicKey(input: RepeaterPublicKey): Uint8Array {
  const bytes = typeof input === 'string' ? hexToBytes(input) : input.slice();
  if (bytes.length !== REPEATER_PUBLIC_KEY_BYTES) {
    throw new RangeError(
      `Repeater public key must be exactly ${REPEATER_PUBLIC_KEY_BYTES} bytes (received ${bytes.length})`,
    );
  }
  return bytes;
}

/**
 * Build CMD_SEND_LOGIN with an empty password. There is intentionally no
 * password argument and no fallback/guessing path.
 */
export function buildBlankGuestLoginCommand(repeater: RepeaterPublicKey): Uint8Array {
  const publicKey = requireFullRepeaterPublicKey(repeater);
  const command = new Uint8Array(1 + REPEATER_PUBLIC_KEY_BYTES);
  command[0] = GuestObserverOpcode.SendLogin;
  command.set(publicKey, 1);
  return command;
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (!globalThis.crypto?.getRandomValues) {
    throw new GuestProtocolError('Secure random bytes are unavailable');
  }
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function buildNeighbourRequestPayload(options: NeighbourRequestOptions = {}): Uint8Array {
  const count = requireInteger(
    options.count ?? MAX_NEIGHBOURS_PER_PAGE,
    'Neighbour page size',
    1,
    MAX_NEIGHBOURS_PER_PAGE,
  );
  const offset = requireInteger(options.offset ?? 0, 'Neighbour page offset', 0, 0xffff);
  const order = options.order ?? 'newest-to-oldest';
  const orderValue = ORDER_VALUE[order];
  if (orderValue === undefined) throw new RangeError(`Unsupported neighbour order: ${String(order)}`);
  const nonce = options.nonce?.slice() ?? secureRandomBytes(4);
  if (nonce.length !== 4) throw new RangeError('Neighbour request nonce must contain exactly 4 bytes');

  const payload = new Uint8Array(NEIGHBOUR_REQUEST_PAYLOAD_BYTES);
  payload[0] = RepeaterRequestType.GetNeighbours;
  payload[1] = NEIGHBOUR_REQUEST_VERSION;
  payload[2] = count;
  putUint16LE(payload, 3, offset);
  payload[5] = orderValue;
  payload[6] = NEIGHBOUR_FULL_KEY_BYTES;
  payload.set(nonce, 7);
  return payload;
}

export function buildNeighbourRequestCommand(
  repeater: RepeaterPublicKey,
  options: NeighbourRequestOptions = {},
): Uint8Array {
  const publicKey = requireFullRepeaterPublicKey(repeater);
  const payload = buildNeighbourRequestPayload(options);
  const command = new Uint8Array(1 + REPEATER_PUBLIC_KEY_BYTES + payload.length);
  command[0] = GuestObserverOpcode.SendBinaryRequest;
  command.set(publicKey, 1);
  command.set(payload, 1 + REPEATER_PUBLIC_KEY_BYTES);
  return command;
}

export function parseCompanionSentFrame(input: Uint8Array): ProtocolParseResult<CompanionSentFrame> {
  const raw = input.slice();
  if (raw[0] !== GuestObserverOpcode.Sent) return failure('Not a companion SENT frame');
  if (raw.length !== 10) return failure(`Companion SENT frame must be 10 bytes (received ${raw.length})`);
  const routeFlag = raw[1];
  if (routeFlag !== 0 && routeFlag !== 1) return failure(`Invalid companion SENT route flag ${routeFlag}`);
  return success({
    route: routeFlag === 1 ? 'flood' : 'direct',
    tag: uint32LE(raw, 2),
    suggestedTimeoutMs: uint32LE(raw, 6),
    raw,
  });
}

export function parseGuestLoginPush(input: Uint8Array): ProtocolParseResult<GuestLoginPush> {
  const raw = input.slice();
  if (raw[0] === GuestObserverOpcode.LoginFail) {
    if (raw.length !== 8) return failure(`LOGIN_FAIL push must be 8 bytes (received ${raw.length})`);
    return success({
      kind: 'login-fail',
      pubkeyPrefixHex: bytesToHex(raw.subarray(2, 8)),
      raw,
    });
  }
  if (raw[0] !== GuestObserverOpcode.LoginSuccess) return failure('Not a guest-login push');
  if (raw.length === 8) {
    return success({
      kind: 'login-success',
      legacy: true,
      admin: raw[1] !== 0,
      pubkeyPrefixHex: bytesToHex(raw.subarray(2, 8)),
      raw,
    });
  }
  if (raw.length !== 14) return failure(`Modern LOGIN_SUCCESS push must be 14 bytes (received ${raw.length})`);
  return success({
    kind: 'login-success',
    legacy: false,
    admin: raw[1] !== 0,
    pubkeyPrefixHex: bytesToHex(raw.subarray(2, 8)),
    serverTimestamp: uint32LE(raw, 8),
    aclPermissions: raw[12] ?? 0,
    firmwareLevel: raw[13] ?? 0,
    raw,
  });
}

export function parseNeighbourResponsePush(
  input: Uint8Array,
): ProtocolParseResult<NeighbourResponsePush> {
  const raw = input.slice();
  if (raw[0] !== GuestObserverOpcode.BinaryResponse) return failure('Not a binary-response push');
  if (raw.length < BINARY_RESPONSE_HEADER_BYTES) return failure('Truncated neighbour-response header');
  if (raw.length > MAX_PUSH_FRAME_BYTES) return failure('Neighbour-response frame exceeds the safety limit');

  const totalCount = uint16LE(raw, 6);
  const resultCount = uint16LE(raw, 8);
  if (totalCount > MAX_REPORTED_NEIGHBOURS) {
    return failure(`Neighbour total ${totalCount} exceeds the safety limit`);
  }
  if (resultCount > MAX_NEIGHBOURS_PER_PAGE) {
    return failure(`Full-key neighbour page cannot contain ${resultCount} records`);
  }
  if (resultCount > totalCount) return failure('Neighbour result count exceeds the reported total');
  const expectedLength = BINARY_RESPONSE_HEADER_BYTES + resultCount * NEIGHBOUR_ENTRY_BYTES;
  if (raw.length !== expectedLength) {
    return failure(`Neighbour response must be ${expectedLength} bytes (received ${raw.length})`);
  }

  const observations: NeighbourObservation[] = [];
  let offset = BINARY_RESPONSE_HEADER_BYTES;
  for (let index = 0; index < resultCount; index += 1) {
    const publicKey = raw.subarray(offset, offset + NEIGHBOUR_FULL_KEY_BYTES);
    offset += NEIGHBOUR_FULL_KEY_BYTES;
    const heardSecondsAgo = uint32LE(raw, offset);
    offset += 4;
    const rawSnr = signedByte(raw[offset] ?? 0);
    offset += 1;
    observations.push({
      pubkeyHex: bytesToHex(publicKey),
      heardSecondsAgo,
      snrDb: rawSnr / 4,
      rawSnr,
    });
  }

  return success({
    tag: uint32LE(raw, 2),
    totalCount,
    observations,
    raw,
  });
}

/** Match only the terminal direct reply; asynchronous pushes remain push data. */
export function sentOrErrorMatcher(): ResponseMatcher {
  return {
    accept(frame) {
      return frame[0] === GuestObserverOpcode.Sent ||
        frame[0] === GuestObserverOpcode.Error ||
        frame[0] === GuestObserverOpcode.Disabled
        ? 'done'
        : 'no';
    },
  };
}

/**
 * Serialises complete remote exchanges, including their asynchronous pushes.
 * The controller may construct one coordinator around `MeshCoreDevice.commands`.
 */
export class GuestObserverCoordinator {
  private readonly commandTimeoutMs: number;
  private readonly pushTimeoutMs: number;
  private readonly maximumPushTimeoutMs: number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly removePushListener: () => void;
  private readonly waiters = new Set<PushWaiter>();
  private readonly bufferedPushes: Uint8Array[] = [];
  private readonly authenticatedRepeaters = new Set<string>();
  private readonly attemptedRepeaters = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private cancellationGeneration = 0;
  private commandAbortController = new AbortController();

  constructor(
    private readonly commands: CommandQueue,
    options: GuestObserverCoordinatorOptions = {},
  ) {
    this.commandTimeoutMs = requireInteger(
      options.commandTimeoutMs ?? 5_000,
      'Guest command timeout',
      1,
      120_000,
    );
    this.pushTimeoutMs = requireInteger(
      options.pushTimeoutMs ?? 20_000,
      'Guest push timeout',
      1,
      120_000,
    );
    this.maximumPushTimeoutMs = requireInteger(
      options.maximumPushTimeoutMs ?? Math.max(60_000, this.pushTimeoutMs),
      'Maximum guest push timeout',
      this.pushTimeoutMs,
      300_000,
    );
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.removePushListener = this.commands.onPush((frame) => {
      this.ingestPush(frame);
    });
  }

  /** Attempt only the repeater's blank-password guest login. */
  loginBlankGuest(repeater: RepeaterPublicKey): Promise<GuestLoginResult> {
    const publicKey = requireFullRepeaterPublicKey(repeater);
    const generation = this.cancellationGeneration;
    const signal = this.commandAbortController.signal;
    return this.enqueue(() => this.loginBlankGuestNow(publicKey, generation, signal), generation);
  }

  queryNeighbourPage(
    repeater: RepeaterPublicKey,
    options: NeighbourRequestOptions = {},
  ): Promise<NeighbourPage> {
    const publicKey = requireFullRepeaterPublicKey(repeater);
    const generation = this.cancellationGeneration;
    const signal = this.commandAbortController.signal;
    return this.enqueue(() => this.queryNeighbourPageNow(publicKey, options, generation, signal), generation);
  }

  fetchNeighbours(
    repeater: RepeaterPublicKey,
    options: FetchNeighboursOptions = {},
  ): Promise<NeighbourFetchResult> {
    const publicKey = requireFullRepeaterPublicKey(repeater);
    const generation = this.cancellationGeneration;
    const signal = this.commandAbortController.signal;
    return this.enqueue(() => this.fetchNeighboursNow(publicKey, options, generation, signal), generation);
  }

  isAuthenticated(repeater: RepeaterPublicKey): boolean {
    return this.authenticatedRepeaters.has(bytesToHex(requireFullRepeaterPublicKey(repeater)));
  }

  /**
   * Accept a raw push when integration routes notifications manually. The
   * constructor already subscribes to CommandQueue pushes, so normal callers do
   * not need to call this method.
   */
  ingestPush(input: Uint8Array): boolean {
    if (this.disposed || !isGuestPushOpcode(input[0])) return false;
    if (input.length > MAX_PUSH_FRAME_BYTES) return true;
    const frame = input.slice();
    for (const waiter of this.waiters) {
      if (!waiter.predicate(frame)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(frame);
      return true;
    }
    this.bufferedPushes.push(frame);
    while (this.bufferedPushes.length > MAX_BUFFERED_PUSHES) this.bufferedPushes.shift();
    return true;
  }

  /** Stop queued/paged work without forgetting already-established guest sessions. */
  cancelPending(reason = 'Guest observer operation cancelled'): void {
    if (this.disposed) return;
    this.cancellationGeneration += 1;
    const previousAbortController = this.commandAbortController;
    this.commandAbortController = new AbortController();
    previousAbortController.abort(new GuestProtocolError(reason));
    this.bufferedPushes.length = 0;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new GuestProtocolError(reason));
    }
    this.waiters.clear();
  }

  dispose(reason = 'Guest observer coordinator disposed'): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancellationGeneration += 1;
    this.commandAbortController.abort(new GuestProtocolError(reason));
    this.removePushListener();
    this.authenticatedRepeaters.clear();
    this.attemptedRepeaters.clear();
    this.bufferedPushes.length = 0;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new GuestProtocolError(reason));
    }
    this.waiters.clear();
  }

  private enqueue<T>(operation: () => Promise<T>, generation: number): Promise<T> {
    const result = this.operationTail.then(
      () => {
        this.assertActive(generation);
        return operation();
      },
      () => {
        this.assertActive(generation);
        return operation();
      },
    );
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loginBlankGuestNow(
    publicKey: Uint8Array,
    generation: number,
    signal: AbortSignal,
  ): Promise<GuestLoginResult> {
    const repeaterPubkeyHex = bytesToHex(publicKey);
    if (this.attemptedRepeaters.has(repeaterPubkeyHex)) {
      throw new GuestProtocolError(
        'Blank guest login was already attempted for this repeater on this companion connection',
      );
    }
    this.attemptedRepeaters.add(repeaterPubkeyHex);
    const prefixHex = bytesToHex(publicKey.subarray(0, 6));
    // A login push has no random request tag, so discard any old push for this
    // prefix before starting a new exchange. Pushes arriving after the write are
    // buffered and remain eligible.
    this.discardBufferedPushes((frame) =>
      (frame[0] === GuestObserverOpcode.LoginSuccess || frame[0] === GuestObserverOpcode.LoginFail) &&
      frame.length >= 8 &&
      bytesToHex(frame.subarray(2, 8)) === prefixHex,
    );
    const sent = await this.sendRemoteCommand(
      buildBlankGuestLoginCommand(publicKey),
      `blank guest login ${repeaterPubkeyHex.slice(0, 12)}`,
      signal,
    );
    this.assertActive(generation);
    const expectedSentTag = uint32LE(publicKey, 0);
    if (sent.tag !== expectedSentTag) {
      throw new GuestProtocolError('Blank guest login SENT tag does not match the repeater key');
    }

    const raw = await this.waitForPush(
      (frame) => {
        if (frame[0] !== GuestObserverOpcode.LoginSuccess && frame[0] !== GuestObserverOpcode.LoginFail) {
          return false;
        }
        return frame.length >= 8 && bytesToHex(frame.subarray(2, 8)) === prefixHex;
      },
      'blank guest login response',
      this.pushWaitMs(sent.suggestedTimeoutMs),
    );
    this.assertActive(generation);
    const parsed = parseGuestLoginPush(raw);
    if (!parsed.ok) throw new GuestProtocolError(parsed.reason);
    if (parsed.value.kind === 'login-fail') {
      this.authenticatedRepeaters.delete(repeaterPubkeyHex);
      return {
        accepted: false,
        repeaterPubkeyHex,
        route: sent.route,
        suggestedTimeoutMs: sent.suggestedTimeoutMs,
        reason: 'login-denied',
      };
    }

    const value = parsed.value;
    if (value.admin) {
      // Some firmware checks the admin password before the guest password. A
      // blank admin password can therefore elevate this otherwise blank login.
      // Never retain or use that session: this coordinator is guest-only.
      this.authenticatedRepeaters.delete(repeaterPubkeyHex);
      return {
        accepted: false,
        repeaterPubkeyHex,
        route: sent.route,
        suggestedTimeoutMs: sent.suggestedTimeoutMs,
        reason: 'admin-session-refused',
        admin: true,
        legacy: value.legacy,
      };
    }

    this.authenticatedRepeaters.add(repeaterPubkeyHex);
    return {
      accepted: true,
      repeaterPubkeyHex,
      route: sent.route,
      suggestedTimeoutMs: sent.suggestedTimeoutMs,
      admin: value.admin,
      legacy: value.legacy,
      ...(!value.legacy
        ? {
            serverTimestamp: value.serverTimestamp,
            aclPermissions: value.aclPermissions,
            firmwareLevel: value.firmwareLevel,
          }
        : {}),
    };
  }

  private async queryNeighbourPageNow(
    publicKey: Uint8Array,
    options: NeighbourRequestOptions,
    generation: number,
    signal: AbortSignal,
  ): Promise<NeighbourPage> {
    const repeaterPubkeyHex = bytesToHex(publicKey);
    if (!this.authenticatedRepeaters.has(repeaterPubkeyHex)) {
      throw new GuestProtocolError('Blank guest login must succeed before requesting neighbours');
    }
    const count = requireInteger(
      options.count ?? MAX_NEIGHBOURS_PER_PAGE,
      'Neighbour page size',
      1,
      MAX_NEIGHBOURS_PER_PAGE,
    );
    const offset = requireInteger(options.offset ?? 0, 'Neighbour page offset', 0, 0xffff);
    const order = options.order ?? 'newest-to-oldest';
    const nonce = options.nonce?.slice() ?? this.randomBytes(4);
    if (nonce.length !== 4) throw new GuestProtocolError('Random-byte provider must return exactly 4 bytes');
    const command = buildNeighbourRequestCommand(publicKey, { count, offset, order, nonce });
    // Only one binary request is allowed in flight. Purge older responses so a
    // recycled companion tag cannot match a stale buffered frame.
    this.discardBufferedPushes((frame) => frame[0] === GuestObserverOpcode.BinaryResponse);
    const sent = await this.sendRemoteCommand(
      command,
      `neighbour page ${repeaterPubkeyHex.slice(0, 12)}:${offset}`,
      signal,
    );
    this.assertActive(generation);

    const raw = await this.waitForPush(
      (frame) => frame[0] === GuestObserverOpcode.BinaryResponse &&
        frame.length >= 6 &&
        uint32LE(frame, 2) === sent.tag,
      'neighbour response',
      this.pushWaitMs(sent.suggestedTimeoutMs),
    );
    this.assertActive(generation);
    const parsed = parseNeighbourResponsePush(raw);
    if (!parsed.ok) throw new GuestProtocolError(parsed.reason);
    if (parsed.value.observations.length > count) {
      throw new GuestProtocolError('Neighbour response contains more records than requested');
    }
    return {
      repeaterPubkeyHex,
      offset,
      requestedCount: count,
      order,
      totalCount: parsed.value.totalCount,
      observations: parsed.value.observations,
      route: sent.route,
      suggestedTimeoutMs: sent.suggestedTimeoutMs,
      responseTag: parsed.value.tag,
    };
  }

  private async fetchNeighboursNow(
    publicKey: Uint8Array,
    options: FetchNeighboursOptions,
    generation: number,
    signal: AbortSignal,
  ): Promise<NeighbourFetchResult> {
    const pageSize = requireInteger(
      options.pageSize ?? MAX_NEIGHBOURS_PER_PAGE,
      'Neighbour page size',
      1,
      MAX_NEIGHBOURS_PER_PAGE,
    );
    const maxPages = requireInteger(options.maxPages ?? 16, 'Maximum neighbour pages', 1, MAX_FETCH_PAGES);
    const maxNeighbours = requireInteger(
      options.maxNeighbours ?? 48,
      'Maximum fetched neighbours',
      1,
      MAX_FETCH_NEIGHBOURS,
    );
    const order = options.order ?? 'newest-to-oldest';
    const repeaterPubkeyHex = bytesToHex(publicKey);
    const observations = new Map<string, NeighbourObservation>();
    let pagesFetched = 0;
    let offset = 0;
    let reportedTotalCount = 0;
    let complete = false;
    let truncatedReason: NeighbourFetchTruncation | undefined;

    while (pagesFetched < maxPages) {
      const page = await this.queryNeighbourPageNow(publicKey, {
        count: pageSize,
        offset,
        order,
        nonce: this.randomBytes(4),
      }, generation, signal);
      this.assertActive(generation);
      pagesFetched += 1;
      reportedTotalCount = page.totalCount;
      for (const observation of page.observations) {
        if (!observations.has(observation.pubkeyHex) && observations.size >= maxNeighbours) {
          truncatedReason = 'max-neighbours';
          break;
        }
        observations.set(observation.pubkeyHex, observation);
      }
      if (truncatedReason) break;

      const returnedCount = page.observations.length;
      if (returnedCount === 0) {
        complete = offset >= page.totalCount;
        if (!complete) truncatedReason = 'empty-page';
        break;
      }
      offset += returnedCount;
      if (offset >= page.totalCount) {
        complete = true;
        break;
      }
      if (offset > 0xffff) {
        truncatedReason = 'offset-limit';
        break;
      }
      if (observations.size >= maxNeighbours) {
        truncatedReason = 'max-neighbours';
        break;
      }
    }

    if (!complete && !truncatedReason) truncatedReason = 'max-pages';
    return {
      repeaterPubkeyHex,
      order,
      reportedTotalCount,
      observations: [...observations.values()],
      pagesFetched,
      complete,
      ...(truncatedReason ? { truncatedReason } : {}),
    };
  }

  private async sendRemoteCommand(
    command: Uint8Array,
    label: string,
    signal: AbortSignal,
  ): Promise<CompanionSentFrame> {
    const frames = await this.commands.send(command, sentOrErrorMatcher(), {
      label,
      timeoutMs: this.commandTimeoutMs,
      signal,
    });
    const raw = frames[frames.length - 1] ?? new Uint8Array();
    if (raw[0] === GuestObserverOpcode.Error) {
      const code = raw.length >= 2 ? raw[1] : undefined;
      throw new GuestCommandError(
        code === undefined ? `${label} was rejected` : `${label} was rejected with error ${code}`,
        code,
      );
    }
    if (raw[0] === GuestObserverOpcode.Disabled) {
      throw new GuestCommandError(`${label} is disabled by this companion firmware`);
    }
    const parsed = parseCompanionSentFrame(raw);
    if (!parsed.ok) throw new GuestProtocolError(parsed.reason);
    return parsed.value;
  }

  private waitForPush(
    predicate: (frame: Uint8Array) => boolean,
    operation: string,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    if (this.disposed) return Promise.reject(new GuestProtocolError('Guest observer coordinator is disposed'));
    const bufferedIndex = this.bufferedPushes.findIndex(predicate);
    if (bufferedIndex >= 0) {
      const buffered = this.bufferedPushes.splice(bufferedIndex, 1)[0];
      if (buffered) return Promise.resolve(buffered.slice());
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: PushWaiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new GuestPushTimeoutError(operation, timeoutMs));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private discardBufferedPushes(predicate: (frame: Uint8Array) => boolean): void {
    for (let index = this.bufferedPushes.length - 1; index >= 0; index -= 1) {
      const frame = this.bufferedPushes[index];
      if (frame && predicate(frame)) this.bufferedPushes.splice(index, 1);
    }
  }

  private pushWaitMs(suggestedTimeoutMs: number): number {
    const suggestedWithMargin = suggestedTimeoutMs > 0 ? suggestedTimeoutMs + 2_000 : 0;
    return Math.min(this.maximumPushTimeoutMs, Math.max(this.pushTimeoutMs, suggestedWithMargin));
  }

  private assertActive(generation: number): void {
    if (this.disposed) throw new GuestProtocolError('Guest observer coordinator is disposed');
    if (generation !== this.cancellationGeneration) {
      throw new GuestProtocolError('Guest observer operation was cancelled');
    }
  }
}

function isGuestPushOpcode(opcode: number | undefined): boolean {
  return opcode === GuestObserverOpcode.LoginSuccess ||
    opcode === GuestObserverOpcode.LoginFail ||
    opcode === GuestObserverOpcode.BinaryResponse;
}
