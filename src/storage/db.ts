import {
  DB_NAME,
  DB_VERSION,
  MIGRATIONS,
  runMigrations,
  type MigrationMap,
  type StoreName,
} from './schema';

export interface OpenDatabaseOptions {
  name?: string;
  version?: number;
  factory?: IDBFactory;
  migrations?: MigrationMap;
  onBlocked?: () => void;
}
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('IndexedDB request failed')),
      { once: true },
    );
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('IndexedDB transaction failed')),
      { once: true },
    );
  });
}

export class FinderDatabase {
  readonly connection: IDBDatabase;

  constructor(connection: IDBDatabase) {
    this.connection = connection;
  }

  close(): void {
    this.connection.close();
  }

  transaction(
    stores: StoreName | readonly StoreName[],
    mode: IDBTransactionMode = 'readonly',
  ): IDBTransaction {
    return this.connection.transaction(
      typeof stores === 'string' ? stores : [...stores],
      mode,
    );
  }

  async get<T>(storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const transaction = this.transaction(storeName);
    const complete = transactionComplete(transaction);
    const result = await requestResult(transaction.objectStore(storeName).get(key));
    await complete;
    return result as T | undefined;
  }

  async getAll<T>(storeName: StoreName, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
    const transaction = this.transaction(storeName);
    const complete = transactionComplete(transaction);
    const result = await requestResult(transaction.objectStore(storeName).getAll(query));
    await complete;
    return result as T[];
  }

  async getAllFromIndex<T>(
    storeName: StoreName,
    indexName: string,
    query?: IDBValidKey | IDBKeyRange,
    count?: number,
  ): Promise<T[]> {
    const transaction = this.transaction(storeName);
    const complete = transactionComplete(transaction);
    const result = await requestResult(
      transaction.objectStore(storeName).index(indexName).getAll(query, count),
    );
    await complete;
    return result as T[];
  }

  async put<T>(storeName: StoreName, value: T): Promise<IDBValidKey> {
    const transaction = this.transaction(storeName, 'readwrite');
    const complete = transactionComplete(transaction);
    const key = await requestResult(transaction.objectStore(storeName).put(value));
    await complete;
    return key;
  }

  async add<T>(storeName: StoreName, value: T): Promise<IDBValidKey> {
    const transaction = this.transaction(storeName, 'readwrite');
    const complete = transactionComplete(transaction);
    const key = await requestResult(transaction.objectStore(storeName).add(value));
    await complete;
    return key;
  }

  async delete(storeName: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
    const transaction = this.transaction(storeName, 'readwrite');
    const complete = transactionComplete(transaction);
    await requestResult(transaction.objectStore(storeName).delete(key));
    await complete;
  }

  async clear(storeName: StoreName): Promise<void> {
    const transaction = this.transaction(storeName, 'readwrite');
    const complete = transactionComplete(transaction);
    await requestResult(transaction.objectStore(storeName).clear());
    await complete;
  }

  async count(
    storeName: StoreName,
    query?: IDBValidKey | IDBKeyRange,
    indexName?: string,
  ): Promise<number> {
    const transaction = this.transaction(storeName);
    const complete = transactionComplete(transaction);
    const store = transaction.objectStore(storeName);
    const source: IDBObjectStore | IDBIndex = indexName ? store.index(indexName) : store;
    const result = await requestResult(source.count(query));
    await complete;
    return result;
  }

  /** Cursor callbacks must be synchronous; returning false stops the scan. */
  iterate<T>(
    storeName: StoreName,
    options: {
      indexName?: string;
      query?: IDBValidKey | IDBKeyRange;
      direction?: IDBCursorDirection;
    },
    callback: (value: T, primaryKey: IDBValidKey) => void | false,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = this.transaction(storeName);
        const store = transaction.objectStore(storeName);
        const source: IDBObjectStore | IDBIndex = options.indexName
          ? store.index(options.indexName)
          : store;
        const request = source.openCursor(options.query, options.direction);
        request.addEventListener('error', () => {
          reject(request.error ?? new Error('IndexedDB cursor failed'));
        });
        request.addEventListener('success', () => {
          const cursor = request.result;
          if (!cursor) return;
          if (callback(cursor.value as T, cursor.primaryKey) === false) {
            resolve();
            return;
          }
          cursor.continue();
        });
        transaction.addEventListener('complete', () => resolve(), { once: true });
        transaction.addEventListener(
          'abort',
          () => reject(transaction.error ?? new Error('IndexedDB cursor transaction aborted')),
          { once: true },
        );
        transaction.addEventListener(
          'error',
          () => reject(transaction.error ?? new Error('IndexedDB cursor transaction failed')),
          { once: true },
        );
      } catch (error) {
        reject(error);
      }
    });
  }
}

export function openFinderDatabase(options: OpenDatabaseOptions = {}): Promise<FinderDatabase> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));

  const name = options.name ?? DB_NAME;
  const version = options.version ?? DB_VERSION;
  const migrations = options.migrations ?? MIGRATIONS;

  return new Promise<FinderDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let upgradeError: unknown;
    try {
      request = factory.open(name, version);
    } catch (error) {
      reject(error);
      return;
    }

    request.addEventListener('upgradeneeded', (event) => {
      const transaction = request.transaction;
      if (!transaction) {
        upgradeError = new Error('IndexedDB upgrade transaction is unavailable');
        return;
      }
      try {
        runMigrations(
          {
            db: request.result,
            transaction,
            oldVersion: event.oldVersion,
            newVersion: event.newVersion ?? version,
          },
          migrations,
        );
      } catch (error) {
        upgradeError = error;
        transaction.abort();
      }
    });
    request.addEventListener('blocked', () => options.onBlocked?.());
    request.addEventListener('error', () => {
      reject(upgradeError ?? request.error ?? new Error(`Unable to open IndexedDB ${name}`));
    });
    request.addEventListener('success', () => {
      const connection = request.result;
      connection.addEventListener('versionchange', () => connection.close());
      resolve(new FinderDatabase(connection));
    });
  });
}

export const openDatabase = openFinderDatabase;

export function deleteFinderDatabase(
  name = DB_NAME,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));
  return new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.addEventListener('success', () => resolve(), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error(`Unable to delete IndexedDB ${name}`)),
      { once: true },
    );
  });
}

export interface StoragePersistenceResult {
  supported: boolean;
  persisted: boolean;
}

export async function requestPersistentStorage(
  storage: Pick<StorageManager, 'persist' | 'persisted'> | undefined = globalThis.navigator?.storage,
): Promise<StoragePersistenceResult> {
  if (!storage?.persist) return { supported: false, persisted: false };
  if (storage.persisted && (await storage.persisted())) {
    return { supported: true, persisted: true };
  }
  return { supported: true, persisted: await storage.persist() };
}
