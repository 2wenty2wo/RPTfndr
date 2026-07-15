import { METERS_PER_DEGREE_LAT, toRadians, type LatLon } from './geo';

export type FixRejectReason = 'hard-accuracy' | 'jump' | 'filter-hold';

export interface RawLocationFix extends LatLon {
  accuracy: number;
  t: number;
}

export interface FilteredPosition extends RawLocationFix {
  deadReckoned: boolean;
}

export interface FixFilterDecision {
  accepted: boolean;
  rejectReason?: FixRejectReason;
  /** A moving track can briefly display a bounded dead-reckoned position. */
  effectivePosition?: FilteredPosition;
  forced: boolean;
  moving: boolean;
  consecutiveRejects: number;
  cause?: 'jump';
}

export interface FixFilterOptions {
  maxAccuracyM?: number;
  maxAccelerationMps2?: number;
  baseToleranceM?: number;
  maxConsecutiveRejects?: number;
  velocitySmoothing?: number;
  minimumMovingSpeedMps?: number;
  noiseAccuracyMultiplier?: number;
  movingStreak?: number;
  maxDeadReckonSeconds?: number;
}

const DEFAULTS = {
  maxAccuracyM: 75,
  maxAccelerationMps2: 12,
  baseToleranceM: 15,
  maxConsecutiveRejects: 4,
  velocitySmoothing: 0.4,
  minimumMovingSpeedMps: 3,
  noiseAccuracyMultiplier: 1.5,
  movingStreak: 3,
  maxDeadReckonSeconds: 2,
} as const;

interface Velocity {
  x: number;
  y: number;
}

export class GpsFixFilter {
  readonly options: Required<FixFilterOptions>;
  private lastAccepted: RawLocationFix | undefined;
  private velocity: Velocity = { x: 0, y: 0 };
  private moveStreak = 0;
  private rejectCount = 0;

  constructor(options: FixFilterOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  reset(): void {
    this.lastAccepted = undefined;
    this.velocity = { x: 0, y: 0 };
    this.moveStreak = 0;
    this.rejectCount = 0;
  }

  getLastAccepted(): RawLocationFix | undefined {
    return this.lastAccepted ? { ...this.lastAccepted } : undefined;
  }

  getVelocity(): Readonly<Velocity> {
    return { ...this.velocity };
  }

  process(fix: RawLocationFix): FixFilterDecision {
    if (
      !Number.isFinite(fix.lat) ||
      fix.lat < -90 ||
      fix.lat > 90 ||
      !Number.isFinite(fix.lon) ||
      !Number.isFinite(fix.accuracy) ||
      fix.accuracy < 0 ||
      fix.accuracy > this.options.maxAccuracyM
    ) {
      this.rejectCount = 0;
      return {
        accepted: false,
        rejectReason: 'hard-accuracy',
        forced: false,
        moving: this.isMoving(),
        consecutiveRejects: 0,
      };
    }

    const last = this.lastAccepted;
    if (!last) {
      this.lastAccepted = { ...fix };
      this.velocity = { x: 0, y: 0 };
      this.moveStreak = 0;
      this.rejectCount = 0;
      return {
        accepted: true,
        effectivePosition: { ...fix, deadReckoned: false },
        forced: false,
        moving: false,
        consecutiveRejects: 0,
      };
    }

    const elapsedSeconds = Math.max(0.001, (fix.t - last.t) / 1_000);
    const metresPerDegreeLon =
      METERS_PER_DEGREE_LAT * Math.max(1e-9, Math.abs(Math.cos(toRadians(last.lat))));
    const x = (fix.lon - last.lon) * metresPerDegreeLon;
    const y = (fix.lat - last.lat) * METERS_PER_DEGREE_LAT;
    const step = Math.hypot(x, y);
    const noise =
      this.options.noiseAccuracyMultiplier * Math.max(fix.accuracy, last.accuracy);
    const moving = this.isMoving();
    const accelerationBudget =
      0.5 * this.options.maxAccelerationMps2 * elapsedSeconds * elapsedSeconds;
    let rejected: boolean;

    if (moving) {
      const residual = Math.hypot(
        x - this.velocity.x * elapsedSeconds,
        y - this.velocity.y * elapsedSeconds,
      );
      rejected =
        residual > accelerationBudget + 2 * fix.accuracy + this.options.baseToleranceM;
    } else {
      rejected = step > accelerationBudget + noise + this.options.baseToleranceM;
    }

    if (rejected && this.rejectCount < this.options.maxConsecutiveRejects) {
      this.rejectCount += 1;
      if (!moving) {
        return {
          accepted: false,
          rejectReason: 'filter-hold',
          forced: false,
          moving: false,
          consecutiveRejects: this.rejectCount,
          cause: 'jump',
        };
      }
      const deadReckonSeconds = Math.min(
        elapsedSeconds,
        this.options.maxDeadReckonSeconds,
      );
      return {
        accepted: false,
        rejectReason: 'jump',
        effectivePosition: {
          lat: last.lat +
            (this.velocity.y * deadReckonSeconds) / METERS_PER_DEGREE_LAT,
          lon: last.lon + (this.velocity.x * deadReckonSeconds) / metresPerDegreeLon,
          accuracy: last.accuracy,
          t: fix.t,
          deadReckoned: true,
        },
        forced: false,
        moving: true,
        consecutiveRejects: this.rejectCount,
        cause: 'jump',
      };
    }

    const instantaneous = { x: x / elapsedSeconds, y: y / elapsedSeconds };
    const forced = rejected;
    if (forced) {
      this.velocity = instantaneous;
      this.moveStreak = 0;
    } else {
      const alpha = this.options.velocitySmoothing;
      this.velocity = {
        x: alpha * instantaneous.x + (1 - alpha) * this.velocity.x,
        y: alpha * instantaneous.y + (1 - alpha) * this.velocity.y,
      };
      if (
        step > noise &&
        Math.hypot(this.velocity.x, this.velocity.y) > this.options.minimumMovingSpeedMps
      ) {
        this.moveStreak += 1;
      } else {
        this.moveStreak = 0;
      }
    }
    this.lastAccepted = { ...fix };
    this.rejectCount = 0;
    return {
      accepted: true,
      effectivePosition: { ...fix, deadReckoned: false },
      forced,
      moving: this.isMoving(),
      consecutiveRejects: 0,
      ...(forced ? { cause: 'jump' as const } : {}),
    };
  }

  accept(fix: RawLocationFix): FixFilterDecision {
    return this.process(fix);
  }

  private isMoving(): boolean {
    return (
      this.moveStreak >= this.options.movingStreak &&
      Math.hypot(this.velocity.x, this.velocity.y) > this.options.minimumMovingSpeedMps
    );
  }
}

export const DEFAULT_FIX_FILTER_OPTIONS: Readonly<Required<FixFilterOptions>> = DEFAULTS;
