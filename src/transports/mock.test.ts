import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockTransport } from './mock';
import { assertTransportSessionCompatibility, TransportModeError } from './transport';

describe('MockTransport', () => {
  afterEach(() => vi.useRealTimers());

  it('provides a minimal app-start, contacts, and device-info handshake', async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const frames: Uint8Array[] = [];
    transport.onFrame((frame) => frames.push(frame));
    await transport.connect();

    await transport.write(Uint8Array.of(0x01));
    await vi.advanceTimersByTimeAsync(5);
    expect(frames.at(-1)?.[0]).toBe(0x05);
    expect(frames.at(-1)).toHaveLength(44);

    await transport.write(Uint8Array.of(0x04, 0, 0, 0, 0));
    await vi.advanceTimersByTimeAsync(10);
    expect(frames.slice(-2).map((frame) => frame[0])).toEqual([0x02, 0x04]);

    await transport.write(Uint8Array.of(0x16));
    await vi.advanceTimersByTimeAsync(5);
    expect(frames.at(-1)?.[0]).toBe(0x0d);
  });

  it('correlates discovery responses to the command tag', async () => {
    vi.useFakeTimers();
    const transport = new MockTransport({
      discoveryResponses: [{ pubkey: new Uint8Array(32).fill(0xaa), uplinkSnr: -2.5 }],
    });
    const frames: Uint8Array[] = [];
    transport.onFrame((frame) => frames.push(frame));
    await transport.connect();
    const command = Uint8Array.of(0x37, 0x80, 0x0f, 0x78, 0x56, 0x34, 0x12);
    await transport.write(command);
    await vi.advanceTimersByTimeAsync(5);

    const response = frames[0]!;
    expect(response[0]).toBe(0x8e);
    expect(response[4]! & 0xf0).toBe(0x90);
    expect(new DataView(response.buffer).getUint32(6, true)).toBe(0x12345678);
    expect(new Int8Array(response.buffer)[5]).toBe(-10);
  });

  it('supports explicit drops and enforces simulated-session separation', async () => {
    const transport = new MockTransport();
    const states: string[] = [];
    transport.onState((state) => states.push(state));
    await transport.connect();
    transport.dropConnection();
    expect(states).toEqual(['disconnected', 'connecting', 'connected', 'disconnected']);
    expect(() => assertTransportSessionCompatibility(transport, false)).toThrow(TransportModeError);
    expect(() => assertTransportSessionCompatibility(transport, true)).not.toThrow();
  });
});
