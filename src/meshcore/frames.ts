/** Companion-protocol notification parsing.
 *
 * A Web Bluetooth notification is one complete companion frame. There is no
 * length prefix at this boundary: byte zero is always the opcode.
 */

export const CompanionOpcode = {
  ContactsStart: 0x02,
  Contact: 0x03,
  ContactsEnd: 0x04,
  SelfInfo: 0x05,
  Battery: 0x0c,
  DeviceInfo: 0x0d,
  RxLog: 0x84,
  RxPacket: 0x88,
  Trace: 0x89,
  NewAdvert: 0x8a,
  ControlData: 0x8e,
} as const;

export interface ContactRecord {
  pubkeyHex: string;
  type: number;
  flags: number;
  pathLength: number;
  outPathHex: string;
  name?: string;
  lastAdvert: number;
  lat: number;
  lon: number;
  lastModified: number;
}
interface FrameBase {
  opcode: number;
  raw: Uint8Array;
}

export interface InvalidCompanionFrame extends FrameBase {
  kind: 'invalid';
  reason: string;
}

export interface UnknownCompanionFrame extends FrameBase {
  kind: 'unknown';
}

export interface RxCompanionFrame extends FrameBase {
  kind: 'rx';
  snr: number;
  rssi: number;
  companionPathLen?: number;
  lora: Uint8Array;
  loraHex: string;
}

export interface DiscoveryResponseFrame extends FrameBase {
  kind: 'discovery-response';
  snr: number;
  rssi: number;
  pathLength: number;
  advType: number;
  uplinkSnr: number;
  tag: number;
  pubkeyHex: string;
  pubkeySizeBytes: 8 | 32;
}

export interface TracePushFrame extends FrameBase {
  kind: 'trace';
  pathLength: number;
  tag: number;
  path: string[];
  snrs: number[];
}

export interface SelfInfoFrame extends FrameBase {
  kind: 'self-info';
  advType: number;
  txPower: number;
  maxTxPower: number;
  pubkeyHex: string;
  lat: number;
  lon: number;
}

export interface ContactFrame extends FrameBase {
  kind: 'contact';
  source: 'sync' | 'push';
  contact: ContactRecord;
}

export interface ContactsStartFrame extends FrameBase {
  kind: 'contacts-start';
}

export interface ContactsEndFrame extends FrameBase {
  kind: 'contacts-end';
  lastModified: number;
}

export interface BatteryFrame extends FrameBase {
  kind: 'battery';
  milliVolts: number;
}

export interface DeviceInfoFrame extends FrameBase {
  kind: 'device-info';
  fwVersion: number;
  reserved: Uint8Array;
  build: string;
  model: string;
}

export type CompanionFrame =
  | InvalidCompanionFrame
  | UnknownCompanionFrame
  | RxCompanionFrame
  | DiscoveryResponseFrame
  | TracePushFrame
  | SelfInfoFrame
  | ContactFrame
  | ContactsStartFrame
  | ContactsEndFrame
  | BatteryFrame
  | DeviceInfoFrame;

export function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

export function hexToBytes(value: string): Uint8Array {
  const compact = value.trim().replace(/^0x/i, '').replace(/[\s:_-]/g, '');
  if (compact.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(compact)) {
    throw new TypeError('Hex must contain complete bytes');
  }
  const result = new Uint8Array(compact.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function signedByte(value: number): number {
  return value > 0x7f ? value - 0x100 : value;
}

function uint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function int32LE(bytes: Uint8Array, offset: number): number {
  return uint32LE(bytes, offset) | 0;
}

function cString(bytes: Uint8Array, offset: number, length: number): string {
  const endLimit = Math.min(bytes.length, offset + length);
  let end = offset;
  while (end < endLimit && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(offset, end)).trim();
}

function invalid(raw: Uint8Array, reason: string): InvalidCompanionFrame {
  return { kind: 'invalid', opcode: raw[0] ?? -1, raw, reason };
}

function parseContact(raw: Uint8Array): ContactRecord | undefined {
  // The fixed-width portion through the name ends at byte 131. Older firmware
  // can omit trailing metadata, so those fields intentionally default to zero.
  if (raw.length < 132) return undefined;
  return {
    pubkeyHex: bytesToHex(raw.subarray(1, 33)),
    type: raw[33] ?? 0,
    flags: raw[34] ?? 0,
    pathLength: raw[35] ?? 0,
    outPathHex: bytesToHex(raw.subarray(36, 100)),
    name: cString(raw, 100, 32) || undefined,
    lastAdvert: raw.length >= 136 ? uint32LE(raw, 132) : 0,
    lat: raw.length >= 140 ? int32LE(raw, 136) / 1_000_000 : 0,
    lon: raw.length >= 144 ? int32LE(raw, 140) / 1_000_000 : 0,
    lastModified: raw.length >= 148 ? uint32LE(raw, 144) : 0,
  };
}

/** The 0x8e opcode is overloaded. This is the protocol's discriminator. */
export function isDiscoveryResponseFrame(raw: Uint8Array): boolean {
  return raw[0] === CompanionOpcode.ControlData && raw.length >= 5 && ((raw[4] ?? 0) & 0xf0) === 0x90;
}

/** Parse a complete companion notification without throwing. */
export function parseCompanionFrame(input: Uint8Array): CompanionFrame {
  const raw = input.slice();
  if (raw.length === 0) return invalid(raw, 'Empty companion notification');
  const opcode = raw[0] ?? -1;

  if (isDiscoveryResponseFrame(raw)) {
    if (raw.length < 10) return invalid(raw, 'Truncated discovery response header');
    const pubkeySize = raw.length - 10;
    if (pubkeySize !== 8 && pubkeySize !== 32) {
      return invalid(raw, `Discovery public key must be 8 or 32 bytes (received ${pubkeySize})`);
    }
    return {
      kind: 'discovery-response',
      opcode,
      raw,
      snr: signedByte(raw[1] ?? 0) / 4,
      rssi: signedByte(raw[2] ?? 0),
      pathLength: raw[3] ?? 0,
      advType: (raw[4] ?? 0) & 0x0f,
      uplinkSnr: signedByte(raw[5] ?? 0) / 4,
      tag: uint32LE(raw, 6),
      pubkeyHex: bytesToHex(raw.subarray(10)),
      pubkeySizeBytes: pubkeySize,
    };
  }

  if (
    opcode === CompanionOpcode.RxPacket ||
    opcode === CompanionOpcode.RxLog ||
    opcode === CompanionOpcode.ControlData
  ) {
    const loraOffset = opcode === CompanionOpcode.RxPacket ? 3 : 4;
    if (raw.length <= loraOffset) return invalid(raw, 'RX frame has no LoRa packet bytes');
    const lora = raw.slice(loraOffset);
    return {
      kind: 'rx',
      opcode,
      raw,
      snr: signedByte(raw[1] ?? 0) / 4,
      rssi: signedByte(raw[2] ?? 0),
      companionPathLen: opcode === CompanionOpcode.RxPacket ? undefined : raw[3],
      lora,
      loraHex: bytesToHex(lora),
    };
  }

  if (opcode === CompanionOpcode.Trace) {
    if (raw.length < 12) return invalid(raw, 'Truncated trace response header');
    const pathLength = raw[2] ?? 0;
    const required = 12 + pathLength + pathLength + 1;
    if (raw.length < required) return invalid(raw, 'Truncated trace path or SNR values');
    const pathBytes = raw.subarray(12, 12 + pathLength);
    const snrBytes = raw.subarray(12 + pathLength, required);
    return {
      kind: 'trace',
      opcode,
      raw,
      pathLength,
      tag: uint32LE(raw, 4),
      path: Array.from(pathBytes, (byte) => byte.toString(16).padStart(2, '0')),
      snrs: Array.from(snrBytes, (byte) => signedByte(byte) / 4),
    };
  }

  if (opcode === CompanionOpcode.SelfInfo) {
    if (raw.length < 44) return invalid(raw, 'Truncated SELF_INFO frame');
    return {
      kind: 'self-info',
      opcode,
      raw,
      advType: raw[1] ?? 0,
      txPower: signedByte(raw[2] ?? 0),
      maxTxPower: signedByte(raw[3] ?? 0),
      pubkeyHex: bytesToHex(raw.subarray(4, 36)),
      lat: int32LE(raw, 36) / 1_000_000,
      lon: int32LE(raw, 40) / 1_000_000,
    };
  }

  if (opcode === CompanionOpcode.Contact || opcode === CompanionOpcode.NewAdvert) {
    const contact = parseContact(raw);
    if (!contact) return invalid(raw, 'Truncated contact record');
    return {
      kind: 'contact',
      opcode,
      raw,
      source: opcode === CompanionOpcode.Contact ? 'sync' : 'push',
      contact,
    };
  }

  if (opcode === CompanionOpcode.ContactsStart) {
    return { kind: 'contacts-start', opcode, raw };
  }

  if (opcode === CompanionOpcode.ContactsEnd) {
    return {
      kind: 'contacts-end',
      opcode,
      raw,
      lastModified: raw.length >= 5 ? uint32LE(raw, 1) : 0,
    };
  }

  if (opcode === CompanionOpcode.Battery) {
    if (raw.length < 3) return invalid(raw, 'Truncated battery frame');
    return { kind: 'battery', opcode, raw, milliVolts: (raw[1] ?? 0) | ((raw[2] ?? 0) << 8) };
  }

  if (opcode === CompanionOpcode.DeviceInfo) {
    if (raw.length < 20) return invalid(raw, 'Truncated device information frame');
    return {
      kind: 'device-info',
      opcode,
      raw,
      fwVersion: signedByte(raw[1] ?? 0),
      reserved: raw.slice(2, 8),
      build: cString(raw, 8, 12),
      model: cString(raw, 20, Math.max(0, raw.length - 20)),
    };
  }

  return { kind: 'unknown', opcode, raw };
}
