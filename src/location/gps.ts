import type { GpsAssociation, GpsFix } from '../types';
import {
  GpsFixFilter,
  type FilteredPosition,
  type FixFilterOptions,
} from './fixFilter';

export const GPS_WATCH_OPTIONS: Readonly<PositionOptions> = {
  enableHighAccuracy: true,
  maximumAge: 5_000,
  timeout: 30_000,
};

export const GPS_ASSOCIATION_DEFAULTS = {
  futureToleranceMs: 1_000,
  freshMaxAgeMs: 10_000,
  staleMaxAgeMs: 30_000,
  goodAccuracyM: 25,
  ringSize: 32,
} as const;

export type GpsState = 'good' | 'degraded' | 'searching' | 'denied' | 'unavailable';

export interface GpsAssociationOptions {
  futureToleranceMs?: number;
  freshMaxAgeMs?: number;
  staleMaxAgeMs?: number;
}

function newestEligibleFix(
  fixes: readonly GpsFix[],
  receptionTime: number,
  futureToleranceMs: number,
): GpsFix | undefined {
  let newest: GpsFix | undefined;
  for (const fix of fixes) {
    if (!fix.accepted || fix.acceptedNum !== 1 || fix.t > receptionTime + futureToleranceMs) {
      continue;
    }
    if (!newest || fix.t > newest.t) newest = fix;
  }
  return newest;
}

export function associateGpsFix(
  fixes: readonly GpsFix[],
  receptionTime: number,
  options: GpsAssociationOptions = {},
): GpsAssociation {
  const futureToleranceMs = options.futureToleranceMs ?? GPS_ASSOCIATION_DEFAULTS.futureToleranceMs;
  const freshMaxAgeMs = options.freshMaxAgeMs ?? GPS_ASSOCIATION_DEFAULTS.freshMaxAgeMs;
  const staleMaxAgeMs = options.staleMaxAgeMs ?? GPS_ASSOCIATION_DEFAULTS.staleMaxAgeMs;
  const fix = newestEligibleFix(fixes, receptionTime, futureToleranceMs);
  if (!fix) {
    return { status: 'none', excludedReason: 'No accepted GPS fix is available.' };
  }
  const ageMs = Math.max(0, receptionTime - fix.t);
  const snapshot = {
    ...(fix.id === undefined ? {} : { fixId: fix.id }),
    lat: fix.lat,
    lon: fix.lon,
    accuracy: fix.accuracy,
    ageMs,
    quality: fix.quality,
  } as const;
  if (ageMs <= freshMaxAgeMs) return { status: 'ok', ...snapshot };
  if (ageMs <= staleMaxAgeMs) {
    return {
      status: 'stale',
      ...snapshot,
      excludedReason: 'The most recent GPS fix is stale and is excluded from location estimates.',
    };
  }
  return {
    status: 'none',
    excludedReason: 'The most recent GPS fix is too old for this reception.',
  };
}

export const associateFix = associateGpsFix;

export class GpsAssociator {
  private readonly fixes: GpsFix[] = [];

  constructor(
    private readonly ringSize = GPS_ASSOCIATION_DEFAULTS.ringSize,
    private readonly options: GpsAssociationOptions = {},
  ) {
    if (!Number.isInteger(ringSize) || ringSize < 1) {
      throw new RangeError('GPS ring size must be a positive integer');
    }
  }

  add(fix: GpsFix): void {
    if (!fix.accepted || fix.acceptedNum !== 1) return;
    this.fixes.push(fix);
    this.fixes.sort((a, b) => a.t - b.t);
    if (this.fixes.length > this.ringSize) {
      this.fixes.splice(0, this.fixes.length - this.ringSize);
    }
  }

  clear(): void {
    this.fixes.length = 0;
  }

  values(): readonly GpsFix[] {
    return [...this.fixes];
  }

  latest(): GpsFix | undefined {
    return this.fixes.at(-1);
  }

  associate(receptionTime: number): GpsAssociation {
    return associateGpsFix(this.fixes, receptionTime, this.options);
  }
}

export interface GpsServiceOptions {
  geolocation?: Geolocation | null;
  filter?: GpsFixFilter;
  filterOptions?: FixFilterOptions;
  associator?: GpsAssociator;
  now?: () => number;
  onFix?: (fix: GpsFix) => number | void | Promise<number | void>;
  onState?: (state: GpsState) => void;
  onClockSkew?: (skewMs: number, fix: GpsFix) => void;
}

export class GpsService {
  readonly filter: GpsFixFilter;
  readonly associator: GpsAssociator;
  private readonly geolocation: Geolocation | null;
  private readonly now: () => number;
  private readonly onFix: GpsServiceOptions['onFix'];
  private readonly onState: GpsServiceOptions['onState'];
  private readonly onClockSkew: GpsServiceOptions['onClockSkew'];
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private watchId: number | undefined;
  private sessionId: string | undefined;
  private state: GpsState = 'searching';
  private displayPosition: FilteredPosition | undefined;

  constructor(options: GpsServiceOptions = {}) {
    this.geolocation =
      options.geolocation === undefined
        ? (globalThis.navigator?.geolocation ?? null)
        : options.geolocation;
    this.filter = options.filter ?? new GpsFixFilter(options.filterOptions);
    this.associator = options.associator ?? new GpsAssociator();
    this.now = options.now ?? Date.now;
    this.onFix = options.onFix;
    this.onState = options.onState;
    this.onClockSkew = options.onClockSkew;
  }

  start(sessionId: string): boolean {
    this.stop();
    this.sessionId = sessionId;
    this.filter.reset();
    this.associator.clear();
    this.displayPosition = undefined;
    if (!this.geolocation) {
      this.setState('unavailable');
      return false;
    }
    this.setState('searching');
    this.watchId = this.geolocation.watchPosition(
      (position) => this.ingestPosition(position),
      (error) => this.handleError(error),
      GPS_WATCH_OPTIONS,
    );
    return true;
  }

  stop(): void {
    if (this.watchId !== undefined && this.geolocation) {
      this.geolocation.clearWatch(this.watchId);
    }
    this.watchId = undefined;
    this.sessionId = undefined;
  }

  getState(): GpsState {
    return this.state;
  }

  getDisplayPosition(): FilteredPosition | undefined {
    return this.displayPosition ? { ...this.displayPosition } : undefined;
  }

  associate(receptionTime: number): GpsAssociation {
    return this.associator.associate(receptionTime);
  }

  /** Public for replay/demo transports and deterministic tests. */
  ingestPosition(position: GeolocationPosition, arrivalTime = this.now()): GpsFix | undefined {
    const sessionId = this.sessionId;
    if (!sessionId) return undefined;
    const coords = position.coords;
    const positionTime = position.timestamp || arrivalTime;
    const decision = this.filter.process({
      lat: coords.latitude,
      lon: coords.longitude,
      accuracy: coords.accuracy,
      t: positionTime,
    });
    const quality =
      coords.accuracy <= GPS_ASSOCIATION_DEFAULTS.goodAccuracyM ? 'good' : 'degraded';
    const fix: GpsFix = {
      sessionId,
      t: arrivalTime,
      posT: positionTime,
      lat: coords.latitude,
      lon: coords.longitude,
      accuracy: coords.accuracy,
      ...(coords.altitude == null ? {} : { altitude: coords.altitude }),
      ...(coords.altitudeAccuracy == null
        ? {}
        : { altitudeAccuracy: coords.altitudeAccuracy }),
      ...(coords.speed == null ? {} : { speed: coords.speed }),
      ...(coords.heading == null ? {} : { heading: coords.heading }),
      accepted: decision.accepted,
      acceptedNum: decision.accepted ? 1 : 0,
      ...(decision.rejectReason ? { rejectReason: decision.rejectReason } : {}),
      quality,
    };
    if (decision.effectivePosition) this.displayPosition = decision.effectivePosition;
    if (decision.accepted) {
      this.associator.add(fix);
      this.setState(quality);
    }
    if (Math.abs(positionTime - arrivalTime) > 5_000) {
      this.onClockSkew?.(positionTime - arrivalTime, fix);
    }
    const persisted = this.onFix?.(fix);
    if (persisted instanceof Promise) {
      const pending = persisted
        .then((id) => {
          if (typeof id === 'number') fix.id = id;
        })
        .finally(() => this.pendingWrites.delete(pending));
      this.pendingWrites.add(pending);
    } else if (typeof persisted === 'number') {
      fix.id = persisted;
    }
    return fix;
  }

  async flushWrites(): Promise<void> {
    await Promise.all([...this.pendingWrites]);
  }

  private handleError(error: GeolocationPositionError): void {
    if (error.code === error.PERMISSION_DENIED) this.setState('denied');
    else if (error.code === error.POSITION_UNAVAILABLE) this.setState('unavailable');
    else this.setState('searching');
  }

  private setState(state: GpsState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState?.(state);
  }
}
