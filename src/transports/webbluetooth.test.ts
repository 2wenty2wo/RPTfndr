import { describe, expect, it, vi } from 'vitest';

import { isMobileBrowser } from './transport';
import { NUS_WRITE_UUID, WebBluetoothTransport } from './webbluetooth';

class FakeCharacteristic extends EventTarget {
  value?: DataView;
  readonly stopNotifications = vi.fn(async () => this as unknown as BluetoothRemoteGATTCharacteristic);
  readonly startNotifications = vi.fn(async () => this as unknown as BluetoothRemoteGATTCharacteristic);
  readonly writeValueWithoutResponse = vi.fn(async (_value: BufferSource) => undefined);
}

function bluetoothHarness(connectFailures = 0): {
  bluetooth: Bluetooth;
  device: BluetoothDevice;
  notify: FakeCharacteristic;
  write: FakeCharacteristic;
  connect: ReturnType<typeof vi.fn>;
  getDevices: ReturnType<typeof vi.fn>;
} {
  const notify = new FakeCharacteristic();
  const write = new FakeCharacteristic();
  const service = {
    getCharacteristic: vi.fn(async (uuid: BluetoothCharacteristicUUID) => (
      uuid === NUS_WRITE_UUID ? write : notify
    ) as unknown as BluetoothRemoteGATTCharacteristic),
  } as unknown as BluetoothRemoteGATTService;
  const server = {
    getPrimaryService: vi.fn(async () => service),
  } as unknown as BluetoothRemoteGATTServer;
  const connect = vi.fn(async () => {
    if (connectFailures-- > 0) throw new Error('temporary GATT failure');
    return server;
  });
  const gatt = {
    connected: true,
    connect,
    disconnect: vi.fn(),
  } as unknown as BluetoothRemoteGATTServer;
  const device = new EventTarget() as EventTarget & BluetoothDevice;
  Object.defineProperties(device, {
    id: { value: 'device-1' },
    name: { value: 'MeshCore Test' },
    gatt: { value: gatt },
  });
  const getDevices = vi.fn(async () => [device]);
  const bluetooth = {
    requestDevice: vi.fn(async () => device),
    getDevices,
  } as unknown as Bluetooth;
  return { bluetooth, device, notify, write, connect, getDevices };
}

describe('WebBluetoothTransport', () => {
  it('retries GATT three times, resets notifications, and preserves one frame per notification', async () => {
    const harness = bluetoothHarness(2);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const transport = new WebBluetoothTransport({ bluetooth: harness.bluetooth, sleep });
    const frames: Uint8Array[] = [];
    transport.onFrame((frame) => frames.push(frame));
    await transport.connect();

    expect(harness.connect).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([500, 1_000]);
    expect(harness.notify.stopNotifications).toHaveBeenCalledBefore(harness.notify.startNotifications);
    harness.notify.value = new DataView(Uint8Array.of(0x88, 0x04, 0xb0, 0xaa).buffer);
    harness.notify.dispatchEvent(new Event('characteristicvaluechanged'));
    expect(frames).toEqual([Uint8Array.of(0x88, 0x04, 0xb0, 0xaa)]);

    await transport.write(Uint8Array.of(0x16));
    expect(harness.write.writeValueWithoutResponse).toHaveBeenCalledOnce();
    await transport.disconnect();
  });

  it('silent reconnect uses getDevices and never reopens the picker', async () => {
    const harness = bluetoothHarness();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const transport = new WebBluetoothTransport({ bluetooth: harness.bluetooth, sleep });
    const states: string[] = [];
    transport.onState((state) => states.push(state));
    await transport.connect();
    harness.device.dispatchEvent(new Event('gattserverdisconnected'));
    await vi.waitFor(() => expect(harness.getDevices).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(transport.state).toBe('connected'));
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(harness.bluetooth.requestDevice).toHaveBeenCalledOnce();
    expect(states).toContain('reconnecting');
    await transport.disconnect();
  });

  it('detects mobile browsers, including iPadOS desktop user agents', () => {
    expect(isMobileBrowser({ userAgent: 'Mozilla/5.0 (iPhone)' })).toBe(true);
    expect(isMobileBrowser({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isMobileBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(false);
  });
});
