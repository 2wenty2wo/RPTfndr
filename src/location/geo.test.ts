import { describe, expect, it } from 'vitest';
import {
  MORTON_QUANT_MAX,
  bearingDegrees,
  destinationPoint,
  distanceMeters,
  gridCell,
  lonLatToTile,
  mortonCode,
  part1By1,
  quantizeLatitude,
  quantizeLongitude,
  tileToLatLon,
} from './geo';

describe('geospatial helpers', () => {
  it('round-trips distance, bearing, and destination', () => {
    const start = { lat: -33.86, lon: 151.2 };
    const end = destinationPoint(start, 90, 1_000);
    expect(distanceMeters(start, end)).toBeCloseTo(1_000, 5);
    expect(bearingDegrees(start, end)).toBeCloseTo(90, 5);
  });

  it('round-trips fractional Web Mercator tiles', () => {
    const tile = lonLatToTile(151.2, -33.86, 12);
    const coordinate = tileToLatLon(tile.x, tile.y, 12);
    expect(coordinate.lat).toBeCloseTo(-33.86, 8);
    expect(coordinate.lon).toBeCloseTo(151.2, 8);
  });

  it('uses stable fixed latitude-band keys with cosine-scaled longitude', () => {
    const equator = gridCell(12, 0, 0);
    const equatorAgain = gridCell(12, 0, 0);
    const highLatitude = gridCell(12, 60, 0);
    expect(equatorAgain.key).toBe(equator.key);
    const equatorNext = gridCell(12, 0, 0.001);
    const highNext = gridCell(12, 60, 0.001);
    expect(equatorNext.ix - equator.ix).toBeGreaterThan(highNext.ix - highLatitude.ix);
    expect(equator.key).toMatch(/^12:\d+:\d+$/);
  });
});
describe('Morton spatial index', () => {
  it('quantises the world corners and interleaves both dimensions', () => {
    expect(quantizeLongitude(-180)).toBe(0);
    expect(quantizeLongitude(180)).toBe(MORTON_QUANT_MAX);
    expect(quantizeLatitude(-90)).toBe(0);
    expect(quantizeLatitude(90)).toBe(MORTON_QUANT_MAX);
    const qx = quantizeLongitude(12.34);
    const qy = quantizeLatitude(56.78);
    expect(mortonCode(56.78, 12.34)).toBe((part1By1(qx) | (part1By1(qy) << 1)) >>> 0);
  });
});
