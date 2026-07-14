export const EARTH_RADIUS_M = 6_371_008.8;
export const METERS_PER_DEGREE_LAT = 111_320;
export const WEB_MERCATOR_MAX_LAT = 85.05112878;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface LocalPoint {
  /** Easting in metres. */
  x: number;
  /** Northing in metres. */
  y: number;
}

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function normalizeLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) return longitude;
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

export function normalizeBearing(bearing: number): number {
  if (!Number.isFinite(bearing)) return bearing;
  return ((bearing % 360) + 360) % 360;
}

export function isValidCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90;
}

export function distanceMeters(a: LatLon, b: LatLon): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(normalizeLongitude(b.lon - a.lon));
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const haversineDistance = distanceMeters;

export function bearingDegrees(from: LatLon, to: LatLon): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLon = toRadians(normalizeLongitude(to.lon - from.lon));
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return normalizeBearing(toDegrees(Math.atan2(y, x)));
}

export const initialBearing = bearingDegrees;

export function destinationPoint(origin: LatLon, bearing: number, distanceM: number): LatLon {
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const theta = toRadians(normalizeBearing(bearing));
  const lat1 = toRadians(origin.lat);
  const lon1 = toRadians(origin.lon);
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinDistance = Math.sin(angularDistance);
  const cosDistance = Math.cos(angularDistance);
  const lat2 = Math.asin(
    sinLat1 * cosDistance + cosLat1 * sinDistance * Math.cos(theta),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(theta) * sinDistance * cosLat1,
      cosDistance - sinLat1 * Math.sin(lat2),
    );
  return { lat: toDegrees(lat2), lon: normalizeLongitude(toDegrees(lon2)) };
}

export function projectLocal(point: LatLon, origin: LatLon): LocalPoint {
  const meanLatitude = toRadians((point.lat + origin.lat) / 2);
  return {
    x:
      toRadians(normalizeLongitude(point.lon - origin.lon)) *
      EARTH_RADIUS_M *
      Math.cos(meanLatitude),
    y: toRadians(point.lat - origin.lat) * EARTH_RADIUS_M,
  };
}

export function unprojectLocal(point: LocalPoint, origin: LatLon): LatLon {
  const lat = origin.lat + toDegrees(point.y / EARTH_RADIUS_M);
  const cosine = Math.max(1e-9, Math.abs(Math.cos(toRadians((lat + origin.lat) / 2))));
  const lon = origin.lon + toDegrees(point.x / (EARTH_RADIUS_M * cosine));
  return { lat, lon: normalizeLongitude(lon) };
}

export function polygonAreaMeters2(polygon: readonly LatLon[]): number {
  if (polygon.length < 3) return 0;
  const origin = polygon[0];
  if (!origin) return 0;
  const projected = polygon.map((point) => projectLocal(point, origin));
  let twiceArea = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    if (!current || !next) continue;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

export function lonLatToTile(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const boundedLatitude = clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const latRadians = toRadians(boundedLatitude);
  return {
    x: ((normalizeLongitude(lon) + 180) / 360) * n,
    y:
      ((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2) *
      n,
  };
}

export function tileToLatLon(x: number, y: number, zoom: number): LatLon {
  const n = 2 ** zoom;
  return {
    lat: toDegrees(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))),
    lon: normalizeLongitude((x / n) * 360 - 180),
  };
}

export interface GridCell {
  key: string;
  sizeM: number;
  ix: number;
  iy: number;
  centerLat: number;
  centerLon: number;
}

/**
 * Fixed global latitude bands keep cell identity stable while the longitude
 * scale uses the cosine of that band's centre, producing near-square cells.
 */
export function gridCell(sizeM: number, lat: number, lon: number): GridCell {
  if (!Number.isFinite(sizeM) || sizeM <= 0) throw new RangeError('Cell size must be positive');
  if (!isValidCoordinate(lat, lon)) throw new RangeError('Invalid latitude or longitude');
  const boundedLat = clamp(lat, -89.999999999, 89.999999999);
  const iy = Math.floor(((boundedLat + 90) * METERS_PER_DEGREE_LAT) / sizeM);
  const centerLat = ((iy + 0.5) * sizeM) / METERS_PER_DEGREE_LAT - 90;
  const lonMetresPerDegree = Math.max(
    1e-9,
    METERS_PER_DEGREE_LAT * Math.abs(Math.cos(toRadians(centerLat))),
  );
  const normalizedLon = normalizeLongitude(lon);
  const ix = Math.floor(((normalizedLon + 180) * lonMetresPerDegree) / sizeM);
  const centerLon = normalizeLongitude(((ix + 0.5) * sizeM) / lonMetresPerDegree - 180);
  return {
    key: `${sizeM}:${iy}:${ix}`,
    sizeM,
    ix,
    iy,
    centerLat,
    centerLon,
  };
}

export function cellIndices(sizeM: number, lat: number, lon: number): { ix: number; iy: number } {
  const { ix, iy } = gridCell(sizeM, lat, lon);
  return { ix, iy };
}

export function cellKey(sizeM: number, lat: number, lon: number): string {
  return gridCell(sizeM, lat, lon).key;
}

const QUANT_BITS = 16;
export const MORTON_QUANT_MAX = (1 << QUANT_BITS) - 1;
export const PS_QUANT_MAX = MORTON_QUANT_MAX;

export function part1By1(value: number): number {
  let result = value & 0xffff;
  result = (result | (result << 8)) & 0x00ff00ff;
  result = (result | (result << 4)) & 0x0f0f0f0f;
  result = (result | (result << 2)) & 0x33333333;
  result = (result | (result << 1)) & 0x55555555;
  return result >>> 0;
}

export function quantizeLongitude(lon: number): number {
  return Math.max(
    0,
    Math.min(MORTON_QUANT_MAX, Math.round(((lon + 180) / 360) * MORTON_QUANT_MAX)),
  );
}

export function quantizeLatitude(lat: number): number {
  return Math.max(
    0,
    Math.min(MORTON_QUANT_MAX, Math.round(((lat + 90) / 180) * MORTON_QUANT_MAX)),
  );
}

export function mortonCode(lat: number, lon: number): number {
  return (part1By1(quantizeLongitude(lon)) | (part1By1(quantizeLatitude(lat)) << 1)) >>> 0;
}

function loadDimension(value: number, position: number, set: boolean): number {
  let lower = 0;
  for (let bit = position - 2; bit >= 0; bit -= 2) {
    lower = (lower | ((1 << bit) >>> 0)) >>> 0;
  }
  const positionBit = (1 << position) >>> 0;
  const cleared = (value & ~((positionBit | lower) >>> 0)) >>> 0;
  return (set ? cleared | positionBit : cleared | lower) >>> 0;
}

/** Smallest Morton key at or above `current` that is inside the encoded box. */
export function mortonBigMin(current: number, minimum: number, maximum: number): number {
  let result = -1;
  let min = minimum >>> 0;
  let max = maximum >>> 0;
  for (let position = 31; position >= 0; position -= 1) {
    const bit = (1 << position) >>> 0;
    const state =
      (current & bit ? 4 : 0) | (min & bit ? 2 : 0) | (max & bit ? 1 : 0);
    if (state === 1) {
      result = loadDimension(min, position, true);
      max = loadDimension(max, position, false);
    } else if (state === 3) {
      return min >>> 0;
    } else if (state === 4) {
      return result;
    } else if (state === 5) {
      min = loadDimension(min, position, true);
    }
  }
  return result;
}

// Compatibility names for the proven upstream spatial-index primitives.
export const ps_part1by1 = part1By1;
export const ps_qx = quantizeLongitude;
export const ps_qy = quantizeLatitude;
export const ps_morton = mortonCode;
export const ps_bigmin = mortonBigMin;
