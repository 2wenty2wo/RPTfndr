import { WORDING } from '../app/wording';
import type { AreaEstimate, CellAggregate } from '../types';
import {
  destinationPoint,
  polygonAreaMeters2,
  projectLocal,
  type LatLon,
} from './geo';

export interface AreaEstimateOptions {
  minSamples?: number;
  minCells?: number;
  signalWindowDb?: number;
  minimumCellConfidence?: number;
  generatedAt?: number;
}

interface HullPoint extends LatLon {
  x: number;
  y: number;
}

function cross(origin: HullPoint, a: HullPoint, b: HullPoint): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

export function convexHull(points: readonly LatLon[]): LatLon[] {
  if (points.length <= 1) return [...points];
  const projectionOrigin = points[0];
  if (!projectionOrigin) return [];
  const unique = new Map<string, HullPoint>();
  for (const point of points) {
    const projected = projectLocal(point, projectionOrigin);
    const hullPoint = { ...point, ...projected };
    unique.set(`${projected.x.toFixed(6)}:${projected.y.toFixed(6)}`, hullPoint);
  }
  const sorted = [...unique.values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 2) return sorted.map(({ lat, lon }) => ({ lat, lon }));

  const lower: HullPoint[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2] as HullPoint, lower[lower.length - 1] as HullPoint, point) <=
        0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: HullPoint[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    if (!point) continue;
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2] as HullPoint, upper[upper.length - 1] as HullPoint, point) <=
        0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper].map(({ lat, lon }) => ({ lat, lon }));
}

export function bufferCellCenters(cells: readonly CellAggregate[]): LatLon[] {
  const points: LatLon[] = [];
  for (const cell of cells) {
    const radiusM = cell.sizeM + cell.medianGpsAcc;
    for (let bearing = 0; bearing < 360; bearing += 45) {
      points.push(
        destinationPoint(
          { lat: cell.centerLat, lon: cell.centerLon },
          bearing,
          radiusM,
        ),
      );
    }
  }
  return convexHull(points);
}

function discAround(cell: CellAggregate): LatLon[] {
  const radiusM = 2 * cell.sizeM + cell.medianGpsAcc;
  const points: LatLon[] = [];
  for (let bearing = 0; bearing < 360; bearing += 45) {
    points.push(
      destinationPoint({ lat: cell.centerLat, lon: cell.centerLon }, bearing, radiusM),
    );
  }
  return points;
}

function notReady(
  reason: string,
  sampleCount: number,
  cellCount: number,
  generatedAt: number,
  strongest?: CellAggregate,
): AreaEstimate {
  return {
    ready: false,
    reason,
    sampleCount,
    cellCount,
    generatedAt,
    ...(strongest ? { strongest } : {}),
  };
}

/** Pure estimate; the AreaEstimator wrapper supplies the two-second live debounce. */
export function estimateArea(
  cells: readonly CellAggregate[],
  options: AreaEstimateOptions = {},
): AreaEstimate {
  const generatedAt = options.generatedAt ?? Date.now();
  const minSamples = options.minSamples ?? 5;
  const minCells = options.minCells ?? 3;
  const signalWindowDb = options.signalWindowDb ?? 6;
  const minimumCellConfidence = options.minimumCellConfidence ?? 0.25;
  const sampleCount = cells.reduce((sum, cell) => sum + cell.count, 0);
  const cellCount = cells.length;
  const strongest = [...cells].sort(
    (a, b) => b.medianRssi - a.medianRssi || b.confidence - a.confidence,
  )[0];

  if (sampleCount < minSamples) {
    return notReady(
      sampleCount === 0 ? WORDING.noConfirmed : WORDING.morePasses,
      sampleCount,
      cellCount,
      generatedAt,
      strongest,
    );
  }
  if (cellCount < minCells) {
    return notReady(WORDING.moreCells, sampleCount, cellCount, generatedAt, strongest);
  }
  if (!strongest) {
    return notReady(WORDING.noConfirmed, sampleCount, cellCount, generatedAt);
  }

  const selected = cells.filter(
    (cell) =>
      cell.medianRssi >= strongest.medianRssi - signalWindowDb &&
      cell.confidence >= minimumCellConfidence,
  );
  if (selected.length === 0) {
    return notReady(WORDING.morePasses, sampleCount, cellCount, generatedAt, strongest);
  }

  const polygonPoints = selected.length >= 3 ? bufferCellCenters(selected) : discAround(strongest);
  const meanConfidence =
    selected.reduce((sum, cell) => sum + cell.confidence, 0) / selected.length;
  const hasThreePasses = selected.some((cell) => cell.passes >= 3);
  const confidence: 'low' | 'medium' | 'high' =
    selected.length >= 3 && meanConfidence > 0.65 && hasThreePasses
      ? 'high'
      : selected.length >= 3 && meanConfidence > 0.4
        ? 'medium'
        : 'low';
  const polygon = polygonPoints.map(({ lat, lon }) => [lat, lon] as [number, number]);

  return {
    ready: true,
    reason: WORDING.estimateBasis,
    sampleCount,
    cellCount,
    polygon,
    areaM2: polygonAreaMeters2(polygonPoints),
    confidence,
    cellsUsed: selected.map((cell) => cell.key),
    strongest,
    generatedAt,
  };
}

export class AreaEstimator {
  private cells: readonly CellAggregate[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(estimate: AreaEstimate) => void>();
  private latestEstimate: AreaEstimate | undefined;

  constructor(
    private readonly options: AreaEstimateOptions = {},
    private readonly debounceMs = 2_000,
  ) {}

  update(cells: readonly CellAggregate[]): void {
    this.cells = [...cells];
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
  }

  flush(): AreaEstimate {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.latestEstimate = estimateArea(this.cells, this.options);
    for (const listener of this.listeners) listener(this.latestEstimate);
    return this.latestEstimate;
  }

  latest(): AreaEstimate | undefined {
    return this.latestEstimate;
  }

  subscribe(listener: (estimate: AreaEstimate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export const estimateSearchArea = estimateArea;
