export type Hex = string;

export type IdentityTier = 'full-pubkey' | 'node-id' | 'prefix' | 'name' | 'none';
export type ClassificationKind =
  | 'DECODE_FAILED'
  | 'UNKNOWN_TRANSMITTER'
  | 'DIRECT_TARGET'
  | 'TARGET_IS_IMMEDIATE_TRANSMITTER'
  | 'AMBIGUOUS_PREFIX'
  | 'NON_TARGET'
  | 'TARGET_ORIGIN_BUT_FORWARDED'
  | 'TARGET_IN_PATH_BUT_NOT_IMMEDIATE';

export interface TargetIdentity {
  kind: 'full-pubkey' | 'node-id' | 'prefix' | 'name-only';
  pubkeyHex?: Hex;
  bytesHex?: Hex;
  name?: string;
}

/**
 * Coordinates supplied by a repeater advert or contact record. MeshCore
 * administrators enter these values manually, so they are display-only and
 * must never be treated as a measured target position.
 */
export interface AdvertisedReferencePosition {
  lat: number;
  lon: number;
  source: 'advert' | 'contact';
  observedAt: number;
  trust: 'untrusted-admin';
}

export interface TargetProfile {
  id: string;
  label: string;
  identity: TargetIdentity;
  source: 'manual' | 'contacts' | 'observed';
  pinnedFrom?: string;
  notes?: string;
  advertisedReference?: AdvertisedReferencePosition;
  photoBlobId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A repeater whose physical coordinates were independently verified for use as
 * a stationary RF observer. Advert/contact coordinates are intentionally not
 * accepted here.
 */
export interface VerifiedObserver {
  id: string;
  label: string;
  repeaterPubkeyHex: Hex;
  lat: number;
  lon: number;
  accuracyM: number;
  verifiedAt: number;
  verification: 'user-surveyed' | 'operator-confirmed';
  trust: 'verified-observer';
  permissionConfirmed: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A target-attributed zero-hop neighbour record returned by a remote observer. */
export interface RemoteObserverEvidence {
  id?: string;
  observerId: string;
  observerPubkeyHex: Hex;
  targetPubkeyHex: Hex;
  observedAt: number;
  receivedAt: number;
  heardSecondsAgo: number;
  snr: number;
  anchorLat: number;
  anchorLon: number;
  anchorAccuracyM: number;
  anchorVerifiedAt: number;
  anchorVerification: VerifiedObserver['verification'];
  source: 'guest-neighbour';
  trust: 'verified-observer';
}

export interface GpsFix {
  id?: number;
  sessionId: string;
  t: number;
  posT: number;
  lat: number;
  lon: number;
  accuracy: number;
  altitude?: number;
  altitudeAccuracy?: number;
  speed?: number;
  heading?: number;
  accepted: boolean;
  acceptedNum: 0 | 1;
  rejectReason?: 'hard-accuracy' | 'jump' | 'filter-hold';
  quality: 'good' | 'degraded';
}

export interface GpsAssociation {
  status: 'ok' | 'stale' | 'none';
  fixId?: number;
  lat?: number;
  lon?: number;
  accuracy?: number;
  ageMs?: number;
  quality?: 'good' | 'degraded';
  excludedReason?: string;
}

export interface ClassificationResult {
  kind: ClassificationKind;
  confirmed: boolean;
  explanation: string;
  identityTier: IdentityTier;
  immediateTx?: { hashHex: Hex; sizeBytes: number; knownAs?: string };
  origin?: { pubkeyHex?: Hex; srcHashHex?: Hex; name?: string };
  collisions?: Array<{ hashHex: Hex; knownAs?: string }>;
  flags: {
    originIsTarget?: boolean;
    targetInPath?: boolean;
    zeroHop?: boolean;
    viaDiscovery?: boolean;
  };
}

export type RouteType = 'flood' | 'direct' | 'transport-flood' | 'transport-direct';

export interface NormalizedPacket {
  hashHex: Hex;
  routeType: RouteType;
  payloadType: number;
  payloadTypeName: string;
  payloadVersion: number;
  pathHashSize: number;
  path: Hex[];
  advert?: {
    pubkeyHex: Hex;
    name?: string;
    isRepeater: boolean;
    hasLocation: boolean;
    lat?: number;
    lon?: number;
    timestamp?: number;
  };
  anonSenderPubkeyHex?: Hex;
  srcHashHex?: Hex;
  destHashHex?: Hex;
  traceHops?: Hex[];
  warnings: string[];
  totalBytes: number;
  rawDecoded: unknown;
}

export interface Reception {
  id?: number;
  sessionId: string;
  t: number;
  source: 'rx' | 'discovery';
  opcode: number;
  frameHex: Hex;
  loraHex?: Hex;
  rssi: number;
  snr: number;
  uplinkSnr?: number;
  companionPathLen?: number;
  decoded?: NormalizedPacket;
  decodeError?: string;
  cls: ClassificationResult;
  conf: 0 | 1;
  gps: GpsAssociation;
  dupOf?: number;
  morton?: number;
}

export interface SessionEvent {
  id?: number;
  sessionId: string;
  t: number;
  type:
    | 'note'
    | 'mark'
    | 'bearing'
    | 'discovery-cmd'
    | 'lifecycle'
    | 'identity-change'
    | 'suspension-gap'
    | 'observer-query'
    | 'observer-evidence'
    | 'smart-wardrive';
  data: Record<string, unknown>;
}

export interface SessionSettings {
  cellSizeM: number;
  minSamples: number;
  minCells: number;
  smoothingWindow: number;
  emaAlpha: number;
  maxGpsAccuracyM: number;
  audioMode: 'chime' | 'tone' | 'geiger' | 'off';
  audioVolume: number;
  audioMuted: boolean;
  forwardedAlert: boolean;
  smartWardriveEnabled: boolean;
  autoDiscoveryEnabled: boolean;
  autoDiscoveryIntervalSec: number;
  observerAssistEnabled: boolean;
  observerPollIntervalMin: number;
}

export interface SearchSession {
  id: string;
  title: string;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  state: 'active' | 'paused' | 'ended';
  targetSnapshot: TargetProfile;
  device?: { pubkeyHex: Hex; model?: string; fwVer?: number; fwBuild?: string; battMv?: number };
  app: { version: string; commit: string; decoderVersion: string };
  mode: 'walk' | 'drive';
  demo: boolean;
  settings: SessionSettings;
  calibration?: { weakRssi: number; strongRssi: number; weakSnr: number; strongSnr: number };
  counters: {
    receptions: number;
    confirmed: number;
    located: number;
    fixesAccepted: number;
    fixesRejected: number;
    decodeFailed: number;
    discoveries: number;
  };
  bestConfirmed?: { t: number; rssi: number; snr: number; receptionId?: number };
}

export interface CellAggregate {
  key: string;
  centerLat: number;
  centerLon: number;
  sizeM: number;
  count: number;
  medianRssi: number;
  maxRssi: number;
  madRssi: number;
  medianSnr: number;
  maxSnr: number;
  medianGpsAcc: number;
  passes: number;
  octants: number;
  firstT: number;
  lastT: number;
  minIdentityTier: IdentityTier;
  confidence: number;
}

export interface AreaEstimate {
  ready: boolean;
  reason: string;
  sampleCount: number;
  cellCount: number;
  polygon?: Array<[number, number]>;
  areaM2?: number;
  confidence?: 'low' | 'medium' | 'high';
  cellsUsed?: string[];
  strongest?: CellAggregate;
  generatedAt: number;
}

export type ConnState =
  | 'disconnected'
  | 'requesting'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unsupported';

export interface Transport {
  readonly kind: 'webbluetooth' | 'mock' | 'replay';
  readonly capabilities: { silentReconnect: boolean };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onFrame(callback: (frame: Uint8Array) => void): () => void;
  onState(callback: (state: ConnState) => void): () => void;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  cellSizeM: 12,
  minSamples: 5,
  minCells: 3,
  smoothingWindow: 7,
  emaAlpha: 0.3,
  maxGpsAccuracyM: 75,
  audioMode: 'chime',
  audioVolume: 0.8,
  audioMuted: false,
  forwardedAlert: false,
  smartWardriveEnabled: false,
  autoDiscoveryEnabled: false,
  autoDiscoveryIntervalSec: 90,
  observerAssistEnabled: false,
  observerPollIntervalMin: 10,
};
