import { normalizeHex, type DiscoveryResponseFrame } from '../meshcore';

export type ObserverCandidateSource = 'automatic-discovery' | 'manual-discovery' | 'contact' | 'advert';
export type ObserverCandidateCoordinateStatus = 'untrusted';

export interface ObserverCandidateAdvertisedCoordinates {
  lat: number;
  lon: number;
  source: 'advert' | 'contact';
  observedAt: number;
  status: ObserverCandidateCoordinateStatus;
}

export interface ObserverCandidate {
  id: string;
  repeaterPubkeyHex: string;
  displayName: string;
  lastHeardAt: number;
  discoverySource: ObserverCandidateSource;
  advertisedCoordinates?: ObserverCandidateAdvertisedCoordinates;
  coordinateStatus: ObserverCandidateCoordinateStatus;
  reviewed: boolean;
  authorised: boolean;
  observerAssistEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ObserverCandidateInput {
  repeaterPubkeyHex?: string;
  displayName?: string;
  lastHeardAt: number;
  discoverySource: ObserverCandidateSource;
  advertisedCoordinates?: Omit<ObserverCandidateAdvertisedCoordinates, 'status'>;
}

function normalizeFullPubkey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const normalized = normalizeHex(value);
    return normalized.length === 64 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function validCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lon) && lon >= -180 && lon <= 180
    && (lat !== 0 || lon !== 0);
}

export function candidateFromDiscoveryResponse(
  response: DiscoveryResponseFrame,
  receivedAt: number,
  metadata?: { displayName?: string; advertisedCoordinates?: Omit<ObserverCandidateAdvertisedCoordinates, 'status'> },
): ObserverCandidateInput | undefined {
  const repeaterPubkeyHex = response.pubkeySizeBytes === 32 ? normalizeFullPubkey(response.pubkeyHex) : undefined;
  if (!repeaterPubkeyHex) return undefined;
  return {
    repeaterPubkeyHex,
    displayName: metadata?.displayName,
    lastHeardAt: receivedAt,
    discoverySource: 'automatic-discovery',
    advertisedCoordinates: metadata?.advertisedCoordinates,
  };
}

export function upsertObserverCandidates(
  existing: readonly ObserverCandidate[],
  inputs: readonly ObserverCandidateInput[],
  now = Date.now(),
): ObserverCandidate[] {
  const byKey = new Map<string, ObserverCandidate>();
  for (const item of existing) {
    const key = normalizeFullPubkey(item.repeaterPubkeyHex);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, {
      ...item,
      repeaterPubkeyHex: key,
      coordinateStatus: 'untrusted',
      advertisedCoordinates: item.advertisedCoordinates && validCoordinate(item.advertisedCoordinates.lat, item.advertisedCoordinates.lon)
        ? { ...item.advertisedCoordinates, status: 'untrusted' }
        : undefined,
    });
  }
  for (const input of inputs) {
    const repeaterPubkeyHex = normalizeFullPubkey(input.repeaterPubkeyHex);
    if (!repeaterPubkeyHex || !Number.isFinite(input.lastHeardAt)) continue;
    const previous = byKey.get(repeaterPubkeyHex);
    const coords = input.advertisedCoordinates && validCoordinate(input.advertisedCoordinates.lat, input.advertisedCoordinates.lon)
      ? { ...input.advertisedCoordinates, status: 'untrusted' as const }
      : previous?.advertisedCoordinates;
    byKey.set(repeaterPubkeyHex, {
      id: previous?.id ?? `observer-candidate-${repeaterPubkeyHex}`,
      repeaterPubkeyHex,
      displayName: (input.displayName?.trim() || previous?.displayName || `Repeater ${repeaterPubkeyHex.slice(0, 8)}`).slice(0, 80),
      lastHeardAt: Math.max(previous?.lastHeardAt ?? 0, input.lastHeardAt),
      discoverySource: input.discoverySource,
      advertisedCoordinates: coords,
      coordinateStatus: 'untrusted',
      reviewed: previous?.reviewed ?? false,
      authorised: previous?.authorised ?? false,
      observerAssistEnabled: previous?.observerAssistEnabled ?? false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
  }
  return [...byKey.values()].sort((left, right) => right.lastHeardAt - left.lastHeardAt);
}

export function normalizeObserverCandidates(value: unknown): ObserverCandidate[] {
  if (!Array.isArray(value)) return [];
  const normalized = upsertObserverCandidates([], value.filter((item): item is ObserverCandidateInput => typeof item === 'object' && item !== null).map((item) => {
    const candidate = item as Partial<ObserverCandidate>;
    return {
      repeaterPubkeyHex: candidate.repeaterPubkeyHex,
      displayName: candidate.displayName,
      lastHeardAt: Number(candidate.lastHeardAt),
      discoverySource: candidate.discoverySource ?? 'automatic-discovery',
      advertisedCoordinates: candidate.advertisedCoordinates,
    };
  }), Date.now());
  const savedByKey = new Map(value
    .filter((item): item is Partial<ObserverCandidate> => typeof item === 'object' && item !== null)
    .map((item) => [normalizeFullPubkey(item.repeaterPubkeyHex), item]));
  return normalized.map((candidate) => {
    const saved = savedByKey.get(candidate.repeaterPubkeyHex);
    return {
      ...candidate,
      reviewed: saved?.reviewed === true,
      authorised: saved?.authorised === true,
      observerAssistEnabled: saved?.observerAssistEnabled === true,
      createdAt: Number.isFinite(saved?.createdAt) ? Number(saved?.createdAt) : candidate.createdAt,
      updatedAt: Number.isFinite(saved?.updatedAt) ? Number(saved?.updatedAt) : candidate.updatedAt,
    };
  });
}
