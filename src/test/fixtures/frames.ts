import { hexToBytes } from '../../meshcore/frames';
import { TARGET_PUBLIC_KEY } from './packets';

function int8(value: number): number {
  return ((Math.round(value) % 256) + 256) % 256;
}
function encodedSnr(value: number): number {
  return int8(value * 4);
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  const normalized = value >>> 0;
  target[offset] = normalized & 0xff;
  target[offset + 1] = (normalized >>> 8) & 0xff;
  target[offset + 2] = (normalized >>> 16) & 0xff;
  target[offset + 3] = (normalized >>> 24) & 0xff;
}

function writeInt32LE(target: Uint8Array, offset: number, value: number): void {
  writeUint32LE(target, offset, value | 0);
}

function writeText(target: Uint8Array, offset: number, length: number, text: string): void {
  target.set(new TextEncoder().encode(text).subarray(0, length), offset);
}

export interface RxFrameOptions {
  snr?: number;
  rssi?: number;
  companionPathLen?: number;
}

export function buildRx88Frame(lora: Uint8Array, options: RxFrameOptions = {}): Uint8Array {
  const frame = new Uint8Array(3 + lora.length);
  frame.set([0x88, encodedSnr(options.snr ?? 2.5), int8(options.rssi ?? -91)]);
  frame.set(lora, 3);
  return frame;
}

export function buildRx84Frame(lora: Uint8Array, options: RxFrameOptions = {}): Uint8Array {
  const frame = new Uint8Array(4 + lora.length);
  frame.set([
    0x84,
    encodedSnr(options.snr ?? 2.5),
    int8(options.rssi ?? -91),
    options.companionPathLen ?? 0,
  ]);
  frame.set(lora, 4);
  return frame;
}

export function buildRx8eFrame(lora: Uint8Array, options: RxFrameOptions = {}): Uint8Array {
  const frame = buildRx84Frame(lora, options);
  frame[0] = 0x8e;
  return frame;
}

export interface DiscoveryFrameOptions extends RxFrameOptions {
  advType?: number;
  uplinkSnr?: number;
  tag?: number;
  pubkeyHex?: string;
}

export function buildDiscoveryResponseFrame(options: DiscoveryFrameOptions = {}): Uint8Array {
  const publicKey = hexToBytes(options.pubkeyHex ?? TARGET_PUBLIC_KEY);
  if (publicKey.length !== 8 && publicKey.length !== 32) {
    throw new RangeError('Discovery response keys must be 8 or 32 bytes');
  }
  const frame = new Uint8Array(10 + publicKey.length);
  frame.set([
    0x8e,
    encodedSnr(options.snr ?? 3),
    int8(options.rssi ?? -88),
    options.companionPathLen ?? 0,
    0x90 | ((options.advType ?? 2) & 0x0f),
    encodedSnr(options.uplinkSnr ?? -1.5),
  ]);
  writeUint32LE(frame, 6, options.tag ?? 0x1234_5678);
  frame.set(publicKey, 10);
  return frame;
}

export interface SelfInfoFrameOptions {
  advType?: number;
  txPower?: number;
  maxTxPower?: number;
  pubkeyHex?: string;
  lat?: number;
  lon?: number;
}

export function buildSelfInfoFrame(options: SelfInfoFrameOptions = {}): Uint8Array {
  const publicKey = hexToBytes(options.pubkeyHex ?? OTHER_PUBLIC_KEY_FOR_COMPANION);
  if (publicKey.length !== 32) throw new RangeError('SELF_INFO public key must be 32 bytes');
  const frame = new Uint8Array(44);
  frame.set([
    0x05,
    options.advType ?? 1,
    int8(options.txPower ?? 20),
    int8(options.maxTxPower ?? 22),
  ]);
  frame.set(publicKey, 4);
  writeInt32LE(frame, 36, Math.round((options.lat ?? -33.8688) * 1_000_000));
  writeInt32LE(frame, 40, Math.round((options.lon ?? 151.2093) * 1_000_000));
  return frame;
}

export const OTHER_PUBLIC_KEY_FOR_COMPANION =
  '102030405060708090a0b0c0d0e0f00112233445566778899aabbccddeeff001';

export interface ContactFrameOptions {
  opcode?: 0x03 | 0x8a;
  pubkeyHex?: string;
  type?: number;
  flags?: number;
  pathLength?: number;
  outPathHex?: string;
  name?: string;
  lastAdvert?: number;
  lat?: number;
  lon?: number;
  lastModified?: number;
}

export function buildContactFrame(options: ContactFrameOptions = {}): Uint8Array {
  const publicKey = hexToBytes(options.pubkeyHex ?? TARGET_PUBLIC_KEY);
  if (publicKey.length !== 32) throw new RangeError('Contact public key must be 32 bytes');
  const outPath = options.outPathHex ? hexToBytes(options.outPathHex) : new Uint8Array();
  if (outPath.length > 64) throw new RangeError('Contact out-path is at most 64 bytes');
  const frame = new Uint8Array(148);
  frame[0] = options.opcode ?? 0x03;
  frame.set(publicKey, 1);
  frame[33] = options.type ?? 2;
  frame[34] = options.flags ?? 0;
  frame[35] = options.pathLength ?? outPath.length;
  frame.set(outPath, 36);
  writeText(frame, 100, 31, options.name ?? 'Lost repeater');
  writeUint32LE(frame, 132, options.lastAdvert ?? 1_700_000_000);
  writeInt32LE(frame, 136, Math.round((options.lat ?? -33.87) * 1_000_000));
  writeInt32LE(frame, 140, Math.round((options.lon ?? 151.21) * 1_000_000));
  writeUint32LE(frame, 144, options.lastModified ?? 1234);
  return frame;
}

export function buildContactsStartFrame(): Uint8Array {
  return Uint8Array.of(0x02);
}

export function buildContactsEndFrame(lastModified = 1234): Uint8Array {
  const frame = new Uint8Array(5);
  frame[0] = 0x04;
  writeUint32LE(frame, 1, lastModified);
  return frame;
}

export function buildBatteryFrame(milliVolts = 4_075): Uint8Array {
  return Uint8Array.of(0x0c, milliVolts & 0xff, (milliVolts >>> 8) & 0xff);
}

export interface DeviceInfoFrameOptions {
  fwVersion?: number;
  build?: string;
  model?: string;
}

export function buildDeviceInfoFrame(options: DeviceInfoFrameOptions = {}): Uint8Array {
  const model = new TextEncoder().encode(options.model ?? 'T-Deck Plus');
  const frame = new Uint8Array(20 + model.length + 1);
  frame[0] = 0x0d;
  frame[1] = int8(options.fwVersion ?? 7);
  writeText(frame, 8, 11, options.build ?? 'v1.11.0');
  frame.set(model, 20);
  return frame;
}

export interface TracePushFrameOptions {
  tag?: number;
  path?: number[];
  snrs?: number[];
}

export function buildTracePushFrame(options: TracePushFrameOptions = {}): Uint8Array {
  const path = options.path ?? [0xa1, 0xb2];
  const snrs = options.snrs ?? [1, -2, 3.25];
  if (snrs.length !== path.length + 1) throw new RangeError('Trace push needs pathLength + 1 SNRs');
  const frame = new Uint8Array(12 + path.length + snrs.length);
  frame[0] = 0x89;
  frame[2] = path.length;
  writeUint32LE(frame, 4, options.tag ?? 0x1234_5678);
  frame.set(path, 12);
  frame.set(snrs.map(encodedSnr), 12 + path.length);
  return frame;
}
