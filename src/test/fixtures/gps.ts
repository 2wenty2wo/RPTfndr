export interface FixtureGpsPoint {
  atMs: number;
  lat: number;
  lon: number;
  accuracy: number;
  speed?: number;
  heading?: number;
}
const SYDNEY = { lat: -33.8688, lon: 151.2093 };

export const WALKING_TRACK: FixtureGpsPoint[] = [
  { atMs: 0, ...SYDNEY, accuracy: 6, speed: 1.2, heading: 90 },
  { atMs: 5_000, lat: -33.8688, lon: 151.209365, accuracy: 5, speed: 1.3, heading: 90 },
  { atMs: 10_000, lat: -33.8688, lon: 151.20943, accuracy: 5, speed: 1.2, heading: 90 },
  { atMs: 15_000, lat: -33.8688, lon: 151.209495, accuracy: 7, speed: 1.1, heading: 90 },
];

export const POOR_ACCURACY_TRACK: FixtureGpsPoint[] = [
  { atMs: 0, ...SYDNEY, accuracy: 12 },
  { atMs: 5_000, lat: -33.8687, lon: 151.2094, accuracy: 82 },
  { atMs: 10_000, lat: -33.8686, lon: 151.2095, accuracy: 95 },
];

export const JUMP_TRACK: FixtureGpsPoint[] = [
  { atMs: 0, ...SYDNEY, accuracy: 5, speed: 0 },
  { atMs: 1_000, lat: -33.82, lon: 151.3, accuracy: 5, speed: 0 },
  { atMs: 2_000, lat: -33.8688, lon: 151.2093, accuracy: 5, speed: 0 },
];

export function offsetTrack(track: readonly FixtureGpsPoint[], epochMs: number): FixtureGpsPoint[] {
  return track.map((point) => ({ ...point, atMs: point.atMs + epochMs }));
}
