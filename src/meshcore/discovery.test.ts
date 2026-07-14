import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyDiscovery } from './classify';
import {
  DiscoveryCoordinator,
  DiscoveryCooldownError,
  buildDiscoveryCommand,
  discoveryTagMatcher,
} from './discovery';
import { parseCompanionFrame, type DiscoveryResponseFrame } from './frames';
import { IdentityUniverse } from './identity';
import {
  buildDiscoveryResponseFrame,
  buildRx88Frame,
} from '../test/fixtures/frames';
import {
  OTHER_PUBLIC_KEY,
  TARGET_PUBLIC_KEY,
  buildAckPacket,
} from '../test/fixtures/packets';

afterEach(() => vi.useRealTimers());

function response(options: Parameters<typeof buildDiscoveryResponseFrame>[0] = {}): DiscoveryResponseFrame {
  const parsed = parseCompanionFrame(buildDiscoveryResponseFrame(options));
  if (parsed.kind !== 'discovery-response') throw new Error(`Unexpected fixture: ${parsed.kind}`);
  return parsed;
}

describe('discovery correlation', () => {
  it('encodes filter and tag in the command', () => {
    expect(buildDiscoveryCommand(0xff, 0x1234_5678)).toEqual(
      Uint8Array.of(0x37, 0x80, 0x0f, 0x78, 0x56, 0x34, 0x12),
    );
  });

  it('collects only tag-correlated responses during the two-second window', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const writes: Uint8Array[] = [];
    const coordinator = new DiscoveryCoordinator(
      async (command) => {
        writes.push(command);
      },
      { now: () => now, nextTag: () => 0x1122_3344 },
    );
    const run = coordinator.start(2);
    expect(run.tag).toBe(0x1122_3344);
    expect(writes).toHaveLength(1);
    expect(coordinator.ingest(buildDiscoveryResponseFrame({ tag: 0xdead_beef }))).toBe(false);
    expect(coordinator.ingest(buildRx88Frame(buildAckPacket()))).toBe(false);
    expect(
      coordinator.ingest(
        buildDiscoveryResponseFrame({ tag: run.tag, snr: -2, uplinkSnr: 4, companionPathLen: 1 }),
      ),
    ).toBe(true);

    now = 3_000;
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await run.done;
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]).toMatchObject({ snr: -2, uplinkSnr: 4, pathLength: 1 });
    expect(coordinator.state().activeTag).toBeUndefined();
  });

  it('enforces a cooldown and supports cancellation', async () => {
    vi.useFakeTimers();
    let now = 0;
    const coordinator = new DiscoveryCoordinator(async () => undefined, {
      now: () => now,
      nextTag: () => 1,
      windowMs: 10,
      cooldownMs: 20,
    });
    const first = coordinator.start();
    now = 10;
    await vi.advanceTimersByTimeAsync(10);
    await first.done;
    expect(() => coordinator.start()).toThrow(DiscoveryCooldownError);

    now = 30;
    const second = coordinator.start();
    const rejection = expect(second.done).rejects.toThrow('field test ended');
    coordinator.cancel('field test ended');
    await rejection;
  });

  it('provides a queue matcher that leaves other frames untouched', () => {
    const matcher = discoveryTagMatcher(99);
    expect(matcher.accept(buildDiscoveryResponseFrame({ tag: 98 }))).toBe('no');
    expect(matcher.accept(buildDiscoveryResponseFrame({ tag: 99 }))).toBe('consume');
  });
});
describe('discovery classification', () => {
  const target = { kind: 'full-pubkey' as const, pubkeyHex: TARGET_PUBLIC_KEY };

  function identities(): IdentityUniverse {
    const universe = new IdentityUniverse();
    universe.observe(TARGET_PUBLIC_KEY, 'Target');
    universe.observe(OTHER_PUBLIC_KEY, 'Other');
    return universe;
  }

  it('confirms hop zero but separates forwarded discovery responses', () => {
    expect(
      classifyDiscovery({ response: response({ companionPathLen: 0 }), target, universe: identities() }),
    ).toMatchObject({
      kind: 'DIRECT_TARGET',
      confirmed: true,
      flags: { viaDiscovery: true, zeroHop: true },
    });
    expect(
      classifyDiscovery({ response: response({ companionPathLen: 2 }), target, universe: identities() }),
    ).toMatchObject({
      kind: 'TARGET_ORIGIN_BUT_FORWARDED',
      confirmed: false,
      flags: { viaDiscovery: true, zeroHop: false },
    });
  });

  it('keeps weak and non-target discovery identities out of confirmed data', () => {
    expect(
      classifyDiscovery({
        response: response(),
        target: { kind: 'prefix', bytesHex: 'a1' },
        universe: identities(),
      }),
    ).toMatchObject({ kind: 'AMBIGUOUS_PREFIX', confirmed: false });
    expect(
      classifyDiscovery({
        response: response({ pubkeyHex: OTHER_PUBLIC_KEY }),
        target,
        universe: identities(),
      }),
    ).toMatchObject({ kind: 'NON_TARGET', confirmed: false });
  });
});
