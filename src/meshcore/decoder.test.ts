import { describe, expect, it } from 'vitest';

import { DecoderAdapter, decoderAdapter } from './decoder';
import { bytesToHex } from './frames';
import {
  assertPacketRoundTrip,
  buildAckPacket,
  buildAdvertPacket,
  buildAnonRequestPacket,
  buildGroupTextPacket,
  buildMeshCorePacket,
  buildPathPacket,
  buildRequestPacket,
  buildTextMessagePacket,
  buildTracePacket,
  TARGET_PUBLIC_KEY,
} from '../test/fixtures/packets';

describe('DecoderAdapter', () => {
  it('normalizes adverts, routes, paths, and locations', () => {
    const packet = buildAdvertPacket({
      routeType: 'transport-flood',
      path: ['a1b2', 'c3d4'],
      pathHashSize: 2,
      name: 'Lost repeater',
      lat: -33.8688,
      lon: 151.2093,
    });
    const decoded = decoderAdapter.decode(bytesToHex(packet));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.packet).toMatchObject({
      routeType: 'transport-flood',
      payloadType: 4,
      payloadTypeName: 'Advert',
      pathHashSize: 2,
      path: ['a1b2', 'c3d4'],
      advert: {
        pubkeyHex: TARGET_PUBLIC_KEY,
        name: 'Lost repeater',
        isRepeater: true,
        hasLocation: true,
        lat: -33.8688,
        lon: 151.2093,
      },
    });
  });

  it('extracts strong and weak origin identities', () => {
    const text = assertPacketRoundTrip(buildTextMessagePacket({ sourceHash: 0xa1, destinationHash: 0x42 }));
    expect(text).toMatchObject({ srcHashHex: 'a1', destHashHex: '42' });

    const anonymous = assertPacketRoundTrip(buildAnonRequestPacket());
    expect(anonymous.anonSenderPubkeyHex).toBe(TARGET_PUBLIC_KEY);
  });

  it('uses decoded trace hops but never decoded Path-payload hashes', () => {
    const trace = assertPacketRoundTrip(
      buildTracePacket({ traceHops: ['a1b2', 'c3d4'], traceHashSize: 2, headerSnrs: [-2, 3] }),
    );
    expect(trace.path).toEqual(['f8', '0c']);
    expect(trace.traceHops).toEqual(['a1b2', 'c3d4']);

    const path = assertPacketRoundTrip(
      buildPathPacket({ path: ['e5'], decodedPath: ['a1'], decodedPathHashSize: 1 }),
    );
    expect(path.path).toEqual(['e5']);
    expect(path.traceHops).toBeUndefined();
  });

  it('turns decoder invalid results and exceptions into data', () => {
    const rejected = new DecoderAdapter({
      decode: () => ({ isValid: false, errors: ['bad route'] }) as never,
    }).decode('aabb');
    expect(rejected).toEqual({ ok: false, error: 'bad route', rawHex: 'aabb' });

    const thrown = new DecoderAdapter({
      decode: () => {
        throw new Error('boom');
      },
    }).decode('AA BB');
    expect(thrown).toEqual({ ok: false, error: 'Decoder exception: boom', rawHex: 'aabb' });
  });

  it('rejects nested malformed typed payloads even when decoder top-level validity is true', () => {
    const malformedText = buildMeshCorePacket({
      payloadType: 2,
      payload: Uint8Array.of(1),
      validate: false,
    });
    const decoded = decoderAdapter.decode(bytesToHex(malformedText));
    expect(decoded.ok).toBe(false);
    expect(!decoded.ok && decoded.error).toContain('too short');
  });

  it('round-trips the programmatic fixture family through the real decoder', () => {
    const fixtures = [
      buildAdvertPacket(),
      buildTextMessagePacket(),
      buildRequestPacket(),
      buildAnonRequestPacket(),
      buildAckPacket(),
      buildGroupTextPacket(),
      buildTracePacket(),
      buildPathPacket(),
    ];
    for (const fixture of fixtures) expect(decoderAdapter.decode(bytesToHex(fixture)).ok).toBe(true);
  });

  it('rejects invalid hex without invoking the package', () => {
    expect(decoderAdapter.decode('abc')).toMatchObject({ ok: false });
    expect(decoderAdapter.decode('zz')).toMatchObject({ ok: false });
  });
});
