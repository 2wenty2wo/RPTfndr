import { MeshCoreDecoder } from '@michaelhart/meshcore-decoder';
import type { DecodedPacket } from '@michaelhart/meshcore-decoder';

import type { NormalizedPacket, RouteType } from '../types';

export const DECODER_VERSION = '0.3.0';

export interface DecodeSuccess {
  ok: true;
  packet: NormalizedPacket;
}

export interface DecodeFailure {
  ok: false;
  error: string;
  /** Canonical input retained for diagnostics and lossless reception storage. */
  rawHex: string;
}

export type DecodeResult = DecodeSuccess | DecodeFailure;

export interface DecoderImplementation {
  decode(hex: string): DecodedPacket;
}

const ROUTE_NAMES: Record<number, RouteType | undefined> = {
  0: 'transport-flood',
  1: 'flood',
  2: 'direct',
  3: 'transport-direct',
};

const PAYLOAD_NAMES: Record<number, string | undefined> = {
  0: 'Request',
  1: 'Response',
  2: 'TextMsg',
  3: 'Ack',
  4: 'Advert',
  5: 'GroupText',
  6: 'GroupData',
  7: 'AnonRequest',
  8: 'Path',
  9: 'Trace',
  10: 'Multipart',
  11: 'Control',
  15: 'RawCustom',
};

function canonicalHex(value: string): string {
  return value.trim().replace(/^0x/i, '').replace(/[\s:_-]/g, '').toLowerCase();
}

function packetError(decoded: DecodedPacket): string | undefined {
  if (!decoded.isValid) return decoded.errors?.join('; ') || 'Decoder rejected the packet';
  const payload = decoded.payload.decoded as { isValid?: unknown; errors?: unknown } | null;
  // meshcore-decoder 0.3.0 currently leaves the top-level flag true for some
  // malformed typed payloads. Treat the nested validity flag as authoritative.
  if (payload?.isValid === false) {
    return Array.isArray(payload.errors)
      ? payload.errors.map(String).join('; ')
      : 'Decoder rejected the packet payload';
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? canonicalHex(value) : undefined;
}

function normalize(decoded: DecodedPacket): NormalizedPacket {
  const routeType = ROUTE_NAMES[decoded.routeType];
  if (!routeType) throw new Error(`Unsupported route type ${String(decoded.routeType)}`);

  const payload = decoded.payload.decoded as Record<string, unknown> | null;
  const appData = payload?.appData as Record<string, unknown> | undefined;
  const location = appData?.location as Record<string, unknown> | undefined;
  const warnings = [...(decoded.errors ?? [])];
  const nestedErrors = payload?.errors;
  if (Array.isArray(nestedErrors)) warnings.push(...nestedErrors.map(String));

  const packet: NormalizedPacket = {
    hashHex: canonicalHex(decoded.messageHash),
    routeType,
    payloadType: decoded.payloadType,
    payloadTypeName: PAYLOAD_NAMES[decoded.payloadType] ?? `Unknown(${decoded.payloadType})`,
    payloadVersion: decoded.payloadVersion,
    pathHashSize: decoded.pathHashSize,
    path: (decoded.path ?? []).map(canonicalHex),
    warnings,
    totalBytes: decoded.totalBytes,
    rawDecoded: decoded,
  };

  if (decoded.payloadType === 4 && payload) {
    const pubkeyHex = stringField(payload.publicKey);
    if (pubkeyHex) {
      packet.advert = {
        pubkeyHex,
        name: typeof appData?.name === 'string' ? appData.name : undefined,
        isRepeater: appData?.deviceRole === 2,
        hasLocation: appData?.hasLocation === true,
        lat: typeof location?.latitude === 'number' ? location.latitude : undefined,
        lon: typeof location?.longitude === 'number' ? location.longitude : undefined,
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : undefined,
      };
    }
  }

  if (decoded.payloadType === 7) packet.anonSenderPubkeyHex = stringField(payload?.senderPublicKey);

  if (decoded.payloadType === 0 || decoded.payloadType === 1 || decoded.payloadType === 2) {
    packet.srcHashHex = stringField(payload?.sourceHash);
    packet.destHashHex = stringField(payload?.destinationHash);
  }

  if (decoded.payloadType === 9 && Array.isArray(payload?.pathHashes)) {
    packet.traceHops = payload.pathHashes
      .filter((item): item is string => typeof item === 'string')
      .map(canonicalHex);
  }

  // Path payload (type 8) deliberately does not copy decoded.pathHashes. Those
  // bytes can be ciphertext; classification uses only the packet header path.
  return packet;
}

export class DecoderAdapter {
  readonly version = DECODER_VERSION;

  constructor(private readonly implementation: DecoderImplementation = MeshCoreDecoder) {}

  decode(inputHex: string): DecodeResult {
    const rawHex = canonicalHex(inputHex);
    if (rawHex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(rawHex)) {
      return { ok: false, error: 'Packet is not valid hexadecimal', rawHex };
    }

    try {
      const decoded = this.implementation.decode(rawHex);
      const error = packetError(decoded);
      if (error) return { ok: false, error, rawHex };
      return { ok: true, packet: normalize(decoded) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error: `Decoder exception: ${message}`, rawHex };
    }
  }
}

export const decoderAdapter = new DecoderAdapter();
