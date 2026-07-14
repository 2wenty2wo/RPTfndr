import type { SessionEvent } from '../types';
import {
  destinationPoint,
  normalizeBearing,
  projectLocal,
  toRadians,
  unprojectLocal,
  type LatLon,
  type LocalPoint,
} from './geo';

export interface BearingObservation extends LatLon {
  t: number;
  bearingDeg: number;
  accuracyDeg?: number;
  note?: string;
}

export interface BearingIntersection {
  point: LatLon;
  distanceFromFirstM: number;
  distanceFromSecondM: number;
  crossingAngleDeg: number;
}

export interface BearingConsensus {
  point: LatLon;
  observationCount: number;
  rmsCrossTrackErrorM: number;
  confidence: 'low' | 'medium' | 'high';
}

function direction(bearingDeg: number): LocalPoint {
  const radians = toRadians(normalizeBearing(bearingDeg));
  return { x: Math.sin(radians), y: Math.cos(radians) };
}

function cross(a: LocalPoint, b: LocalPoint): number {
  return a.x * b.y - a.y * b.x;
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
  const crossingAngle = Math.min(
    Math.abs(normalizeBearing(first.bearingDeg) - normalizeBearing(second.bearingDeg)),
    360 - Math.abs(normalizeBearing(first.bearingDeg) - normalizeBearing(second.bearingDeg)),
  );
  const acuteCrossingAngle = Math.min(crossingAngle, 180 - crossingAngle);
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

/** Least-squares crossing of bearing lines; this remains an approximate search aid. */
export function consensusBearing(
  observations: readonly BearingObservation[],
): BearingConsensus | undefined {
  if (observations.length < 2) return undefined;
  const first = observations[0];
  if (!first) return undefined;
  const origin: LatLon = { lat: first.lat, lon: first.lon };
  let a00 = 0;
  let a01 = 0;
  let a11 = 0;
  let b0 = 0;
  let b1 = 0;
  const lines = observations.map((observation) => {
    const point = projectLocal(observation, origin);
    const ray = direction(observation.bearingDeg);
    const normal = { x: -ray.y, y: ray.x };
    const offset = normal.x * point.x + normal.y * point.y;
    const weight = 1 / Math.max(1, observation.accuracyDeg ?? 10) ** 2;
    a00 += weight * normal.x * normal.x;
    a01 += weight * normal.x * normal.y;
    a11 += weight * normal.y * normal.y;
    b0 += weight * normal.x * offset;
    b1 += weight * normal.y * offset;
    return { normal, offset };
  });
  const determinant = a00 * a11 - a01 * a01;
  if (Math.abs(determinant) < 1e-9) return undefined;
  const point = {
    x: (b0 * a11 - b1 * a01) / determinant,
    y: (a00 * b1 - a01 * b0) / determinant,
  };
  const sumSquares = lines.reduce((sum, line) => {
    const residual = line.normal.x * point.x + line.normal.y * point.y - line.offset;
    return sum + residual * residual;
  }, 0);
  const rms = Math.sqrt(sumSquares / lines.length);
  const confidence: BearingConsensus['confidence'] =
    observations.length >= 3 && rms <= 25
      ? 'high'
      : rms <= 75
        ? 'medium'
        : 'low';
  return {
    point: unprojectLocal(point, origin),
    observationCount: observations.length,
    rmsCrossTrackErrorM: rms,
    confidence,
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
      ...(observation.note === undefined ? {} : { note: observation.note }),
    },
  };
}

export function observationFromBearingEvent(
  event: SessionEvent,
): BearingObservation | undefined {
  if (event.type !== 'bearing') return undefined;
  const { lat, lon, bearingDeg, accuracyDeg, note } = event.data;
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    typeof bearingDeg !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(bearingDeg)
  ) {
    return undefined;
  }
  return {
    t: event.t,
    lat,
    lon,
    bearingDeg: normalizeBearing(bearingDeg),
    ...(typeof accuracyDeg === 'number' ? { accuracyDeg } : {}),
    ...(typeof note === 'string' ? { note } : {}),
  };
}

export const createBearingEvent = bearingEvent;
