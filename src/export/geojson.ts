import type {
  AreaEstimate,
  CellAggregate,
  Reception,
  SearchSession,
  SessionEvent,
} from '../types';

export type GeoJsonPosition = [longitude: number, latitude: number];
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: GeoJsonPosition }
  | { type: 'LineString'; coordinates: GeoJsonPosition[] }
  | { type: 'Polygon'; coordinates: GeoJsonPosition[][] };

export interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry: GeoJsonGeometry;
  properties: Record<string, unknown>;
}

export interface MeshCoreGeoJson {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
  metadata: {
    generator: 'MeshCore Finder';
    sessionId: string;
    targetId: string;
    exportedAt: string;
    simulatedData: boolean;
    coordinateOrder: 'longitude, latitude';
    caveat: string;
  };
}

export interface GeoJsonExportInput {
  session: SearchSession;
  receptions: readonly Reception[];
  cells?: readonly CellAggregate[];
  estimate?: AreaEstimate;
  events?: readonly SessionEvent[];
  /** AreaEstimate uses [lat, lon] by default; change only for imported data. */
  estimateCoordinateOrder?: 'lat-lon' | 'lon-lat';
  exportedAt?: Date | string;
}

export function buildGeoJson(input: GeoJsonExportInput): MeshCoreGeoJson {
  const features: GeoJsonFeature[] = [];

  for (const reception of input.receptions) {
    const { lat, lon } = reception.gps;
    if (lat === undefined || lon === undefined || !validCoordinates(lat, lon)) continue;
    features.push({
      type: 'Feature',
      ...(reception.id === undefined ? {} : { id: `reception-${reception.id}` }),
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        featureType: 'reception',
        sessionId: reception.sessionId,
        time: new Date(reception.t).toISOString(),
        source: reception.source,
        classification: reception.cls.kind,
        confirmed: reception.cls.confirmed,
        explanation: reception.cls.explanation,
        identityTier: reception.cls.identityTier,
        packetHash: reception.decoded?.hashHex ?? null,
        packetType: reception.decoded?.payloadTypeName ?? null,
        originPubkey: reception.cls.origin?.pubkeyHex ?? null,
        originHash: reception.cls.origin?.srcHashHex ?? null,
        immediateTransmitter: reception.cls.immediateTx?.hashHex ?? null,
        path: reception.decoded?.path ?? [],
        rssiDbm: reception.rssi,
        snrDb: reception.snr,
        uplinkSnrDb: reception.uplinkSnr ?? null,
        gpsStatus: reception.gps.status,
        gpsAccuracyM: reception.gps.accuracy ?? null,
        gpsAgeMs: reception.gps.ageMs ?? null,
        simulatedData: input.session.demo,
      },
    });
  }

  for (const cell of input.cells ?? []) {
    features.push({
      type: 'Feature',
      id: `cell-${cell.key}`,
      geometry: { type: 'Polygon', coordinates: [cellRing(cell)] },
      properties: {
        featureType: 'signal-cell',
        cellKey: cell.key,
        sampleCount: cell.count,
        medianRssiDbm: cell.medianRssi,
        maxRssiDbm: cell.maxRssi,
        madRssiDb: cell.madRssi,
        medianSnrDb: cell.medianSnr,
        maxSnrDb: cell.maxSnr,
        medianGpsAccuracyM: cell.medianGpsAcc,
        passes: cell.passes,
        approachOctants: cell.octants,
        confidence: cell.confidence,
        identityTier: cell.minIdentityTier,
        simulatedData: input.session.demo,
      },
    });
  }

  const estimate = input.estimate;
  if (estimate?.polygon && estimate.polygon.length >= 3) {
    const order = input.estimateCoordinateOrder ?? 'lat-lon';
    const ring = estimate.polygon.map(([first, second]): GeoJsonPosition => (
      order === 'lat-lon' ? [second, first] : [first, second]
    ));
    closeRing(ring);
    features.push({
      type: 'Feature',
      id: 'strongest-confirmed-search-area',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        featureType: 'search-area-estimate',
        label: 'Strongest confirmed search area',
        ready: estimate.ready,
        reason: estimate.reason,
        sampleCount: estimate.sampleCount,
        cellCount: estimate.cellCount,
        areaM2: estimate.areaM2 ?? null,
        confidence: estimate.confidence ?? null,
        methodCaveat: 'Relative signal strength narrows a search area; it does not identify an exact position.',
        simulatedData: input.session.demo,
      },
    });
  }

  for (const event of input.events ?? []) {
    if (event.type !== 'bearing') continue;
    const lat = finiteNumber(event.data.lat);
    const lon = finiteNumber(event.data.lon);
    const bearing = finiteNumber(event.data.degrees ?? event.data.bearing ?? event.data.heading);
    if (lat === undefined || lon === undefined || !validCoordinates(lat, lon) || bearing === undefined) continue;
    const distanceM = finiteNumber(event.data.lengthM) ?? 100;
    const endpoint = destinationPoint(lat, lon, bearing, Math.max(1, distanceM));
    features.push({
      type: 'Feature',
      ...(event.id === undefined ? {} : { id: `bearing-${event.id}` }),
      geometry: { type: 'LineString', coordinates: [[lon, lat], [endpoint.lon, endpoint.lat]] },
      properties: {
        featureType: 'bearing',
        time: new Date(event.t).toISOString(),
        bearingDeg: bearing,
        displayLengthM: Math.max(1, distanceM),
        note: typeof event.data.note === 'string' ? event.data.note : null,
        simulatedData: input.session.demo,
      },
    });
  }

  const exportedAt = input.exportedAt instanceof Date
    ? input.exportedAt.toISOString()
    : input.exportedAt ?? new Date().toISOString();
  return {
    type: 'FeatureCollection',
    features,
    metadata: {
      generator: 'MeshCore Finder',
      sessionId: input.session.id,
      targetId: input.session.targetSnapshot.id,
      exportedAt,
      simulatedData: input.session.demo,
      coordinateOrder: 'longitude, latitude',
      caveat: 'This mapped signal estimate does not identify an exact transmitter position.',
    },
  };
}

export function stringifyGeoJson(input: GeoJsonExportInput, pretty = true): string {
  return JSON.stringify(buildGeoJson(input), null, pretty ? 2 : undefined);
}

function cellRing(cell: CellAggregate): GeoJsonPosition[] {
  const halfLatitude = (cell.sizeM / 2) / 111_320;
  const longitudeScale = Math.max(0.01, Math.cos(cell.centerLat * Math.PI / 180));
  const halfLongitude = (cell.sizeM / 2) / (111_320 * longitudeScale);
  return [
    [cell.centerLon - halfLongitude, cell.centerLat - halfLatitude],
    [cell.centerLon + halfLongitude, cell.centerLat - halfLatitude],
    [cell.centerLon + halfLongitude, cell.centerLat + halfLatitude],
    [cell.centerLon - halfLongitude, cell.centerLat + halfLatitude],
    [cell.centerLon - halfLongitude, cell.centerLat - halfLatitude],
  ];
}

function closeRing(ring: GeoJsonPosition[]): void {
  const first = ring[0];
  const last = ring.at(-1);
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([...first]);
}

function validCoordinates(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function destinationPoint(
  latitude: number,
  longitude: number,
  bearingDegrees: number,
  distanceM: number,
): { lat: number; lon: number } {
  const radiusM = 6_371_008.8;
  const angular = distanceM / radiusM;
  const bearing = bearingDegrees * Math.PI / 180;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular)
      + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
  );
  return { lat: lat2 * 180 / Math.PI, lon: ((lon2 * 180 / Math.PI + 540) % 360) - 180 };
}
