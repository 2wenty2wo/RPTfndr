import { afterEach, describe, expect, it } from 'vitest';
import type { GpsFix, Reception, SearchSession, TargetProfile } from '../types';
import { deleteFinderDatabase, openFinderDatabase } from './db';
import { FinderRepository } from './repo';
import { findResumableSessions, resumeSession } from './resume';
import { DB_VERSION, INDEXES, MIGRATIONS, STORES, type Migration } from './schema';
import { acquireWriterLock, type LockManagerLike } from './writerLock';

let sequence = 0;
const opened: Array<{ name: string; close: () => void }> = [];

function databaseName(label: string): string {
  sequence += 1;
  return `mcf-${label}-${sequence}`;
}

function target(): TargetProfile {
  return {
    id: 'target-1',
    label: 'Lost repeater',
    identity: { kind: 'full-pubkey', pubkeyHex: 'aa'.repeat(32) },
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
  };
}

function session(overrides: Partial<SearchSession> = {}): SearchSession {
  return {
    id: 'session-1',
    title: 'Search',
    createdAt: 1,
    startedAt: 1,
    state: 'active',
    targetSnapshot: target(),
    app: { version: 'test', commit: 'test', decoderVersion: 'test' },
    mode: 'walk',
    demo: false,
    settings: {
      cellSizeM: 12,
      minSamples: 5,
      minCells: 3,
      smoothingWindow: 7,
      emaAlpha: 0.3,
      maxGpsAccuracyM: 75,
      audioMode: 'off',
      audioVolume: 0.8,
      audioMuted: false,
      forwardedAlert: false,
    },
    counters: {
      receptions: 99,
      confirmed: 99,
      located: 99,
      fixesAccepted: 99,
      fixesRejected: 99,
      decodeFailed: 99,
      discoveries: 99,
    },
    ...overrides,
  };
}

function reception(overrides: Partial<Reception> = {}): Reception {
  return {
    sessionId: 'session-1',
    t: 100,
    source: 'rx',
    opcode: 0x88,
    frameHex: '88',
    rssi: -80,
    snr: 3,
    cls: {
      kind: 'DIRECT_TARGET',
      confirmed: true,
      explanation: 'test',
      identityTier: 'full-pubkey',
      flags: { zeroHop: true },
    },
    conf: 1,
    gps: {
      status: 'ok',
      lat: -33.86,
      lon: 151.2,
      accuracy: 5,
      quality: 'good',
      ageMs: 0,
    },
    ...overrides,
  };
}

function fix(overrides: Partial<GpsFix> = {}): GpsFix {
  return {
    sessionId: 'session-1',
    t: 100,
    posT: 100,
    lat: -33.86,
    lon: 151.2,
    accuracy: 5,
    accepted: true,
    acceptedNum: 1,
    quality: 'good',
    ...overrides,
  };
}

async function repository(label: string): Promise<FinderRepository> {
  const name = databaseName(label);
  const db = await openFinderDatabase({ name });
  opened.push({ name, close: () => db.close() });
  return new FinderRepository(db);
}

afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.close();
    await deleteFinderDatabase(item.name);
  }
});

describe('IndexedDB schema and migrations', () => {
  it('creates the current stores and compound indexes', async () => {
    const repo = await repository('schema');
    const connection = repo.db.connection;
    expect(connection.version).toBe(DB_VERSION);
    expect([...connection.objectStoreNames]).toEqual([
      STORES.blobs,
      STORES.events,
      STORES.fixes,
      STORES.receptions,
      STORES.sessions,
      STORES.settings,
      STORES.targets,
    ]);
    const transaction = connection.transaction(STORES.receptions);
    const index = transaction
      .objectStore(STORES.receptions)
      .index(INDEXES.receptions.sessionConfirmedTime);
    expect(index.keyPath).toEqual(['sessionId', 'conf', 't']);
  });

  it('runs an added migration sequentially from v2', async () => {
    const name = databaseName('migration');
    const first = await openFinderDatabase({ name });
    first.close();
    const migration: Migration = ({ db }) => db.createObjectStore('test-v3');
    const migrations = new Map([...MIGRATIONS, [3, migration]]);
    const upgraded = await openFinderDatabase({ name, version: 3, migrations });
    opened.push({ name, close: () => upgraded.close() });
    expect(upgraded.connection.objectStoreNames.contains('test-v3')).toBe(true);
  });

  it('migrates lastKnown targets and legacy bearing fields from v1', async () => {
    const name = databaseName('v1-data');
    const migrationV1 = MIGRATIONS.get(1);
    if (!migrationV1) throw new Error('v1 migration missing');
    const first = await openFinderDatabase({
      name,
      version: 1,
      migrations: new Map([[1, migrationV1]]),
    });
    const legacyTarget = {
      ...target(),
      updatedAt: 1_700_000_000_000,
      lastKnown: {
        lat: -33.86,
        lon: 151.2,
        label: 'Last self-reported advert position',
      },
    };
    await first.put(STORES.targets, legacyTarget);
    await first.put(STORES.sessions, {
      ...session(),
      targetSnapshot: legacyTarget,
    });
    await first.add(STORES.events, {
      sessionId: 'session-1',
      t: 1_700_000_000_100,
      type: 'bearing',
      data: {
        lat: -33.86,
        lon: 151.2,
        degrees: 91,
        uncertainty: 12,
        accuracy: 8,
      },
    });
    first.close();

    const upgraded = await openFinderDatabase({ name });
    opened.push({ name, close: () => upgraded.close() });
    expect(await upgraded.get(STORES.targets, 'target-1')).toMatchObject({
      advertisedReference: {
        lat: -33.86,
        lon: 151.2,
        source: 'advert',
        observedAt: 1_700_000_000_000,
        trust: 'untrusted-admin',
      },
    });
    expect(await upgraded.get(STORES.sessions, 'session-1')).toMatchObject({
      targetSnapshot: {
        advertisedReference: { source: 'advert', trust: 'untrusted-admin' },
      },
    });
    const [bearing] = await upgraded.getAll<Record<string, unknown>>(STORES.events);
    expect(bearing).toMatchObject({
      data: {
        lat: -33.86,
        lon: 151.2,
        bearingDeg: 91,
        accuracyDeg: 12,
        gpsAccuracyM: 8,
      },
    });
    expect(bearing?.data).not.toHaveProperty('degrees');
    expect(bearing?.data).not.toHaveProperty('uncertainty');
  });
});

describe('FinderRepository', () => {
  it('persists records and reconciles counters from append stores', async () => {
    const repo = await repository('reconcile');
    await repo.putTarget(target());
    await repo.putSession(session());
    const confirmedId = await repo.addReception(reception());
    await repo.addReception(
      reception({
        t: 200,
        source: 'discovery',
        conf: 0,
        cls: {
          kind: 'DECODE_FAILED',
          confirmed: false,
          explanation: 'bad',
          identityTier: 'none',
          flags: {},
        },
        decodeError: 'bad packet',
        gps: { status: 'none' },
      }),
    );
    await repo.addFix(fix());
    await repo.addFix(
      fix({ accepted: false, acceptedNum: 0, rejectReason: 'hard-accuracy', t: 200 }),
    );

    const reconciled = await repo.reconcileSessionCounters('session-1');
    expect(reconciled.counters).toEqual({
      receptions: 2,
      confirmed: 1,
      located: 1,
      fixesAccepted: 1,
      fixesRejected: 1,
      decodeFailed: 1,
      discoveries: 1,
    });
    expect(reconciled.bestConfirmed).toMatchObject({
      t: 100,
      rssi: -80,
      receptionId: confirmedId,
    });
    expect((await repo.listConfirmedReceptions('session-1')).map((entry) => entry.id)).toEqual([
      confirmedId,
    ]);
  });

  it('finds and resumes active/paused sessions while replaying persisted state', async () => {
    const repo = await repository('resume');
    await repo.putSession(session({ state: 'paused' }));
    await repo.addFix(fix());
    await repo.addReception(reception());
    expect((await findResumableSessions(repo)).map((entry) => entry.id)).toEqual(['session-1']);

    const seen: string[] = [];
    const rebuilt = await resumeSession(repo, 'session-1', {
      reset: () => seen.push('reset'),
      onFix: () => seen.push('fix'),
      onReception: () => seen.push('reception'),
    });
    expect(rebuilt.session.state).toBe('active');
    expect(seen).toEqual(['reset', 'fix', 'reception']);
    expect((await repo.listEvents('session-1', 'lifecycle'))[0]?.data).toEqual({
      action: 'resumed',
    });
  });

  it('deletes a session and its append-only records without deleting its target', async () => {
    const repo = await repository('delete');
    await repo.putTarget(target());
    await repo.putSession(session());
    await repo.addReception(reception());
    await repo.addFix(fix());
    await repo.addEvent({ sessionId: 'session-1', t: 1, type: 'note', data: {} });
    await repo.deleteSession('session-1');
    expect(await repo.getSession('session-1')).toBeUndefined();
    expect(await repo.listReceptions('session-1')).toEqual([]);
    expect(await repo.listFixes('session-1')).toEqual([]);
    expect(await repo.listEvents('session-1')).toEqual([]);
    expect(await repo.getTarget('target-1')).toBeDefined();
  });

  it('rolls back every imported store when any archive record fails', async () => {
    const repo = await repository('atomic-import');
    const duplicateA = reception({ id: 7 });
    const duplicateB = reception({ id: 7, t: 200 });

    await expect(repo.importSessionBundle(target(), session(), [duplicateA, duplicateB], [], []))
      .rejects.toBeDefined();
    expect(await repo.getTarget('target-1')).toBeUndefined();
    expect(await repo.getSession('session-1')).toBeUndefined();
    expect(await repo.listReceptions('session-1')).toEqual([]);
  });

  it('atomically remaps imported fix and duplicate reception relationships', async () => {
    const repo = await repository('import-relationships');
    await repo.addFix(fix({ sessionId: 'seed' }));
    await repo.addReception(reception({ sessionId: 'seed' }));

    const archivedFix = fix({ id: 91 });
    const first = reception({ id: 71, gps: { ...reception().gps, fixId: 91 } });
    const duplicate = reception({
      id: 72,
      t: 200,
      dupOf: 71,
      gps: { ...reception().gps, fixId: 91 },
    });
    await repo.importSessionBundle(
      target(),
      session(),
      [first, duplicate],
      [archivedFix],
      [{
        id: 81,
        sessionId: 'session-1',
        t: 150,
        type: 'bearing',
        data: {
          lat: 1,
          lon: 2,
          bearingDeg: 90,
          confirmedReceptionId: 71,
          confirmedReceptionAgeMs: 1_000,
        },
      }],
    );

    const [importedFix] = await repo.listFixes('session-1');
    const [importedFirst, importedDuplicate] = await repo.listReceptions('session-1');
    expect(importedFix?.id).not.toBe(91);
    expect(importedFirst?.id).not.toBe(71);
    expect(importedDuplicate?.id).not.toBe(72);
    expect(importedFirst?.gps.fixId).toBe(importedFix?.id);
    expect(importedDuplicate?.gps.fixId).toBe(importedFix?.id);
    expect(importedDuplicate?.dupOf).toBe(importedFirst?.id);
    const [importedBearing] = await repo.listEvents('session-1', 'bearing');
    expect(importedBearing?.id).not.toBe(81);
    expect(importedBearing?.data.confirmedReceptionId).toBe(importedFirst?.id);
    expect(importedBearing?.data.confirmedReceptionAgeMs).toBe(50);
    expect(await repo.getSession('session-1')).toMatchObject({
      counters: {
        receptions: 2,
        confirmed: 2,
        located: 2,
        fixesAccepted: 1,
        fixesRejected: 0,
        decodeFailed: 0,
        discoveries: 0,
      },
      bestConfirmed: { receptionId: importedFirst?.id },
    });
  });

  it('rejects imported bearings linked to missing or non-confirmed receptions', async () => {
    const missingRepo = await repository('import-missing-bearing-link');
    const event = {
      sessionId: 'session-1',
      t: 150,
      type: 'bearing' as const,
      data: { lat: 1, lon: 2, bearingDeg: 90, confirmedReceptionId: 999 },
    };
    await expect(missingRepo.importSessionBundle(target(), session(), [reception({ id: 71 })], [], [event]))
      .rejects.toThrow('missing archived reception');

    const unconfirmedRepo = await repository('import-unconfirmed-bearing-link');
    const unconfirmed = reception({ id: 71 });
    unconfirmed.cls.confirmed = false;
    unconfirmed.conf = 0;
    await expect(unconfirmedRepo.importSessionBundle(
      target(),
      session(),
      [unconfirmed],
      [],
      [{ ...event, data: { ...event.data, confirmedReceptionId: 71 } }],
    )).rejects.toThrow('non-confirmed archived reception');
  });

  it('does not overwrite an existing target during an atomic import', async () => {
    const repo = await repository('import-collision');
    await repo.putTarget(target());
    await expect(repo.importSessionBundle(target(), session(), [reception()], [], []))
      .rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await repo.getSession('session-1')).toBeUndefined();
    expect(await repo.listReceptions('session-1')).toEqual([]);
  });
});

describe('writer lock', () => {
  it('allows writing with an explicit unsupported fallback', async () => {
    const lease = await acquireWriterLock({ locks: null });
    expect(lease).toMatchObject({ acquired: true, readOnly: false, supported: false });
  });

  it('makes a contending tab read-only', async () => {
    let held = false;
    const locks: LockManagerLike = {
      async request(_name, _options, callback) {
        if (held) return callback(null);
        held = true;
        try {
          return await callback({ name: 'mcf-writer' });
        } finally {
          held = false;
        }
      },
    };
    const first = await acquireWriterLock({ locks });
    const second = await acquireWriterLock({ locks });
    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, readOnly: true, supported: true });
    first.release();
    await first.done;
  });
});
