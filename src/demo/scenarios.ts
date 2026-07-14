import type { GpsFix, TargetProfile } from '../types';
import { ReplayTransport, type ReplayTransportOptions, type ScriptEvent } from '../transports/replay';

export type DemoScenarioId =
  | 'approach-and-pass'
  | 'forwarded-only'
  | 'gps-gap'
  | 'poor-accuracy'
  | 'prefix-collision'
  | 'multi-pass'
  | 'multipath-outlier'
  | 'ble-drop';

export interface DemoScenario {
  id: DemoScenarioId;
  title: string;
  description: string;
  target: TargetProfile;
  events: ScriptEvent[];
}

export interface DemoScenarioDescriptor {
  id: DemoScenarioId;
  title: string;
  description: string;
}

const TARGET_BYTES = Uint8Array.from([
  0xa1, 0xb2, 0xc3, 0xd4, 0x10, 0x11, 0x12, 0x13,
  0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
  0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23,
  0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b,
]);
const OTHER_BYTES = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index);
const COLLISION_BYTES = Uint8Array.from({ length: 32 }, (_, index) => (
  index < 3 ? TARGET_BYTES[index]! : 0xe0 - index
));

export const DEMO_TARGET_PUBKEY_HEX = bytesToHex(TARGET_BYTES);
export const DEMO_TARGET_PROFILE: TargetProfile = {
  id: 'demo-target-a1b2c3d4',
  label: 'SIMULATED Lost Repeater',
  identity: { kind: 'full-pubkey', pubkeyHex: DEMO_TARGET_PUBKEY_HEX },
  source: 'manual',
  notes: 'SIMULATED DATA target for replay scenarios.',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

export const DEMO_SCENARIOS: readonly DemoScenarioDescriptor[] = [
  {
    id: 'approach-and-pass',
    title: 'Approach and pass',
    description: 'Confirmed direct receptions strengthen and then weaken along a walking track.',
  },
  {
    id: 'forwarded-only',
    title: 'Forwarded only',
    description: 'Target-origin packets are forwarded by another node and never enter the signal gauge.',
  },
  {
    id: 'gps-gap',
    title: 'GPS gap',
    description: 'Capture continues while position fixes become stale and then recover.',
  },
  {
    id: 'poor-accuracy',
    title: 'Poor GPS accuracy',
    description: 'Direct hits arrive alongside rejected and degraded position fixes.',
  },
  {
    id: 'prefix-collision',
    title: 'Prefix collision',
    description: 'Two observed identities share a path prefix, keeping matching evidence ambiguous.',
  },
  {
    id: 'multi-pass',
    title: 'Multiple passes',
    description: 'Two time-separated approaches demonstrate pass and direction confidence.',
  },
  {
    id: 'multipath-outlier',
    title: 'Multipath outlier',
    description: 'One implausibly strong distant reading tests robust cell aggregation.',
  },
  {
    id: 'ble-drop',
    title: 'Bluetooth drop',
    description: 'A scripted link loss and reconnect preserves the demo capture timeline.',
  },
] as const;

export function createDemoScenario(id: DemoScenarioId): DemoScenario {
  const descriptor = DEMO_SCENARIOS.find((candidate) => candidate.id === id);
  if (!descriptor) throw new RangeError(`Unknown demo scenario "${id}"`);
  return {
    ...descriptor,
    target: structuredCloneSafe(DEMO_TARGET_PROFILE),
    events: buildEvents(id),
  };
}

export function createDemoReplayTransport(
  id: DemoScenarioId,
  options?: ReplayTransportOptions,
): ReplayTransport {
  return new ReplayTransport(createDemoScenario(id).events, options);
}

/**
 * Build a valid MeshCore AnonRequest inside a companion 0x88 RX notification.
 * AnonRequest exposes the full origin key without requiring a signed advert,
 * which makes deterministic demo identity evidence possible offline.
 */
export function buildDemoRxFrame(options: {
  originPubkey?: Uint8Array;
  path?: Uint8Array[];
  pathHashSize?: 1 | 2 | 3;
  routeType?: 0 | 1 | 2 | 3;
  rssi?: number;
  snr?: number;
} = {}): Uint8Array {
  const path = options.path ?? [];
  const pathHashSize = options.pathHashSize ?? (path[0]?.length as 1 | 2 | 3 | undefined) ?? 3;
  if (!path.every((hash) => hash.length === pathHashSize)) {
    throw new RangeError('Every demo path hash must match pathHashSize.');
  }
  if (path.length > 63) throw new RangeError('A MeshCore path can contain at most 63 hops.');
  const origin = options.originPubkey ?? TARGET_BYTES;
  if (origin.length !== 32) throw new RangeError('The demo origin public key must be 32 bytes.');
  const routeType = options.routeType ?? 1; // flood
  const transportBytes = routeType === 0 || routeType === 3 ? 4 : 0;
  const packet = new Uint8Array(1 + transportBytes + 1 + path.length * pathHashSize + 35);
  let offset = 0;
  packet[offset++] = routeType | (7 << 2); // payload type 7: AnonRequest, version 0
  offset += transportBytes; // deterministic zero transport region codes
  packet[offset++] = ((pathHashSize - 1) << 6) | path.length;
  for (const hash of path) {
    packet.set(hash, offset);
    offset += hash.length;
  }
  packet[offset++] = 0x42; // destination hash
  packet.set(origin, offset);
  offset += 32;
  packet[offset++] = 0x12; // deterministic two-byte cipher MAC
  packet[offset] = 0x34;

  const frame = new Uint8Array(3 + packet.length);
  frame[0] = 0x88;
  frame[1] = encodeInt8(Math.round((options.snr ?? 4) * 4));
  frame[2] = encodeInt8(Math.round(options.rssi ?? -90));
  frame.set(packet, 3);
  return frame;
}

function buildEvents(id: DemoScenarioId): ScriptEvent[] {
  const track = baseTrack();
  const events: ScriptEvent[] = [];
  const addFix = (atMs: number, index: number, overrides: Partial<GpsFix> = {}): void => {
    const point = track[index % track.length]!;
    events.push({
      atMs,
      kind: 'gps',
      fix: {
        sessionId: `demo-${id}`,
        t: 1_700_000_000_000 + atMs,
        posT: 1_700_000_000_000 + atMs,
        lat: point.lat,
        lon: point.lon,
        accuracy: 7,
        speed: 1.3,
        heading: point.heading,
        accepted: true,
        acceptedNum: 1,
        quality: 'good',
        ...overrides,
      },
    });
  };
  const addDirect = (atMs: number, rssi: number, snr = 4): void => {
    events.push({ atMs, kind: 'frame', frame: buildDemoRxFrame({ rssi, snr }) });
  };
  const addForwarded = (atMs: number, rssi = -82): void => {
    events.push({
      atMs,
      kind: 'frame',
      frame: buildDemoRxFrame({
        originPubkey: TARGET_BYTES,
        path: [OTHER_BYTES.subarray(0, 3)],
        rssi,
      }),
    });
  };

  switch (id) {
    case 'approach-and-pass': {
      const strengths = [-108, -101, -94, -84, -71, -66, -74, -87, -99];
      strengths.forEach((rssi, index) => {
        const atMs = index * 4_000;
        addFix(atMs, index);
        addDirect(atMs + 500, rssi, -4 + index * 1.4);
      });
      break;
    }
    case 'forwarded-only':
      for (let index = 0; index < 7; index += 1) {
        const atMs = index * 5_000;
        addFix(atMs, index);
        addForwarded(atMs + 600, -96 + index * 3);
      }
      break;
    case 'gps-gap':
      addFix(0, 0);
      addDirect(500, -98);
      addDirect(8_500, -88);
      addDirect(18_000, -78);
      addDirect(33_000, -75);
      addFix(40_000, 5);
      addDirect(40_500, -72);
      break;
    case 'poor-accuracy':
      for (let index = 0; index < 6; index += 1) {
        const atMs = index * 5_000;
        if (index === 1 || index === 3) {
          addFix(atMs, index, {
            accuracy: 120,
            accepted: false,
            acceptedNum: 0,
            rejectReason: 'hard-accuracy',
            quality: 'degraded',
          });
        } else {
          addFix(atMs, index, { accuracy: 38, quality: 'degraded' });
        }
        addDirect(atMs + 500, -97 + index * 5);
      }
      break;
    case 'prefix-collision':
      addFix(0, 0);
      // Zero-hop observations teach the identity universe both full keys.
      addDirect(300, -92);
      events.push({
        atMs: 700,
        kind: 'frame',
        frame: buildDemoRxFrame({ originPubkey: COLLISION_BYTES, rssi: -91 }),
      });
      events.push({
        atMs: 1_200,
        kind: 'frame',
        frame: buildDemoRxFrame({
          originPubkey: OTHER_BYTES,
          path: [TARGET_BYTES.subarray(0, 3)],
          rssi: -70,
        }),
      });
      break;
    case 'multi-pass':
      for (let pass = 0; pass < 2; pass += 1) {
        for (let index = 0; index < 7; index += 1) {
          const trackIndex = pass === 0 ? index : 6 - index;
          const atMs = pass * 200_000 + index * 4_000;
          addFix(atMs, trackIndex);
          addDirect(atMs + 500, -101 + (3 - Math.abs(3 - index)) * 9);
        }
      }
      break;
    case 'multipath-outlier':
      for (let index = 0; index < 6; index += 1) {
        const atMs = index * 4_000;
        addFix(atMs, index);
        addDirect(atMs + 500, -98 + index * 5);
      }
      events.push({
        atMs: 26_000,
        kind: 'gps',
        fix: {
          sessionId: `demo-${id}`,
          t: 1_700_000_026_000,
          posT: 1_700_000_026_000,
          lat: -33.862,
          lon: 151.215,
          accuracy: 8,
          speed: 1.2,
          heading: 90,
          accepted: true,
          acceptedNum: 1,
          quality: 'good',
        },
      });
      addDirect(26_500, -55, 11);
      break;
    case 'ble-drop':
      addFix(0, 0);
      addDirect(500, -92);
      events.push({ atMs: 4_000, kind: 'drop', reason: 'Simulated BLE range loss' });
      events.push({ atMs: 10_000, kind: 'reconnect' });
      addFix(10_200, 2);
      addDirect(10_700, -84);
      break;
  }
  return events.sort((a, b) => a.atMs - b.atMs);
}

function baseTrack(): Array<{ lat: number; lon: number; heading: number }> {
  return Array.from({ length: 9 }, (_, index) => ({
    lat: -33.86895 + index * 0.00007,
    lon: 151.20900 + index * 0.00005,
    heading: 32,
  }));
}

function encodeInt8(value: number): number {
  return Math.max(-128, Math.min(127, value)) & 0xff;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
