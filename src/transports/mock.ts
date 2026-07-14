import { ObservableTransport } from './transport';

export interface MockContact {
  pubkey: Uint8Array;
  name: string;
  type?: number;
  flags?: number;
  pathLength?: number;
  outPath?: Uint8Array;
  lastAdvert?: number;
  latitude?: number;
  longitude?: number;
  lastModified?: number;
}

export interface MockDiscoveryResponse {
  pubkey: Uint8Array;
  pathLength?: number;
  advType?: number;
  snr?: number;
  rssi?: number;
  uplinkSnr?: number;
  delayMs?: number;
}

export interface MockTransportOptions {
  responseDelayMs?: number;
  selfInfoFrame?: Uint8Array;
  contacts?: MockContact[] | Uint8Array[];
  contactsLastModified?: number;
  deviceQueryFrame?: Uint8Array;
  discoveryResponses?: MockDiscoveryResponse[];
  /** Override built-in command handling. Return true when a write was handled. */
  writeHandler?: (bytes: Uint8Array, transport: MockTransport) => boolean | void | Promise<boolean | void>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export type MockWriteListener = (bytes: Uint8Array) => void;

/**
 * Deterministic in-memory MeshCore companion used by demo mode and browser
 * tests. Its default constructor provides a complete minimal handshake.
 */
export class MockTransport extends ObservableTransport {
  readonly kind = 'mock' as const;
  readonly dataMode = 'simulated' as const;
  readonly capabilities = { silentReconnect: true } as const;

  private readonly responseDelayMs: number;
  private readonly selfInfoFrame: Uint8Array;
  private readonly contactFrames: Uint8Array[];
  private readonly contactsLastModified: number;
  private readonly deviceQueryFrame: Uint8Array;
  private readonly discoveryResponses: MockDiscoveryResponse[];
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private readonly timers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  private readonly writeListeners = new Set<MockWriteListener>();
  private writeHandler?: MockTransportOptions['writeHandler'];

  readonly writes: Uint8Array[] = [];

  constructor(options: MockTransportOptions = {}) {
    super();
    this.responseDelayMs = Math.max(0, options.responseDelayMs ?? 5);
    this.selfInfoFrame = (options.selfInfoFrame ?? buildDefaultSelfInfoFrame()).slice();
    this.contactFrames = (options.contacts ?? []).map((contact) => (
      contact instanceof Uint8Array ? contact.slice() : buildMockContactFrame(contact)
    ));
    this.contactsLastModified = options.contactsLastModified ?? 0;
    this.deviceQueryFrame = (options.deviceQueryFrame ?? buildDefaultDeviceQueryFrame()).slice();
    this.discoveryResponses = (options.discoveryResponses ?? []).map((response) => ({
      ...response,
      pubkey: response.pubkey.slice(),
    }));
    this.writeHandler = options.writeHandler;
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  async connect(): Promise<void> {
    if (this.currentState === 'connected') return;
    this.emitState('connecting');
    await Promise.resolve();
    this.emitState('connected');
  }

  async disconnect(): Promise<void> {
    this.cancelTimers();
    this.emitState('disconnected');
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.currentState !== 'connected') {
      throw new Error('Cannot write: mock transport is not connected.');
    }
    const command = bytes.slice();
    this.writes.push(command);
    for (const listener of this.writeListeners) listener(command.slice());

    const handled = await this.writeHandler?.(command.slice(), this);
    if (handled === true) return;
    this.handleCompanionCommand(command);
  }

  onWrite(callback: MockWriteListener): () => void {
    this.writeListeners.add(callback);
    return () => this.writeListeners.delete(callback);
  }

  setWriteHandler(handler: MockTransportOptions['writeHandler']): void {
    this.writeHandler = handler;
  }

  injectFrame(frame: Uint8Array, delayMs = 0): void {
    const copy = frame.slice();
    this.schedule(() => {
      if (this.currentState === 'connected') this.emitFrame(copy);
    }, delayMs);
  }

  dropConnection(): void {
    this.cancelTimers();
    this.emitState('disconnected');
  }

  restoreConnection(delayMs = 0): void {
    this.emitState('reconnecting');
    this.schedule(() => this.emitState('connected'), delayMs);
  }

  clearWrites(): void {
    this.writes.length = 0;
  }

  private handleCompanionCommand(command: Uint8Array): void {
    switch (command[0]) {
      case 0x01: // CMD_APP_START -> SELF_INFO
        this.injectFrame(this.selfInfoFrame, this.responseDelayMs);
        break;
      case 0x04: { // CMD_GET_CONTACTS -> start, records, end
        let delay = this.responseDelayMs;
        this.injectFrame(Uint8Array.of(0x02), delay);
        for (const contact of this.contactFrames) {
          delay += this.responseDelayMs;
          this.injectFrame(contact, delay);
        }
        delay += this.responseDelayMs;
        const end = new Uint8Array(5);
        end[0] = 0x04;
        new DataView(end.buffer).setUint32(1, this.contactsLastModified, true);
        this.injectFrame(end, delay);
        break;
      }
      case 0x16: // CMD_DEVICE_QUERY
        this.injectFrame(this.deviceQueryFrame, this.responseDelayMs);
        break;
      case 0x37: { // Discovery request; tag begins at byte 3.
        if (command.length < 7) break;
        const tag = new DataView(command.buffer, command.byteOffset, command.byteLength).getUint32(3, true);
        for (const response of this.discoveryResponses) {
          this.injectFrame(
            buildMockDiscoveryResponseFrame(response, tag),
            response.delayMs ?? this.responseDelayMs,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  private schedule(callback: () => void, delayMs: number): void {
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(timer);
      callback();
    }, Math.max(0, delayMs));
    this.timers.add(timer);
  }

  private cancelTimers(): void {
    for (const timer of this.timers) this.clearTimeoutFn(timer);
    this.timers.clear();
  }
}

export function buildDefaultSelfInfoFrame(): Uint8Array {
  const frame = new Uint8Array(44);
  frame[0] = 0x05;
  frame[1] = 0x02; // repeater advertisement type
  new DataView(frame.buffer).setInt16(2, 22, true);
  for (let index = 0; index < 32; index += 1) frame[4 + index] = 0x10 + index;
  return frame;
}

export function buildDefaultDeviceQueryFrame(): Uint8Array {
  const build = new TextEncoder().encode('mock-1.0');
  const model = new TextEncoder().encode('Mock Companion');
  const frame = new Uint8Array(20 + model.length);
  frame[0] = 0x0d;
  frame[1] = 1;
  frame.set(build.subarray(0, 11), 8);
  frame.set(model, 20);
  return frame;
}

export function buildMockContactFrame(contact: MockContact): Uint8Array {
  if (contact.pubkey.length !== 32) throw new RangeError('A mock contact public key must be 32 bytes.');
  const frame = new Uint8Array(148);
  frame[0] = 0x03;
  frame.set(contact.pubkey, 1);
  frame[33] = contact.type ?? 2;
  frame[34] = contact.flags ?? 0;
  frame[35] = contact.pathLength ?? 0;
  if (contact.outPath) frame.set(contact.outPath.subarray(0, 64), 36);
  writeCString(frame, 100, 32, contact.name);
  const view = new DataView(frame.buffer);
  view.setUint32(132, contact.lastAdvert ?? 0, true);
  view.setInt32(136, Math.round((contact.latitude ?? 0) * 1_000_000), true);
  view.setInt32(140, Math.round((contact.longitude ?? 0) * 1_000_000), true);
  view.setUint32(144, contact.lastModified ?? 0, true);
  return frame;
}

export function buildMockDiscoveryResponseFrame(
  response: MockDiscoveryResponse,
  tag: number,
): Uint8Array {
  if (response.pubkey.length !== 32 && response.pubkey.length !== 8) {
    throw new RangeError('A discovery public key must be 8 or 32 bytes.');
  }
  const frame = new Uint8Array(10 + response.pubkey.length);
  frame[0] = 0x8e;
  frame[1] = encodeInt8(Math.round((response.snr ?? 5) * 4));
  frame[2] = encodeInt8(Math.round(response.rssi ?? -75));
  frame[3] = response.pathLength ?? 0;
  frame[4] = 0x90 | ((response.advType ?? 2) & 0x0f);
  frame[5] = encodeInt8(Math.round((response.uplinkSnr ?? 4) * 4));
  new DataView(frame.buffer).setUint32(6, tag >>> 0, true);
  frame.set(response.pubkey, 10);
  return frame;
}

function writeCString(target: Uint8Array, offset: number, maxLength: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, maxLength - 1), offset);
}

function encodeInt8(value: number): number {
  return Math.max(-128, Math.min(127, value)) & 0xff;
}
