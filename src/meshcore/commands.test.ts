import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CommandCancelledError,
  CommandQueue,
  CommandTimeoutError,
  contactsStreamMatcher,
  opcodeMatcher,
} from './commands';

afterEach(() => vi.useRealTimers());

describe('CommandQueue', () => {
  it('allows exactly one in-flight command and advances on a matching response', async () => {
    const writes: number[] = [];
    const queue = new CommandQueue(async (command) => {
      writes.push(command[0] ?? -1);
    });

    const first = queue.send(Uint8Array.of(0x01), opcodeMatcher(0x05), { label: 'start' });
    const second = queue.send(Uint8Array.of(0x16), opcodeMatcher(0x0d), { label: 'query' });
    await vi.waitFor(() => expect(writes).toEqual([0x01]));
    expect(queue.state()).toMatchObject({ activeLabel: 'start', queued: 1 });

    queue.handleFrame(Uint8Array.of(0x05, 1));
    await expect(first).resolves.toEqual([Uint8Array.of(0x05, 1)]);
    await vi.waitFor(() => expect(writes).toEqual([0x01, 0x16]));
    queue.handleFrame(Uint8Array.of(0x0d, 7));
    await expect(second).resolves.toHaveLength(1);
    expect(queue.state()).toMatchObject({ queued: 0, matchedFrames: 0 });
  });

  it('collects a multi-frame contacts response and passes unrelated pushes through', async () => {
    const pushes: number[] = [];
    const queue = new CommandQueue(async () => undefined);
    queue.onPush((frame) => pushes.push(frame[0] ?? -1));
    const response = queue.send(Uint8Array.of(0x04), contactsStreamMatcher(), { label: 'contacts' });
    await Promise.resolve();

    queue.handleFrame(Uint8Array.of(0x0c, 0xef, 0x0f));
    queue.handleFrame(Uint8Array.of(0x02));
    queue.handleFrame(Uint8Array.of(0x03, 1));
    queue.handleFrame(Uint8Array.of(0x03, 2));
    queue.handleFrame(Uint8Array.of(0x04, 9, 0, 0, 0));

    await expect(response).resolves.toEqual([
      Uint8Array.of(0x02),
      Uint8Array.of(0x03, 1),
      Uint8Array.of(0x03, 2),
      Uint8Array.of(0x04, 9, 0, 0, 0),
    ]);
    expect(pushes).toEqual([0x0c]);
  });

  it('times out a stalled command and clears the queue for the next write', async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const queue = new CommandQueue(async (command) => {
      writes.push(command[0] ?? -1);
    });
    const stalled = queue.send(Uint8Array.of(1), opcodeMatcher(5), {
      label: 'stalled',
      timeoutMs: 50,
    });
    const next = queue.send(Uint8Array.of(2), null, { label: 'fire-and-forget' });
    const rejection = expect(stalled).rejects.toBeInstanceOf(CommandTimeoutError);
    await vi.advanceTimersByTimeAsync(51);
    await rejection;
    await expect(next).resolves.toEqual([]);
    expect(writes).toEqual([1, 2]);
  });

  it('rejects active and queued work on cancellation', async () => {
    const queue = new CommandQueue(async () => undefined);
    const first = queue.send(Uint8Array.of(1), opcodeMatcher(5), { label: 'first' });
    const second = queue.send(Uint8Array.of(2), opcodeMatcher(6), { label: 'second' });
    const firstRejection = expect(first).rejects.toBeInstanceOf(CommandCancelledError);
    const secondRejection = expect(second).rejects.toBeInstanceOf(CommandCancelledError);
    queue.cancelAll();
    await firstRejection;
    await secondRejection;
  });

  it('removes an individually aborted queued command before it can write', async () => {
    const writes: number[] = [];
    const queue = new CommandQueue(async (command) => {
      writes.push(command[0] ?? -1);
    });
    const first = queue.send(Uint8Array.of(1), opcodeMatcher(5), { label: 'first' });
    const controller = new AbortController();
    const queued = queue.send(Uint8Array.of(2), null, {
      label: 'guest queued',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(writes).toEqual([1]));

    controller.abort(new Error('guest poll stopped'));
    await expect(queued).rejects.toMatchObject({
      name: 'CommandCancelledError',
      message: 'guest poll stopped',
    });
    queue.handleFrame(Uint8Array.of(5));
    await expect(first).resolves.toHaveLength(1);
    await Promise.resolve();
    expect(writes).toEqual([1]);
  });

  it('does not overlap writes when an active command is aborted mid-write', async () => {
    const writes: number[] = [];
    let finishFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      finishFirstWrite = resolve;
    });
    const queue = new CommandQueue(async (command) => {
      writes.push(command[0] ?? -1);
      if (command[0] === 1) await firstWrite;
    });
    const controller = new AbortController();
    const active = queue.send(Uint8Array.of(1), null, {
      label: 'guest active',
      signal: controller.signal,
    });
    const next = queue.send(Uint8Array.of(2), null, { label: 'next' });
    await vi.waitFor(() => expect(writes).toEqual([1]));

    controller.abort('stop active guest command');
    await expect(active).rejects.toBeInstanceOf(CommandCancelledError);
    expect(writes).toEqual([1]);

    finishFirstWrite();
    await expect(next).resolves.toEqual([]);
    expect(writes).toEqual([1, 2]);
  });

  it('does not lose a synchronous response emitted during write', async () => {
    // A deferred assignment is required because the write callback intentionally
    // re-enters the queue synchronously during construction.
    let queue!: CommandQueue;
    // eslint-disable-next-line prefer-const
    queue = new CommandQueue(async () => {
      queue.handleFrame(Uint8Array.of(0x05));
    });
    await expect(queue.send(Uint8Array.of(1), opcodeMatcher(5), { label: 'sync' })).resolves.toHaveLength(1);
  });
});
