type JsonRecord = Record<string, unknown>;

export interface NormalizedRecord {
  value: unknown;
  changed: boolean;
}

/** Normalize the v1 target coordinate shape without assigning it any trust. */
export function normalizeTargetRecord(value: unknown): NormalizedRecord {
  if (!isRecord(value)) return { value, changed: false };
  if (isRecord(value.advertisedReference) || value.lastKnown === undefined) {
    return { value, changed: false };
  }
  if (!isRecord(value.lastKnown)) return { value, changed: false };

  const legacy = value.lastKnown;
  if (!isCoordinate(legacy.lat, -90, 90) || !isCoordinate(legacy.lon, -180, 180)) {
    return { value, changed: false };
  }
  const label = typeof legacy.label === 'string' ? legacy.label.toLowerCase() : '';
  const observedAt = finiteNumber(value.updatedAt) ?? finiteNumber(value.createdAt) ?? 0;
  const next: JsonRecord = { ...value };
  delete next.lastKnown;
  next.advertisedReference = {
    lat: legacy.lat,
    lon: legacy.lon,
    source: label.includes('advert') ? 'advert' : 'contact',
    observedAt,
    trust: 'untrusted-admin',
  };
  return { value: next, changed: true };
}

/** Normalize legacy bearing field names to the archive/database v2 shape. */
export function normalizeSessionEventRecord(value: unknown): NormalizedRecord {
  if (!isRecord(value) || value.type !== 'bearing' || !isRecord(value.data)) {
    return { value, changed: false };
  }
  const data = value.data;
  const storedBearing = finiteNumber(data.bearingDeg) ?? finiteNumber(data.degrees);
  const bearingDeg = storedBearing === undefined
    ? undefined
    : ((storedBearing % 360) + 360) % 360;
  const accuracyDeg = finiteNumber(data.accuracyDeg) ?? finiteNumber(data.uncertainty);
  const gpsAccuracyM = finiteNumber(data.gpsAccuracyM) ?? finiteNumber(data.accuracy);
  const hasLegacy = data.degrees !== undefined
    || data.uncertainty !== undefined
    || data.accuracy !== undefined;
  const needsCanonical = bearingDeg !== undefined && data.bearingDeg !== bearingDeg
    || accuracyDeg !== undefined && data.accuracyDeg !== accuracyDeg
    || gpsAccuracyM !== undefined && data.gpsAccuracyM !== gpsAccuracyM;
  if (!hasLegacy && !needsCanonical) return { value, changed: false };

  const nextData: JsonRecord = { ...data };
  if (bearingDeg !== undefined) nextData.bearingDeg = bearingDeg;
  if (accuracyDeg !== undefined) nextData.accuracyDeg = accuracyDeg;
  if (gpsAccuracyM !== undefined) nextData.gpsAccuracyM = gpsAccuracyM;
  delete nextData.degrees;
  delete nextData.uncertainty;
  delete nextData.accuracy;
  return { value: { ...value, data: nextData }, changed: true };
}

export function normalizeSearchSessionRecord(value: unknown): NormalizedRecord {
  if (!isRecord(value)) return { value, changed: false };
  const normalizedTarget = normalizeTargetRecord(value.targetSnapshot);
  if (!normalizedTarget.changed) return { value, changed: false };
  return {
    value: { ...value, targetSnapshot: normalizedTarget.value },
    changed: true,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isCoordinate(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}
