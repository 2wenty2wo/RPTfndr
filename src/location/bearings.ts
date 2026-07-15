import type { SessionEvent } from '../types';
import {
  destinationPoint,
  distanceMeters,
  isValidCoordinate,
  normalizeBearing,
  polygonAreaMeters2,
  projectLocal,
  toRadians,
  unprojectLocal,
  type LatLon,
  type LocalPoint,
} from './geo';

export type BearingObservationId = number | string;

export interface BearingObservation extends LatLon {
  id?: BearingObservationId;
  t: number;
  bearingDeg: number;
  accuracyDeg?: number;
  gpsAccuracyM?: number;
  /** Age of the associated accepted GPS fix when the bearing was saved. */
  gpsAgeMs?: number;
  /** Confirmed target reception used to validate this field observation. */
  confirmedReceptionId?: number;
  /** Age of that confirmed reception when the bearing was saved. */
  confirmedReceptionAgeMs?: number;
  note?: string;
}

export interface BearingIntersection {
  point: LatLon;
  distanceFromFirstM: number;
  distanceFromSecondM: number;
  crossingAngleDeg: number;
}

export type BearingGeometryQuality = 'poor' | 'fair' | 'good';
export type BearingConfidence = 'low' | 'medium' | 'high';
export type BearingExclusionReason =
  | 'invalid-observation'
  | 'stale-gps'
  | 'poor-gps'
  | 'no-recent-confirmed-reception'
  | 'insufficient-separation'
  | 'near-parallel'
  | 'backward-intersection'
  | 'outlier'
  | 'analysis-limit';

export interface BearingExclusion {
  reason: BearingExclusionReason;
  observationIds: BearingObservationId[];
  detail: string;
}

export interface BearingConsensus {
  /** Numerical centre used to construct the zone; render the polygon, not a point marker. */
  point: LatLon;
  observationCount: number;
  rmsCrossTrackErrorM: number;
  confidence: BearingConfidence;
  radiusM: number;
  polygon: Array<[number, number]>;
  geometryQuality: BearingGeometryQuality;
  contributingObservationIds: BearingObservationId[];
  exclusionReasons: BearingExclusion[];
  approximate: true;
}

export interface BearingConsensusAnalysis {
  ready: boolean;
  reason: string;
  eligibleObservationCount: number;
  exclusions: BearingExclusion[];
  consensus?: BearingConsensus;
}

/** Short public name used by application state and archive exports. */
export type BearingAnalysis = BearingConsensusAnalysis;

export interface FinalApproachEstimate {
  ready: boolean;
  reason: string;
  polygon?: Array<[number, number]>;
  areaM2?: number;
  confidence: BearingConfidence;
  bearingCount: number;
  signalCellCount: number;
  rmsCrossTrackErrorM?: number;
  geometryQuality?: BearingGeometryQuality;
  bearingRadiusM?: number;
  contributingObservationIds: BearingObservationId[];
  exclusionReasons: BearingExclusion[];
  approximate: true;
  disagreement?: boolean;
  generatedAt: number;
}

export interface BearingAnalysisOptions {
  minimumSeparationM?: number;
  minimumCrossingAngleDeg?: number;
  maximumGpsAgeMs?: number;
  maximumGpsAccuracyM?: number;
  maximumConfirmedReceptionAgeMs?: number;
  requireGpsMetadata?: boolean;
  requireRecentConfirmedReception?: boolean;
  defaultAccuracyDeg?: number;
  defaultGpsAccuracyM?: number;
  zoneVertices?: number;
  /** Hard cap prevents cubic consensus work on oversized imported logs. */
  maximumObservations?: number;
}

export interface FinalApproachOptions extends BearingAnalysisOptions {
  generatedAt?: number;
  signalConfidence?: BearingConfidence;
}

export interface FinalApproachResult {
  consensus?: BearingConsensus;
  estimate: FinalApproachEstimate;
  exclusions: BearingExclusion[];
}

interface ResolvedAnalysisOptions {
  minimumSeparationM: number;
  minimumCrossingAngleDeg: number;
  maximumGpsAgeMs: number;
  maximumGpsAccuracyM: number;
  maximumConfirmedReceptionAgeMs: number;
  requireGpsMetadata: boolean;
  requireRecentConfirmedReception: boolean;
  defaultAccuracyDeg: number;
  defaultGpsAccuracyM: number;
  zoneVertices: number;
  maximumObservations: number;
}

interface IdentifiedObservation {
  id: BearingObservationId;
  observation: BearingObservation;
}

interface PairCandidate {
  first: IdentifiedObservation;
  second: IdentifiedObservation;
  intersection: BearingIntersection;
}

interface LineModel {
  identified: IdentifiedObservation;
  point: LocalPoint;
  direction: LocalPoint;
  normal: LocalPoint;
  offset: number;
}

interface LeastSquaresSolution {
  point: LocalPoint;
  models: LineModel[];
  a00: number;
  a01: number;
  a11: number;
  determinant: number;
}

const DEFAULT_ANALYSIS_OPTIONS: ResolvedAnalysisOptions = {
  minimumSeparationM: 20,
  minimumCrossingAngleDeg: 15,
  maximumGpsAgeMs: 15_000,
  maximumGpsAccuracyM: 75,
  maximumConfirmedReceptionAgeMs: 30_000,
  requireGpsMetadata: true,
  requireRecentConfirmedReception: true,
  defaultAccuracyDeg: 10,
  defaultGpsAccuracyM: 25,
  zoneVertices: 32,
  maximumObservations: 128,
};

function resolvedOptions(options: BearingAnalysisOptions): ResolvedAnalysisOptions {
  return {
    ...DEFAULT_ANALYSIS_OPTIONS,
    ...options,
    minimumSeparationM: Math.max(0, options.minimumSeparationM ?? DEFAULT_ANALYSIS_OPTIONS.minimumSeparationM),
    minimumCrossingAngleDeg: Math.max(
      0.1,
      Math.min(89.9, options.minimumCrossingAngleDeg ?? DEFAULT_ANALYSIS_OPTIONS.minimumCrossingAngleDeg),
    ),
    maximumGpsAgeMs: Math.max(0, options.maximumGpsAgeMs ?? DEFAULT_ANALYSIS_OPTIONS.maximumGpsAgeMs),
    maximumGpsAccuracyM: Math.max(
      0,
      options.maximumGpsAccuracyM ?? DEFAULT_ANALYSIS_OPTIONS.maximumGpsAccuracyM,
    ),
    maximumConfirmedReceptionAgeMs: Math.max(
      0,
      options.maximumConfirmedReceptionAgeMs ?? DEFAULT_ANALYSIS_OPTIONS.maximumConfirmedReceptionAgeMs,
    ),
    defaultAccuracyDeg: Math.max(
      0.5,
      Math.min(89, options.defaultAccuracyDeg ?? DEFAULT_ANALYSIS_OPTIONS.defaultAccuracyDeg),
    ),
    defaultGpsAccuracyM: Math.max(
      1,
      options.defaultGpsAccuracyM ?? DEFAULT_ANALYSIS_OPTIONS.defaultGpsAccuracyM,
    ),
    zoneVertices: Math.max(8, Math.round(options.zoneVertices ?? DEFAULT_ANALYSIS_OPTIONS.zoneVertices)),
    maximumObservations: Math.max(
      2,
      Math.min(256, Math.round(options.maximumObservations ?? DEFAULT_ANALYSIS_OPTIONS.maximumObservations)),
    ),
  };
}

function direction(bearingDeg: number): LocalPoint {
  const radians = toRadians(normalizeBearing(bearingDeg));
  return { x: Math.sin(radians), y: Math.cos(radians) };
}

function cross(a: LocalPoint, b: LocalPoint): number {
  return a.x * b.y - a.y * b.x;
}

function dot(a: LocalPoint, b: LocalPoint): number {
  return a.x * b.x + a.y * b.y;
}

function subtract(a: LocalPoint, b: LocalPoint): LocalPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function observationId(observation: BearingObservation, index: number): BearingObservationId {
  return observation.id ?? `observation-${index + 1}`;
}

function crossingAngleDeg(first: number, second: number): number {
  const difference = Math.abs(normalizeBearing(first) - normalizeBearing(second));
  const smaller = Math.min(difference, 360 - difference);
  return Math.min(smaller, 180 - smaller);
}

function validObservation(observation: BearingObservation): boolean {
  return (
    Number.isFinite(observation.t) &&
    Number.isFinite(observation.lat) &&
    Number.isFinite(observation.lon) &&
    isValidCoordinate(observation.lat, observation.lon) &&
    observation.lon >= -180 &&
    observation.lon <= 180 &&
    Number.isFinite(observation.bearingDeg)
  );
}

function exclusion(
  reason: BearingExclusionReason,
  observations: readonly IdentifiedObservation[],
  detail: string,
): BearingExclusion {
  return { reason, observationIds: observations.map(({ id }) => id), detail };
}

export function bearingLine(
  observation: BearingObservation,
  lengthM = 1_000,
): [LatLon, LatLon] {
  return [
    { lat: observation.lat, lon: observation.lon },
    destinationPoint(observation, observation.bearingDeg, lengthM),
  ];
}

export function intersectBearings(
  first: BearingObservation,
  second: BearingObservation,
  options: { raysOnly?: boolean; minimumCrossingAngleDeg?: number } = {},
): BearingIntersection | undefined {
  const origin: LatLon = { lat: first.lat, lon: first.lon };
  const p: LocalPoint = { x: 0, y: 0 };
  const q = projectLocal(second, origin);
  const d = direction(first.bearingDeg);
  const e = direction(second.bearingDeg);
  const determinant = cross(d, e);
  const acuteCrossingAngle = crossingAngleDeg(first.bearingDeg, second.bearingDeg);
  if (
    Math.abs(determinant) < 1e-9 ||
    acuteCrossingAngle < (options.minimumCrossingAngleDeg ?? 5)
  ) {
    return undefined;
  }
  const delta = { x: q.x - p.x, y: q.y - p.y };
  const firstDistance = cross(delta, e) / determinant;
  const secondDistance = cross(delta, d) / determinant;
  if ((options.raysOnly ?? true) && (firstDistance < 0 || secondDistance < 0)) return undefined;
  return {
    point: unprojectLocal(
      { x: p.x + firstDistance * d.x, y: p.y + firstDistance * d.y },
      origin,
    ),
    distanceFromFirstM: firstDistance,
    distanceFromSecondM: secondDistance,
    crossingAngleDeg: acuteCrossingAngle,
  };
}

function crossTrackSigmaM(
  observation: BearingObservation,
  distanceM: number,
  options: ResolvedAnalysisOptions,
): number {
  const angularAccuracy = Math.max(
    0.5,
    Math.min(89, observation.accuracyDeg ?? options.defaultAccuracyDeg),
  );
  const gpsAccuracy = Math.max(1, observation.gpsAccuracyM ?? options.defaultGpsAccuracyM);
  const angularErrorM = Math.abs(Math.tan(toRadians(angularAccuracy))) * Math.max(0, distanceM);
  return Math.max(1, Math.hypot(gpsAccuracy, angularErrorM));
}

function makeLineModels(
  observations: readonly IdentifiedObservation[],
  origin: LatLon,
): LineModel[] {
  return observations.map((identified) => {
    const point = projectLocal(identified.observation, origin);
    const ray = direction(identified.observation.bearingDeg);
    const normal = { x: -ray.y, y: ray.x };
    return {
      identified,
      point,
      direction: ray,
      normal,
      offset: normal.x * point.x + normal.y * point.y,
    };
  });
}

function solveWeightedLines(
  observations: readonly IdentifiedObservation[],
  origin: LatLon,
  seed: LocalPoint,
  options: ResolvedAnalysisOptions,
): LeastSquaresSolution | undefined {
  const models = makeLineModels(observations, origin);
  let current = seed;
  let latest: LeastSquaresSolution | undefined;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    let a00 = 0;
    let a01 = 0;
    let a11 = 0;
    let b0 = 0;
    let b1 = 0;
    for (const model of models) {
      const rangeM = Math.hypot(current.x - model.point.x, current.y - model.point.y);
      const sigmaM = crossTrackSigmaM(model.identified.observation, rangeM, options);
      const weight = 1 / (sigmaM * sigmaM);
      a00 += weight * model.normal.x * model.normal.x;
      a01 += weight * model.normal.x * model.normal.y;
      a11 += weight * model.normal.y * model.normal.y;
      b0 += weight * model.normal.x * model.offset;
      b1 += weight * model.normal.y * model.offset;
    }
    const determinant = a00 * a11 - a01 * a01;
    if (Math.abs(determinant) < 1e-12) return undefined;
    current = {
      x: (b0 * a11 - b1 * a01) / determinant,
      y: (a00 * b1 - a01 * b0) / determinant,
    };
    latest = { point: current, models, a00, a01, a11, determinant };
  }
  return latest;
}

function residualAt(model: LineModel, point: LocalPoint): number {
  return model.normal.x * point.x + model.normal.y * point.y - model.offset;
}

function forwardDistanceAt(model: LineModel, point: LocalPoint): number {
  return dot(subtract(point, model.point), model.direction);
}

function ransacInliers(
  candidates: readonly PairCandidate[],
  observations: readonly IdentifiedObservation[],
  origin: LatLon,
  options: ResolvedAnalysisOptions,
): { seed: LocalPoint; inliers: IdentifiedObservation[] } | undefined {
  const models = makeLineModels(observations, origin);
  let best:
    | { seed: LocalPoint; inliers: IdentifiedObservation[]; normalizedError: number }
    | undefined;
  for (const candidate of candidates) {
    const seed = projectLocal(candidate.intersection.point, origin);
    const inliers: IdentifiedObservation[] = [];
    let normalizedError = 0;
    for (const model of models) {
      const forwardM = forwardDistanceAt(model, seed);
      const gpsToleranceM = Math.max(
        1,
        model.identified.observation.gpsAccuracyM ?? options.defaultGpsAccuracyM,
      );
      if (forwardM < -gpsToleranceM) continue;
      const rangeM = Math.hypot(seed.x - model.point.x, seed.y - model.point.y);
      const sigmaM = crossTrackSigmaM(model.identified.observation, rangeM, options);
      const normalized = Math.abs(residualAt(model, seed)) / sigmaM;
      if (normalized <= 3) {
        inliers.push(model.identified);
        normalizedError += normalized * normalized;
      }
    }
    if (
      !best ||
      inliers.length > best.inliers.length ||
      (inliers.length === best.inliers.length && normalizedError < best.normalizedError)
    ) {
      best = { seed, inliers, normalizedError };
    }
  }
  return best && best.inliers.length >= 2 ? { seed: best.seed, inliers: best.inliers } : undefined;
}

function zonePolygon(point: LatLon, radiusM: number, vertices: number): Array<[number, number]> {
  return Array.from({ length: vertices }, (_, index) => {
    const vertex = destinationPoint(point, (index * 360) / vertices, radiusM);
    return [vertex.lat, vertex.lon];
  });
}

function matrixGeometry(
  solution: LeastSquaresSolution,
  observations: readonly IdentifiedObservation[],
): { maximumVariance: number; condition: number; bestCrossingAngleDeg: number } {
  const { a00, a01, a11, determinant } = solution;
  const covariance00 = a11 / determinant;
  const covariance01 = -a01 / determinant;
  const covariance11 = a00 / determinant;
  const trace = covariance00 + covariance11;
  const root = Math.sqrt(
    Math.max(0, (covariance00 - covariance11) ** 2 + 4 * covariance01 * covariance01),
  );
  const maximumVariance = Math.max(0, (trace + root) / 2);
  const minimumVariance = Math.max(1e-9, (trace - root) / 2);
  let bestCrossingAngleDeg = 0;
  for (let firstIndex = 0; firstIndex < observations.length; firstIndex += 1) {
    const first = observations[firstIndex];
    if (!first) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < observations.length; secondIndex += 1) {
      const second = observations[secondIndex];
      if (!second) continue;
      bestCrossingAngleDeg = Math.max(
        bestCrossingAngleDeg,
        crossingAngleDeg(first.observation.bearingDeg, second.observation.bearingDeg),
      );
    }
  }
  return {
    maximumVariance,
    condition: maximumVariance / minimumVariance,
    bestCrossingAngleDeg,
  };
}

function confidenceFor(
  count: number,
  rmsM: number,
  radiusM: number,
  geometryQuality: BearingGeometryQuality,
): BearingConfidence {
  if (count >= 3 && geometryQuality === 'good' && rmsM <= 25 && radiusM <= 100) return 'high';
  if (geometryQuality !== 'poor' && rmsM <= 75 && radiusM <= 250) return 'medium';
  return 'low';
}

function geometryQualityFor(
  bestCrossingAngleDeg: number,
  condition: number,
): BearingGeometryQuality {
  if (bestCrossingAngleDeg >= 45 && condition <= 6) return 'good';
  if (bestCrossingAngleDeg >= 25 && condition <= 20) return 'fair';
  return 'poor';
}

function individualEligibility(
  observations: readonly BearingObservation[],
  options: ResolvedAnalysisOptions,
  indexOffset = 0,
): { eligible: IdentifiedObservation[]; exclusions: BearingExclusion[] } {
  const eligible: IdentifiedObservation[] = [];
  const exclusions: BearingExclusion[] = [];
  observations.forEach((observation, index) => {
    const identified = { id: observationId(observation, index + indexOffset), observation };
    if (!validObservation(observation)) {
      exclusions.push(exclusion('invalid-observation', [identified], 'The bearing record is incomplete or has invalid coordinates.'));
      return;
    }
    if (options.requireGpsMetadata && observation.gpsAgeMs === undefined) {
      exclusions.push(exclusion('stale-gps', [identified], 'GPS freshness was not recorded for this bearing.'));
      return;
    }
    if (observation.gpsAgeMs !== undefined && (
      !Number.isFinite(observation.gpsAgeMs) ||
      observation.gpsAgeMs < 0 ||
      observation.gpsAgeMs > options.maximumGpsAgeMs
    )) {
      exclusions.push(exclusion('stale-gps', [identified], 'The associated GPS fix was too old.'));
      return;
    }
    if (options.requireGpsMetadata && observation.gpsAccuracyM === undefined) {
      exclusions.push(exclusion('poor-gps', [identified], 'GPS accuracy was not recorded for this bearing.'));
      return;
    }
    if (observation.gpsAccuracyM !== undefined && (
      !Number.isFinite(observation.gpsAccuracyM) ||
      observation.gpsAccuracyM < 0 ||
      observation.gpsAccuracyM > options.maximumGpsAccuracyM
    )) {
      exclusions.push(exclusion('poor-gps', [identified], 'The associated GPS accuracy was outside the allowed limit.'));
      return;
    }
    if (options.requireRecentConfirmedReception && (
      observation.confirmedReceptionId === undefined ||
      observation.confirmedReceptionAgeMs === undefined ||
      !Number.isFinite(observation.confirmedReceptionAgeMs) ||
      observation.confirmedReceptionAgeMs < 0 ||
      observation.confirmedReceptionAgeMs > options.maximumConfirmedReceptionAgeMs
    )) {
      exclusions.push(exclusion('no-recent-confirmed-reception', [identified], 'No recent confirmed target reception was recorded with this bearing.'));
      return;
    }
    eligible.push(identified);
  });
  return { eligible, exclusions };
}

export function analyzeBearingConsensus(
  observations: readonly BearingObservation[],
  analysisOptions: BearingAnalysisOptions = {},
): BearingConsensusAnalysis {
  const options = resolvedOptions(analysisOptions);
  const omittedCount = Math.max(0, observations.length - options.maximumObservations);
  const considered = omittedCount > 0 ? observations.slice(-options.maximumObservations) : observations;
  const eligibility = individualEligibility(considered, options, omittedCount);
  const exclusions = [...eligibility.exclusions];
  if (omittedCount > 0) {
    const sampledIds = observations
      .slice(0, Math.min(omittedCount, 16))
      .map((observation, index) => observationId(observation, index));
    exclusions.unshift({
      reason: 'analysis-limit',
      observationIds: sampledIds,
      detail: `${omittedCount} older bearing observation${omittedCount === 1 ? '' : 's'} omitted from bounded consensus analysis.`,
    });
  }
  const { eligible } = eligibility;
  if (eligible.length < 2) {
    return {
      ready: false,
      reason: 'At least two eligible bearings from separated locations are required.',
      eligibleObservationCount: eligible.length,
      exclusions,
    };
  }

  const pairCandidates: PairCandidate[] = [];
  for (let firstIndex = 0; firstIndex < eligible.length; firstIndex += 1) {
    const first = eligible[firstIndex];
    if (!first) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < eligible.length; secondIndex += 1) {
      const second = eligible[secondIndex];
      if (!second) continue;
      const requiredSeparationM = Math.max(
        options.minimumSeparationM,
        (first.observation.gpsAccuracyM ?? 0) + (second.observation.gpsAccuracyM ?? 0),
      );
      if (distanceMeters(first.observation, second.observation) < requiredSeparationM) {
        exclusions.push(exclusion('insufficient-separation', [first, second], 'These bearings were recorded too close together for their GPS accuracy.'));
        continue;
      }
      const angle = crossingAngleDeg(first.observation.bearingDeg, second.observation.bearingDeg);
      if (angle < options.minimumCrossingAngleDeg) {
        exclusions.push(exclusion('near-parallel', [first, second], 'These bearings cross at too shallow an angle.'));
        continue;
      }
      const lineIntersection = intersectBearings(first.observation, second.observation, {
        raysOnly: false,
        minimumCrossingAngleDeg: options.minimumCrossingAngleDeg,
      });
      if (!lineIntersection) {
        exclusions.push(exclusion('near-parallel', [first, second], 'These bearing lines do not provide stable crossing geometry.'));
        continue;
      }
      if (lineIntersection.distanceFromFirstM < 0 || lineIntersection.distanceFromSecondM < 0) {
        exclusions.push(exclusion('backward-intersection', [first, second], 'The bearing rays only cross behind one or both observation locations.'));
        continue;
      }
      pairCandidates.push({ first, second, intersection: lineIntersection });
    }
  }

  if (pairCandidates.length === 0) {
    return {
      ready: false,
      reason: 'No usable forward crossing was found. Move to a more separated location and take another bearing.',
      eligibleObservationCount: eligible.length,
      exclusions,
    };
  }

  const origin = eligible[0]?.observation;
  if (!origin) {
    return {
      ready: false,
      reason: 'No eligible bearing origin was available.',
      eligibleObservationCount: 0,
      exclusions,
    };
  }
  const robust = ransacInliers(pairCandidates, eligible, origin, options);
  if (!robust) {
    return {
      ready: false,
      reason: 'The bearings do not agree closely enough to form an approximate zone.',
      eligibleObservationCount: eligible.length,
      exclusions,
    };
  }

  let contributors = robust.inliers;
  let solution = solveWeightedLines(contributors, origin, robust.seed, options);
  if (!solution) {
    return {
      ready: false,
      reason: 'The bearing geometry is too weak to form an approximate zone.',
      eligibleObservationCount: eligible.length,
      exclusions,
    };
  }

  const retained: IdentifiedObservation[] = [];
  for (const model of solution.models) {
    const gpsToleranceM = Math.max(
      1,
      model.identified.observation.gpsAccuracyM ?? options.defaultGpsAccuracyM,
    );
    if (forwardDistanceAt(model, solution.point) < -gpsToleranceM) {
      exclusions.push(exclusion('backward-intersection', [model.identified], 'The consensus falls behind this bearing ray.'));
      continue;
    }
    const rangeM = Math.hypot(
      solution.point.x - model.point.x,
      solution.point.y - model.point.y,
    );
    const normalizedResidual = Math.abs(residualAt(model, solution.point)) /
      crossTrackSigmaM(model.identified.observation, rangeM, options);
    if (contributors.length > 2 && normalizedResidual > 3) {
      exclusions.push(exclusion('outlier', [model.identified], 'This bearing disagrees with the stronger consensus.'));
      continue;
    }
    retained.push(model.identified);
  }
  if (retained.length < 2) {
    return {
      ready: false,
      reason: 'The bearings do not agree closely enough to form an approximate zone.',
      eligibleObservationCount: eligible.length,
      exclusions,
    };
  }
  if (retained.length !== contributors.length) {
    contributors = retained;
    solution = solveWeightedLines(contributors, origin, solution.point, options);
    if (!solution) {
      return {
        ready: false,
        reason: 'The remaining bearing geometry is too weak to form an approximate zone.',
        eligibleObservationCount: eligible.length,
        exclusions,
      };
    }
  }

  const contributorIds = new Set(contributors.map(({ id }) => id));
  for (const identified of eligible) {
    if (!contributorIds.has(identified.id) && !exclusions.some(({ reason, observationIds }) =>
      reason === 'outlier' && observationIds.includes(identified.id))) {
      exclusions.push(exclusion('outlier', [identified], 'This bearing did not support the strongest forward crossing.'));
    }
  }

  const residualSquares = solution.models.map((model) => residualAt(model, solution.point) ** 2);
  const rms = Math.sqrt(
    residualSquares.reduce((sum, value) => sum + value, 0) / residualSquares.length,
  );
  const geometry = matrixGeometry(solution, contributors);
  const geometryQuality = geometryQualityFor(geometry.bestCrossingAngleDeg, geometry.condition);
  const radiusM = Math.max(5, Math.hypot(2 * Math.sqrt(geometry.maximumVariance), rms));
  const point = unprojectLocal(solution.point, origin);
  const consensus: BearingConsensus = {
    point,
    observationCount: contributors.length,
    rmsCrossTrackErrorM: rms,
    confidence: confidenceFor(contributors.length, rms, radiusM, geometryQuality),
    radiusM,
    polygon: zonePolygon(point, radiusM, options.zoneVertices),
    geometryQuality,
    contributingObservationIds: contributors.map(({ id }) => id),
    exclusionReasons: [...exclusions],
    approximate: true,
  };
  return {
    ready: true,
    reason: contributors.length >= 3
      ? 'Approximate bearing zone formed from separated observations.'
      : 'Approximate bearing zone formed from two observations; a third bearing is recommended.',
    eligibleObservationCount: eligible.length,
    exclusions,
    consensus,
  };
}

/**
 * Compatibility helper for callers that only need line consensus. It accepts
 * historic observations without validation metadata; final-approach estimates
 * use the stricter eligibility checks in `deriveFinalApproach`.
 */
export function consensusBearing(
  observations: readonly BearingObservation[],
  options: BearingAnalysisOptions = {},
): BearingConsensus | undefined {
  return analyzeBearingConsensus(observations, {
    requireGpsMetadata: false,
    requireRecentConfirmedReception: false,
    ...options,
  }).consensus;
}

function tupleToLatLon([lat, lon]: readonly [number, number]): LatLon {
  return { lat, lon };
}

function polygonWithoutClosingPoint(
  polygon: readonly (readonly [number, number])[],
): Array<[number, number]> {
  const result = polygon
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon) && isValidCoordinate(lat, lon) && lon >= -180 && lon <= 180)
    .map(([lat, lon]) => [lat, lon] as [number, number]);
  const first = result[0];
  const last = result[result.length - 1];
  if (result.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) {
    result.pop();
  }
  return result;
}

function signedArea(points: readonly LocalPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current && next) twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

function segmentLineIntersection(
  start: LocalPoint,
  end: LocalPoint,
  clipStart: LocalPoint,
  clipEnd: LocalPoint,
): LocalPoint {
  const segment = subtract(end, start);
  const clip = subtract(clipEnd, clipStart);
  const denominator = cross(segment, clip);
  if (Math.abs(denominator) < 1e-12) return end;
  const distance = cross(subtract(clipStart, start), clip) / denominator;
  return { x: start.x + distance * segment.x, y: start.y + distance * segment.y };
}

/** Intersects convex [latitude, longitude] polygons using local metre coordinates. */
export function intersectConvexPolygons(
  subjectPolygon: readonly (readonly [number, number])[],
  clipPolygon: readonly (readonly [number, number])[],
): Array<[number, number]> {
  const subject = polygonWithoutClosingPoint(subjectPolygon);
  const clip = polygonWithoutClosingPoint(clipPolygon);
  const originTuple = subject[0] ?? clip[0];
  if (subject.length < 3 || clip.length < 3 || !originTuple) return [];
  const origin = tupleToLatLon(originTuple);
  let output = subject.map((point) => projectLocal(tupleToLatLon(point), origin));
  const clipLocal = clip.map((point) => projectLocal(tupleToLatLon(point), origin));
  const orientation = signedArea(clipLocal) >= 0 ? 1 : -1;
  const inside = (point: LocalPoint, edgeStart: LocalPoint, edgeEnd: LocalPoint): boolean =>
    orientation * cross(subtract(edgeEnd, edgeStart), subtract(point, edgeStart)) >= -1e-8;

  for (let clipIndex = 0; clipIndex < clipLocal.length; clipIndex += 1) {
    const edgeStart = clipLocal[clipIndex];
    const edgeEnd = clipLocal[(clipIndex + 1) % clipLocal.length];
    if (!edgeStart || !edgeEnd || output.length === 0) break;
    const input = output;
    output = [];
    let previous = input[input.length - 1];
    if (!previous) continue;
    for (const current of input) {
      const currentInside = inside(current, edgeStart, edgeEnd);
      const previousInside = inside(previous, edgeStart, edgeEnd);
      if (currentInside) {
        if (!previousInside) {
          output.push(segmentLineIntersection(previous, current, edgeStart, edgeEnd));
        }
        output.push(current);
      } else if (previousInside) {
        output.push(segmentLineIntersection(previous, current, edgeStart, edgeEnd));
      }
      previous = current;
    }
  }

  const result: Array<[number, number]> = [];
  for (const local of output) {
    const point = unprojectLocal(local, origin);
    const previous = result[result.length - 1];
    if (!previous || distanceMeters(tupleToLatLon(previous), point) > 0.01) {
      result.push([point.lat, point.lon]);
    }
  }
  if (result.length > 1) {
    const first = result[0];
    const last = result[result.length - 1];
    if (first && last && distanceMeters(tupleToLatLon(first), tupleToLatLon(last)) <= 0.01) {
      result.pop();
    }
  }
  return result;
}

function weakerConfidence(
  first: BearingConfidence,
  second: BearingConfidence,
): BearingConfidence {
  const rank: Record<BearingConfidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[first] <= rank[second] ? first : second;
}

export function deriveFinalApproach(
  observations: readonly BearingObservation[],
  signalPolygon: readonly (readonly [number, number])[] | undefined,
  signalCellCount: number,
  options: FinalApproachOptions = {},
): FinalApproachResult {
  const generatedAt = options.generatedAt ?? Date.now();
  const analysis = analyzeBearingConsensus(observations, options);
  const consensus = analysis.consensus;
  const base: Omit<FinalApproachEstimate, 'ready' | 'reason' | 'confidence'> = {
    bearingCount: consensus?.observationCount ?? 0,
    signalCellCount: Math.max(0, signalCellCount),
    contributingObservationIds: consensus?.contributingObservationIds ?? [],
    exclusionReasons: analysis.exclusions,
    approximate: true,
    generatedAt,
    ...(consensus ? {
      rmsCrossTrackErrorM: consensus.rmsCrossTrackErrorM,
      geometryQuality: consensus.geometryQuality,
      bearingRadiusM: consensus.radiusM,
    } : {}),
  };

  if (!consensus) {
    return {
      estimate: {
        ...base,
        ready: false,
        reason: analysis.reason,
        confidence: 'low',
      },
      exclusions: analysis.exclusions,
    };
  }
  if (!signalPolygon || polygonWithoutClosingPoint(signalPolygon).length < 3) {
    return {
      consensus,
      estimate: {
        ...base,
        ready: false,
        reason: 'The confirmed-signal search area is not ready; keep collecting confirmed receptions.',
        confidence: consensus.confidence,
      },
      exclusions: analysis.exclusions,
    };
  }

  const polygon = intersectConvexPolygons(consensus.polygon, signalPolygon);
  if (polygon.length < 3) {
    return {
      consensus,
      estimate: {
        ...base,
        ready: false,
        reason: 'The approximate bearing zone and confirmed-signal search area do not overlap. Recheck the bearings and collect another pass.',
        confidence: 'low',
        disagreement: true,
      },
      exclusions: analysis.exclusions,
    };
  }

  const areaM2 = polygonAreaMeters2(polygon.map(tupleToLatLon));
  if (!Number.isFinite(areaM2) || areaM2 <= 0.01) {
    return {
      consensus,
      estimate: {
        ...base,
        ready: false,
        reason: 'The approximate overlap is too small or unstable. Recheck the bearings and collect another pass.',
        confidence: 'low',
        disagreement: true,
      },
      exclusions: analysis.exclusions,
    };
  }

  const signalConfidence = options.signalConfidence ?? (
    signalCellCount >= 3 ? 'medium' : 'low'
  );
  return {
    consensus,
    estimate: {
      ...base,
      ready: true,
      reason: consensus.observationCount >= 3
        ? 'Approximate final-approach zone from directional bearings and confirmed signal observations.'
        : 'Approximate final-approach zone from two bearings and confirmed signal observations; add a third bearing to improve confidence.',
      polygon,
      areaM2,
      confidence: weakerConfidence(consensus.confidence, signalConfidence),
    },
    exclusions: analysis.exclusions,
  };
}

export function bearingEvent(
  sessionId: string,
  observation: BearingObservation,
): SessionEvent {
  return {
    sessionId,
    t: observation.t,
    type: 'bearing',
    data: {
      lat: observation.lat,
      lon: observation.lon,
      bearingDeg: normalizeBearing(observation.bearingDeg),
      ...(observation.accuracyDeg === undefined
        ? {}
        : { accuracyDeg: observation.accuracyDeg }),
      ...(observation.gpsAccuracyM === undefined
        ? {}
        : { gpsAccuracyM: observation.gpsAccuracyM }),
      ...(observation.gpsAgeMs === undefined ? {} : { gpsAgeMs: observation.gpsAgeMs }),
      ...(observation.confirmedReceptionId === undefined
        ? {}
        : { confirmedReceptionId: observation.confirmedReceptionId }),
      ...(observation.confirmedReceptionAgeMs === undefined
        ? {}
        : { confirmedReceptionAgeMs: observation.confirmedReceptionAgeMs }),
      ...(observation.note === undefined ? {} : { note: observation.note }),
    },
  };
}

export function observationFromBearingEvent(
  event: SessionEvent,
): BearingObservation | undefined {
  if (event.type !== 'bearing') return undefined;
  const lat = finiteNumber(event.data.lat);
  const lon = finiteNumber(event.data.lon);
  const storedBearing = finiteNumber(
    event.data.bearingDeg ?? event.data.degrees ?? event.data.bearing ?? event.data.heading,
  );
  if (
    lat === undefined ||
    lon === undefined ||
    storedBearing === undefined ||
    !isValidCoordinate(lat, lon) ||
    lon < -180 ||
    lon > 180
  ) {
    return undefined;
  }
  const accuracyDeg = positiveNumber(event.data.accuracyDeg ?? event.data.uncertainty);
  const gpsAccuracyM = positiveNumber(event.data.gpsAccuracyM ?? event.data.accuracy);
  const gpsAgeMs = positiveNumber(event.data.gpsAgeMs);
  const confirmedReceptionId = positiveNumber(event.data.confirmedReceptionId);
  const confirmedReceptionAgeMs = positiveNumber(event.data.confirmedReceptionAgeMs);
  const note = typeof event.data.note === 'string' ? event.data.note : undefined;
  return {
    ...(event.id === undefined ? {} : { id: event.id }),
    t: event.t,
    lat,
    lon,
    bearingDeg: normalizeBearing(storedBearing),
    ...(accuracyDeg === undefined ? {} : { accuracyDeg }),
    ...(gpsAccuracyM === undefined ? {} : { gpsAccuracyM }),
    ...(gpsAgeMs === undefined ? {} : { gpsAgeMs }),
    ...(confirmedReceptionId === undefined ? {} : { confirmedReceptionId }),
    ...(confirmedReceptionAgeMs === undefined ? {} : { confirmedReceptionAgeMs }),
    ...(note === undefined ? {} : { note }),
  };
}

export const createBearingEvent = bearingEvent;
