export const DB_NAME = 'meshcore-finder';
export const DB_VERSION = 1;

export const STORES = {
  sessions: 'sessions',
  targets: 'targets',
  receptions: 'receptions',
  fixes: 'fixes',
  events: 'events',
  settings: 'settings',
  blobs: 'blobs',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export const INDEXES = {
  sessions: {
    state: 'by-state',
    createdAt: 'by-created-at',
  },
  targets: {
    updatedAt: 'by-updated-at',
  },
  receptions: {
    sessionTime: 'by-session-time',
    sessionConfirmedTime: 'by-session-confirmed-time',
    sessionMorton: 'by-session-morton',
  },
  fixes: {
    sessionTime: 'by-session-time',
    sessionAcceptedTime: 'by-session-accepted-time',
  },
  events: {
    sessionTime: 'by-session-time',
    sessionType: 'by-session-type',
  },
} as const;

export interface MigrationContext {
  readonly db: IDBDatabase;
  readonly transaction: IDBTransaction;
  readonly oldVersion: number;
  readonly newVersion: number;
}
export type Migration = (context: MigrationContext) => void;
export type MigrationMap = ReadonlyMap<number, Migration>;

function migrateToV1({ db }: MigrationContext): void {
  const sessions = db.createObjectStore(STORES.sessions, { keyPath: 'id' });
  sessions.createIndex(INDEXES.sessions.state, 'state');
  sessions.createIndex(INDEXES.sessions.createdAt, 'createdAt');

  const targets = db.createObjectStore(STORES.targets, { keyPath: 'id' });
  targets.createIndex(INDEXES.targets.updatedAt, 'updatedAt');

  const receptions = db.createObjectStore(STORES.receptions, {
    keyPath: 'id',
    autoIncrement: true,
  });
  receptions.createIndex(INDEXES.receptions.sessionTime, ['sessionId', 't']);
  receptions.createIndex(INDEXES.receptions.sessionConfirmedTime, ['sessionId', 'conf', 't']);
  receptions.createIndex(INDEXES.receptions.sessionMorton, ['sessionId', 'morton']);

  const fixes = db.createObjectStore(STORES.fixes, {
    keyPath: 'id',
    autoIncrement: true,
  });
  fixes.createIndex(INDEXES.fixes.sessionTime, ['sessionId', 't']);
  fixes.createIndex(INDEXES.fixes.sessionAcceptedTime, ['sessionId', 'acceptedNum', 't']);

  const events = db.createObjectStore(STORES.events, {
    keyPath: 'id',
    autoIncrement: true,
  });
  events.createIndex(INDEXES.events.sessionTime, ['sessionId', 't']);
  events.createIndex(INDEXES.events.sessionType, ['sessionId', 'type']);

  db.createObjectStore(STORES.settings, { keyPath: 'key' });
  db.createObjectStore(STORES.blobs, { keyPath: 'id' });
}

/**
 * Migrations are deliberately version keyed and run one at a time. Tests and
 * future releases can extend this map without replacing the v1 migration.
 */
export const MIGRATIONS: MigrationMap = new Map<number, Migration>([[1, migrateToV1]]);

export function runMigrations(
  context: Omit<MigrationContext, 'oldVersion' | 'newVersion'> & {
    oldVersion: number;
    newVersion: number;
  },
  migrations: MigrationMap = MIGRATIONS,
): void {
  for (let version = context.oldVersion + 1; version <= context.newVersion; version += 1) {
    const migration = migrations.get(version);
    if (!migration) {
      throw new Error(`Missing IndexedDB migration for version ${version}`);
    }
    migration(context);
  }
}
