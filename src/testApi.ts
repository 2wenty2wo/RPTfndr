import type { FinalApproachEstimate } from './location';
import type { GpsFix, Reception, TargetProfile } from './types';

export interface FinderTestApi {
  ready: Promise<void>;
  acknowledge(): Promise<void>;
  connectMock(): Promise<void>;
  injectFrame(frame: Uint8Array): void;
  injectGps(fix: Omit<GpsFix, 'sessionId' | 'acceptedNum'>): Promise<void>;
  addBearing(bearingDeg: number, accuracyDeg: number, note?: string): Promise<void>;
  dropConnection(): void;
  restoreConnection(): void;
  receptions(): readonly Reception[];
  finalApproach(): FinalApproachEstimate | undefined;
  activeTarget(): TargetProfile | undefined;
  clear(): Promise<void>;
}
