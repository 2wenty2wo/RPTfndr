import { describe, expect, it } from 'vitest';

import {
  IdentityUniverse,
  components,
  idPrecision,
  matchTargetEvidence,
  matchTargetOrigin,
  normalizeHex,
  resolveColumn,
  resolveColumnReadonly,
} from './identity';
import {
  COLLIDING_PUBLIC_KEY,
  OTHER_PUBLIC_KEY,
  TARGET_PUBLIC_KEY,
} from '../test/fixtures/packets';

describe('identity normalization and universe', () => {
  it('canonicalizes common hex notation and rejects partial bytes', () => {
    expect(normalizeHex('0xA1:B2-c3 d4')).toBe('a1b2c3d4');
    expect(() => normalizeHex('abc')).toThrow(/complete/);
    expect(() => normalizeHex('not hex')).toThrow(/complete/);
  });

  it('deduplicates the same public key across contacts and observations', () => {
    const universe = new IdentityUniverse();
    universe.addContact({ pubkeyHex: TARGET_PUBLIC_KEY, name: 'Target' });
    universe.observe(TARGET_PUBLIC_KEY, undefined, 'observed');
    expect(universe.all()).toHaveLength(1);
    expect(universe.all()[0]).toMatchObject({
      name: 'Target',
      sources: ['contact', 'observed'],
    });
    expect(universe.knownAs('a1b2')).toBe('Target');
  });

  it('detects collision growth only when two distinct full keys share evidence', () => {
    const universe = new IdentityUniverse();
    const changes: string[][] = [];
    universe.onGrowth((change) => changes.push(change.newCollisionPrefixes));
    universe.addContact({ pubkeyHex: TARGET_PUBLIC_KEY, name: 'Target' });
    expect(universe.isCollision('a1')).toBe(false);
    universe.observe(COLLIDING_PUBLIC_KEY, 'Sibling');
    expect(universe.isCollision('a1')).toBe(true);
    expect(universe.isCollision('a1b2c3d4')).toBe(true);
    expect(universe.collisionsFor('a1')).toHaveLength(2);
    expect(changes.at(-1)).toContain('a1');

    universe.addTarget({ kind: 'node-id', bytesHex: 'e5f60718' }, 'partial-target');
    expect(universe.isCollision('e5')).toBe(false);
  });

  it('matches origin identities at their declared tier', () => {
    const universe = new IdentityUniverse();
    universe.observe(TARGET_PUBLIC_KEY, 'Target');
    expect(
      matchTargetOrigin({ kind: 'full-pubkey', pubkeyHex: TARGET_PUBLIC_KEY }, TARGET_PUBLIC_KEY, undefined, universe),
    ).toMatchObject({ matches: true, tier: 'full-pubkey', strong: true });
    expect(
      matchTargetOrigin({ kind: 'node-id', bytesHex: 'a1b2c3d4' }, TARGET_PUBLIC_KEY, undefined, universe),
    ).toMatchObject({ matches: true, tier: 'node-id', strong: true });
    expect(
      matchTargetOrigin({ kind: 'prefix', bytesHex: 'a1' }, TARGET_PUBLIC_KEY, undefined, universe),
    ).toMatchObject({ matches: true, tier: 'prefix', strong: false });
    expect(
      matchTargetOrigin({ kind: 'name-only', name: 'target' }, OTHER_PUBLIC_KEY, 'Target', universe),
    ).toMatchObject({ matches: true, tier: 'name', strong: false });
    expect(matchTargetEvidence({ kind: 'node-id', bytesHex: 'a1b2c3d4' }, 'a1b2')).toMatchObject({
      matches: true,
      strong: true,
    });
  });
});
describe('upstream column-key parity', () => {
  it('retains helper and collision component semantics', () => {
    expect(idPrecision('5E')).toBe(1);
    expect(idPrecision('5E/AB')).toBe(4);
    expect(components('5E/AB/CD')).toEqual(['5E', 'AB', 'CD']);
  });

  it('promotes precise ids and creates canonical ambiguous columns', () => {
    expect(resolveColumn('5E9F', ['5E']).events).toEqual([
      { type: 'rename', from: '5E', to: '5E9F' },
    ]);
    const collision = resolveColumn('5E', ['5E9F', '5EAB']);
    expect(collision.key).toBe('5E9F/5EAB');
    expect(collision.events).toContainEqual({ type: 'add', key: '5E9F/5EAB' });
  });

  it('resolves short disk ids to collision columns rather than a sibling', () => {
    const columns = ['5E9F', '5EAB', '5E9F/5EAB'];
    expect(resolveColumnReadonly('5E', columns)).toBe('5E9F/5EAB');
    expect(resolveColumnReadonly('5E9F', columns)).toBe('5E9F');
  });
});
