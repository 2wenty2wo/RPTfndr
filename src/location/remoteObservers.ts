import {
  clamp,
  destinationPoint,
  distanceMeters,
  polygonAreaMeters2,
  projectLocal,
  unprojectLocal,
  type LatLon,
  type LocalPoint,
} from './geo';
import { intersectConvexPolygons } from './bearings';

export type RemoteObserverObservationId = number | string;
export type RemoteObserverConfidence = 'low' | 'medium' | 'high';
export type RemoteObserverGeometryQuality = 'limited' | 'fair' | 'good';
export type RemoteObserverExclusionReason =
  | 'invalid-observation'
  | 'unverified-observer-position'
  | 'stale-observation'
  | 'future-observation'
  | 'target-mismatch'
  | 'unverified-target-match'
  | 'identity-collision'
  | 'indirect-neighbour'
  | 'observation-id-collision'
  | 'observer-position-collision'
  | 'insufficient-separation'
  | 'inconsistent-relative-signal'
  | 'analysis-limit';

/**
 * A target-attributed neighbour report from a repeater whose physical position
 * has been verified independently. Admin-advertised coordinates must set
 * `coordinateVerified` to false and will be rejected.
 */
export interface RemoteObserverObservation extends LatLon {
  id: RemoteObserverObservationId;
  observerId: string;
  targetPublicKey: string;
  observedAt: number;
  snrDb: number;
  coordinateVerified: boolean;
  coordinateAccuracyM?: number;
  /** Only a full-key match is eligible; short hashes can collide. */
  targetMatch: 'full-key' | 'short-id' | 'unverified';
  /** True only for a zero-hop/direct neighbour record. */
  directNeighbour: boolean;
  /** Set when parsing or collection detects an ambiguous identity. */
  identityCollision?: boolean;
}

export interface RemoteObserverExclusion {
  reason: RemoteObserverExclusionReason;
  observationIds: RemoteObserverObservationId[];
  observerIds: string[];
  detail: string;
}

export interface RemoteObserverZone {
  polygon: Array<[number, number]>;
  areaM2: number;
  confidence: RemoteObserverConfidence;
  geometryQuality: RemoteObserverGeometryQuality;
  observerCount: number;
  observationCount: number;
  relativeConstraintCount: number;
  contributingObservationIds: RemoteObserverObservationId[];
  contributingObserverIds: string[];
  exclusionReasons: RemoteObserverExclusion[];
  terrainUncertaintyDb: number;
  generatedAt: number;
  approximate: true;
  method: 'relative-snr-envelope';
}

export interface RemoteObserverAnalysis {
  ready: boolean;
  reason: string;
  eligibleObserverCount: number;
  eligibleObservationCount: number;
  exclusions: RemoteObserverExclusion[];
  zone?: RemoteObserverZone;
}

export interface RemoteObserverAnalysisOptions {
  /** Full public key of the missing target. Matching is case-insensitive. */
  targetPublicKey: string;
  generatedAt?: number;
  maximumObservationAgeMs?: number;
  maximumFutureSkewMs?: number;
  maximumCoordinateAccuracyM?: number;
  /** Conservative uncertainty used when a verified source omits its accuracy. */
  defaultCoordinateAccuracyM?: number;
  minimumObserverSeparationM?: number;
  observerPositionCollisionM?: number;
  /** Pairwise SNR differences below this value do not constrain the zone. */
  terrainUncertaintyDb?: number;
  minimumZonePaddingM?: number;
  networkPaddingFactor?: number;
  maximumZonePaddingM?: number;
  zoneVertices?: number;
  maximumObservations?: number;
}

export interface RemoteObserverCombinationOptions {
  otherConfidence?: RemoteObserverConfidence;
  otherZoneLabel?: string;
  generatedAt?: number;
}

export interface RemoteObserverCombinedZone {
  ready: boolean;
  reason: string;
  polygon?: Array<[number, number]>;
  areaM2?: number;
  confidence: RemoteObserverConfidence;
  observerCount: number;
  contributingObservationIds: RemoteObserverObservationId[];
  contributingObserverIds: string[];
  approximate: true;
  disagreement?: boolean;
  generatedAt: number;
}

interface ResolvedOptions {
  targetPublicKey: string;
  generatedAt: number;
  maximumObservationAgeMs: number;
  maximumFutureSkewMs: number;
  maximumCoordinateAccuracyM: number;
  defaultCoordinateAccuracyM: number;
  minimumObserverSeparationM: number;
  observerPositionCollisionM: number;
  terrainUncertaintyDb: number;
  minimumZonePaddingM: number;
  networkPaddingFactor: number;
  maximumZonePaddingM: number;
  zoneVertices: number;
  maximumObservations: number;
}

interface ObserverAggregate extends LatLon {
  observerId: string;
  snrDb: number;
  coordinateAccuracyM: number;
  observedAt: number;
  observations: RemoteObserverObservation[];
}

interface HullPoint extends LatLon, LocalPoint {}

const DEFAULTS = {
  maximumObservationAgeMs: 5 * 60_000,
  maximumFutureSkewMs: 30_000,
  maximumCoordinateAccuracyM: 250,
  defaultCoordinateAccuracyM: 25,
  minimumObserverSeparationM: 100,
  observerPositionCollisionM: 250,
  terrainUncertaintyDb: 10,
  minimumZonePaddingM: 1_000,
  networkPaddingFactor: 1.5,
  maximumZonePaddingM: 50_000,
  zoneVertices: 16,
  maximumObservations: 256,
} as const;

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveOptions(options: RemoteObserverAnalysisOptions): ResolvedOptions {
  return {
    targetPublicKey: normalizeIdentity(options.targetPublicKey),
    generatedAt: options.generatedAt ?? Date.now(),
    maximumObservationAgeMs: finitePositive(
      options.maximumObservationAgeMs,
      DEFAULTS.maximumObservationAgeMs,
    ),
    maximumFutureSkewMs: finitePositive(options.maximumFutureSkewMs, DEFAULTS.maximumFutureSkewMs),
    maximumCoordinateAccuracyM: finitePositive(
      options.maximumCoordinateAccuracyM,
      DEFAULTS.maximumCoordinateAccuracyM,
    ),
    defaultCoordinateAccuracyM: finitePositive(
      options.defaultCoordinateAccuracyM,
      DEFAULTS.defaultCoordinateAccuracyM,
    ),
    minimumObserverSeparationM: finitePositive(
      options.minimumObserverSeparationM,
      DEFAULTS.minimumObserverSeparationM,
    ),
    observerPositionCollisionM: finitePositive(
      options.observerPositionCollisionM,
      DEFAULTS.observerPositionCollisionM,
    ),
    terrainUncertaintyDb: finitePositive(options.terrainUncertaintyDb, DEFAULTS.terrainUncertaintyDb),
    minimumZonePaddingM: finitePositive(options.minimumZonePaddingM, DEFAULTS.minimumZonePaddingM),
    networkPaddingFactor: finitePositive(options.networkPaddingFactor, DEFAULTS.networkPaddingFactor),
    maximumZonePaddingM: finitePositive(options.maximumZonePaddingM, DEFAULTS.maximumZonePaddingM),
    zoneVertices: Math.round(clamp(finitePositive(options.zoneVertices, DEFAULTS.zoneVertices), 8, 64)),
    maximumObservations: Math.round(
      clamp(finitePositive(options.maximumObservations, DEFAULTS.maximumObservations), 2, 512),
    ),
  };
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, '');
}

function idKey(id: RemoteObserverObservationId): string {
  return `${typeof id}:${String(id)}`;
}

function validId(id: RemoteObserverObservationId): boolean {
  return typeof id === 'number'
    ? Number.isFinite(id)
    : typeof id === 'string' && id.trim().length > 0;
}

function validObservation(observation: RemoteObserverObservation): boolean {
  return (
    validId(observation.id) &&
    observation.observerId.trim().length > 0 &&
    observation.targetPublicKey.trim().length > 0 &&
    Number.isFinite(observation.lat) &&
    observation.lat >= -90 &&
    observation.lat <= 90 &&
    Number.isFinite(observation.lon) &&
    observation.lon >= -180 &&
    observation.lon <= 180 &&
    Number.isFinite(observation.observedAt) &&
    observation.observedAt >= 0 &&
    Number.isFinite(observation.snrDb) &&
    observation.snrDb >= -32 &&
    observation.snrDb <= 31.75 &&
    (observation.coordinateAccuracyM === undefined ||
      (Number.isFinite(observation.coordinateAccuracyM) && observation.coordinateAccuracyM >= 0))
  );
}

function exclusion(
  reason: RemoteObserverExclusionReason,
  observations: readonly RemoteObserverObservation[],
  detail: string,
): RemoteObserverExclusion {
  return {
    reason,
    observationIds: observations.map(({ id }) => id),
    observerIds: [...new Set(observations.map(({ observerId }) => observerId))],
    detail,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return Number.NaN;
  if (sorted.length % 2 === 1) return value;
  const previous = sorted[middle - 1];
  return previous === undefined ? value : (previous + value) / 2;
}

function cross(origin: HullPoint, first: HullPoint, second: HullPoint): number {
  return (
    (first.x - origin.x) * (second.y - origin.y) -
    (first.y - origin.y) * (second.x - origin.x)
  );
}

function convexHull(points: readonly LatLon[]): LatLon[] {
  const origin = points[0];
  if (!origin) return [];
  const unique = new Map<string, HullPoint>();
  for (const point of points) {
    const local = projectLocal(point, origin);
    unique.set(`${local.x.toFixed(4)}:${local.y.toFixed(4)}`, { ...point, ...local });
  }
  const sorted = [...unique.values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 2) return sorted.map(({ lat, lon }) => ({ lat, lon }));

  const lower: HullPoint[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2] as HullPoint, lower[lower.length - 1] as HullPoint, point) <= 0
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
      cross(upper[upper.length - 2] as HullPoint, upper[upper.length - 1] as HullPoint, point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper].map(({ lat, lon }) => ({ lat, lon }));
}

function clipHalfPlane(
  polygon: readonly LocalPoint[],
  normal: LocalPoint,
  maximumProjection: number,
): LocalPoint[] {
  if (polygon.length < 3) return [];
  const projection = (point: LocalPoint): number => point.x * normal.x + point.y * normal.y;
  const inside = (point: LocalPoint): boolean => projection(point) <= maximumProjection + 1e-7;
  const result: LocalPoint[] = [];
  let previous = polygon[polygon.length - 1];
  if (!previous) return result;
  for (const current of polygon) {
    const previousInside = inside(previous);
    const currentInside = inside(current);
    if (previousInside !== currentInside) {
      const previousProjection = projection(previous);
      const currentProjection = projection(current);
      const denominator = currentProjection - previousProjection;
      if (Math.abs(denominator) > 1e-9) {
        const fraction = clamp((maximumProjection - previousProjection) / denominator, 0, 1);
        result.push({
          x: previous.x + (current.x - previous.x) * fraction,
          y: previous.y + (current.y - previous.y) * fraction,
        });
      }
    }
    if (currentInside) result.push(current);
    previous = current;
  }
  return result;
}

function maximumObserverSpan(observers: readonly ObserverAggregate[]): number {
  let maximum = 0;
  for (let firstIndex = 0; firstIndex < observers.length; firstIndex += 1) {
    const first = observers[firstIndex];
    if (!first) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < observers.length; secondIndex += 1) {
      const second = observers[secondIndex];
      if (second) maximum = Math.max(maximum, distanceMeters(first, second));
    }
  }
  return maximum;
}

function polygonArea(polygon: readonly (readonly [number, number])[]): number {
  return polygonAreaMeters2(polygon.map(([lat, lon]) => ({ lat, lon })));
}

function weakerConfidence(
  first: RemoteObserverConfidence,
  second: RemoteObserverConfidence,
): RemoteObserverConfidence {
  const rank: Record<RemoteObserverConfidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[first] <= rank[second] ? first : second;
}

/**
 * Builds a broad likelihood envelope from relative SNR ordering. SNR is never
 * converted into a range: common offsets leave the result unchanged, and only
 * differences larger than the configured terrain/fading uncertainty can trim
 * the observer-network envelope.
 */
export function analyzeRemoteObservers(
  observations: readonly RemoteObserverObservation[],
  analysisOptions: RemoteObserverAnalysisOptions,
): RemoteObserverAnalysis {
  const options = resolveOptions(analysisOptions);
  const exclusions: RemoteObserverExclusion[] = [];
  if (!/^[0-9a-f]{64}$/.test(options.targetPublicKey)) {
    return {
      ready: false,
      reason: 'A full target public key is required before remote observations can be matched.',
      eligibleObserverCount: 0,
      eligibleObservationCount: 0,
      exclusions,
    };
  }

  const ordered = [...observations].sort((a, b) => b.observedAt - a.observedAt);
  const limited = ordered.slice(0, options.maximumObservations);
  const overflow = ordered.slice(options.maximumObservations);
  if (overflow.length > 0) {
    exclusions.push(
      exclusion(
        'analysis-limit',
        overflow,
        `Only the ${options.maximumObservations} most recent remote observations were analysed.`,
      ),
    );
  }

  const idGroups = new Map<string, RemoteObserverObservation[]>();
  for (const observation of limited) {
    const key = idKey(observation.id);
    const group = idGroups.get(key) ?? [];
    group.push(observation);
    idGroups.set(key, group);
  }
  const collidingIds = new Set<string>();
  for (const [key, group] of idGroups) {
    if (group.length <= 1) continue;
    collidingIds.add(key);
    exclusions.push(
      exclusion(
        'observation-id-collision',
        group,
        'The same observation ID appeared more than once, so every copy was rejected.',
      ),
    );
  }

  const valid: RemoteObserverObservation[] = [];
  for (const observation of limited) {
    if (collidingIds.has(idKey(observation.id))) continue;
    if (!validObservation(observation)) {
      exclusions.push(exclusion('invalid-observation', [observation], 'The remote observation contains invalid fields.'));
      continue;
    }
    if (!observation.coordinateVerified) {
      exclusions.push(
        exclusion(
          'unverified-observer-position',
          [observation],
          'The observer position was not independently verified; advertised coordinates are display-only.',
        ),
      );
      continue;
    }
    if ((observation.coordinateAccuracyM ?? 0) > options.maximumCoordinateAccuracyM) {
      exclusions.push(
        exclusion(
          'unverified-observer-position',
          [observation],
          'The verified observer position uncertainty exceeds the configured limit.',
        ),
      );
      continue;
    }
    if (observation.observedAt > options.generatedAt + options.maximumFutureSkewMs) {
      exclusions.push(exclusion('future-observation', [observation], 'The remote observation time is implausibly in the future.'));
      continue;
    }
    if (options.generatedAt - observation.observedAt > options.maximumObservationAgeMs) {
      exclusions.push(exclusion('stale-observation', [observation], 'The remote target observation is too old for live estimation.'));
      continue;
    }
    if (observation.targetMatch !== 'full-key') {
      exclusions.push(
        exclusion(
          'unverified-target-match',
          [observation],
          'Only a full-public-key target match is eligible; short identifiers can collide.',
        ),
      );
      continue;
    }
    if (normalizeIdentity(observation.targetPublicKey) !== options.targetPublicKey) {
      exclusions.push(exclusion('target-mismatch', [observation], 'The neighbour record belongs to a different target.'));
      continue;
    }
    if (observation.identityCollision) {
      exclusions.push(exclusion('identity-collision', [observation], 'The target or observer identity is ambiguous.'));
      continue;
    }
    if (!observation.directNeighbour) {
      exclusions.push(
        exclusion(
          'indirect-neighbour',
          [observation],
          'Only direct zero-hop neighbour evidence can be attributed to this observer location.',
        ),
      );
      continue;
    }
    valid.push(observation);
  }

  const observerGroups = new Map<string, RemoteObserverObservation[]>();
  for (const observation of valid) {
    const key = normalizeIdentity(observation.observerId);
    const group = observerGroups.get(key) ?? [];
    group.push(observation);
    observerGroups.set(key, group);
  }

  const aggregates: ObserverAggregate[] = [];
  for (const group of observerGroups.values()) {
    const freshest = [...group].sort((a, b) => b.observedAt - a.observedAt)[0];
    if (!freshest) continue;
    let collision = false;
    for (let firstIndex = 0; firstIndex < group.length && !collision; firstIndex += 1) {
      const first = group[firstIndex];
      if (!first) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < group.length; secondIndex += 1) {
        const second = group[secondIndex];
        if (!second) continue;
        const tolerated = Math.max(
          options.observerPositionCollisionM,
          (first.coordinateAccuracyM ?? options.defaultCoordinateAccuracyM) +
            (second.coordinateAccuracyM ?? options.defaultCoordinateAccuracyM),
        );
        if (distanceMeters(first, second) > tolerated) {
          collision = true;
          break;
        }
      }
    }
    if (collision) {
      exclusions.push(
        exclusion(
          'observer-position-collision',
          group,
          'One observer identity was associated with incompatible verified positions.',
        ),
      );
      continue;
    }
    aggregates.push({
      observerId: freshest.observerId,
      lat: freshest.lat,
      lon: freshest.lon,
      snrDb: median(group.map(({ snrDb }) => snrDb)),
      coordinateAccuracyM: Math.max(
        ...group.map(
          ({ coordinateAccuracyM }) => coordinateAccuracyM ?? options.defaultCoordinateAccuracyM,
        ),
      ),
      observedAt: freshest.observedAt,
      observations: [...group],
    });
  }

  const eligibleObservationCount = aggregates.reduce(
    (total, aggregate) => total + aggregate.observations.length,
    0,
  );
  if (aggregates.length < 2) {
    return {
      ready: false,
      reason: 'At least two eligible remote observers are required; three or more are recommended.',
      eligibleObserverCount: aggregates.length,
      eligibleObservationCount,
      exclusions,
    };
  }

  const maximumSpanM = maximumObserverSpan(aggregates);
  if (maximumSpanM < options.minimumObserverSeparationM) {
    exclusions.push(
      exclusion(
        'insufficient-separation',
        aggregates.flatMap(({ observations: group }) => group),
        'The eligible observers are too close together to provide independent location evidence.',
      ),
    );
    return {
      ready: false,
      reason: 'Remote observers need verified positions separated by a useful distance.',
      eligibleObserverCount: aggregates.length,
      eligibleObservationCount,
      exclusions,
    };
  }

  const maximumAccuracyM = Math.max(...aggregates.map(({ coordinateAccuracyM }) => coordinateAccuracyM));
  const unconstrainedPaddingM = clamp(
    Math.max(
      options.minimumZonePaddingM,
      maximumSpanM * options.networkPaddingFactor,
      maximumAccuracyM * 4,
    ),
    options.minimumZonePaddingM,
    Math.max(options.minimumZonePaddingM, options.maximumZonePaddingM),
  );
  const supportPoints: LatLon[] = [];
  for (const observer of aggregates) {
    for (let vertex = 0; vertex < options.zoneVertices; vertex += 1) {
      supportPoints.push(
        destinationPoint(observer, (vertex * 360) / options.zoneVertices, unconstrainedPaddingM),
      );
    }
  }
  const envelope = convexHull(supportPoints);
  const origin: LatLon = {
    lat: aggregates.reduce((sum, observer) => sum + observer.lat, 0) / aggregates.length,
    lon: aggregates.reduce((sum, observer) => sum + observer.lon, 0) / aggregates.length,
  };
  const localObservers = new Map(
    aggregates.map((observer) => [normalizeIdentity(observer.observerId), projectLocal(observer, origin)]),
  );
  let localPolygon = envelope.map((point) => projectLocal(point, origin));
  let relativeConstraintCount = 0;
  let signalConflict = false;

  observerPairs:
  for (let firstIndex = 0; firstIndex < aggregates.length; firstIndex += 1) {
    const first = aggregates[firstIndex];
    if (!first) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < aggregates.length; secondIndex += 1) {
      const second = aggregates[secondIndex];
      if (!second) continue;
      const differenceDb = Math.abs(first.snrDb - second.snrDb);
      if (differenceDb <= options.terrainUncertaintyDb) continue;
      const stronger = first.snrDb > second.snrDb ? first : second;
      const weaker = stronger === first ? second : first;
      const strongerPoint = localObservers.get(normalizeIdentity(stronger.observerId));
      const weakerPoint = localObservers.get(normalizeIdentity(weaker.observerId));
      if (!strongerPoint || !weakerPoint) continue;
      const delta = {
        x: weakerPoint.x - strongerPoint.x,
        y: weakerPoint.y - strongerPoint.y,
      };
      const separationM = Math.hypot(delta.x, delta.y);
      if (separationM < 1e-6) continue;
      const normal = { x: delta.x / separationM, y: delta.y / separationM };
      // The allowance deliberately remains large: SNR ranks likelihood but is
      // not treated as a path-loss-derived distance measurement.
      const allowanceFraction = clamp(options.terrainUncertaintyDb / (2 * differenceDb), 0.15, 0.5);
      const uncertaintyM = stronger.coordinateAccuracyM + weaker.coordinateAccuracyM;
      const maximumProjection =
        strongerPoint.x * normal.x +
        strongerPoint.y * normal.y +
        separationM * (0.5 + allowanceFraction) +
        uncertaintyM;
      const clipped = clipHalfPlane(localPolygon, normal, maximumProjection);
      if (clipped.length >= 3) {
        localPolygon = clipped;
        relativeConstraintCount += 1;
      } else {
        signalConflict = true;
        break observerPairs;
      }
    }
  }

  let polygon = localPolygon.map((point) => {
    const latLon = unprojectLocal(point, origin);
    return [latLon.lat, latLon.lon] as [number, number];
  });
  let areaM2 = polygonArea(polygon);
  if (signalConflict || polygon.length < 3 || !Number.isFinite(areaM2) || areaM2 <= 1) {
    signalConflict = true;
    const allObservations = aggregates.flatMap(({ observations: group }) => group);
    exclusions.push(
      exclusion(
        'inconsistent-relative-signal',
        allObservations,
        'Relative SNR constraints conflicted, so the untrimmed observer envelope was retained.',
      ),
    );
    polygon = envelope.map(({ lat, lon }) => [lat, lon]);
    areaM2 = polygonArea(polygon);
    relativeConstraintCount = 0;
  }

  const geometryQuality: RemoteObserverGeometryQuality =
    aggregates.length >= 4 && maximumSpanM >= options.minimumObserverSeparationM * 4
      ? 'good'
      : aggregates.length >= 3 && maximumSpanM >= options.minimumObserverSeparationM * 2
        ? 'fair'
        : 'limited';
  // Remote SNR remains propagation-dependent, so this estimator deliberately
  // never emits high confidence even with many observers.
  const confidence: RemoteObserverConfidence =
    !signalConflict && aggregates.length >= 3 && geometryQuality !== 'limited' ? 'medium' : 'low';
  const contributingObservationIds = aggregates.flatMap(({ observations: group }) =>
    group.map(({ id }) => id),
  );
  const contributingObserverIds = aggregates.map(({ observerId }) => observerId);
  const zone: RemoteObserverZone = {
    polygon,
    areaM2,
    confidence,
    geometryQuality,
    observerCount: aggregates.length,
    observationCount: eligibleObservationCount,
    relativeConstraintCount,
    contributingObservationIds,
    contributingObserverIds,
    exclusionReasons: exclusions,
    terrainUncertaintyDb: options.terrainUncertaintyDb,
    generatedAt: options.generatedAt,
    approximate: true,
    method: 'relative-snr-envelope',
  };

  return {
    ready: true,
    reason:
      aggregates.length >= 3
        ? 'Approximate remote-observer likelihood zone; terrain and antenna effects can dominate SNR.'
        : 'Approximate remote-observer likelihood zone from two observers; add a third verified observer to improve confidence.',
    eligibleObserverCount: aggregates.length,
    eligibleObservationCount,
    exclusions,
    zone,
  };
}

/** Intersects a remote-observer zone with an existing convex RSSI or final-approach zone. */
export function combineRemoteObserverZone(
  remoteZone: RemoteObserverZone | undefined,
  otherPolygon: readonly (readonly [number, number])[] | undefined,
  options: RemoteObserverCombinationOptions = {},
): RemoteObserverCombinedZone {
  const generatedAt = options.generatedAt ?? Date.now();
  const base = {
    observerCount: remoteZone?.observerCount ?? 0,
    contributingObservationIds: remoteZone?.contributingObservationIds ?? [],
    contributingObserverIds: remoteZone?.contributingObserverIds ?? [],
    approximate: true as const,
    generatedAt,
  };
  if (!remoteZone) {
    return {
      ...base,
      ready: false,
      reason: 'The remote-observer likelihood zone is not ready.',
      confidence: 'low',
    };
  }
  if (!otherPolygon || otherPolygon.length < 3) {
    return {
      ...base,
      ready: false,
      reason: `The ${options.otherZoneLabel ?? 'local search'} zone is not ready.`,
      confidence: remoteZone.confidence,
    };
  }
  const polygon = intersectConvexPolygons(remoteZone.polygon, otherPolygon);
  const areaM2 = polygonArea(polygon);
  if (polygon.length < 3 || !Number.isFinite(areaM2) || areaM2 <= 1) {
    return {
      ...base,
      ready: false,
      reason: `The remote-observer likelihood zone and ${options.otherZoneLabel ?? 'local search zone'} do not overlap. Treat the evidence as disagreement and collect more observations.`,
      confidence: 'low',
      disagreement: true,
    };
  }
  return {
    ...base,
    ready: true,
    reason: `Approximate overlap between remote observers and the ${options.otherZoneLabel ?? 'local search zone'}.`,
    polygon,
    areaM2,
    confidence: weakerConfidence(remoteZone.confidence, options.otherConfidence ?? 'low'),
  };
}
