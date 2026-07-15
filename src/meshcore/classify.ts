import type {
  ClassificationResult,
  IdentityTier,
  NormalizedPacket,
  TargetIdentity,
  TargetProfile,
} from '../types';
import type { DiscoveryResponseFrame } from './frames';
import {
  matchTargetEvidence,
  matchTargetOrigin,
  normalizeHex,
  targetBytes,
  targetTier,
  type IdentityUniverse,
  type UniverseIdentity,
} from './identity';

export interface ClassificationInput {
  packet?: NormalizedPacket;
  decodeError?: string;
  target: TargetIdentity | TargetProfile;
  universe: IdentityUniverse;
}

interface OriginEvidence {
  pubkeyHex?: string;
  srcHashHex?: string;
  name?: string;
}

function identityOf(target: TargetIdentity | TargetProfile): TargetIdentity {
  return 'identity' in target ? target.identity : target;
}

function result(
  kind: ClassificationResult['kind'],
  explanation: string,
  identityTier: IdentityTier,
  options: Omit<ClassificationResult, 'kind' | 'confirmed' | 'explanation' | 'identityTier'>,
): ClassificationResult {
  return {
    kind,
    confirmed: kind === 'DIRECT_TARGET' || kind === 'TARGET_IS_IMMEDIATE_TRANSMITTER',
    explanation,
    identityTier,
    ...options,
  };
}

function originOf(packet: NormalizedPacket): OriginEvidence {
  if (packet.advert) {
    return { pubkeyHex: packet.advert.pubkeyHex, name: packet.advert.name };
  }
  if (packet.anonSenderPubkeyHex) return { pubkeyHex: packet.anonSenderPubkeyHex };
  if (packet.srcHashHex) return { srcHashHex: packet.srcHashHex };
  return {};
}

function classificationCollisions(
  evidence: string,
  target: TargetIdentity,
  universe: IdentityUniverse,
): UniverseIdentity[] {
  const normalized = normalizeHex(evidence);
  const candidates = universe
    .matching(normalized)
    .filter((candidate) => candidate.pubkeyHex?.length === 64);
  const targetPubkey = target.kind === 'full-pubkey' ? targetBytes(target) : undefined;
  if (targetPubkey?.startsWith(normalized) && !candidates.some((item) => item.pubkeyHex === targetPubkey)) {
    candidates.push({
      id: targetPubkey,
      bytesHex: targetPubkey,
      pubkeyHex: targetPubkey,
      name: target.name,
      sources: ['target'],
    });
  }
  const distinct = new Set(candidates.map((candidate) => candidate.pubkeyHex));
  return distinct.size >= 2 ? candidates : [];
}

function collisionOutput(candidates: UniverseIdentity[]): ClassificationResult['collisions'] {
  const seen = new Set<string>();
  const output: NonNullable<ClassificationResult['collisions']> = [];
  for (const candidate of candidates) {
    const identity = candidate.pubkeyHex ?? candidate.bytesHex;
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push({ hashHex: identity.slice(0, 8), knownAs: candidate.name });
  }
  return output.length > 0 ? output : undefined;
}

function originMetadata(origin: OriginEvidence): ClassificationResult['origin'] | undefined {
  if (!origin.pubkeyHex && !origin.srcHashHex && !origin.name) return undefined;
  return origin;
}

function transmitter(hashHex: string, universe: IdentityUniverse): NonNullable<ClassificationResult['immediateTx']> {
  return {
    hashHex,
    sizeBytes: hashHex.length / 2,
    knownAs: universe.knownAs(hashHex),
  };
}

/** Implements the documented precedence table. This function is deliberately pure. */
export function classify(input: ClassificationInput): ClassificationResult {
  const target = identityOf(input.target);
  const packet = input.packet;
  if (!packet) {
    return result(
      'DECODE_FAILED',
      input.decodeError ? `Packet decode failed: ${input.decodeError}` : 'Packet decode failed.',
      'none',
      { flags: {} },
    );
  }

  if (!['flood', 'transport-flood', 'direct', 'transport-direct'].includes(packet.routeType)) {
    return result('DECODE_FAILED', `Decoder returned an unsupported route: ${String(packet.routeType)}`, 'none', {
      flags: {},
    });
  }

  // Trace payload path hashes are real hops. Its header path contains SNR
  // values. For every other payload, including Path (8), use the header path.
  const isTrace = packet.payloadType === 9;
  const hops = (isTrace ? packet.traceHops ?? [] : packet.path).map((hop) => normalizeHex(hop));
  const origin = originOf(packet);
  const fullOrigin = origin.pubkeyHex;
  const originMatch = fullOrigin
    ? matchTargetOrigin(target, fullOrigin, origin.name, input.universe)
    : { matches: false, tier: targetTier(target), strong: false, collision: false };
  const flags: ClassificationResult['flags'] = {
    originIsTarget: originMatch.matches || undefined,
  };

  if ((packet.routeType === 'direct' || packet.routeType === 'transport-direct') && !isTrace) {
    const note = originMatch.matches
      ? ' The payload origin matches the target, but a direct route still does not prove the immediate RF transmitter.'
      : '';
    return result(
      'UNKNOWN_TRANSMITTER',
      `Direct-route paths are remaining routing instructions, so the immediate transmitter cannot be proven.${note}`,
      originMatch.matches ? originMatch.tier : fullOrigin ? 'full-pubkey' : 'none',
      { origin: originMetadata(origin), flags },
    );
  }

  if (hops.length === 0) {
    flags.zeroHop = true;
    if (fullOrigin) {
      const collisions = originMatch.matches
        ? classificationCollisions(
            target.kind === 'full-pubkey' ? fullOrigin : targetBytes(target) ?? fullOrigin,
            target,
            input.universe,
          )
        : [];
      if (originMatch.matches && originMatch.strong && collisions.length === 0) {
        return result(
          'DIRECT_TARGET',
          'A zero-hop flood packet identifies the target as the RF originator.',
          originMatch.tier,
          { origin: originMetadata(origin), flags },
        );
      }
      if (originMatch.matches) {
        return result(
          'AMBIGUOUS_PREFIX',
          originMatch.collision || collisions.length > 0
            ? 'The zero-hop origin matches the target identifier, but that identifier collides in the known identity universe.'
            : 'The zero-hop origin only matches a weak target identifier. Pin the full public key before using it for location.',
          originMatch.tier,
          { origin: originMetadata(origin), collisions: collisionOutput(collisions), flags },
        );
      }
      return result('NON_TARGET', 'The zero-hop packet has a full origin identity that does not match the target.', 'full-pubkey', {
        origin: originMetadata(origin),
        flags,
      });
    }

    if (origin.srcHashHex) {
      const hashMatch = matchTargetEvidence(target, origin.srcHashHex);
      if (!targetBytes(target)) {
        return result(
          'UNKNOWN_TRANSMITTER',
          'The packet contains only a one-byte source hash, which cannot be compared with this target profile.',
          'prefix',
          { origin: originMetadata(origin), flags },
        );
      }
      if (!hashMatch.matches) {
        return result('NON_TARGET', 'The one-byte source hash disproves a target match.', 'prefix', {
          origin: originMetadata(origin),
          flags,
        });
      }
      return result(
        'AMBIGUOUS_PREFIX',
        'The one-byte source hash matches the target prefix but is not unique enough to confirm identity.',
        'prefix',
        {
          origin: originMetadata(origin),
          collisions: collisionOutput(classificationCollisions(origin.srcHashHex, target, input.universe)),
          flags,
        },
      );
    }

    return result(
      'UNKNOWN_TRANSMITTER',
      'The zero-hop packet contains no origin identity that can be compared with the target.',
      'none',
      { flags },
    );
  }

  const immediateHash = hops[hops.length - 1] as string;
  const immediateTx = transmitter(immediateHash, input.universe);
  const immediateMatch = matchTargetEvidence(target, immediateHash);
  const immediateCollisions = immediateMatch.matches
    ? classificationCollisions(immediateHash, target, input.universe)
    : [];

  if (immediateMatch.matches) {
    flags.targetInPath = true;
    if (immediateMatch.strong && immediateCollisions.length === 0) {
      const selfForwarded = originMatch.matches ? ' The target also appears as the origin (self-forwarded).' : '';
      return result(
        'TARGET_IS_IMMEDIATE_TRANSMITTER',
        `The last flood/trace hop uniquely matches the target, proving it was the immediate RF transmitter.${selfForwarded}`,
        immediateMatch.tier,
        { immediateTx, origin: originMetadata(origin), flags },
      );
    }
    return result(
      'AMBIGUOUS_PREFIX',
      immediateCollisions.length > 0
        ? 'The immediate-transmitter hash matches multiple known identities, so it cannot confirm the target.'
        : 'The immediate-transmitter hash matches only a short target prefix. Pin a node ID or full key first.',
      immediateMatch.tier,
      {
        immediateTx,
        origin: originMetadata(origin),
        collisions: collisionOutput(immediateCollisions),
        flags,
      },
    );
  }

  if (originMatch.matches) {
    flags.targetInPath = true;
    if (!originMatch.strong) {
      return result(
        'AMBIGUOUS_PREFIX',
        'The packet origin is compatible with the target profile, but the profile is not strong enough to identify it.',
        originMatch.tier,
        { immediateTx, origin: originMetadata(origin), flags },
      );
    }
    return result(
      'TARGET_ORIGIN_BUT_FORWARDED',
      'The target originated this packet, but another node was the immediate RF transmitter.',
      originMatch.tier,
      { immediateTx, origin: originMetadata(origin), flags },
    );
  }

  for (const hop of hops.slice(0, -1)) {
    const match = matchTargetEvidence(target, hop);
    if (!match.matches) continue;
    flags.targetInPath = true;
    const collisions = classificationCollisions(hop, target, input.universe);
    if (!match.strong || collisions.length > 0) {
      return result(
        'AMBIGUOUS_PREFIX',
        'A non-immediate hop is compatible with the target, but its short hash is ambiguous.',
        match.tier,
        {
          immediateTx,
          origin: originMetadata(origin),
          collisions: collisionOutput(collisions),
          flags,
        },
      );
    }
    return result(
      'TARGET_IN_PATH_BUT_NOT_IMMEDIATE',
      'The target appears earlier in the route, but a different node transmitted this copy to the companion.',
      match.tier,
      { immediateTx, origin: originMetadata(origin), flags },
    );
  }

  return result(
    'NON_TARGET',
    'Neither the immediate transmitter, the packet origin, nor an earlier route hop matches the target.',
    'prefix',
    { immediateTx, origin: originMetadata(origin), flags },
  );
}

export interface DiscoveryClassificationInput {
  response: DiscoveryResponseFrame;
  target: TargetIdentity | TargetProfile;
  universe: IdentityUniverse;
}

export function classifyDiscovery(input: DiscoveryClassificationInput): ClassificationResult {
  const target = identityOf(input.target);
  const evidence = normalizeHex(input.response.pubkeyHex);
  const inferredName = input.universe.knownAs(evidence);
  const evidenceMatch = matchTargetEvidence(target, evidence);
  const nameMatches =
    target.kind === 'name-only' &&
    Boolean(target.name && inferredName && target.name.localeCompare(inferredName, undefined, { sensitivity: 'accent' }) === 0);
  const collisions = evidenceMatch.matches
    ? classificationCollisions(evidence, target, input.universe)
    : [];
  const flags: ClassificationResult['flags'] = {
    viaDiscovery: true,
    zeroHop: input.response.pathLength === 0,
    originIsTarget: evidenceMatch.matches || nameMatches || undefined,
  };
  const origin = { pubkeyHex: evidence, name: inferredName };

  if (nameMatches || (evidenceMatch.matches && (!evidenceMatch.strong || collisions.length > 0))) {
    return result(
      'AMBIGUOUS_PREFIX',
      collisions.length > 0
        ? 'The discovery identity collides with another known node.'
        : 'The discovery response only matches a weak target identity. Pin its full public key.',
      nameMatches ? 'name' : evidenceMatch.tier,
      { origin, collisions: collisionOutput(collisions), flags },
    );
  }

  if (!evidenceMatch.matches) {
    if (target.kind === 'name-only') {
      return result(
        'UNKNOWN_TRANSMITTER',
        'The discovery response has no unique known name that can be compared with this target profile.',
        'none',
        { origin, flags },
      );
    }
    return result('NON_TARGET', 'The discovery public key does not match the target.', 'node-id', {
      origin,
      flags,
    });
  }

  if (input.response.pathLength === 0) {
    return result(
      'DIRECT_TARGET',
      'A tag-correlated zero-hop discovery response identifies the target as directly heard.',
      evidenceMatch.tier,
      { origin, flags },
    );
  }
  return result(
    'TARGET_ORIGIN_BUT_FORWARDED',
    'The discovery response identifies the target, but the companion path length shows it was forwarded.',
    evidenceMatch.tier,
    { origin, flags },
  );
}

/** Pure helper used after identity-universe growth introduces a collision. */
export function reclassifyAll(
  inputs: readonly Omit<ClassificationInput, 'target' | 'universe'>[],
  target: TargetIdentity | TargetProfile,
  universe: IdentityUniverse,
): ClassificationResult[] {
  return inputs.map((input) => classify({ ...input, target, universe }));
}
