import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_COMMIT, APP_VERSION, DECODER_VERSION } from '../app/version';
import { IdentityUniverse } from '../meshcore';
import { deleteFinderDatabase, FinderRepository, openFinderDatabase, type FinderDatabase } from '../storage';
import { buildDiscoveryResponseFrame, buildRx88Frame } from '../test/fixtures/frames';
import {
  buildAnonRequestPacket,
  OTHER_PUBLIC_KEY,
  TARGET_PUBLIC_KEY,
} from '../test/fixtures/packets';
import { DEFAULT_SESSION_SETTINGS, type SearchSession, type TargetProfile } from '../types';
import { SessionRecorder } from './recorder';

const target: TargetProfile = {
  id: 'target-recorder',
  label: 'Recorder target',
  identity: { kind: 'full-pubkey', pubkeyHex: TARGET_PUBLIC_KEY },
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
};

function session(id: string): SearchSession {
  return {
    id,
    title: 'Recorder test',
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    state: 'active',
    targetSnapshot: target,
    app: { version: APP_VERSION, commit: APP_COMMIT, decoderVersion: DECODER_VERSION },
    mode: 'walk',
    demo: true,
    settings: { ...DEFAULT_SESSION_SETTINGS },
    counters: {
      receptions: 0,
      confirmed: 0,
      located: 0,
      fixesAccepted: 0,
      fixesRejected: 0,
      decodeFailed: 0,
      discoveries: 0,
    },
  };
}

let database: FinderDatabase | undefined;
let databaseName: string | undefined;

afterEach(async () => {
  database?.close();
  if (databaseName) await deleteFinderDatabase(databaseName);
  database = undefined;
  databaseName = undefined;
});

describe('SessionRecorder', () => {
  it('persists every frame while only confirmed direct samples reach signal and cells', async () => {
    databaseName = `recorder-${crypto.randomUUID()}`;
    database = await openFinderDatabase({ name: databaseName });
    const repository = new FinderRepository(database);
    const searchSession = session('session-recorder');
    await repository.putSession(searchSession);
    const universe = new IdentityUniverse();
    universe.addTarget(target);
    const recorder = new SessionRecorder({ repository, session: searchSession, universe });
    const t = searchSession.startedAt + 1_000;
    await recorder.addFix({
      sessionId: searchSession.id,
      t,
      posT: t,
      lat: -33.8688,
      lon: 151.2093,
      accuracy: 6,
      accepted: true,
      acceptedNum: 1,
      quality: 'good',
    });

    const directFrame = buildRx88Frame(buildAnonRequestPacket({ senderPubkeyHex: TARGET_PUBLIC_KEY }), { rssi: -78, snr: 4 });
    const forwardedFrame = buildRx88Frame(buildAnonRequestPacket({
      senderPubkeyHex: TARGET_PUBLIC_KEY,
      path: [OTHER_PUBLIC_KEY.slice(0, 6)],
      pathHashSize: 3,
    }), { rssi: -50, snr: 10 });
    const direct = await recorder.ingestRawFrame(directFrame, t + 100);
    const forwarded = await recorder.ingestRawFrame(forwardedFrame, t + 200);

    expect(direct?.cls.kind).toBe('DIRECT_TARGET');
    expect(forwarded?.cls.kind).toBe('TARGET_ORIGIN_BUT_FORWARDED');
    expect(recorder.signal.snapshot(t + 200).sampleCount).toBe(1);
    expect(recorder.cells.values().reduce((total, cell) => total + cell.count, 0)).toBe(1);
    expect((await repository.listReceptions(searchSession.id))).toHaveLength(2);
    expect(recorder.session.counters).toMatchObject({ receptions: 2, confirmed: 1, located: 1 });
    await recorder.end();
  });

  it('links duplicates, preserves decode failures, and records suspension gaps', async () => {
    databaseName = `recorder-${crypto.randomUUID()}`;
    database = await openFinderDatabase({ name: databaseName });
    const repository = new FinderRepository(database);
    const searchSession = session('session-duplicates');
    await repository.putSession(searchSession);
    const universe = new IdentityUniverse();
    universe.addTarget(target);
    const recorder = new SessionRecorder({ repository, session: searchSession, universe });
    const frame = buildRx88Frame(buildAnonRequestPacket({ senderPubkeyHex: TARGET_PUBLIC_KEY }));
    const first = await recorder.ingestRawFrame(frame, searchSession.startedAt + 1_000);
    const duplicate = await recorder.ingestRawFrame(frame, searchSession.startedAt + 2_000);
    const malformed = await recorder.ingestRawFrame(buildRx88Frame(Uint8Array.of(0xff)), searchSession.startedAt + 70_000);

    expect(duplicate?.dupOf).toBe(first?.id);
    expect(malformed?.cls.kind).toBe('DECODE_FAILED');
    expect((await repository.listEvents(searchSession.id, 'suspension-gap'))).toHaveLength(1);
    expect((await repository.listReceptions(searchSession.id))).toHaveLength(3);
    await recorder.end();
  });

  it('records discovery responses only after tag/window validation', async () => {
    databaseName = `recorder-${crypto.randomUUID()}`;
    database = await openFinderDatabase({ name: databaseName });
    const repository = new FinderRepository(database);
    const searchSession = session('session-discovery-validation');
    await repository.putSession(searchSession);
    const universe = new IdentityUniverse();
    universe.addTarget(target);
    const recorder = new SessionRecorder({ repository, session: searchSession, universe });
    const frame = buildDiscoveryResponseFrame({ pubkeyHex: TARGET_PUBLIC_KEY, companionPathLen: 0 });

    const uncorrelated = await recorder.ingestRawFrame(frame, searchSession.startedAt + 1_000);
    const accepted = await recorder.ingestRawFrame(frame, searchSession.startedAt + 2_000, true);
    const malformed = await recorder.ingestRawFrame(
      Uint8Array.of(0x8e, 0, 0, 0, 0x90),
      searchSession.startedAt + 3_000,
    );

    expect(uncorrelated?.cls.kind).toBe('UNKNOWN_TRANSMITTER');
    expect(uncorrelated?.cls.confirmed).toBe(false);
    expect(accepted?.cls.kind).toBe('DIRECT_TARGET');
    expect(malformed?.cls.kind).toBe('DECODE_FAILED');
    expect((await repository.listReceptions(searchSession.id))).toHaveLength(3);
    await recorder.end();
  });

  it('pins an observed full key and reclassifies earlier ambiguous receptions', async () => {
    databaseName = `recorder-${crypto.randomUUID()}`;
    database = await openFinderDatabase({ name: databaseName });
    const repository = new FinderRepository(database);
    const partialTarget: TargetProfile = {
      ...target,
      id: 'target-partial',
      identity: { kind: 'prefix', bytesHex: TARGET_PUBLIC_KEY.slice(0, 4) },
    };
    const searchSession = { ...session('session-pin'), targetSnapshot: partialTarget };
    await repository.putSession(searchSession);
    const universe = new IdentityUniverse();
    universe.addTarget(partialTarget);
    const recorder = new SessionRecorder({ repository, session: searchSession, universe });
    const frame = buildRx88Frame(buildAnonRequestPacket({ senderPubkeyHex: TARGET_PUBLIC_KEY }));
    const before = await recorder.ingestRawFrame(frame, searchSession.startedAt + 1_000);
    expect(before?.cls.kind).toBe('AMBIGUOUS_PREFIX');

    await recorder.updateTarget({
      ...partialTarget,
      identity: { kind: 'full-pubkey', pubkeyHex: TARGET_PUBLIC_KEY },
      pinnedFrom: 'prefix',
      updatedAt: 2,
    });

    const [stored] = await repository.listReceptions(searchSession.id);
    expect(stored?.cls.kind).toBe('DIRECT_TARGET');
    expect(stored?.conf).toBe(1);
    expect(recorder.session.targetSnapshot.identity.kind).toBe('full-pubkey');
    await recorder.end();
  });

  it('does not let a pending debounced snapshot overwrite an immediate end', async () => {
    databaseName = `recorder-${crypto.randomUUID()}`;
    database = await openFinderDatabase({ name: databaseName });
    const repository = new FinderRepository(database);
    const searchSession = session('session-immediate-end');
    await repository.putSession(searchSession);
    const universe = new IdentityUniverse();
    universe.addTarget(target);
    const recorder = new SessionRecorder({ repository, session: searchSession, universe });
    const ingest = recorder.ingestRawFrame(
      buildRx88Frame(buildAnonRequestPacket({ senderPubkeyHex: TARGET_PUBLIC_KEY })),
      searchSession.startedAt + 1_000,
    );

    await recorder.end();
    await ingest;

    expect((await repository.getSession(searchSession.id))?.state).toBe('ended');
  });

  it('flushes and clears its debounced session write during shutdown', async () => {
    databaseName = `recorder-${crypto.randomUUID()}`;
    database = await openFinderDatabase({ name: databaseName });
    const repository = new FinderRepository(database);
    const searchSession = session('session-shutdown');
    await repository.putSession(searchSession);
    const universe = new IdentityUniverse();
    universe.addTarget(target);
    const recorder = new SessionRecorder({ repository, session: searchSession, universe });
    const putSession = vi.spyOn(repository, 'putSession');
    const clearTimeout = vi.spyOn(globalThis, 'clearTimeout');

    try {
      await recorder.updateAutomationSettings({
        smartWardriveEnabled: true,
        autoDiscoveryEnabled: true,
        autoDiscoveryIntervalSec: 120,
        observerAssistEnabled: false,
        observerPollIntervalMin: 10,
      });

      await recorder.shutdown();

      expect(clearTimeout).toHaveBeenCalled();
      expect(putSession).toHaveBeenCalledTimes(1);
      expect((await repository.getSession(searchSession.id))?.settings).toMatchObject({
        smartWardriveEnabled: true,
        autoDiscoveryEnabled: true,
        autoDiscoveryIntervalSec: 120,
      });

      await recorder.updateAutomationSettings({
        smartWardriveEnabled: false,
        autoDiscoveryEnabled: false,
        autoDiscoveryIntervalSec: 90,
        observerAssistEnabled: false,
        observerPollIntervalMin: 10,
      });
      expect(putSession).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout.mockRestore();
    }
  });
});
