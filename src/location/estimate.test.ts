import { describe, expect, it, vi } from 'vitest';
import type { CellAggregate } from '../types';
import { AreaEstimator, estimateArea } from './estimate';

function cell(
  key: string,
  lat: number,
  lon: number,
  overrides: Partial<CellAggregate> = {},
): CellAggregate {
  return {
    key,
    centerLat: lat,
    centerLon: lon,
    sizeM: 12,
    count: 2,
    medianRssi: -70,
    maxRssi: -68,
    madRssi: 2,
    medianSnr: 3,
    maxSnr: 4,
    medianGpsAcc: 5,
    passes: 3,
    octants: 3,
    firstT: 0,
    lastT: 1,
    minIdentityTier: 'full-pubkey',
    confidence: 0.8,
    ...overrides,
  };
}

describe('area estimate', () => {
  it('gates on confirmed sample and cell counts with honest reasons', () => {
    const noSamples = estimateArea([], { generatedAt: 1 });
    expect(noSamples).toMatchObject({ ready: false, sampleCount: 0, cellCount: 0 });
    expect(noSamples.reason).toContain('No provably direct');

    const tooFewCells = estimateArea([cell('a', 0, 0, { count: 5 })], { generatedAt: 1 });
    expect(tooFewCells).toMatchObject({ ready: false, sampleCount: 5, cellCount: 1 });
    expect(tooFewCells.reason).toContain('more places');
  });

  it('buffers the strongest cells into a hull and excludes a weak outlier', () => {
    const estimate = estimateArea(
      [
        cell('a', 0, 0, { medianRssi: -65 }),
        cell('b', 0, 0.001, { medianRssi: -67 }),
        cell('c', 0.001, 0, { medianRssi: -69 }),
        cell('outlier', 1, 1, { medianRssi: -90 }),
      ],
      { generatedAt: 123 },
    );
    expect(estimate).toMatchObject({
      ready: true,
      confidence: 'high',
      generatedAt: 123,
      strongest: { key: 'a' },
    });
    expect(estimate.cellsUsed).toEqual(['a', 'b', 'c']);
    expect(estimate.polygon?.length).toBeGreaterThanOrEqual(8);
    expect(estimate.areaM2).toBeGreaterThan(0);
    expect(estimate.reason).toContain('not an exact position');
  });

  it('uses a low-confidence disc when fewer than three strong cells survive', () => {
    const estimate = estimateArea([
      cell('a', 0, 0, { medianRssi: -60, count: 2 }),
      cell('b', 0, 0.001, { medianRssi: -80, count: 2 }),
      cell('c', 0.001, 0, { medianRssi: -90, count: 2 }),
    ]);
    expect(estimate).toMatchObject({ ready: true, confidence: 'low', cellsUsed: ['a'] });
    expect(estimate.polygon).toHaveLength(8);
  });

  it('debounces live updates for two seconds', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const estimator = new AreaEstimator({ generatedAt: 1 });
    estimator.subscribe(listener);
    estimator.update([cell('a', 0, 0)]);
    vi.advanceTimersByTime(1_999);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
