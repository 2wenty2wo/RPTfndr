import { describe, expect, it } from 'vitest';

import type { ConnState, Transport } from '../types';
import {
  MeshCoreDevice,
  buildAppStartCommand,
  buildGetContactsCommand,
} from './device';
import {
  buildBatteryFrame,
  buildContactFrame,
  buildContactsEndFrame,
  buildContactsStartFrame,
  buildDeviceInfoFrame,
  buildSelfInfoFrame,
} from '../test/fixtures/frames';

class ScriptedTransport implements Transport {
  readonly kind = 'mock' as const;
  readonly capabilities = { silentReconnect: true };
  readonly writes: Uint8Array[] = [];
  connects = 0;
  private readonly frameListeners = new Set<(frame: Uint8Array) => void>();
  private readonly stateListeners = new Set<(state: ConnState) => void>();

  async connect(): Promise<void> {
    this.connects += 1;
    this.emitState('connected');
  }

  async disconnect(): Promise<void> {
    this.emitState('disconnected');
  }

  async write(command: Uint8Array): Promise<void> {
    this.writes.push(command.slice());
    switch (command[0]) {
      case 0x01:
        this.emitFrame(buildBatteryFrame(4_111));
        this.emitFrame(buildSelfInfoFrame());
        break;
      case 0x04:
        this.emitFrame(buildContactsStartFrame());
        this.emitFrame(buildContactFrame({ name: 'Target', lastModified: 42 }));
        this.emitFrame(buildContactsEndFrame(42));
        break;
      case 0x16:
        this.emitFrame(buildDeviceInfoFrame({ fwVersion: 9, build: 'build-9', model: 'Companion' }));
        break;
    }
  }

  onFrame(callback: (frame: Uint8Array) => void): () => void {
    this.frameListeners.add(callback);
    return () => this.frameListeners.delete(callback);
  }

  onState(callback: (state: ConnState) => void): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  emitFrame(frame: Uint8Array): void {
    for (const listener of this.frameListeners) listener(frame.slice());
  }

  private emitState(state: ConnState): void {
    for (const listener of this.stateListeners) listener(state);
  }
}

describe('device command helpers', () => {
  it('encodes APP_START and incremental contacts commands byte-for-byte', () => {
    const appStart = buildAppStartCommand('finder');
    expect(appStart.slice(0, 8)).toEqual(Uint8Array.of(1, 3, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20));
    expect(new TextDecoder().decode(appStart.slice(8))).toBe('finder');
    expect(buildGetContactsCommand()).toEqual(Uint8Array.of(4));
    expect(buildGetContactsCommand(0x1234_5678)).toEqual(Uint8Array.of(4, 0x78, 0x56, 0x34, 0x12));
  });

  it('orchestrates APP_START, gap, contact stream, and device query', async () => {
    const transport = new ScriptedTransport();
    const delays: number[] = [];
    const device = new MeshCoreDevice(transport, {
      appName: 'finder-test',
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    const snapshot = await device.connect();

    expect(transport.writes.map((command) => command[0])).toEqual([0x01, 0x04, 0x16]);
    expect(delays).toEqual([300]);
    expect(snapshot).toMatchObject({
      batteryMilliVolts: 4_111,
      contactsLastModified: 42,
      contacts: [{ name: 'Target', type: 2 }],
      info: { fwVersion: 9, build: 'build-9', model: 'Companion' },
      warnings: [],
    });
    expect(snapshot.self.pubkeyHex).toHaveLength(64);
    device.dispose();
  });

  it('upserts unsolicited contact pushes and exposes parsed pushes', async () => {
    const transport = new ScriptedTransport();
    const device = new MeshCoreDevice(transport, { delay: async () => undefined });
    await device.connect();
    const kinds: string[] = [];
    device.onPush((frame) => kinds.push(frame.kind));
    transport.emitFrame(buildContactFrame({ opcode: 0x8a, name: 'Renamed target' }));
    expect(device.contacts()[0]?.name).toBe('Renamed target');
    expect(kinds).toEqual(['contact']);
    device.dispose();
  });

  it('rehydrates the companion protocol without reopening the Bluetooth picker path', async () => {
    const transport = new ScriptedTransport();
    const device = new MeshCoreDevice(transport, { delay: async () => undefined });
    await device.connect();
    await device.rehydrate();

    expect(transport.connects).toBe(1);
    expect(transport.writes.map((command) => command[0])).toEqual([0x01, 0x04, 0x16, 0x01, 0x04, 0x16]);
    device.dispose();
  });
});
