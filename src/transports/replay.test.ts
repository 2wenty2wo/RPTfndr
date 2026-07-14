import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GpsFix } from '../types';
import { ReplayTransport, replayEventsFromArchive } from './replay';

const FIX: GpsFix = {
  sessionId: 'demo',
  t: 1_000,
  posT: 1_000,
  lat: -33.86,
  lon: 151.2,
  accuracy: 5,
  accepted: true,
  acceptedNum: 1,
  quality: 'good',
};

describe('ReplayTransport', () => {
  afterEach(() => vi.useRealTimers());

  it('replays frame/GPS/link events with acceleration and stable ordering', async () => {
    vi.useFakeTimers();
    const replay = new ReplayTransport([
      { atMs: 1_000, kind: 'frame', frame: Uint8Array.of(0x88, 1) },
      { atMs: 0, kind: 'gps', fix: FIX },
      { atMs: 2_000, kind: 'drop' },
      { atMs: 3_000, kind: 'reconnect' },
      { atMs: 3_100, kind: 'frame', frame: Uint8Array.of(0x88, 2) },
    ], { speed: 2 });
    const timeline: string[] = [];
    replay.onGps(() => timeline.push('gps'));
    replay.onFrame((frame) => timeline.push(`frame-${frame[1]}`));
    replay.onState((state) => timeline.push(state));

    await replay.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(timeline).toContain('gps');
    await vi.advanceTimersByTimeAsync(500);
    expect(timeline).toContain('frame-1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timeline).toContain('disconnected');
    expect(timeline).toContain('reconnecting');
    expect(timeline).toContain('connected');
    await vi.advanceTimersByTimeAsync(50);
    expect(timeline.at(-1)).toBe('frame-2');
  });

  it('runs max speed in bounded asynchronous batches and completes', async () => {
    vi.useFakeTimers();
    const frames = Array.from({ length: 750 }, (_, index) => ({
      atMs: index,
      kind: 'frame' as const,
      frame: Uint8Array.of(0x88, index & 0xff),
    }));
    const replay = new ReplayTransport(frames, { speed: 'max' });
    let received = 0;
    let completed = false;
    replay.onFrame(() => { received += 1; });
    replay.onComplete(() => { completed = true; });
    await replay.connect();
    await vi.runAllTimersAsync();
    expect(received).toBe(750);
    expect(completed).toBe(true);
    expect(replay.isPlaying).toBe(false);
  });

  it('converts archive timestamps to a relative script without a session header', () => {
    const events = replayEventsFromArchive({
      fixes: [{ ...FIX, t: 5_000, posT: 5_000 }],
      receptions: [{ t: 5_500, frameHex: '880102' }, { t: 6_000, frameHex: 'not-hex' }],
    });
    expect(events.map((event) => [event.kind, event.atMs])).toEqual([
      ['gps', 0],
      ['frame', 500],
    ]);
  });
});
