import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_SETTINGS } from '../types';
import { resolveSessionSettings } from './controller';

describe('session mode settings', () => {
  it('retains drive presets when persisted values are unchanged walk defaults', () => {
    const settings = resolveSessionSettings('drive', { ...DEFAULT_SESSION_SETTINGS });
    expect(settings).toMatchObject({ cellSizeM: 45, smoothingWindow: 5, emaAlpha: 0.4 });
  });

  it('honours valid custom aggregation values while enforcing the drive cell minimum', () => {
    const settings = resolveSessionSettings('drive', {
      ...DEFAULT_SESSION_SETTINGS,
      cellSizeM: 35,
      smoothingWindow: 9,
      emaAlpha: 0.5,
    });
    expect(settings).toMatchObject({ cellSizeM: 35, smoothingWindow: 9, emaAlpha: 0.5 });
  });
});
