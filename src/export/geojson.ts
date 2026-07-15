import type {
  AreaEstimate,
  CellAggregate,
  RemoteObserverEvidence,
  Reception,
  SearchSession,
  SessionEvent,
} from '../types';
import {
  observationFromBearingEvent,
  type BearingConsensus,
  type FinalApproachEstimate,
  type RemoteObserverAnalysis,
  type RemoteObserverCombinedZone,
} from '../location';

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
    bearingConsensus?: {
      approximate: true;
      confidence: string;
      radiusM: number;
      geometryQuality: string;
      observationCount: number;
    };
    finalApproach?: {
      approximate: true;
      ready: boolean;
      reason: string;
      confidence: string;
      disagreement: boolean;
      bearingCount: number;
      signalCellCount: number;
      areaM2: number | null;
    };
    remoteObservers?: {
      approximate: true;
      ready: boolean;
      reason: string;
      confidence: string | null;
      observerCount: number;
      observationCount: number;
      areaM2: number | null;
    };
    communityAssistedZone?: {
      approximate: true;
      ready: boolean;
      reason: string;
      confidence: string;
      disagreement: boolean;
      observerCount: number;
      areaM2: number | null;
    };
    importedObserverAudit?: {
      reportCount: number;
      analysisEligibility: 'audit-only';
      geometryExported: false;
    };
  };
}

export interface GeoJsonExportInput {
  session: SearchSession;
  receptions: readonly Reception[];
  cells?: readonly CellAggregate[];
  estimate?: AreaEstimate;
  events?: readonly SessionEvent[];
  bearingConsensus?: BearingConsensus;
  finalApproach?: FinalApproachEstimate;
  observerEvidence?: readonly RemoteObserverEvidence[];
  remoteObserverAnalysis?: RemoteObserverAnalysis;
  communityAssistedZone?: RemoteObserverCombinedZone;
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

  const targetPubkeyHex = input.session.targetSnapshot.identity.kind === 'full-pubkey'
    ? input.session.targetSnapshot.identity.pubkeyHex?.toLowerCase()
    : undefined;
  const observerReportMap = new Map<string, RemoteObserverEvidence>();
  for (const report of [
    ...observerEvidenceFromEvents(input.events ?? [], targetPubkeyHex),
    ...(input.observerEvidence ?? []),
  ]) {
    const key = report.id
      ?? `${report.observerPubkeyHex}:${report.targetPubkeyHex}:${report.receivedAt}`;
    observerReportMap.set(key, report);
  }
  const observerReports = [...observerReportMap.values()];
  const contributingReportIds = new Set(
    (input.remoteObserverAnalysis?.zone?.contributingObservationIds ?? []).map(String),
  );
  for (const report of observerReports) {
    if (!validObserverReport(report, targetPubkeyHex)) continue;
    features.push({
      type: 'Feature',
      ...(report.id === undefined ? {} : { id: `remote-observer-${report.id}` }),
      geometry: { type: 'Point', coordinates: [report.anchorLon, report.anchorLat] },
      properties: {
        featureType: 'remote-observer-report',
        label: 'Verified remote observer report',
        positionRole: 'verified-observer-anchor',
        observerId: report.observerId,
        observerPubkey: report.observerPubkeyHex,
        targetPubkey: report.targetPubkeyHex,
        observedAt: new Date(report.observedAt).toISOString(),
        receivedAt: new Date(report.receivedAt).toISOString(),
        heardSecondsAgo: report.heardSecondsAgo,
        snrDb: report.snr,
        observerPositionAccuracyM: report.anchorAccuracyM,
        observerPositionVerifiedAt: new Date(report.anchorVerifiedAt).toISOString(),
        observerPositionVerification: report.anchorVerification,
        source: report.source,
        trust: report.trust,
        analysisEligibility: report.id !== undefined && contributingReportIds.has(String(report.id))
          ? 'contributing'
          : 'not-contributing',
        methodCaveat: 'This point is the independently verified observer position, not a target position.',
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
        methodCaveat: 'Relative signal strength narrows an approximate search area; it does not determine transmitter coordinates.',
        simulatedData: input.session.demo,
      },
    });
  }

  if (input.bearingConsensus?.polygon && input.bearingConsensus.polygon.length >= 3) {
    features.push({
      type: 'Feature',
      id: 'approximate-bearing-zone',
      geometry: { type: 'Polygon', coordinates: [latLonRing(input.bearingConsensus.polygon)] },
      properties: {
        featureType: 'bearing-consensus-zone',
        label: 'Approximate directional-bearing zone',
        approximate: true,
        confidence: input.bearingConsensus.confidence,
        geometryQuality: input.bearingConsensus.geometryQuality,
        observationCount: input.bearingConsensus.observationCount,
        radiusM: input.bearingConsensus.radiusM,
        rmsCrossTrackErrorM: input.bearingConsensus.rmsCrossTrackErrorM,
        contributingObservationIds: input.bearingConsensus.contributingObservationIds,
        exclusionReasons: input.bearingConsensus.exclusionReasons,
        simulatedData: input.session.demo,
      },
    });
  }

  if (input.finalApproach?.polygon && input.finalApproach.polygon.length >= 3) {
    features.push({
      type: 'Feature',
      id: 'approximate-final-approach-zone',
      geometry: { type: 'Polygon', coordinates: [latLonRing(input.finalApproach.polygon)] },
      properties: {
        featureType: 'final-approach-zone',
        label: 'Approximate final-approach zone',
        approximate: true,
        ready: input.finalApproach.ready,
        reason: input.finalApproach.reason,
        confidence: input.finalApproach.confidence,
        areaM2: input.finalApproach.areaM2 ?? null,
        bearingCount: input.finalApproach.bearingCount,
        signalCellCount: input.finalApproach.signalCellCount,
        rmsCrossTrackErrorM: input.finalApproach.rmsCrossTrackErrorM ?? null,
        geometryQuality: input.finalApproach.geometryQuality ?? null,
        contributingObservationIds: input.finalApproach.contributingObservationIds,
        exclusionReasons: input.finalApproach.exclusionReasons,
        simulatedData: input.session.demo,
      },
    });
  }

  const remoteZone = input.remoteObserverAnalysis?.zone;
  if (remoteZone?.polygon && remoteZone.polygon.length >= 3) {
    features.push({
      type: 'Feature',
      id: 'approximate-remote-observer-zone',
      geometry: { type: 'Polygon', coordinates: [latLonRing(remoteZone.polygon)] },
      properties: {
        featureType: 'remote-observer-zone',
        label: 'Approximate remote-observer likelihood zone',
        approximate: true,
        method: remoteZone.method,
        confidence: remoteZone.confidence,
        geometryQuality: remoteZone.geometryQuality,
        observerCount: remoteZone.observerCount,
        observationCount: remoteZone.observationCount,
        relativeConstraintCount: remoteZone.relativeConstraintCount,
        areaM2: remoteZone.areaM2,
        terrainUncertaintyDb: remoteZone.terrainUncertaintyDb,
        contributingObservationIds: remoteZone.contributingObservationIds,
        contributingObserverIds: remoteZone.contributingObserverIds,
        exclusionReasons: remoteZone.exclusionReasons,
        methodCaveat: 'Relative SNR provides a broad likelihood envelope; terrain, antennas, and fading can dominate the readings.',
        simulatedData: input.session.demo,
      },
    });
  }

  if (input.communityAssistedZone?.polygon && input.communityAssistedZone.polygon.length >= 3) {
    features.push({
      type: 'Feature',
      id: 'approximate-community-assisted-zone',
      geometry: {
        type: 'Polygon',
        coordinates: [latLonRing(input.communityAssistedZone.polygon)],
      },
      properties: {
        featureType: 'community-assisted-zone',
        label: 'Approximate community-assisted search zone',
        approximate: true,
        ready: input.communityAssistedZone.ready,
        reason: input.communityAssistedZone.reason,
        confidence: input.communityAssistedZone.confidence,
        disagreement: input.communityAssistedZone.disagreement === true,
        observerCount: input.communityAssistedZone.observerCount,
        areaM2: input.communityAssistedZone.areaM2 ?? null,
        contributingObservationIds: input.communityAssistedZone.contributingObservationIds,
        contributingObserverIds: input.communityAssistedZone.contributingObserverIds,
        methodCaveat: 'This overlap remains an approximate search zone and requires close-range visual confirmation.',
        simulatedData: input.session.demo,
      },
    });
  }

  for (const event of input.events ?? []) {
    const observation = observationFromBearingEvent(event);
    if (!observation) continue;
    const { lat, lon, bearingDeg: bearing } = observation;
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
        accuracyDeg: observation.accuracyDeg ?? null,
        gpsAccuracyM: observation.gpsAccuracyM ?? null,
        confirmedReceptionId: observation.confirmedReceptionId ?? null,
        displayLengthM: Math.max(1, distanceM),
        note: typeof event.data.note === 'string' ? event.data.note : null,
        simulatedData: input.session.demo,
      },
    });
  }

  const exportedAt = input.exportedAt instanceof Date
    ? input.exportedAt.toISOString()
    : input.exportedAt ?? new Date().toISOString();
  const importedObserverAuditCount = countImportedObserverAudit(input.events ?? []);
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
      caveat: 'Every mapped zone is approximate and requires close-range searching and visual confirmation.',
      ...(input.bearingConsensus ? {
        bearingConsensus: {
          approximate: true,
          confidence: input.bearingConsensus.confidence,
          radiusM: input.bearingConsensus.radiusM,
          geometryQuality: input.bearingConsensus.geometryQuality,
          observationCount: input.bearingConsensus.observationCount,
        },
      } : {}),
      ...(input.finalApproach ? {
        finalApproach: {
          approximate: true,
          ready: input.finalApproach.ready,
          reason: input.finalApproach.reason,
          confidence: input.finalApproach.confidence,
          disagreement: input.finalApproach.disagreement === true,
          bearingCount: input.finalApproach.bearingCount,
          signalCellCount: input.finalApproach.signalCellCount,
          areaM2: input.finalApproach.areaM2 ?? null,
        },
      } : {}),
      ...(input.remoteObserverAnalysis ? {
        remoteObservers: {
          approximate: true,
          ready: input.remoteObserverAnalysis.ready,
          reason: input.remoteObserverAnalysis.reason,
          confidence: input.remoteObserverAnalysis.zone?.confidence ?? null,
          observerCount: input.remoteObserverAnalysis.zone?.observerCount
            ?? input.remoteObserverAnalysis.eligibleObserverCount,
          observationCount: input.remoteObserverAnalysis.zone?.observationCount
            ?? input.remoteObserverAnalysis.eligibleObservationCount,
          areaM2: input.remoteObserverAnalysis.zone?.areaM2 ?? null,
        },
      } : {}),
      ...(input.communityAssistedZone ? {
        communityAssistedZone: {
          approximate: true,
          ready: input.communityAssistedZone.ready,
          reason: input.communityAssistedZone.reason,
          confidence: input.communityAssistedZone.confidence,
          disagreement: input.communityAssistedZone.disagreement === true,
          observerCount: input.communityAssistedZone.observerCount,
          areaM2: input.communityAssistedZone.areaM2 ?? null,
        },
      } : {}),
      ...(importedObserverAuditCount > 0 ? {
        importedObserverAudit: {
          reportCount: importedObserverAuditCount,
          analysisEligibility: 'audit-only',
          geometryExported: false,
        },
      } : {}),
    },
  };
}

function countImportedObserverAudit(events: readonly SessionEvent[]): number {
  return events.filter((event) => (
    event.type === 'note'
    && event.data.kind === 'imported-observer-evidence-audit'
    && event.data.eligibility === 'audit-only'
    && event.data.originalEventType === 'observer-evidence'
  )).length;
}

function observerEvidenceFromEvents(
  events: readonly SessionEvent[],
  targetPubkeyHex: string | undefined,
): RemoteObserverEvidence[] {
  const reports: RemoteObserverEvidence[] = [];
  for (const event of events) {
    if (event.type !== 'observer-evidence') continue;
    const data = event.data;
    const observedAt = finiteNumber(data.observedAt);
    const receivedAt = finiteNumber(data.receivedAt);
    const heardSecondsAgo = finiteNumber(data.heardSecondsAgo);
    const snr = finiteNumber(data.snr);
    const anchorLat = finiteNumber(data.anchorLat);
    const anchorLon = finiteNumber(data.anchorLon);
    const anchorAccuracyM = finiteNumber(data.anchorAccuracyM);
    const anchorVerifiedAt = finiteNumber(data.anchorVerifiedAt);
    if (
      typeof data.observerId !== 'string'
      || typeof data.observerPubkeyHex !== 'string'
      || typeof data.targetPubkeyHex !== 'string'
      || observedAt === undefined
      || receivedAt === undefined
      || heardSecondsAgo === undefined
      || snr === undefined
      || anchorLat === undefined
      || anchorLon === undefined
      || anchorAccuracyM === undefined
      || anchorVerifiedAt === undefined
      || (data.anchorVerification !== 'user-surveyed'
        && data.anchorVerification !== 'operator-confirmed')
      || data.source !== 'guest-neighbour'
      || data.trust !== 'verified-observer'
      || targetPubkeyHex === undefined
      || data.targetPubkeyHex.toLowerCase() !== targetPubkeyHex
      || observedAt < 0
      || receivedAt < 0
      || observedAt > receivedAt
      || heardSecondsAgo < 0
      || Math.abs((receivedAt - observedAt) - heardSecondsAgo * 1_000) > 2_000
      || Math.abs(event.t - receivedAt) > 30_000
    ) continue;
    reports.push({
      ...(typeof data.id === 'string' ? { id: data.id } : {}),
      observerId: data.observerId,
      observerPubkeyHex: data.observerPubkeyHex,
      targetPubkeyHex: data.targetPubkeyHex,
      observedAt,
      receivedAt,
      heardSecondsAgo,
      snr,
      anchorLat,
      anchorLon,
      anchorAccuracyM,
      anchorVerifiedAt,
      anchorVerification: data.anchorVerification,
      source: 'guest-neighbour',
      trust: 'verified-observer',
    });
  }
  return reports;
}

function validObserverReport(
  report: RemoteObserverEvidence,
  targetPubkeyHex: string | undefined,
): boolean {
  return report.trust === 'verified-observer'
    && report.source === 'guest-neighbour'
    && /^(?:[0-9a-f]{2}){32}$/i.test(report.observerPubkeyHex)
    && /^(?:[0-9a-f]{2}){32}$/i.test(report.targetPubkeyHex)
    && targetPubkeyHex !== undefined
    && report.targetPubkeyHex.toLowerCase() === targetPubkeyHex
    && validCoordinates(report.anchorLat, report.anchorLon)
    && Number.isFinite(report.anchorAccuracyM)
    && report.anchorAccuracyM >= 1
    && Number.isFinite(report.observedAt)
    && Number.isFinite(report.receivedAt)
    && report.observedAt >= 0
    && report.receivedAt >= report.observedAt
    && Number.isFinite(report.anchorVerifiedAt)
    && Number.isFinite(report.heardSecondsAgo)
    && report.heardSecondsAgo >= 0
    && Math.abs((report.receivedAt - report.observedAt) - report.heardSecondsAgo * 1_000) <= 2_000
    && Number.isFinite(report.snr)
    && report.snr >= -32
    && report.snr <= 31.75;
}

function latLonRing(polygon: readonly (readonly [number, number])[]): GeoJsonPosition[] {
  const ring = polygon.map(([lat, lon]) => [lon, lat] as GeoJsonPosition);
  closeRing(ring);
  return ring;
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
