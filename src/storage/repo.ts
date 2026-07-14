import type {
  GpsFix,
  Reception,
  SearchSession,
  SessionEvent,
  TargetProfile,
} from '../types';
import { FinderDatabase, transactionComplete } from './db';
import { INDEXES, STORES, type StoreName } from './schema';

export interface SettingRecord<T = unknown> {
  key: string;
  value: T;
}

export interface BlobRecord {
  id: string;
  blob: Blob;
  name?: string;
  mediaType?: string;
  createdAt?: number;
}

const MIN_TIME = -Number.MAX_SAFE_INTEGER;
const MAX_TIME = Number.MAX_SAFE_INTEGER;

function timeRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId, MIN_TIME], [sessionId, MAX_TIME]);
}

function confirmedTimeRange(sessionId: string, confirmed: 0 | 1): IDBKeyRange {
  return IDBKeyRange.bound(
    [sessionId, confirmed, MIN_TIME],
    [sessionId, confirmed, MAX_TIME],
  );
}

function acceptedTimeRange(sessionId: string, accepted: 0 | 1): IDBKeyRange {
  return IDBKeyRange.bound(
    [sessionId, accepted, MIN_TIME],
    [sessionId, accepted, MAX_TIME],
  );
}

function numericKey(key: IDBValidKey): number {
  if (typeof key !== 'number') throw new Error('Expected an auto-increment numeric key');
  return key;
}

export class FinderRepository {
  readonly db: FinderDatabase;

  constructor(database: FinderDatabase | IDBDatabase) {
    this.db = database instanceof FinderDatabase ? database : new FinderDatabase(database);
  }

  putSession(session: SearchSession): Promise<IDBValidKey> {
    return this.db.put(STORES.sessions, session);
  }

  getSession(id: string): Promise<SearchSession | undefined> {
    return this.db.get<SearchSession>(STORES.sessions, id);
  }

  async listSessions(): Promise<SearchSession[]> {
    const sessions = await this.db.getAll<SearchSession>(STORES.sessions);
    return sessions.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  async listResumableSessions(): Promise<SearchSession[]> {
    const [active, paused] = await Promise.all([
      this.db.getAllFromIndex<SearchSession>(
        STORES.sessions,
        INDEXES.sessions.state,
        IDBKeyRange.only('active'),
      ),
      this.db.getAllFromIndex<SearchSession>(
        STORES.sessions,
        INDEXES.sessions.state,
        IDBKeyRange.only('paused'),
      ),
    ]);
    return [...active, ...paused].sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
  }

  async putTarget(target: TargetProfile): Promise<void> {
    await this.db.put(STORES.targets, target);
  }

  getTarget(id: string): Promise<TargetProfile | undefined> {
    return this.db.get<TargetProfile>(STORES.targets, id);
  }

  async listTargets(): Promise<TargetProfile[]> {
    const targets = await this.db.getAll<TargetProfile>(STORES.targets);
    return targets.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  deleteTarget(id: string): Promise<void> {
    return this.db.delete(STORES.targets, id);
  }

  async addReception(reception: Reception): Promise<number> {
    return numericKey(await this.db.add(STORES.receptions, reception));
  }

  async putReception(reception: Reception): Promise<number> {
    return numericKey(await this.db.put(STORES.receptions, reception));
  }

  getReception(id: number): Promise<Reception | undefined> {
    return this.db.get<Reception>(STORES.receptions, id);
  }

  listReceptions(sessionId: string): Promise<Reception[]> {
    return this.db.getAllFromIndex<Reception>(
      STORES.receptions,
      INDEXES.receptions.sessionTime,
      timeRange(sessionId),
    );
  }

  listConfirmedReceptions(sessionId: string): Promise<Reception[]> {
    return this.db.getAllFromIndex<Reception>(
      STORES.receptions,
      INDEXES.receptions.sessionConfirmedTime,
      confirmedTimeRange(sessionId, 1),
    );
  }

  iterateReceptions(
    sessionId: string,
    callback: (reception: Reception) => void | false,
  ): Promise<void> {
    return this.db.iterate<Reception>(
      STORES.receptions,
      { indexName: INDEXES.receptions.sessionTime, query: timeRange(sessionId) },
      (reception) => callback(reception),
    );
  }

  async addFix(fix: GpsFix): Promise<number> {
    return numericKey(await this.db.add(STORES.fixes, fix));
  }

  async putFix(fix: GpsFix): Promise<number> {
    return numericKey(await this.db.put(STORES.fixes, fix));
  }

  listFixes(sessionId: string, accepted?: boolean): Promise<GpsFix[]> {
    if (accepted === undefined) {
      return this.db.getAllFromIndex<GpsFix>(
        STORES.fixes,
        INDEXES.fixes.sessionTime,
        timeRange(sessionId),
      );
    }
    return this.db.getAllFromIndex<GpsFix>(
      STORES.fixes,
      INDEXES.fixes.sessionAcceptedTime,
      acceptedTimeRange(sessionId, accepted ? 1 : 0),
    );
  }

  iterateFixes(
    sessionId: string,
    callback: (fix: GpsFix) => void | false,
    accepted?: boolean,
  ): Promise<void> {
    return this.db.iterate<GpsFix>(
      STORES.fixes,
      accepted === undefined
        ? { indexName: INDEXES.fixes.sessionTime, query: timeRange(sessionId) }
        : {
            indexName: INDEXES.fixes.sessionAcceptedTime,
            query: acceptedTimeRange(sessionId, accepted ? 1 : 0),
          },
      (fix) => callback(fix),
    );
  }

  async addEvent(event: SessionEvent): Promise<number> {
    return numericKey(await this.db.add(STORES.events, event));
  }

  listEvents(sessionId: string, type?: SessionEvent['type']): Promise<SessionEvent[]> {
    if (type === undefined) {
      return this.db.getAllFromIndex<SessionEvent>(
        STORES.events,
        INDEXES.events.sessionTime,
        timeRange(sessionId),
      );
    }
    return this.db
      .getAllFromIndex<SessionEvent>(
        STORES.events,
        INDEXES.events.sessionType,
        IDBKeyRange.only([sessionId, type]),
      )
      .then((events) => events.sort((a, b) => a.t - b.t));
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.db.put<SettingRecord<T>>(STORES.settings, { key, value });
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const record = await this.db.get<SettingRecord<T>>(STORES.settings, key);
    return record?.value;
  }

  deleteSetting(key: string): Promise<void> {
    return this.db.delete(STORES.settings, key);
  }

  async putBlob(record: BlobRecord): Promise<void> {
    await this.db.put(STORES.blobs, record);
  }

  getBlob(id: string): Promise<BlobRecord | undefined> {
    return this.db.get<BlobRecord>(STORES.blobs, id);
  }

  deleteBlob(id: string): Promise<void> {
    return this.db.delete(STORES.blobs, id);
  }

  async reconcileSessionCounters(sessionId: string): Promise<SearchSession> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} does not exist`);

    let receptions = 0;
    let confirmed = 0;
    let located = 0;
    let decodeFailed = 0;
    let discoveries = 0;
    let bestConfirmed: SearchSession['bestConfirmed'];

    await this.iterateReceptions(sessionId, (reception) => {
      receptions += 1;
      if (reception.conf === 1 && reception.cls.confirmed) {
        confirmed += 1;
        if (reception.gps.status === 'ok') located += 1;
        if (
          !bestConfirmed ||
          reception.rssi > bestConfirmed.rssi ||
          (reception.rssi === bestConfirmed.rssi && reception.t < bestConfirmed.t)
        ) {
          bestConfirmed = {
            t: reception.t,
            rssi: reception.rssi,
            snr: reception.snr,
            ...(reception.id === undefined ? {} : { receptionId: reception.id }),
          };
        }
      }
      if (reception.cls.kind === 'DECODE_FAILED' || reception.decodeError !== undefined) {
        decodeFailed += 1;
      }
      if (reception.source === 'discovery') discoveries += 1;
    });

    let fixesAccepted = 0;
    let fixesRejected = 0;
    await this.iterateFixes(sessionId, (fix) => {
      if (fix.acceptedNum === 1 && fix.accepted) fixesAccepted += 1;
      else fixesRejected += 1;
    });

    const reconciled: SearchSession = {
      ...session,
      counters: {
        receptions,
        confirmed,
        located,
        fixesAccepted,
        fixesRejected,
        decodeFailed,
        discoveries,
      },
      ...(bestConfirmed ? { bestConfirmed } : { bestConfirmed: undefined }),
    };
    await this.putSession(reconciled);
    return reconciled;
  }

  /** Atomically replace stored classifications and their derived session counters. */
  async replaceSessionClassifications(
    session: SearchSession,
    receptions: readonly Reception[],
  ): Promise<void> {
    const nextSession = structuredClone(session);
    const records = receptions.map((reception) => structuredClone(reception));
    for (const reception of records) {
      if (!Number.isSafeInteger(reception.id) || (reception.id as number) < 1) {
        throw new Error('Reclassified receptions must already have persistent IDs');
      }
      if (reception.sessionId !== nextSession.id) {
        throw new Error('Reclassified reception belongs to a different session');
      }
    }

    const transaction = this.db.transaction([STORES.sessions, STORES.receptions], 'readwrite');
    const complete = transactionComplete(transaction);
    try {
      transaction.objectStore(STORES.sessions).put(nextSession);
      const store = transaction.objectStore(STORES.receptions);
      for (const reception of records) store.put(reception);
    } catch (error) {
      try {
        transaction.abort();
        await complete;
      } catch {
        // Preserve the synchronous setup error below.
      }
      throw error;
    }
    await complete;
  }

  /** Import a validated archive as one all-or-nothing IndexedDB transaction. */
  async importSessionBundle(
    target: TargetProfile,
    session: SearchSession,
    receptions: readonly Reception[],
    fixes: readonly GpsFix[],
    events: readonly SessionEvent[],
  ): Promise<SearchSession> {
    // Prepare and validate every value before opening the transaction. This
    // avoids committing an earlier request if cloning a later record throws.
    const importedTarget = structuredClone(target);
    const importedFixes = fixes.map((source) => {
      const record = structuredClone(source);
      const oldId = record.id;
      delete record.id;
      return { record, oldId };
    });
    const importedReceptions = receptions.map((source) => {
      const record = structuredClone(source);
      const oldId = record.id;
      const oldFixId = record.gps.fixId;
      const oldDupOf = record.dupOf;
      delete record.id;
      delete record.gps.fixId;
      delete record.dupOf;
      return { record, oldId, oldFixId, oldDupOf, newId: undefined as number | undefined };
    });
    const importedEvents = events.map((source) => {
      const record = structuredClone(source);
      delete record.id;
      return record;
    });
    const oldFixIds = uniqueArchiveIds(importedFixes, 'fix');
    const oldReceptionIds = uniqueArchiveIds(importedReceptions, 'reception');
    for (const reception of importedReceptions) {
      if (reception.oldFixId !== undefined && !oldFixIds.has(reception.oldFixId)) {
        throw new Error(`Reception references missing archived fix ${reception.oldFixId}`);
      }
      if (reception.oldDupOf !== undefined && !oldReceptionIds.has(reception.oldDupOf)) {
        throw new Error(`Reception references missing archived reception ${reception.oldDupOf}`);
      }
    }
    let importedSession = reconcileImportedSession(
      structuredClone(session),
      importedReceptions.map(({ record }) => record),
      importedFixes.map(({ record }) => record),
    );

    const stores: readonly StoreName[] = [
      STORES.targets,
      STORES.sessions,
      STORES.receptions,
      STORES.fixes,
      STORES.events,
    ];
    const transaction = this.db.transaction(stores, 'readwrite');
    const complete = transactionComplete(transaction);
    let enqueueError: unknown;
    const abortImport = (error: unknown): void => {
      enqueueError ??= error;
      try {
        transaction.abort();
      } catch {
        // The original enqueue/mapping error remains the useful failure.
      }
    };
    const trackRequestError = <T>(request: IDBRequest<T>): IDBRequest<T> => {
      request.addEventListener('error', () => {
        enqueueError ??= request.error;
      });
      return request;
    };
    const fixIdMap = new Map<number, number>();
    const receptionIdMap = new Map<number, number>();
    let pendingIdAssignments = fixes.length + receptions.length;

    try {
      trackRequestError(transaction.objectStore(STORES.targets).add(importedTarget));
      const sessionStore = transaction.objectStore(STORES.sessions);
      trackRequestError(sessionStore.add(structuredClone(importedSession)));
      const receptionStore = transaction.objectStore(STORES.receptions);
      const fixStore = transaction.objectStore(STORES.fixes);
      const persistRemappedReceptionLinks = (): void => {
        pendingIdAssignments -= 1;
        if (pendingIdAssignments !== 0) return;
        try {
          for (const imported of importedReceptions) {
            const id = imported.newId;
            if (id === undefined) throw new Error('Imported reception did not receive an ID');
            imported.record.id = id;
            if (imported.oldFixId !== undefined) {
              const fixId = fixIdMap.get(imported.oldFixId);
              if (fixId === undefined) throw new Error(`Unable to remap archived fix ${imported.oldFixId}`);
              imported.record.gps.fixId = fixId;
            }
            if (imported.oldDupOf !== undefined) {
              const dupOf = receptionIdMap.get(imported.oldDupOf);
              if (dupOf === undefined) throw new Error(`Unable to remap archived reception ${imported.oldDupOf}`);
              imported.record.dupOf = dupOf;
            }
            trackRequestError(receptionStore.put(structuredClone(imported.record)));
          }
          importedSession = reconcileImportedSession(
            importedSession,
            importedReceptions.map(({ record }) => record),
            importedFixes.map(({ record }) => record),
          );
          trackRequestError(sessionStore.put(structuredClone(importedSession)));
        } catch (error) {
          abortImport(error);
        }
      };

      for (const imported of importedFixes) {
        const request = trackRequestError(fixStore.add(imported.record));
        request.addEventListener('success', () => {
          try {
            const newId = numericKey(request.result);
            if (imported.oldId !== undefined) fixIdMap.set(imported.oldId, newId);
            persistRemappedReceptionLinks();
          } catch (error) {
            abortImport(error);
          }
        });
      }
      for (const imported of importedReceptions) {
        const request = trackRequestError(receptionStore.add(imported.record));
        request.addEventListener('success', () => {
          try {
            const newId = numericKey(request.result);
            imported.newId = newId;
            if (imported.oldId !== undefined) receptionIdMap.set(imported.oldId, newId);
            persistRemappedReceptionLinks();
          } catch (error) {
            abortImport(error);
          }
        });
      }

      const eventStore = transaction.objectStore(STORES.events);
      for (const event of importedEvents) trackRequestError(eventStore.add(event));
    } catch (error) {
      abortImport(error);
    }
    try {
      await complete;
    } catch (error) {
      throw enqueueError ?? error;
    }
    return structuredClone(importedSession);
  }

  /** Delete a session and all of its append-only records in one transaction. */
  async deleteSession(id: string): Promise<void> {
    const stores: readonly StoreName[] = [
      STORES.sessions,
      STORES.receptions,
      STORES.fixes,
      STORES.events,
    ];
    const transaction = this.db.transaction(stores, 'readwrite');
    const complete = transactionComplete(transaction);
    transaction.objectStore(STORES.sessions).delete(id);

    const deleteByIndex = (storeName: StoreName, indexName: string): void => {
      const request = transaction
        .objectStore(storeName)
        .index(indexName)
        .openCursor(timeRange(id));
      request.addEventListener('success', () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      });
    };
    deleteByIndex(STORES.receptions, INDEXES.receptions.sessionTime);
    deleteByIndex(STORES.fixes, INDEXES.fixes.sessionTime);
    deleteByIndex(STORES.events, INDEXES.events.sessionTime);
    await complete;
  }
}

function uniqueArchiveIds(
  records: ReadonlyArray<{ oldId?: number }>,
  label: 'fix' | 'reception',
): Set<number> {
  const ids = new Set<number>();
  for (const record of records) {
    if (record.oldId === undefined) continue;
    if (!Number.isSafeInteger(record.oldId) || record.oldId < 1) {
      throw new Error(`Archive contains invalid ${label} ID ${record.oldId}`);
    }
    if (ids.has(record.oldId)) throw new Error(`Archive contains duplicate ${label} ID ${record.oldId}`);
    ids.add(record.oldId);
  }
  return ids;
}

function reconcileImportedSession(
  session: SearchSession,
  receptions: readonly Reception[],
  fixes: readonly GpsFix[],
): SearchSession {
  let confirmed = 0;
  let located = 0;
  let decodeFailed = 0;
  let discoveries = 0;
  let bestConfirmed: SearchSession['bestConfirmed'];
  for (const reception of receptions) {
    if (reception.conf === 1 && reception.cls.confirmed) {
      confirmed += 1;
      if (reception.gps.status === 'ok') located += 1;
      if (
        !bestConfirmed
        || reception.rssi > bestConfirmed.rssi
        || (reception.rssi === bestConfirmed.rssi && reception.t < bestConfirmed.t)
      ) {
        bestConfirmed = {
          t: reception.t,
          rssi: reception.rssi,
          snr: reception.snr,
          ...(reception.id === undefined ? {} : { receptionId: reception.id }),
        };
      }
    }
    if (reception.cls.kind === 'DECODE_FAILED' || reception.decodeError !== undefined) decodeFailed += 1;
    if (reception.source === 'discovery') discoveries += 1;
  }
  const fixesAccepted = fixes.filter((fix) => fix.acceptedNum === 1 && fix.accepted).length;
  return {
    ...session,
    counters: {
      receptions: receptions.length,
      confirmed,
      located,
      fixesAccepted,
      fixesRejected: fixes.length - fixesAccepted,
      decodeFailed,
      discoveries,
    },
    ...(bestConfirmed ? { bestConfirmed } : { bestConfirmed: undefined }),
  };
}

export class DebouncedSessionWriter {
  private pending: SearchSession | undefined;
  private queuedWrites = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  lastError: unknown;

  constructor(
    private readonly repository: FinderRepository,
    private readonly delayMs = 2_000,
    private readonly maxQueuedWrites = 25,
  ) {}

  queue(session: SearchSession): void {
    this.pending = structuredClone(session);
    this.queuedWrites += 1;
    if (this.queuedWrites >= this.maxQueuedWrites) {
      void this.flush().catch((error: unknown) => {
        this.lastError = error;
      });
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch((error: unknown) => {
          this.lastError = error;
        });
      }, this.delayMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const session = this.pending;
    if (!session) return this.chain;
    this.pending = undefined;
    this.queuedWrites = 0;
    this.chain = this.chain.then(async () => {
      await this.repository.putSession(session);
    });
    return this.chain;
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

export const Repository = FinderRepository;
