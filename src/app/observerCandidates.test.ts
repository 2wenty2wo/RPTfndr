import { describe, expect, it } from 'vitest';
import { upsertObserverCandidates } from './observerCandidates';
import { AppController } from './controller';

const keyA = 'a'.repeat(64);
const keyB = 'b'.repeat(64);

describe('observer candidate store', () => {
  it('creates untrusted candidates with display-only coordinates', () => {
    const [candidate] = upsertObserverCandidates([], [{
      repeaterPubkeyHex: keyA,
      displayName: 'Ridge repeater',
      lastHeardAt: 1_000,
      discoverySource: 'automatic-discovery',
      advertisedCoordinates: { lat: 51.5, lon: -0.12, source: 'advert', observedAt: 900 },
    }], 1_100);

    expect(candidate).toMatchObject({
      repeaterPubkeyHex: keyA,
      displayName: 'Ridge repeater',
      coordinateStatus: 'untrusted',
      authorised: false,
      observerAssistEnabled: false,
    });
    expect(candidate?.advertisedCoordinates).toMatchObject({ status: 'untrusted' });
  });

  it('deduplicates by full public key and refreshes stale candidates', () => {
    const [first] = upsertObserverCandidates([], [{
      repeaterPubkeyHex: keyA,
      displayName: 'Old name',
      lastHeardAt: 1_000,
      discoverySource: 'automatic-discovery',
    }], 1_000);
    const refreshed = upsertObserverCandidates([first!], [
      { repeaterPubkeyHex: keyA.toUpperCase(), displayName: 'Fresh name', lastHeardAt: 5_000, discoverySource: 'automatic-discovery' },
      { repeaterPubkeyHex: keyB, displayName: 'Other', lastHeardAt: 4_000, discoverySource: 'automatic-discovery' },
    ], 5_100);

    expect(refreshed).toHaveLength(2);
    expect(refreshed.find((item) => item.repeaterPubkeyHex === keyA)).toMatchObject({
      id: first?.id,
      displayName: 'Fresh name',
      lastHeardAt: 5_000,
      createdAt: first?.createdAt,
      updatedAt: 5_100,
    });
  });
});

describe('observer polling trust boundary', () => {
  it('refuses to use candidates directly in runObserverPoll', async () => {
    const controller = new AppController();
    await expect((controller as unknown as { runObserverPoll: (...args: unknown[]) => Promise<void> }).runObserverPoll(
      1,
      'session',
      keyB,
      {},
      [{ id: 'candidate', repeaterPubkeyHex: keyA, trust: 'candidate' }],
    )).rejects.toThrow('Observer candidates cannot be used directly');
  });
});
