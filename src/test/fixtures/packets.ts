import type { NormalizedPacket, RouteType } from '../../types';
import { decoderAdapter } from '../../meshcore/decoder';
import { bytesToHex, hexToBytes } from '../../meshcore/frames';

export const TARGET_PUBLIC_KEY =
  'a1b2c3d40102030405060708090a0b0c0d0e0f101112131415161718191a1b1c';
export const OTHER_PUBLIC_KEY =
  'e5f60718292a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4';
export const COLLIDING_PUBLIC_KEY =
  'a1b2c3d4ffeeddccbbaa99887766554433221100ffeeddccbbaa998877665544';

const ROUTE_CODES: Record<RouteType, number> = {
  'transport-flood': 0,
  flood: 1,
  direct: 2,
  'transport-direct': 3,
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function uint32LE(value: number): Uint8Array {
  const normalized = value >>> 0;
  return Uint8Array.of(
    normalized & 0xff,
    (normalized >>> 8) & 0xff,
    (normalized >>> 16) & 0xff,
    (normalized >>> 24) & 0xff,
  );
}

function int32LE(value: number): Uint8Array {
  return uint32LE(value | 0);
}

function pathBytes(path: readonly string[], hashSize: 1 | 2 | 3): Uint8Array {
  const result = new Uint8Array(path.length * hashSize);
  path.forEach((hash, index) => {
    const bytes = hexToBytes(hash);
    if (bytes.length !== hashSize) throw new RangeError(`Each path hash must be ${hashSize} byte(s)`);
    result.set(bytes, index * hashSize);
  });
  return result;
}

export interface PacketBuilderOptions {
  routeType?: RouteType;
  payloadType: number;
  payloadVersion?: number;
  path?: string[];
  pathHashSize?: 1 | 2 | 3;
  transportCodes?: [number, number];
  payload: Uint8Array;
  validate?: boolean;
}

export function buildMeshCorePacket(options: PacketBuilderOptions): Uint8Array {
  const routeType = options.routeType ?? 'flood';
  const routeCode = ROUTE_CODES[routeType];
  const payloadVersion = options.payloadVersion ?? 0;
  const path = options.path ?? [];
  const pathHashSize = options.pathHashSize ?? 1;
  if (path.length > 63) throw new RangeError('MeshCore paths contain at most 63 hops');
  const header = (routeCode & 0x03) | ((options.payloadType & 0x0f) << 2) | ((payloadVersion & 0x03) << 6);
  const transport =
    routeType === 'transport-flood' || routeType === 'transport-direct'
      ? concat(
          Uint8Array.of(
            (options.transportCodes?.[0] ?? 0x1234) & 0xff,
            ((options.transportCodes?.[0] ?? 0x1234) >>> 8) & 0xff,
            (options.transportCodes?.[1] ?? 0x5678) & 0xff,
            ((options.transportCodes?.[1] ?? 0x5678) >>> 8) & 0xff,
          ),
        )
      : new Uint8Array();
  const pathLengthByte = ((pathHashSize - 1) << 6) | path.length;
  const packet = concat(
    Uint8Array.of(header),
    transport,
    Uint8Array.of(pathLengthByte),
    pathBytes(path, pathHashSize),
    options.payload,
  );
  if (options.validate !== false) assertPacketRoundTrip(packet, { routeType, payloadType: options.payloadType });
  return packet;
}

export interface CommonPacketOptions {
  routeType?: RouteType;
  path?: string[];
  pathHashSize?: 1 | 2 | 3;
}

export interface AdvertPacketOptions extends CommonPacketOptions {
  pubkeyHex?: string;
  name?: string;
  role?: number;
  timestamp?: number;
  lat?: number;
  lon?: number;
}

export function buildAdvertPacket(options: AdvertPacketOptions = {}): Uint8Array {
  const publicKey = hexToBytes(options.pubkeyHex ?? TARGET_PUBLIC_KEY);
  if (publicKey.length !== 32) throw new RangeError('Advert public key must be 32 bytes');
  const hasLocation = options.lat !== undefined && options.lon !== undefined;
  const hasName = options.name !== undefined;
  const flags = (options.role ?? 2) | (hasLocation ? 0x10 : 0) | (hasName ? 0x80 : 0);
  const payload = concat(
    publicKey,
    uint32LE(options.timestamp ?? 1_700_000_000),
    new Uint8Array(64),
    Uint8Array.of(flags),
    hasLocation
      ? concat(
          int32LE(Math.round((options.lat as number) * 1_000_000)),
          int32LE(Math.round((options.lon as number) * 1_000_000)),
        )
      : new Uint8Array(),
    hasName ? concat(new TextEncoder().encode(options.name), Uint8Array.of(0)) : new Uint8Array(),
  );
  const packet = buildMeshCorePacket({ ...options, payloadType: 4, payload });
  assertPacketRoundTrip(packet, {
    routeType: options.routeType ?? 'flood',
    payloadType: 4,
    advertPubkeyHex: bytesToHex(publicKey),
  });
  return packet;
}

export interface TextPacketOptions extends CommonPacketOptions {
  sourceHash?: number;
  destinationHash?: number;
  ciphertext?: Uint8Array;
}

export function buildTextMessagePacket(options: TextPacketOptions = {}): Uint8Array {
  return buildMeshCorePacket({
    ...options,
    payloadType: 2,
    payload: concat(
      Uint8Array.of(options.destinationHash ?? 0x42, options.sourceHash ?? 0xa1, 0x12, 0x34),
      options.ciphertext ?? Uint8Array.of(0xaa),
    ),
  });
}

export function buildRequestPacket(options: TextPacketOptions = {}): Uint8Array {
  return buildMeshCorePacket({
    ...options,
    payloadType: 0,
    payload: concat(
      Uint8Array.of(options.destinationHash ?? 0x42, options.sourceHash ?? 0xa1, 0x12, 0x34),
      options.ciphertext ?? Uint8Array.of(0xaa),
    ),
  });
}

export interface AnonRequestPacketOptions extends CommonPacketOptions {
  senderPubkeyHex?: string;
  destinationHash?: number;
}

export function buildAnonRequestPacket(options: AnonRequestPacketOptions = {}): Uint8Array {
  const sender = hexToBytes(options.senderPubkeyHex ?? TARGET_PUBLIC_KEY);
  if (sender.length !== 32) throw new RangeError('Anonymous-request sender key must be 32 bytes');
  return buildMeshCorePacket({
    ...options,
    payloadType: 7,
    payload: concat(Uint8Array.of(options.destinationHash ?? 0x42), sender, Uint8Array.of(0x12, 0x34, 0xaa)),
  });
}

export function buildAckPacket(options: CommonPacketOptions = {}): Uint8Array {
  return buildMeshCorePacket({ ...options, payloadType: 3, payload: Uint8Array.of(0xde, 0xad, 0xbe, 0xef) });
}

export function buildGroupTextPacket(options: CommonPacketOptions = {}): Uint8Array {
  return buildMeshCorePacket({ ...options, payloadType: 5, payload: Uint8Array.of(0x42, 0x12, 0x34, 0xaa) });
}

export interface TracePacketOptions extends Omit<CommonPacketOptions, 'pathHashSize'> {
  traceHops?: string[];
  traceHashSize?: 1 | 2 | 4 | 8;
  headerSnrs?: number[];
  tag?: number;
}

export function buildTracePacket(options: TracePacketOptions = {}): Uint8Array {
  const traceHashSize = options.traceHashSize ?? 1;
  const selector = Math.log2(traceHashSize);
  if (!Number.isInteger(selector) || selector < 0 || selector > 3) {
    throw new RangeError('Trace hashes must be 1, 2, 4, or 8 bytes');
  }
  const traceHops = options.traceHops ?? ['a1'];
  const tracePath = concat(...traceHops.map((hop) => {
    const bytes = hexToBytes(hop);
    if (bytes.length !== traceHashSize) throw new RangeError('Trace-hop width does not match traceHashSize');
    return bytes;
  }));
  const headerPath = (options.headerSnrs ?? []).map((snr) =>
    ((Math.round(snr * 4) % 256) + 256).toString(16).slice(-2),
  );
  return buildMeshCorePacket({
    routeType: options.routeType,
    path: headerPath,
    pathHashSize: 1,
    payloadType: 9,
    payload: concat(uint32LE(options.tag ?? 0x1234_5678), uint32LE(0), Uint8Array.of(selector), tracePath),
  });
}

export interface PathPacketOptions extends CommonPacketOptions {
  decodedPath?: string[];
  decodedPathHashSize?: 1 | 2 | 3;
}

export function buildPathPacket(options: PathPacketOptions = {}): Uint8Array {
  const decodedPath = options.decodedPath ?? ['ff'];
  const decodedSize = options.decodedPathHashSize ?? 1;
  return buildMeshCorePacket({
    routeType: options.routeType,
    path: options.path,
    pathHashSize: options.pathHashSize,
    payloadType: 8,
    payload: concat(
      Uint8Array.of(((decodedSize - 1) << 6) | decodedPath.length),
      pathBytes(decodedPath, decodedSize),
      Uint8Array.of(15, 0xaa),
    ),
  });
}

export function buildRawPacket(options: CommonPacketOptions & { payload?: Uint8Array } = {}): Uint8Array {
  return buildMeshCorePacket({ ...options, payloadType: 15, payload: options.payload ?? Uint8Array.of(0xaa) });
}

export interface ExpectedRoundTrip {
  routeType?: RouteType;
  payloadType?: number;
  advertPubkeyHex?: string;
}

export function assertPacketRoundTrip(packet: Uint8Array, expected: ExpectedRoundTrip = {}): NormalizedPacket {
  const decoded = decoderAdapter.decode(bytesToHex(packet));
  if (!decoded.ok) throw new Error(`Invalid fixture packet: ${decoded.error}`);
  if (expected.routeType !== undefined && decoded.packet.routeType !== expected.routeType) {
    throw new Error(`Fixture route mismatch: ${decoded.packet.routeType} !== ${expected.routeType}`);
  }
  if (expected.payloadType !== undefined && decoded.packet.payloadType !== expected.payloadType) {
    throw new Error(`Fixture payload mismatch: ${decoded.packet.payloadType} !== ${expected.payloadType}`);
  }
  if (
    expected.advertPubkeyHex !== undefined &&
    decoded.packet.advert?.pubkeyHex !== expected.advertPubkeyHex.toLowerCase()
  ) {
    throw new Error('Fixture advert public key did not round-trip');
  }
  return decoded.packet;
}
