import { describe, expect, it } from 'vitest';

import { CommandQueue } from './commands';
import {
  GuestObserverCoordinator,
  GuestObserverOpcode,
  GuestProtocolError,
  MAX_NEIGHBOURS_PER_PAGE,
  NEIGHBOUR_ENTRY_BYTES,
  buildBlankGuestLoginCommand,
  buildNeighbourRequestCommand,
  buildNeighbourRequestPayload,
  parseCompanionSentFrame,
  parseGuestLoginPush,
  parseNeighbourResponsePush,
  requireFullRepeaterPublicKey,
} from './guest';
import { bytesToHex, hexToBytes } from './frames';

const REPEATER_KEY = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join('');
const NEIGHBOUR_A = 'aa'.repeat(32);
const NEIGHBOUR_B = 'bb'.repeat(32);
const NEIGHBOUR_C = 'cc'.repeat(32);
const NEIGHBOUR_D = 'dd'.repeat(32);

function putUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function putUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function uint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function sentFrame(tag: number, timeoutMs = 4_000, flood = false): Uint8Array {
  const frame = new Uint8Array(10);
  frame[0] = GuestObserverOpcode.Sent;
  frame[1] = flood ? 1 : 0;
  putUint32LE(frame, 2, tag);
  putUint32LE(frame, 6, timeoutMs);
  return frame;
}

function modernLoginSuccess(serverTimestamp = 123, admin = false): Uint8Array {
  const frame = new Uint8Array(14);
  frame[0] = GuestObserverOpcode.LoginSuccess;
  frame[1] = admin ? 1 : 0;
  frame.set(hexToBytes(REPEATER_KEY).subarray(0, 6), 2);
  putUint32LE(frame, 8, serverTimestamp);
  frame[12] = 2;
  frame[13] = 2;
  return frame;
}

function legacyLoginSuccess(admin = false): Uint8Array {
  return Uint8Array.of(
    GuestObserverOpcode.LoginSuccess,
    admin ? 1 : 0,
    ...hexToBytes(REPEATER_KEY).subarray(0, 6),
  );
}

function loginFail(): Uint8Array {
  const frame = new Uint8Array(8);
  frame[0] = GuestObserverOpcode.LoginFail;
  frame.set(hexToBytes(REPEATER_KEY).subarray(0, 6), 2);
  return frame;
}

interface ResponseEntry {
  key: string;
  age: number;
  rawSnr: number;
}

function neighbourResponse(tag: number, total: number, entries: ResponseEntry[]): Uint8Array {
  const frame = new Uint8Array(10 + entries.length * NEIGHBOUR_ENTRY_BYTES);
  frame[0] = GuestObserverOpcode.BinaryResponse;
  putUint32LE(frame, 2, tag);
  putUint16LE(frame, 6, total);
  putUint16LE(frame, 8, entries.length);
  let offset = 10;
  for (const entry of entries) {
    frame.set(hexToBytes(entry.key), offset);
    offset += 32;
    putUint32LE(frame, offset, entry.age);
    offset += 4;
    frame[offset] = entry.rawSnr & 0xff;
    offset += 1;
  }
  return frame;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('blank guest login primitives', () => {
  it('requires a full key and emits CMD_SEND_LOGIN with no password bytes', () => {
    const command = buildBlankGuestLoginCommand(REPEATER_KEY);
    expect(command).toHaveLength(33);
    expect(command[0]).toBe(26);
    expect(bytesToHex(command.subarray(1))).toBe(REPEATER_KEY);

    expect(() => requireFullRepeaterPublicKey('aa'.repeat(31))).toThrow(/exactly 32 bytes/);
    expect(() => requireFullRepeaterPublicKey('aa'.repeat(33))).toThrow(/exactly 32 bytes/);
    expect(() => requireFullRepeaterPublicKey('not-hex')).toThrow(/complete bytes|Hex/);
  });

  it('parses modern, legacy, and failed login pushes with strict lengths', () => {
    const modern = parseGuestLoginPush(modernLoginSuccess(0x1234_5678));
    expect(modern).toMatchObject({
      ok: true,
      value: {
        kind: 'login-success',
        legacy: false,
        pubkeyPrefixHex: REPEATER_KEY.slice(0, 12),
        serverTimestamp: 0x1234_5678,
        aclPermissions: 2,
        firmwareLevel: 2,
      },
    });

    const legacy = legacyLoginSuccess();
    expect(parseGuestLoginPush(legacy)).toMatchObject({
      ok: true,
      value: { kind: 'login-success', legacy: true },
    });
    expect(parseGuestLoginPush(loginFail())).toMatchObject({
      ok: true,
      value: { kind: 'login-fail', pubkeyPrefixHex: REPEATER_KEY.slice(0, 12) },
    });
    expect(parseGuestLoginPush(Uint8Array.of(GuestObserverOpcode.LoginSuccess, 0))).toMatchObject({ ok: false });
    expect(parseGuestLoginPush(Uint8Array.of(GuestObserverOpcode.LoginFail, 0))).toMatchObject({ ok: false });
  });

  it('parses and bounds the companion SENT response', () => {
    expect(parseCompanionSentFrame(sentFrame(0xfedc_ba98, 12_345, true))).toMatchObject({
      ok: true,
      value: { route: 'flood', tag: 0xfedc_ba98, suggestedTimeoutMs: 12_345 },
    });
    expect(parseCompanionSentFrame(Uint8Array.of(GuestObserverOpcode.Sent))).toMatchObject({ ok: false });
    const invalidRoute = sentFrame(1);
    invalidRoute[1] = 2;
    expect(parseCompanionSentFrame(invalidRoute)).toMatchObject({ ok: false });
  });
});

describe('neighbour protocol primitives', () => {
  it('builds version-zero, full-key, bounded pagination requests', () => {
    const nonce = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const payload = buildNeighbourRequestPayload({
      count: 3,
      offset: 0x1234,
      order: 'strongest-to-weakest',
      nonce,
    });
    expect([...payload]).toEqual([6, 0, 3, 0x34, 0x12, 2, 32, 0xde, 0xad, 0xbe, 0xef]);

    const command = buildNeighbourRequestCommand(REPEATER_KEY, {
      count: 3,
      offset: 0x1234,
      order: 'strongest-to-weakest',
      nonce,
    });
    expect(command[0]).toBe(50);
    expect(bytesToHex(command.subarray(1, 33))).toBe(REPEATER_KEY);
    expect(command.subarray(33)).toEqual(payload);
    expect(MAX_NEIGHBOURS_PER_PAGE).toBe(3);

    expect(() => buildNeighbourRequestPayload({ count: 4, nonce })).toThrow(/1 to 3/);
    expect(() => buildNeighbourRequestPayload({ count: 0, nonce })).toThrow(/1 to 3/);
    expect(() => buildNeighbourRequestPayload({ offset: 65_536, nonce })).toThrow(/0 to 65535/);
    expect(() => buildNeighbourRequestPayload({ nonce: Uint8Array.of(1, 2, 3) })).toThrow(/exactly 4/);
  });

  it('parses full identities, uint32 heard ages, signed quarter-dB SNR, and tags', () => {
    const frame = neighbourResponse(0x1020_3040, 2, [
      { key: NEIGHBOUR_A, age: 45, rawSnr: -9 },
      { key: NEIGHBOUR_B, age: 0xffff_ffff, rawSnr: 17 },
    ]);
    const parsed = parseNeighbourResponsePush(frame);
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        tag: 0x1020_3040,
        totalCount: 2,
        observations: [
          { pubkeyHex: NEIGHBOUR_A, heardSecondsAgo: 45, rawSnr: -9, snrDb: -2.25 },
          { pubkeyHex: NEIGHBOUR_B, heardSecondsAgo: 0xffff_ffff, rawSnr: 17, snrDb: 4.25 },
        ],
      },
    });
  });

  it('rejects truncated, overfull, inconsistent, and trailing neighbour data', () => {
    expect(parseNeighbourResponsePush(Uint8Array.of(GuestObserverOpcode.BinaryResponse))).toMatchObject({ ok: false });

    const overfull = neighbourResponse(1, 4, [
      { key: NEIGHBOUR_A, age: 1, rawSnr: 1 },
      { key: NEIGHBOUR_B, age: 1, rawSnr: 1 },
      { key: NEIGHBOUR_C, age: 1, rawSnr: 1 },
    ]);
    putUint16LE(overfull, 8, 4);
    expect(parseNeighbourResponsePush(overfull)).toMatchObject({ ok: false });

    const inconsistent = neighbourResponse(1, 0, [{ key: NEIGHBOUR_A, age: 1, rawSnr: 1 }]);
    expect(parseNeighbourResponsePush(inconsistent)).toMatchObject({ ok: false });

    const valid = neighbourResponse(1, 1, [{ key: NEIGHBOUR_A, age: 1, rawSnr: 1 }]);
    const trailing = new Uint8Array(valid.length + 1);
    trailing.set(valid);
    expect(parseNeighbourResponsePush(trailing)).toMatchObject({ ok: false });
  });
});

describe('GuestObserverCoordinator', () => {
  it('correlates login prefixes and binary tags while fetching paginated full-key neighbours', async () => {
    const writes: Uint8Array[] = [];
    let nextTag = 0x5000;
    let queue!: CommandQueue;
    // eslint-disable-next-line prefer-const
    queue = new CommandQueue(async (command) => {
      writes.push(command.slice());
      if (command[0] === GuestObserverOpcode.SendLogin) {
        queue.handleFrame(sentFrame(0x0302_0100, 1));
        const unrelatedLogin = modernLoginSuccess();
        unrelatedLogin.set(hexToBytes('ff'.repeat(6)), 2);
        queue.handleFrame(unrelatedLogin);
        queue.handleFrame(modernLoginSuccess());
        return;
      }
      if (command[0] !== GuestObserverOpcode.SendBinaryRequest) return;
      const offset = uint16LE(command, 36);
      const tag = nextTag;
      nextTag += 1;
      queue.handleFrame(sentFrame(tag, 1));
      // A stale response must not satisfy the current tagged exchange.
      queue.handleFrame(neighbourResponse(tag + 100, 1, [{ key: NEIGHBOUR_D, age: 1, rawSnr: 1 }]));
      if (offset === 0) {
        queue.handleFrame(neighbourResponse(tag, 4, [
          { key: NEIGHBOUR_A, age: 3, rawSnr: -8 },
          { key: NEIGHBOUR_B, age: 5, rawSnr: 0 },
          { key: NEIGHBOUR_C, age: 8, rawSnr: 12 },
        ]));
      } else {
        queue.handleFrame(neighbourResponse(tag, 4, [
          { key: NEIGHBOUR_D, age: 13, rawSnr: -20 },
        ]));
      }
    });
    let nonce = 0;
    const coordinator = new GuestObserverCoordinator(queue, {
      pushTimeoutMs: 100,
      maximumPushTimeoutMs: 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(nonce++),
    });

    const login = await coordinator.loginBlankGuest(REPEATER_KEY);
    expect(login).toMatchObject({ accepted: true, repeaterPubkeyHex: REPEATER_KEY, legacy: false });
    expect(coordinator.isAuthenticated(REPEATER_KEY)).toBe(true);

    const result = await coordinator.fetchNeighbours(REPEATER_KEY);
    expect(result).toMatchObject({
      complete: true,
      pagesFetched: 2,
      reportedTotalCount: 4,
    });
    expect(result.observations.map((entry) => entry.pubkeyHex)).toEqual([
      NEIGHBOUR_A,
      NEIGHBOUR_B,
      NEIGHBOUR_C,
      NEIGHBOUR_D,
    ]);
    expect(writes.map((command) => command[0])).toEqual([26, 50, 50]);
    expect(uint16LE(writes[1] ?? new Uint8Array(), 36)).toBe(0);
    expect(uint16LE(writes[2] ?? new Uint8Array(), 36)).toBe(3);
    expect(writes.every((command) => bytesToHex(command.subarray(1, 33)) === REPEATER_KEY)).toBe(true);
    coordinator.dispose();
  });

  it('returns a normal rejection for blank login and refuses neighbour queries', async () => {
    let loginWrites = 0;
    let queue!: CommandQueue;
    // eslint-disable-next-line prefer-const
    queue = new CommandQueue(async (command) => {
      if (command[0] !== GuestObserverOpcode.SendLogin) return;
      loginWrites += 1;
      queue.handleFrame(sentFrame(0x0302_0100, 1));
      queue.handleFrame(loginFail());
    });
    const coordinator = new GuestObserverCoordinator(queue, {
      pushTimeoutMs: 100,
      maximumPushTimeoutMs: 1_000,
      randomBytes: (length) => new Uint8Array(length),
    });
    await expect(coordinator.loginBlankGuest(REPEATER_KEY)).resolves.toMatchObject({ accepted: false });
    await expect(coordinator.loginBlankGuest(REPEATER_KEY)).rejects.toThrow(/already attempted/);
    expect(loginWrites).toBe(1);
    await expect(coordinator.queryNeighbourPage(REPEATER_KEY, { nonce: new Uint8Array(4) }))
      .rejects.toBeInstanceOf(GuestProtocolError);
    coordinator.dispose();
  });

  it.each([
    ['modern', modernLoginSuccess(123, true), false],
    ['legacy', legacyLoginSuccess(true), true],
  ] as const)('refuses a blank login that firmware elevates to a %s admin session', async (_name, loginPush, legacy) => {
    let loginWrites = 0;
    let queue!: CommandQueue;
    // eslint-disable-next-line prefer-const
    queue = new CommandQueue(async (command) => {
      if (command[0] !== GuestObserverOpcode.SendLogin) return;
      loginWrites += 1;
      queue.handleFrame(sentFrame(0x0302_0100, 1));
      queue.handleFrame(loginPush);
    });
    const coordinator = new GuestObserverCoordinator(queue, {
      pushTimeoutMs: 100,
      maximumPushTimeoutMs: 1_000,
      randomBytes: (length) => new Uint8Array(length),
    });

    await expect(coordinator.loginBlankGuest(REPEATER_KEY)).resolves.toMatchObject({
      accepted: false,
      reason: 'admin-session-refused',
      admin: true,
      legacy,
    });
    expect(coordinator.isAuthenticated(REPEATER_KEY)).toBe(false);
    await expect(coordinator.queryNeighbourPage(REPEATER_KEY, { nonce: new Uint8Array(4) }))
      .rejects.toThrow(/login must succeed/);
    await expect(coordinator.loginBlankGuest(REPEATER_KEY)).rejects.toThrow(/already attempted/);
    expect(loginWrites).toBe(1);
    coordinator.dispose();
  });

  it('stops pagination at configured safety bounds', async () => {
    let tag = 10;
    let queue!: CommandQueue;
    // eslint-disable-next-line prefer-const
    queue = new CommandQueue(async (command) => {
      if (command[0] === GuestObserverOpcode.SendLogin) {
        queue.handleFrame(sentFrame(0x0302_0100, 1));
        queue.handleFrame(modernLoginSuccess());
        return;
      }
      const currentTag = tag++;
      queue.handleFrame(sentFrame(currentTag, 1));
      queue.handleFrame(neighbourResponse(currentTag, 30, [
        { key: NEIGHBOUR_A, age: 1, rawSnr: 1 },
        { key: NEIGHBOUR_B, age: 2, rawSnr: 2 },
        { key: NEIGHBOUR_C, age: 3, rawSnr: 3 },
      ]));
    });
    const coordinator = new GuestObserverCoordinator(queue, {
      pushTimeoutMs: 100,
      maximumPushTimeoutMs: 1_000,
      randomBytes: (length) => new Uint8Array(length),
    });
    await coordinator.loginBlankGuest(REPEATER_KEY);
    await expect(coordinator.fetchNeighbours(REPEATER_KEY, { maxPages: 1, maxNeighbours: 20 }))
      .resolves.toMatchObject({ complete: false, pagesFetched: 1, truncatedReason: 'max-pages' });
    coordinator.dispose();
  });

  it('cancels in-flight and queued work without losing authentication or retrying blank login', async () => {
    let loginWrites = 0;
    let binaryWrites = 0;
    let answerBinaryRequests = false;
    let queue!: CommandQueue;
    // eslint-disable-next-line prefer-const
    queue = new CommandQueue(async (command) => {
      if (command[0] === GuestObserverOpcode.SendLogin) {
        loginWrites += 1;
        queue.handleFrame(sentFrame(0x0302_0100, 1));
        queue.handleFrame(modernLoginSuccess());
        return;
      }
      if (command[0] !== GuestObserverOpcode.SendBinaryRequest) return;
      binaryWrites += 1;
      const tag = 0x6000 + binaryWrites;
      if (answerBinaryRequests) {
        queue.handleFrame(sentFrame(tag, 1));
        queue.handleFrame(neighbourResponse(tag, 1, [
          { key: NEIGHBOUR_A, age: 1, rawSnr: 4 },
        ]));
      }
    });
    const coordinator = new GuestObserverCoordinator(queue, {
      commandTimeoutMs: 1_000,
      pushTimeoutMs: 1_000,
      maximumPushTimeoutMs: 3_000,
      randomBytes: (length) => new Uint8Array(length),
    });

    await coordinator.loginBlankGuest(REPEATER_KEY);
    const inFlight = coordinator.queryNeighbourPage(REPEATER_KEY, { nonce: new Uint8Array(4) });
    const queued = coordinator.queryNeighbourPage(REPEATER_KEY, { nonce: new Uint8Array(4) });
    const inFlightRejection = expect(inFlight).rejects.toThrow('field search stopped');
    const queuedRejection = expect(queued).rejects.toBeInstanceOf(GuestProtocolError);
    await nextTask();
    expect(binaryWrites).toBe(1);

    coordinator.cancelPending('field search stopped');
    await Promise.all([inFlightRejection, queuedRejection]);
    expect(binaryWrites).toBe(1);
    expect(coordinator.isAuthenticated(REPEATER_KEY)).toBe(true);

    await expect(coordinator.loginBlankGuest(REPEATER_KEY)).rejects.toThrow(/already attempted/);
    expect(loginWrites).toBe(1);

    answerBinaryRequests = true;
    await expect(coordinator.queryNeighbourPage(REPEATER_KEY, { nonce: new Uint8Array(4) }))
      .resolves.toMatchObject({ totalCount: 1, observations: [{ pubkeyHex: NEIGHBOUR_A }] });
    expect(binaryWrites).toBe(2);
    expect(loginWrites).toBe(1);
    coordinator.dispose();
  });

  it('removes a guest command queued behind companion work before it writes', async () => {
    const writes: number[] = [];
    let queue!: CommandQueue;
    // eslint-disable-next-line prefer-const
    queue = new CommandQueue(async (command) => {
      writes.push(command[0] ?? -1);
    });
    const companionWork = queue.send(Uint8Array.of(0x04), {
      accept: (frame) => frame[0] === 0x04 ? 'done' : 'no',
    }, { label: 'contacts' });
    const coordinator = new GuestObserverCoordinator(queue, {
      commandTimeoutMs: 1_000,
      pushTimeoutMs: 1_000,
      maximumPushTimeoutMs: 3_000,
      randomBytes: (length) => new Uint8Array(length),
    });
    const login = coordinator.loginBlankGuest(REPEATER_KEY);
    const loginRejection = expect(login).rejects.toThrow('connection context changed');
    await nextTask();
    expect(writes).toEqual([0x04]);
    expect(queue.state().queued).toBe(1);

    coordinator.cancelPending('connection context changed');
    await loginRejection;
    queue.handleFrame(Uint8Array.of(0x04));
    await companionWork;
    await nextTask();

    expect(writes).toEqual([0x04]);
    expect(queue.state().queued).toBe(0);
    await expect(coordinator.loginBlankGuest(REPEATER_KEY)).rejects.toThrow(/already attempted/);
    coordinator.dispose();
  });

  it('cannot continue canceled pagination when a late page response arrives', async () => {
    let binaryWrites = 0;
    let secondTag = 0;
    let markSecondWrite!: () => void;
    const secondWrite = new Promise<void>((resolve) => { markSecondWrite = resolve; });
    let queue!: CommandQueue;
    // eslint-disable-next-line prefer-const
    queue = new CommandQueue(async (command) => {
      if (command[0] === GuestObserverOpcode.SendLogin) {
        queue.handleFrame(sentFrame(0x0302_0100, 1));
        queue.handleFrame(modernLoginSuccess());
        return;
      }
      if (command[0] !== GuestObserverOpcode.SendBinaryRequest) return;
      binaryWrites += 1;
      const tag = 0x7000 + binaryWrites;
      queue.handleFrame(sentFrame(tag, 1));
      if (binaryWrites === 1) {
        queue.handleFrame(neighbourResponse(tag, 7, [
          { key: NEIGHBOUR_A, age: 1, rawSnr: 1 },
          { key: NEIGHBOUR_B, age: 2, rawSnr: 2 },
          { key: NEIGHBOUR_C, age: 3, rawSnr: 3 },
        ]));
      } else if (binaryWrites === 2) {
        secondTag = tag;
        markSecondWrite();
      }
    });
    const coordinator = new GuestObserverCoordinator(queue, {
      commandTimeoutMs: 1_000,
      pushTimeoutMs: 1_000,
      maximumPushTimeoutMs: 3_000,
      randomBytes: (length) => new Uint8Array(length),
    });

    await coordinator.loginBlankGuest(REPEATER_KEY);
    const fetch = coordinator.fetchNeighbours(REPEATER_KEY, { maxPages: 4, maxNeighbours: 12 });
    const fetchRejection = expect(fetch).rejects.toThrow('pagination stopped');
    await secondWrite;
    await nextTask();
    expect(binaryWrites).toBe(2);

    coordinator.cancelPending('pagination stopped');
    await fetchRejection;
    queue.handleFrame(neighbourResponse(secondTag, 7, [
      { key: NEIGHBOUR_D, age: 4, rawSnr: 4 },
    ]));
    await nextTask();

    expect(binaryWrites).toBe(2);
    expect(coordinator.isAuthenticated(REPEATER_KEY)).toBe(true);
    coordinator.dispose();
  });
});
