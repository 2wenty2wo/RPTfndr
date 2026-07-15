import { describe, expect, it } from 'vitest';

import {
  isDiscoveryResponseFrame,
  parseCompanionFrame,
} from './frames';
import {
  buildBatteryFrame,
  buildContactFrame,
  buildDeviceInfoFrame,
  buildDiscoveryResponseFrame,
  buildRx84Frame,
  buildRx88Frame,
  buildRx8eFrame,
  buildSelfInfoFrame,
  buildTracePushFrame,
} from '../test/fixtures/frames';
import { buildAdvertPacket, TARGET_PUBLIC_KEY } from '../test/fixtures/packets';

describe('companion frame parsing', () => {
  it('uses the correct packet offset for all three RX opcodes', () => {
    const lora = buildAdvertPacket();
    for (const [frame, opcode, path] of [
      [buildRx88Frame(lora, { snr: -2.25, rssi: -101 }), 0x88, undefined],
      [buildRx84Frame(lora, { companionPathLen: 3 }), 0x84, 3],
      [buildRx8eFrame(lora, { companionPathLen: 4 }), 0x8e, 4],
    ] as const) {
      const parsed = parseCompanionFrame(frame);
      expect(parsed.kind).toBe('rx');
      if (parsed.kind !== 'rx') continue;
      expect(parsed.opcode).toBe(opcode);
      expect(parsed.lora).toEqual(lora);
      expect(parsed.companionPathLen).toBe(path);
    }
    const signed = parseCompanionFrame(buildRx88Frame(lora, { snr: -2.25, rssi: -101 }));
    expect(signed.kind === 'rx' && signed.snr).toBe(-2.25);
    expect(signed.kind === 'rx' && signed.rssi).toBe(-101);
  });

  it('disambiguates the 0x8e overload by the control nibble', () => {
    const normal = buildRx8eFrame(buildAdvertPacket());
    const discovery = buildDiscoveryResponseFrame({
      tag: 0xfedc_ba98,
      snr: -3.5,
      rssi: -99,
      uplinkSnr: 4.25,
    });
    expect(isDiscoveryResponseFrame(normal)).toBe(false);
    expect(isDiscoveryResponseFrame(discovery)).toBe(true);

    const parsed = parseCompanionFrame(discovery);
    expect(parsed.kind).toBe('discovery-response');
    if (parsed.kind !== 'discovery-response') return;
    expect(parsed.tag).toBe(0xfedc_ba98);
    expect(parsed.pubkeyHex).toBe(TARGET_PUBLIC_KEY);
    expect(parsed.pubkeySizeBytes).toBe(32);
    expect(parsed.snr).toBe(-3.5);
    expect(parsed.uplinkSnr).toBe(4.25);
    expect(parsed.rssi).toBe(-99);
  });

  it('rejects discovery keys that are neither 8 nor 32 bytes', () => {
    const malformed = Uint8Array.of(0x8e, 0, 0, 0, 0x92, 0, 1, 0, 0, 0, 1, 2, 3);
    const parsed = parseCompanionFrame(malformed);
    expect(parsed.kind).toBe('invalid');
    expect(parsed.kind === 'invalid' && parsed.reason).toContain('8 or 32');
  });

  it('parses session metadata frames without losing signed coordinates', () => {
    const self = parseCompanionFrame(buildSelfInfoFrame({ lat: -33.9, lon: 151.2, txPower: -4 }));
    expect(self.kind).toBe('self-info');
    if (self.kind === 'self-info') {
      expect(self.lat).toBe(-33.9);
      expect(self.lon).toBe(151.2);
      expect(self.txPower).toBe(-4);
      expect(self.pubkeyHex).toHaveLength(64);
    }

    const device = parseCompanionFrame(buildDeviceInfoFrame({ fwVersion: -1, build: 'abc', model: 'T-Deck' }));
    expect(device.kind).toBe('device-info');
    if (device.kind === 'device-info') {
      expect(device.fwVersion).toBe(-1);
      expect(device.build).toBe('abc');
      expect(device.model).toBe('T-Deck');
    }

    expect(parseCompanionFrame(buildBatteryFrame(4_123))).toMatchObject({
      kind: 'battery',
      milliVolts: 4_123,
    });
  });

  it('parses fixed contact and trace layouts', () => {
    const contact = parseCompanionFrame(
      buildContactFrame({ name: 'Target', pathLength: 2, lat: -35.1, lon: 149.2, lastModified: 77 }),
    );
    expect(contact.kind).toBe('contact');
    if (contact.kind === 'contact') {
      expect(contact.contact).toMatchObject({
        pubkeyHex: TARGET_PUBLIC_KEY,
        name: 'Target',
        type: 2,
        pathLength: 2,
        lat: -35.1,
        lon: 149.2,
        lastModified: 77,
      });
    }

    const trace = parseCompanionFrame(buildTracePushFrame({ path: [0xa1, 0xb2], snrs: [-1, 2, 3.25] }));
    expect(trace).toMatchObject({
      kind: 'trace',
      path: ['a1', 'b2'],
      snrs: [-1, 2, 3.25],
    });
  });

  it('never throws for empty or truncated notifications', () => {
    expect(parseCompanionFrame(new Uint8Array()).kind).toBe('invalid');
    expect(parseCompanionFrame(Uint8Array.of(0x05)).kind).toBe('invalid');
    expect(parseCompanionFrame(Uint8Array.of(0xff)).kind).toBe('unknown');
  });
});
