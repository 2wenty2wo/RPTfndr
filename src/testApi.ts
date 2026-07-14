import type { GpsFix, Reception } from './types';

export interface FinderTestApi {
  ready: Promise<void>;
  acknowledge(): Promise<void>;
  connectMock(): Promise<void>;
  injectFrame(frame: Uint8Array): void;
  injectGps(fix: Omit<GpsFix, 'sessionId' | 'acceptedNum'>): Promise<void>;
  dropConnection(): void;
  restoreConnection(): void;
  receptions(): readonly Reception[];
  clear(): Promise<void>;
}
