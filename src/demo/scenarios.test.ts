import { describe, expect, it } from 'vitest';

import { DecoderAdapter } from '../meshcore/decoder';
import { parseCompanionFrame } from '../meshcore/frames';
import { ReplayTransport } from '../transports/replay';
import {
  DEMO_SCENARIOS,
  DEMO_TARGET_PUBKEY_HEX,
  buildDemoRxFrame,
  createDemoReplayTransport,
  createDemoScenario,
} from './scenarios';

describe('demo scenarios', () => {
  it('builds real packet-layout frames that round-trip through the production decoder', () => {
    const companion = parseCompanionFrame(buildDemoRxFrame());
    expect(companion.kind).toBe('rx');
    if (companion.kind !== 'rx') throw new Error('Expected RX frame');
    const decoded = new DecoderAdapter().decode(companion.loraHex);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.packet.payloadTypeName).toBe('AnonRequest');
    expect(decoded.packet.anonSenderPubkeyHex).toBe(DEMO_TARGET_PUBKEY_HEX);
    expect(decoded.packet.path).toEqual([]);
  });

  it('provides all required named scripts with simulated targets and timed events', () => {
    expect(DEMO_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'approach-and-pass',
      'forwarded-only',
      'gps-gap',
      'poor-accuracy',
      'prefix-collision',
      'multi-pass',
      'multipath-outlier',
      'ble-drop',
    ]);
    for (const descriptor of DEMO_SCENARIOS) {
      const scenario = createDemoScenario(descriptor.id);
      expect(scenario.target.label).toContain('SIMULATED');
      expect(scenario.events.length).toBeGreaterThan(0);
      expect(scenario.events.every((event, index) => index === 0 || event.atMs >= scenario.events[index - 1]!.atMs)).toBe(true);
    }
  });

  it('returns a replay transport branded as simulated', () => {
    const replay = createDemoReplayTransport('ble-drop', { speed: 'max' });
    expect(replay).toBeInstanceOf(ReplayTransport);
    expect(replay.dataMode).toBe('simulated');
  });
});
