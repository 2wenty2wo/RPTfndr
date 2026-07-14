import type { CellAggregate, IdentityTier, Reception } from '../types';
import {
  bearingDegrees,
  clamp,
  clamp01,
  distanceMeters,
  gridCell,
  normalizeBearing,
} from './geo';

export interface CellSample {
  t: number;
  lat: number;
  lon: number;
  gpsAccuracy: number;
  rssi: number;
  snr: number;
  identityTier: IdentityTier;
  heading?: number;
}

export interface CellAggregationOptions {
  mode?: 'walk' | 'drive';
  cellSizeM?: number;
  maxSamplesPerCell?: number;
  maxGpsAccuracyM?: number;
  liveView?: boolean;
  now?: number;
  random?: () => number;
}

const MODE_DEFAULTS = {
  walk: { cellSizeM: 12, minCellSizeM: 8, maxCellSizeM: 20, passGapMs: 180_000 },
  drive: { cellSizeM: 45, minCellSizeM: 30, maxCellSizeM: 60, passGapMs: 120_000 },
} as const;

const TIER_RANK: Readonly<Record<IdentityTier, number>> = {
  none: 0,
  name: 1,
  prefix: 2,
  'node-id': 3,
  'full-pubkey': 4,
};

function weakestTier(a: IdentityTier, b: IdentityTier): IdentityTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle];
  if (high === undefined) return Number.NaN;
  if (sorted.length % 2 === 1) return high;
  const low = sorted[middle - 1];
  return low === undefined ? high : (low + high) / 2;
}

export function medianAbsoluteDeviation(values: readonly number[]): number {
  const midpoint = median(values);
  return median(values.map((value) => Math.abs(value - midpoint)));
}

export function cellSizeForMode(mode: 'walk' | 'drive', requested?: number): number {
  const profile = MODE_DEFAULTS[mode];
  return clamp(
    requested ?? profile.cellSizeM,
    profile.minCellSizeM,
    profile.maxCellSizeM,
  );
}

export function headingOctant(heading: number): number {
  return Math.floor((normalizeBearing(heading) + 22.5) / 45) % 8;
}

export function receptionToCellSample(
  reception: Reception,
  maxGpsAccuracyM = 75,
): CellSample | undefined {
  const gps = reception.gps;
  if (
    reception.conf !== 1 ||
    !reception.cls.confirmed ||
    gps.status !== 'ok' ||
    gps.lat === undefined ||
    gps.lon === undefined ||
    gps.accuracy === undefined ||
    gps.accuracy > maxGpsAccuracyM ||
    !Number.isFinite(reception.rssi) ||
    !Number.isFinite(reception.snr)
  ) {
    return undefined;
  }
  return {
    t: reception.t,
    lat: gps.lat,
    lon: gps.lon,
    gpsAccuracy: gps.accuracy,
    rssi: reception.rssi,
    snr: reception.snr,
    identityTier: reception.cls.identityTier,
  };
}

interface CellAccumulator {
  readonly cell: ReturnType<typeof gridCell>;
  readonly samples: CellSample[];
  readonly octants: Set<number>;
  count: number;
  passes: number;
  firstT: number;
  lastT: number;
  minimumTier: IdentityTier;
}

export class CellAggregator {
  readonly mode: 'walk' | 'drive';
  readonly cellSizeM: number;
  private readonly maxSamplesPerCell: number;
  private readonly maxGpsAccuracyM: number;
  private readonly liveView: boolean;
  private readonly now: number;
  private readonly random: () => number;
  private readonly passGapMs: number;
  private readonly groups = new Map<string, CellAccumulator>();
  private previousSample: CellSample | undefined;

  constructor(options: CellAggregationOptions = {}) {
    this.mode = options.mode ?? 'walk';
    this.cellSizeM = cellSizeForMode(this.mode, options.cellSizeM);
    this.maxSamplesPerCell = Math.max(1, Math.floor(options.maxSamplesPerCell ?? 500));
    this.maxGpsAccuracyM = options.maxGpsAccuracyM ?? 75;
    this.liveView = options.liveView ?? false;
    this.now = options.now ?? Date.now();
    this.random = options.random ?? Math.random;
    this.passGapMs = MODE_DEFAULTS[this.mode].passGapMs;
  }

  addReception(reception: Reception): boolean {
    const sample = receptionToCellSample(reception, this.maxGpsAccuracyM);
    return sample ? this.add(sample) : false;
  }

  add(sample: CellSample): boolean {
    if (
      !Number.isFinite(sample.t) ||
      !Number.isFinite(sample.lat) ||
      !Number.isFinite(sample.lon) ||
      !Number.isFinite(sample.gpsAccuracy) ||
      sample.gpsAccuracy < 0 ||
      sample.gpsAccuracy > this.maxGpsAccuracyM ||
      !Number.isFinite(sample.rssi) ||
      !Number.isFinite(sample.snr)
    ) {
      return false;
    }
    const cell = gridCell(this.cellSizeM, sample.lat, sample.lon);
    let accumulator = this.groups.get(cell.key);
    if (!accumulator) {
      accumulator = {
        cell,
        samples: [],
        octants: new Set<number>(),
        count: 0,
        passes: 0,
        firstT: sample.t,
        lastT: sample.t,
        minimumTier: sample.identityTier,
      };
      this.groups.set(cell.key, accumulator);
    }

    let heading = sample.heading;
    if (
      heading === undefined &&
      this.previousSample &&
      distanceMeters(this.previousSample, sample) >= 1
    ) {
      heading = bearingDegrees(this.previousSample, sample);
    }
    if (heading !== undefined && Number.isFinite(heading)) {
      accumulator.octants.add(headingOctant(heading));
    }
    if (!this.previousSample || sample.t >= this.previousSample.t) this.previousSample = sample;

    if (accumulator.count === 0) accumulator.passes = 1;
    else if (sample.t - accumulator.lastT > this.passGapMs) accumulator.passes += 1;
    accumulator.count += 1;
    accumulator.firstT = Math.min(accumulator.firstT, sample.t);
    accumulator.lastT = Math.max(accumulator.lastT, sample.t);
    accumulator.minimumTier = weakestTier(accumulator.minimumTier, sample.identityTier);

    if (accumulator.samples.length < this.maxSamplesPerCell) {
      accumulator.samples.push(sample);
    } else {
      const replacement = Math.floor(this.random() * accumulator.count);
      if (replacement < this.maxSamplesPerCell) accumulator.samples[replacement] = sample;
    }
    return true;
  }

  values(): CellAggregate[] {
    return [...this.groups.values()]
      .map((group) => this.finish(group))
      .sort((a, b) => b.medianRssi - a.medianRssi || a.key.localeCompare(b.key));
  }

  clear(): void {
    this.groups.clear();
    this.previousSample = undefined;
  }

  private finish(group: CellAccumulator): CellAggregate {
    const rssi = group.samples.map((sample) => sample.rssi);
    const snr = group.samples.map((sample) => sample.snr);
    const accuracy = group.samples.map((sample) => sample.gpsAccuracy);
    const medianRssi = median(rssi);
    const madRssi = medianAbsoluteDeviation(rssi);
    const medianGpsAcc = median(accuracy);
    const spanMinutes = (group.lastT - group.firstT) / 60_000;
    const gpsQuality = clamp01((50 - medianGpsAcc) / 40);
    const tierQuality =
      group.minimumTier === 'full-pubkey'
        ? 1
        : group.minimumTier === 'node-id'
          ? 0.7
          : 0;
    let confidence =
      0.25 * (Math.min(group.count, 10) / 10) +
      0.2 * (Math.min(group.passes, 3) / 3) +
      0.1 * (Math.min(spanMinutes, 30) / 30) +
      0.1 * (Math.min(group.octants.size, 3) / 3) +
      0.15 * gpsQuality +
      0.1 * (1 - clamp01(madRssi / 8)) +
      0.1 * tierQuality;
    if (this.liveView && this.now - group.lastT > 30 * 60_000) confidence *= 0.8;

    return {
      key: group.cell.key,
      centerLat: group.cell.centerLat,
      centerLon: group.cell.centerLon,
      sizeM: group.cell.sizeM,
      count: group.count,
      medianRssi,
      maxRssi: Math.max(...rssi),
      madRssi,
      medianSnr: median(snr),
      maxSnr: Math.max(...snr),
      medianGpsAcc,
      passes: group.passes,
      octants: group.octants.size,
      firstT: group.firstT,
      lastT: group.lastT,
      minIdentityTier: group.minimumTier,
      confidence: clamp01(confidence),
    };
  }
}

export function aggregateCells(
  input: readonly CellSample[] | readonly Reception[],
  options: CellAggregationOptions = {},
): CellAggregate[] {
  const aggregator = new CellAggregator(options);
  const chronological = [...input].sort((a, b) => a.t - b.t);
  for (const value of chronological) {
    if ('cls' in value) aggregator.addReception(value);
    else aggregator.add(value);
  }
  return aggregator.values();
}

export function aggregateReceptions(
  receptions: readonly Reception[],
  options: CellAggregationOptions = {},
): CellAggregate[] {
  return aggregateCells(receptions, options);
}

export const CELL_MODE_DEFAULTS = MODE_DEFAULTS;
