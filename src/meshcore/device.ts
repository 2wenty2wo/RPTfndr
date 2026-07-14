import type { ConnState, Transport } from '../types';
import { CommandQueue, contactsStreamMatcher, opcodeMatcher } from './commands';
import {
  CompanionOpcode,
  parseCompanionFrame,
  type CompanionFrame,
  type ContactRecord,
  type DeviceInfoFrame,
  type SelfInfoFrame,
} from './frames';

export const CommandOpcode = {
  AppStart: 0x01,
  GetContacts: 0x04,
  DeviceQuery: 0x16,
} as const;

export function buildAppStartCommand(appName = 'MeshCore Finder'): Uint8Array {
  const name = new TextEncoder().encode(appName);
  const command = new Uint8Array(8 + name.length);
  command.set([CommandOpcode.AppStart, 0x03, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);
  command.set(name, 8);
  return command;
}

export function buildGetContactsCommand(lastModified = 0): Uint8Array {
  if (!Number.isInteger(lastModified) || lastModified < 0 || lastModified > 0xffff_ffff) {
    throw new RangeError('Contact last-modified marker must be a uint32');
  }
  if (lastModified === 0) return Uint8Array.of(CommandOpcode.GetContacts);
  return Uint8Array.of(
    CommandOpcode.GetContacts,
    lastModified & 0xff,
    (lastModified >>> 8) & 0xff,
    (lastModified >>> 16) & 0xff,
    (lastModified >>> 24) & 0xff,
  );
}

export function buildDeviceQueryCommand(): Uint8Array {
  return Uint8Array.of(CommandOpcode.DeviceQuery);
}

export interface DeviceSnapshot {
  self: SelfInfoFrame;
  contacts: ContactRecord[];
  contactsLastModified: number;
  info?: DeviceInfoFrame;
  batteryMilliVolts?: number;
  warnings: string[];
}

export interface DeviceOptions {
  appName?: string;
  commandTimeoutMs?: number;
  contactsTimeoutMs?: number;
  postStartGapMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}

export class CompanionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanionProtocolError';
  }
}

/**
 * Companion handshake and response orchestration. Bluetooth reconnect policy
 * stays in the transport; this class only owns protocol state.
 */
export class MeshCoreDevice {
  readonly commands: CommandQueue;

  private readonly appName: string;
  private readonly commandTimeoutMs: number;
  private readonly contactsTimeoutMs: number;
  private readonly postStartGapMs: number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly contactMap = new Map<string, ContactRecord>();
  private readonly pushListeners = new Set<(frame: CompanionFrame) => void>();
  private readonly removeFrameListener: () => void;
  private readonly removeStateListener: () => void;
  private readonly removeQueuePushListener: () => void;
  private connectPromise?: Promise<DeviceSnapshot>;
  private self?: SelfInfoFrame;
  private info?: DeviceInfoFrame;
  private batteryMilliVolts?: number;
  private contactsLastModified = 0;
  private state: ConnState = 'disconnected';
  private warnings: string[] = [];

  constructor(
    readonly transport: Transport,
    options: DeviceOptions = {},
  ) {
    this.appName = options.appName ?? 'MeshCore Finder';
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
    this.contactsTimeoutMs = options.contactsTimeoutMs ?? 12_000;
    this.postStartGapMs = options.postStartGapMs ?? 300;
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    this.commands = new CommandQueue((command) => this.transport.write(command));
    this.removeFrameListener = this.transport.onFrame((frame) => this.commands.handleFrame(frame));
    this.removeQueuePushListener = this.commands.onPush((frame) => this.handlePush(frame));
    this.removeStateListener = this.transport.onState((state) => {
      this.state = state;
      if (state === 'disconnected' || state === 'unsupported') {
        this.commands.cancelAll(`Transport became ${state}`);
      }
    });
  }

  connect(): Promise<DeviceSnapshot> {
    return this.runHandshake(true);
  }

  /** Re-run APP_START/contact/device metadata after a picker-free GATT reconnect. */
  rehydrate(): Promise<DeviceSnapshot> {
    return this.runHandshake(false);
  }

  private runHandshake(connectTransport: boolean): Promise<DeviceSnapshot> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.performHandshake(connectTransport).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.commands.cancelAll('Device disconnected');
    await this.transport.disconnect();
  }

  async syncContacts(lastModified = this.contactsLastModified): Promise<ContactRecord[]> {
    const frames = await this.commands.send(buildGetContactsCommand(lastModified), contactsStreamMatcher(), {
      label: 'GET_CONTACTS',
      timeoutMs: this.contactsTimeoutMs,
    });
    let completedMarker = lastModified;
    for (const frame of frames) {
      const parsed = parseCompanionFrame(frame);
      if (parsed.kind === 'contact') this.contactMap.set(parsed.contact.pubkeyHex, parsed.contact);
      else if (parsed.kind === 'contacts-end') completedMarker = parsed.lastModified;
      else if (parsed.kind === 'invalid') this.warnings.push(parsed.reason);
    }
    // Advance the incremental marker only after END_OF_CONTACTS was consumed.
    this.contactsLastModified = completedMarker;
    return this.contacts();
  }

  async queryDeviceInfo(): Promise<DeviceInfoFrame> {
    const frames = await this.commands.send(buildDeviceQueryCommand(), opcodeMatcher(CompanionOpcode.DeviceInfo), {
      label: 'DEVICE_QUERY',
      timeoutMs: this.commandTimeoutMs,
    });
    const parsed = parseCompanionFrame(frames[frames.length - 1] ?? new Uint8Array());
    if (parsed.kind !== 'device-info') {
      throw new CompanionProtocolError(
        parsed.kind === 'invalid' ? parsed.reason : 'DEVICE_QUERY returned an unexpected frame',
      );
    }
    this.info = parsed;
    return parsed;
  }

  contacts(): ContactRecord[] {
    return [...this.contactMap.values()].map((contact) => ({ ...contact }));
  }

  snapshot(): DeviceSnapshot {
    if (!this.self) throw new CompanionProtocolError('APP_START has not completed');
    return {
      self: { ...this.self, raw: this.self.raw.slice() },
      contacts: this.contacts(),
      contactsLastModified: this.contactsLastModified,
      info: this.info ? { ...this.info, raw: this.info.raw.slice(), reserved: this.info.reserved.slice() } : undefined,
      batteryMilliVolts: this.batteryMilliVolts,
      warnings: [...this.warnings],
    };
  }

  connectionState(): ConnState {
    return this.state;
  }

  onPush(listener: (frame: CompanionFrame) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  dispose(): void {
    this.commands.cancelAll('Device disposed');
    this.removeFrameListener();
    this.removeStateListener();
    this.removeQueuePushListener();
    this.pushListeners.clear();
  }

  private async performHandshake(connectTransport: boolean): Promise<DeviceSnapshot> {
    this.warnings = [];
    if (connectTransport) await this.transport.connect();
    const selfFrames = await this.commands.send(
      buildAppStartCommand(this.appName),
      opcodeMatcher(CompanionOpcode.SelfInfo),
      { label: 'APP_START', timeoutMs: this.commandTimeoutMs },
    );
    const parsedSelf = parseCompanionFrame(selfFrames[selfFrames.length - 1] ?? new Uint8Array());
    if (parsedSelf.kind !== 'self-info') {
      throw new CompanionProtocolError(
        parsedSelf.kind === 'invalid' ? parsedSelf.reason : 'APP_START returned an unexpected frame',
      );
    }
    this.self = parsedSelf;

    await this.delay(this.postStartGapMs);
    await this.syncContacts(this.contactsLastModified);
    try {
      await this.queryDeviceInfo();
    } catch (cause) {
      // Older firmware can lack DEVICE_QUERY. The radio is still usable; retain
      // this as session diagnostics rather than failing an otherwise valid link.
      const message = cause instanceof Error ? cause.message : String(cause);
      this.warnings.push(`DEVICE_QUERY unavailable: ${message}`);
    }
    return this.snapshot();
  }

  private handlePush(raw: Uint8Array): void {
    const frame = parseCompanionFrame(raw);
    if (frame.kind === 'contact') this.contactMap.set(frame.contact.pubkeyHex, frame.contact);
    else if (frame.kind === 'battery') this.batteryMilliVolts = frame.milliVolts;
    else if (frame.kind === 'device-info') this.info = frame;
    else if (frame.kind === 'self-info') this.self = frame;
    else if (frame.kind === 'invalid') this.warnings.push(frame.reason);
    for (const listener of this.pushListeners) listener(frame);
  }
}

export async function connectMeshCoreDevice(
  transport: Transport,
  options?: DeviceOptions,
): Promise<{ device: MeshCoreDevice; snapshot: DeviceSnapshot }> {
  const device = new MeshCoreDevice(transport, options);
  try {
    return { device, snapshot: await device.connect() };
  } catch (error) {
    device.dispose();
    throw error;
  }
}
