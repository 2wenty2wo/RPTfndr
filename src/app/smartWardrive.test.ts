import { describe, expect, it, vi } from 'vitest';

import { SmartWardriveScheduler } from './smartWardrive';

describe('SmartWardriveScheduler', () => {
  it('runs enabled work at bounded intervals and serialises discovery before observers', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new SmartWardriveScheduler({
      onDiscovery: async () => { calls.push('discovery'); },
      onObserverPoll: async () => { calls.push('observers'); },
      initialDiscoveryDelayMs: 1_000,
      initialObserverDelayMs: 1_000,
    });
    scheduler.start({
      enabled: true,
      autoDiscovery: true,
      discoveryIntervalMs: 1,
      observerAssist: true,
      observerPollIntervalMs: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(['discovery', 'observers']);
    expect(scheduler.snapshot()).toMatchObject({
      active: true,
      discoveryRuns: 1,
      observerPollRuns: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['discovery', 'observers', 'discovery']);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(calls.filter((call) => call === 'observers')).toHaveLength(2);
    scheduler.stop();
    vi.useRealTimers();
  });

  it('does no work while disabled and cancels pending work on stop', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => undefined);
    const scheduler = new SmartWardriveScheduler({
      onDiscovery: task,
      onObserverPoll: task,
      initialDiscoveryDelayMs: 0,
    });
    scheduler.start({
      enabled: false,
      autoDiscovery: true,
      discoveryIntervalMs: 60_000,
      observerAssist: false,
      observerPollIntervalMs: 300_000,
    });
    await vi.runAllTimersAsync();
    expect(task).not.toHaveBeenCalled();
    scheduler.start({
      enabled: true,
      autoDiscovery: true,
      discoveryIntervalMs: 60_000,
      observerAssist: false,
      observerPollIntervalMs: 300_000,
    });
    scheduler.stop('Page hidden.');
    await vi.runAllTimersAsync();
    expect(task).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toMatchObject({ active: false, reason: 'Page hidden.' });
    vi.useRealTimers();
  });

  it('does not let a rejected in-flight run mutate state after stop', async () => {
    vi.useFakeTimers();
    let rejectDiscovery!: (reason: unknown) => void;
    const discovery = new Promise<void>((_resolve, reject) => {
      rejectDiscovery = reject;
    });
    const observerPoll = vi.fn(async () => undefined);
    const scheduler = new SmartWardriveScheduler({
      onDiscovery: () => discovery,
      onObserverPoll: observerPoll,
      initialDiscoveryDelayMs: 0,
      initialObserverDelayMs: 0,
    });
    scheduler.start({
      enabled: true,
      autoDiscovery: true,
      discoveryIntervalMs: 60_000,
      observerAssist: true,
      observerPollIntervalMs: 300_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    scheduler.stop('Page hidden.');
    rejectDiscovery(new Error('stale discovery failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(observerPoll).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toMatchObject({
      active: false,
      reason: 'Page hidden.',
      nextDiscoveryAt: undefined,
      nextObserverPollAt: undefined,
      lastError: undefined,
    });
    vi.useRealTimers();
  });

  it('does not let a rejected old generation mutate or run work after restart', async () => {
    vi.useFakeTimers();
    let now = 0;
    let rejectDiscovery!: (reason: unknown) => void;
    const discovery = new Promise<void>((_resolve, reject) => {
      rejectDiscovery = reject;
    });
    const observerPoll = vi.fn(async () => undefined);
    const scheduler = new SmartWardriveScheduler({
      onDiscovery: () => discovery,
      onObserverPoll: observerPoll,
      now: () => now,
      initialDiscoveryDelayMs: 0,
      initialObserverDelayMs: 10,
    });
    scheduler.start({
      enabled: true,
      autoDiscovery: true,
      discoveryIntervalMs: 60_000,
      observerAssist: true,
      observerPollIntervalMs: 300_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    scheduler.start({
      enabled: true,
      autoDiscovery: false,
      discoveryIntervalMs: 60_000,
      observerAssist: true,
      observerPollIntervalMs: 300_000,
    });
    const restarted = scheduler.snapshot();
    now = 10;
    rejectDiscovery(new Error('old generation failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(observerPoll).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toEqual(restarted);
    scheduler.stop();
    vi.useRealTimers();
  });
});
