import type { IdentityTier, TargetIdentity, TargetProfile } from '../types';

export type IdentitySource = 'contact' | 'observed' | 'discovery' | 'target';

export interface UniverseIdentityInput {
  id?: string;
  pubkeyHex?: string;
  bytesHex?: string;
  name?: string;
  source: IdentitySource;
}
export interface UniverseIdentity {
  id: string;
  bytesHex: string;
  pubkeyHex?: string;
  name?: string;
  sources: IdentitySource[];
}

export interface UniverseChange {
  added: boolean;
  generation: number;
  newCollisionPrefixes: string[];
}

export interface TargetMatch {
  matches: boolean;
  tier: IdentityTier;
  strong: boolean;
  collision: boolean;
}

export function normalizeHex(value: string): string {
  const normalized = value.trim().replace(/^0x/i, '').replace(/[\s:_-]/g, '').toLowerCase();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new TypeError('Identity must contain complete hexadecimal bytes');
  }
  return normalized;
}

function tryNormalizeHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return normalizeHex(value);
  } catch {
    return undefined;
  }
}

function cleanName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function sameName(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0);
}

function collisionPrefixSet(records: Iterable<UniverseIdentity>): Set<string> {
  const counts = new Map<string, Set<string>>();
  for (const record of records) {
    // Only a full public key establishes a distinct identity. A target's short
    // profile and a matching observed full key may be the same node.
    if (!record.pubkeyHex || record.pubkeyHex.length !== 64) continue;
    for (let bytes = 1; bytes <= 4; bytes += 1) {
      const prefix = record.pubkeyHex.slice(0, bytes * 2);
      const identities = counts.get(prefix) ?? new Set<string>();
      identities.add(record.pubkeyHex);
      counts.set(prefix, identities);
    }
  }
  return new Set(
    [...counts.entries()].filter(([, identities]) => identities.size >= 2).map(([prefix]) => prefix),
  );
}

/** Contacts + observations + discoveries + target profiles used for collision checks. */
export class IdentityUniverse {
  private readonly records = new Map<string, UniverseIdentity>();
  private readonly listeners = new Set<(change: UniverseChange) => void>();
  private generationValue = 0;

  get generation(): number {
    return this.generationValue;
  }

  add(input: UniverseIdentityInput): UniverseChange {
    const pubkeyHex = tryNormalizeHex(input.pubkeyHex);
    const bytesHex = pubkeyHex ?? tryNormalizeHex(input.bytesHex);
    if (!bytesHex) throw new TypeError('Universe identity requires public-key or identity bytes');
    if (pubkeyHex && pubkeyHex.length !== 64) {
      throw new RangeError('A full MeshCore public key must be 32 bytes');
    }

    const key = pubkeyHex ? `pubkey:${pubkeyHex}` : `partial:${input.id ?? bytesHex}`;
    const previousCollisions = collisionPrefixSet(this.records.values());
    const existing = this.records.get(key);
    if (existing) {
      const sourceSet = new Set(existing.sources);
      sourceSet.add(input.source);
      const name = existing.name ?? cleanName(input.name);
      const changed = sourceSet.size !== existing.sources.length || name !== existing.name;
      if (changed) {
        this.records.set(key, { ...existing, name, sources: [...sourceSet] });
        this.generationValue += 1;
      }
      return { added: false, generation: this.generationValue, newCollisionPrefixes: [] };
    }

    const record: UniverseIdentity = {
      id: input.id ?? pubkeyHex ?? bytesHex,
      bytesHex,
      pubkeyHex,
      name: cleanName(input.name),
      sources: [input.source],
    };
    this.records.set(key, record);
    this.generationValue += 1;

    const nextCollisions = collisionPrefixSet(this.records.values());
    const newCollisionPrefixes = [...nextCollisions].filter((prefix) => !previousCollisions.has(prefix));
    const change = { added: true, generation: this.generationValue, newCollisionPrefixes };
    for (const listener of this.listeners) listener(change);
    return change;
  }

  addContact(contact: { pubkeyHex: string; name?: string }): UniverseChange {
    return this.add({ ...contact, source: 'contact' });
  }

  observe(pubkeyHex: string, name?: string, source: 'observed' | 'discovery' = 'observed'): UniverseChange {
    if (normalizeHex(pubkeyHex).length === 64) return this.add({ pubkeyHex, name, source });
    return this.add({ bytesHex: pubkeyHex, name, source });
  }

  addTarget(target: TargetProfile | TargetIdentity, id?: string): UniverseChange | undefined {
    const profile = 'identity' in target ? target : undefined;
    const identity = profile?.identity ?? (target as TargetIdentity);
    const profileId = profile?.id ?? id;
    if (identity.kind === 'name-only') return undefined;
    const pubkeyHex = identity.kind === 'full-pubkey' ? identity.pubkeyHex : undefined;
    const bytesHex = pubkeyHex ?? identity.bytesHex;
    if (!bytesHex) return undefined;
    return this.add({ id: profileId, pubkeyHex, bytesHex, name: identity.name, source: 'target' });
  }

  all(): UniverseIdentity[] {
    return [...this.records.values()].map((record) => ({ ...record, sources: [...record.sources] }));
  }

  /** All known identities that could have produced these leading bytes. */
  matching(evidence: string): UniverseIdentity[] {
    const normalized = normalizeHex(evidence);
    return this.all().filter(
      (record) => record.bytesHex.length >= normalized.length && record.bytesHex.startsWith(normalized),
    );
  }

  /** Returns candidates only when the evidence is actually colliding. */
  collisionsFor(evidence: string): UniverseIdentity[] {
    const candidates = this.matching(evidence).filter(
      (record) => record.pubkeyHex && record.pubkeyHex.length === 64,
    );
    const distinct = new Set(candidates.map((record) => record.pubkeyHex));
    return distinct.size >= 2 ? candidates : [];
  }

  isCollision(evidence: string): boolean {
    return this.collisionsFor(evidence).length >= 2;
  }

  knownAs(evidence: string): string | undefined {
    const candidates = this.matching(evidence);
    const identities = new Set(candidates.map((record) => record.pubkeyHex ?? record.id));
    if (identities.size !== 1) return undefined;
    return candidates.find((record) => record.name)?.name;
  }

  collisionPrefixes(): string[] {
    return [...collisionPrefixSet(this.records.values())].sort();
  }

  onGrowth(listener: (change: UniverseChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function targetTier(target: TargetIdentity): IdentityTier {
  switch (target.kind) {
    case 'full-pubkey':
      return 'full-pubkey';
    case 'node-id':
      return 'node-id';
    case 'prefix':
      return 'prefix';
    case 'name-only':
      return 'name';
  }
}

export function targetBytes(target: TargetIdentity): string | undefined {
  return tryNormalizeHex(target.kind === 'full-pubkey' ? target.pubkeyHex : target.bytesHex);
}

export function matchTargetEvidence(target: TargetIdentity, evidence: string): TargetMatch {
  const bytes = targetBytes(target);
  const normalizedEvidence = tryNormalizeHex(evidence);
  const tier = targetTier(target);
  if (!bytes || !normalizedEvidence) return { matches: false, tier, strong: false, collision: false };
  const overlap = Math.min(bytes.length, normalizedEvidence.length);
  const matches = bytes.slice(0, overlap) === normalizedEvidence.slice(0, overlap);
  return {
    matches,
    tier,
    strong: matches && (tier === 'full-pubkey' || tier === 'node-id'),
    collision: false,
  };
}

export function matchTargetOrigin(
  target: TargetIdentity,
  pubkeyHex: string | undefined,
  name: string | undefined,
  universe: IdentityUniverse,
): TargetMatch {
  const tier = targetTier(target);
  if (target.kind === 'name-only') {
    const matches = sameName(target.name, name);
    return { matches, tier, strong: false, collision: false };
  }

  const targetHex = targetBytes(target);
  const originHex = tryNormalizeHex(pubkeyHex);
  if (!targetHex || !originHex) return { matches: false, tier, strong: false, collision: false };
  const exactForTier =
    target.kind === 'full-pubkey'
      ? targetHex.length === originHex.length && targetHex === originHex
      : originHex.startsWith(targetHex);
  const collisionEvidence = target.kind === 'full-pubkey' ? originHex : targetHex;
  const collision = exactForTier && universe.isCollision(collisionEvidence);
  return {
    matches: exactForTier,
    tier,
    strong: exactForTier && (target.kind === 'full-pubkey' || (target.kind === 'node-id' && !collision)),
    collision,
  };
}

// Repeater-column compatibility ported from the upstream signal tester. IDs
// are leading public-key bytes; collision columns are sorted slash joins.
export function idPrecision(id: string): number {
  if (id === 'direct' || id === 'unknown' || id.includes('/')) return 4;
  return Math.ceil(id.length / 2);
}

export function idSuffix(id: string, bytes: number): string {
  return id.slice(0, bytes * 2).toUpperCase();
}

export function colHead(column: string): string {
  return column.split('/')[0] ?? '';
}

export function components(key: string): string[] {
  if (!key || key === 'direct' || key === 'unknown') return [];
  return key.split('/').filter((part) => part && part !== 'direct' && part !== 'unknown');
}

export function colsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const rightParts = right.split('/');
  return left.split('/').some((part) => rightParts.includes(part));
}

export function colMinPrecision(column: string, storedMinPrecision?: number): number {
  if (column === 'direct') return 4;
  return storedMinPrecision ?? idPrecision(colHead(column));
}

export function colMatchesRawId(
  column: string,
  rawId: string,
  storedMinPrecision?: number,
): boolean {
  if (column === 'direct' || column === 'unknown') return false;
  const precision = Math.min(idPrecision(rawId), colMinPrecision(column, storedMinPrecision));
  return idSuffix(colHead(column), precision) === idSuffix(rawId, precision);
}

export function colMatchesRawIdReadonly(column: string, rawId: string): boolean {
  if (column === 'direct' || column === 'unknown') return false;
  const head = colHead(column);
  const precision = Math.min(idPrecision(rawId), idPrecision(head));
  return idSuffix(head, precision) === idSuffix(rawId, precision);
}

export function resolveColumnReadonly(rawId: string, columns: readonly string[]): string {
  if (rawId === 'direct' || rawId === 'unknown') return rawId;
  if (columns.includes(rawId)) return rawId;
  const matches = columns.filter((column) => colMatchesRawIdReadonly(column, rawId));
  if (matches.length === 0) return rawId;
  const specifics = matches.filter((column) => !column.includes('/'));
  if (specifics.length >= 2) {
    const collisionKey = specifics.slice().sort().join('/');
    if (columns.includes(collisionKey)) return collisionKey;
  }
  if (specifics.length === 1) return specifics[0] ?? rawId;
  return matches.find((column) => column.includes('/')) ?? matches[0] ?? rawId;
}

export type ColumnEvent =
  | { type: 'rename'; from: string; to: string }
  | { type: 'split'; existing: string; collisionKey: string }
  | { type: 'add'; key: string };

export interface ColumnResolution {
  key: string;
  events: ColumnEvent[];
}

export function resolveColumn(
  rawId: string,
  columns: readonly string[],
  minPrecisionOf: (column: string) => number | undefined = () => undefined,
): ColumnResolution {
  const mutable = [...columns];
  const events: ColumnEvent[] = [];
  const has = (key: string) => mutable.includes(key);
  const add = (key: string) => {
    if (!has(key)) {
      mutable.push(key);
      events.push({ type: 'add', key });
    }
  };
  const rename = (from: string, to: string) => {
    const index = mutable.indexOf(from);
    if (index < 0) return;
    if (mutable.includes(to)) mutable.splice(index, 1);
    else mutable[index] = to;
    events.push({ type: 'rename', from, to });
  };
  const split = (existing: string, collisionKey: string) => {
    if (!has(collisionKey)) mutable.push(collisionKey);
    events.push({ type: 'split', existing, collisionKey });
  };

  if (rawId === 'direct') {
    add('direct');
    return { key: 'direct', events };
  }
  if (has(rawId)) return { key: rawId, events };

  const rawPrecision = idPrecision(rawId);
  const matches = mutable.filter(
    (column) => column !== 'direct' && colMatchesRawId(column, rawId, minPrecisionOf(column)),
  );
  if (matches.length === 0) {
    add(rawId);
    return { key: rawId, events };
  }

  const specifics = matches.filter((column) => !column.includes('/'));
  const collisions = matches.filter((column) => column.includes('/'));
  if (specifics.length >= 2) {
    const collisionKey = specifics.slice().sort().join('/');
    if (!has(collisionKey)) {
      const subsets = collisions.filter((key) =>
        key.split('/').every((component) => specifics.includes(component)),
      );
      for (const subset of subsets) rename(subset, collisionKey);
      add(collisionKey);
    }
    return { key: collisionKey, events };
  }

  if (specifics.length === 1) {
    const existing = specifics[0] as string;
    const existingPrecision = idPrecision(existing);
    const commonPrecision = Math.min(rawPrecision, existingPrecision);
    if (idSuffix(rawId, commonPrecision) === idSuffix(existing, commonPrecision)) {
      if (rawPrecision > existingPrecision) {
        rename(existing, rawId);
        for (const collision of [...mutable]) {
          if (!collision.includes('/')) continue;
          const parts = collision.split('/');
          if (!parts.includes(existing)) continue;
          const replacement = parts.map((part) => (part === existing ? rawId : part)).sort().join('/');
          if (replacement !== collision) rename(collision, replacement);
        }
        return { key: rawId, events };
      }
      return { key: existing, events };
    }
    const collisionKey = [existing, rawId].sort().join('/');
    split(existing, collisionKey);
    add(rawId);
    return { key: rawId, events };
  }

  let destination = collisions[0] ?? rawId;
  let isNewSibling = false;
  for (const collision of collisions) {
    const parts = collision.split('/');
    const minimumComponentPrecision = Math.min(...parts.map(idPrecision));
    const refined = parts.find((part) => {
      const precision = idPrecision(part);
      return rawPrecision > precision && idSuffix(rawId, precision) === idSuffix(part, precision);
    });
    if (refined) {
      const newKey = parts.map((part) => (part === refined ? rawId : part)).sort().join('/');
      if (newKey !== collision) {
        rename(collision, newKey);
        if (collision === destination) destination = newKey;
      }
    } else if (rawPrecision >= minimumComponentPrecision) {
      add(rawId);
      const newKey = [...parts, rawId].sort().join('/');
      if (newKey !== collision) {
        rename(collision, newKey);
        if (collision === destination) destination = newKey;
      }
      isNewSibling = true;
    }
  }
  return { key: isNewSibling ? rawId : destination, events };
}
