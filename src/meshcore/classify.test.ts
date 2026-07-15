import { describe, expect, it } from 'vitest';

import { classify, reclassifyAll } from './classify';
import { decoderAdapter } from './decoder';
import { bytesToHex } from './frames';
import { IdentityUniverse } from './identity';
import type { NormalizedPacket, TargetIdentity } from '../types';
import {
  COLLIDING_PUBLIC_KEY,
  OTHER_PUBLIC_KEY,
  TARGET_PUBLIC_KEY,
  buildAckPacket,
  buildAdvertPacket,
  buildMeshCorePacket,
  buildPathPacket,
  buildRawPacket,
  buildTextMessagePacket,
  buildTracePacket,
} from '../test/fixtures/packets';

const FULL_TARGET: TargetIdentity = { kind: 'full-pubkey', pubkeyHex: TARGET_PUBLIC_KEY };

function decode(packet: Uint8Array): NormalizedPacket {
  const result = decoderAdapter.decode(bytesToHex(packet));
  if (!result.ok) throw new Error(result.error);
  return result.packet;
}

function universe(...keys: Array<[string, string?]>): IdentityUniverse {
  const value = new IdentityUniverse();
  value.observe(TARGET_PUBLIC_KEY, 'Target');
  for (const [key, name] of keys) value.observe(key, name);
  return value;
}

function classifyPacket(
  packet: Uint8Array,
  target: TargetIdentity = FULL_TARGET,
  identities = universe(),
) {
  return classify({ packet: decode(packet), target, universe: identities });
}

describe('classification precedence', () => {
  it('retains decoder failure as an explicit non-confirmed reception', () => {
    expect(
      classify({ decodeError: 'reserved path width', target: FULL_TARGET, universe: universe() }),
    ).toMatchObject({
      kind: 'DECODE_FAILED',
      confirmed: false,
      identityTier: 'none',
    });
  });

  it('confirms a zero-hop flood advert from the full target', () => {
    expect(classifyPacket(buildAdvertPacket())).toMatchObject({
      kind: 'DIRECT_TARGET',
      confirmed: true,
      identityTier: 'full-pubkey',
      flags: { zeroHop: true, originIsTarget: true },
    });
  });

  it('never infers an immediate transmitter from direct-route instructions', () => {
    const direct = classifyPacket(buildAdvertPacket({ routeType: 'direct', path: ['e5'] }));
    expect(direct).toMatchObject({
      kind: 'UNKNOWN_TRANSMITTER',
      confirmed: false,
      flags: { originIsTarget: true },
    });
    expect(direct.explanation).toContain('remaining routing instructions');
  });

  it('separates target-origin forwarded packets from immediate target transmissions', () => {
    const identities = universe([OTHER_PUBLIC_KEY, 'Other']);
    const forwarded = classifyPacket(
      buildAdvertPacket({ pubkeyHex: TARGET_PUBLIC_KEY, path: ['e5'] }),
      FULL_TARGET,
      identities,
    );
    expect(forwarded).toMatchObject({
      kind: 'TARGET_ORIGIN_BUT_FORWARDED',
      confirmed: false,
      immediateTx: { hashHex: 'e5', knownAs: 'Other' },
    });

    const targetLast = classifyPacket(
      buildAdvertPacket({ pubkeyHex: OTHER_PUBLIC_KEY, path: ['a1'] }),
      FULL_TARGET,
      identities,
    );
    expect(targetLast).toMatchObject({
      kind: 'TARGET_IS_IMMEDIATE_TRANSMITTER',
      confirmed: true,
      immediateTx: { hashHex: 'a1', knownAs: 'Target' },
    });
  });

  it('distinguishes an earlier target hop from the final transmitter', () => {
    const classified = classifyPacket(
      buildAdvertPacket({ pubkeyHex: OTHER_PUBLIC_KEY, path: ['a1', 'e5'] }),
      FULL_TARGET,
      universe([OTHER_PUBLIC_KEY, 'Other']),
    );
    expect(classified).toMatchObject({
      kind: 'TARGET_IN_PATH_BUT_NOT_IMMEDIATE',
      confirmed: false,
      flags: { targetInPath: true },
      immediateTx: { hashHex: 'e5' },
    });
  });

  it('caps prefix-only and name-only target matches at ambiguous', () => {
    expect(
      classifyPacket(buildAdvertPacket(), { kind: 'prefix', bytesHex: 'a1' }),
    ).toMatchObject({ kind: 'AMBIGUOUS_PREFIX', confirmed: false, identityTier: 'prefix' });
    expect(
      classifyPacket(buildAdvertPacket({ name: 'Lost repeater' }), {
        kind: 'name-only',
        name: 'lost repeater',
      }),
    ).toMatchObject({ kind: 'AMBIGUOUS_PREFIX', confirmed: false, identityTier: 'name' });
  });

  it('allows a collision-free node ID but blocks it after a universe collision', () => {
    const target: TargetIdentity = { kind: 'node-id', bytesHex: 'a1b2c3d4' };
    expect(classifyPacket(buildAdvertPacket(), target)).toMatchObject({
      kind: 'DIRECT_TARGET',
      identityTier: 'node-id',
    });
    const colliding = universe([COLLIDING_PUBLIC_KEY, 'Collision']);
    expect(classifyPacket(buildAdvertPacket(), target, colliding)).toMatchObject({
      kind: 'AMBIGUOUS_PREFIX',
      confirmed: false,
      identityTier: 'node-id',
    });
  });

  it('treats one-byte source hashes as disproof or ambiguity, never confirmation', () => {
    expect(classifyPacket(buildTextMessagePacket({ sourceHash: 0xe5 }))).toMatchObject({
      kind: 'NON_TARGET',
      confirmed: false,
      identityTier: 'prefix',
    });
    expect(classifyPacket(buildTextMessagePacket({ sourceHash: 0xa1 }))).toMatchObject({
      kind: 'AMBIGUOUS_PREFIX',
      confirmed: false,
      identityTier: 'prefix',
    });
  });

  it('uses Trace payload hops and ignores Path payload decoded hashes', () => {
    const trace = classifyPacket(
      buildTracePacket({ traceHops: ['e5', 'a1'], headerSnrs: [-5, 2] }),
    );
    expect(trace.kind).toBe('TARGET_IS_IMMEDIATE_TRANSMITTER');

    const path = classifyPacket(buildPathPacket({ path: ['e5'], decodedPath: ['a1'] }));
    expect(path.kind).toBe('NON_TARGET');
    expect(path.immediateTx?.hashHex).toBe('e5');
  });

  it('keeps no-identity and unknown payloads unconfirmed', () => {
    expect(classifyPacket(buildAckPacket())).toMatchObject({ kind: 'UNKNOWN_TRANSMITTER', confirmed: false });
    const unknown = buildMeshCorePacket({ payloadType: 14, payload: Uint8Array.of(0xaa) });
    expect(classifyPacket(unknown)).toMatchObject({ kind: 'UNKNOWN_TRANSMITTER', confirmed: false });
    expect(classifyPacket(buildRawPacket({ path: ['e5'] }))).toMatchObject({ kind: 'NON_TARGET' });
  });

  it('reclassifies old confirmed hashes when a retro-collision appears', () => {
    const identities = universe();
    const packet = decode(buildAdvertPacket({ pubkeyHex: OTHER_PUBLIC_KEY, path: ['a1'] }));
    expect(classify({ packet, target: FULL_TARGET, universe: identities }).kind).toBe(
      'TARGET_IS_IMMEDIATE_TRANSMITTER',
    );
    identities.observe(COLLIDING_PUBLIC_KEY, 'Collision');
    const [updated] = reclassifyAll([{ packet }], FULL_TARGET, identities);
    expect(updated).toMatchObject({ kind: 'AMBIGUOUS_PREFIX', confirmed: false });
    expect(updated?.collisions).toHaveLength(2);
  });

  it('classifies duplicate message hashes independently by received path', () => {
    const direct = decode(buildAdvertPacket());
    const forwarded = decode(buildAdvertPacket({ path: ['e5'] }));
    expect(direct.hashHex).toBe(forwarded.hashHex);
    expect(classify({ packet: direct, target: FULL_TARGET, universe: universe() }).kind).toBe('DIRECT_TARGET');
    expect(classify({ packet: forwarded, target: FULL_TARGET, universe: universe() }).kind).toBe(
      'TARGET_ORIGIN_BUT_FORWARDED',
    );
  });
});
