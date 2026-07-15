import { describe, expect, it } from 'vitest';
import { initialAppState, type AppState } from '../../app/store';
import type { TargetProfile } from '../../types';
import {
  compatibilityScreen,
  connectScreen,
  dfScreen,
  diagnosticsScreen,
  discoveryPanelScreen,
  finderScreen,
  mapScreen,
  privacyScreen,
  sessionDetailScreen,
  sessionsScreen,
  settingsScreen,
  targetScreen,
} from './index';

const target: TargetProfile = {
  id: 'target-screen',
  label: 'Screen target',
  identity: { kind: 'node-id', bytesHex: 'a1b2c3d4' },
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
};

describe('screen rendering', () => {
  it('renders every route with empty and selected-target states', () => {
    const empty: Readonly<AppState> = { ...initialAppState, ready: true };
    const selected: Readonly<AppState> = { ...empty, targets: [target], activeTarget: target };
    const outputs = [
      connectScreen(empty),
      targetScreen(selected),
      finderScreen(selected),
      dfScreen(selected),
      mapScreen(selected),
      sessionsScreen(empty),
      sessionDetailScreen(empty, 'missing'),
      discoveryPanelScreen(selected),
      diagnosticsScreen(empty),
      settingsScreen(empty),
      privacyScreen(),
      compatibilityScreen(),
    ];
    for (const output of outputs) {
      expect(output.length).toBeGreaterThan(100);
      expect(output).not.toContain('undefined');
    }
  });

  it('uses approximate-zone wording without precision claims', () => {
    const output = `${mapScreen(initialAppState)}${privacyScreen()}${dfScreen(initialAppState)}`;
    expect(output).toContain('approximate search area');
    expect(output).toContain("single receiver's RSSI and SNR cannot determine coordinates");
    expect(output.toLowerCase()).not.toMatch(/\b(exact|pinpoint(?:ed)?)\b/);
  });

  it('reflects persisted audio preferences in the settings controls', () => {
    const state: Readonly<AppState> = {
      ...initialAppState,
      preferences: {
        ...initialAppState.preferences,
        audioMode: 'geiger',
        audioVolume: 0.45,
        audioMuted: true,
        forwardedAlert: true,
      },
    };
    const output = settingsScreen(state);
    expect(output).toContain('value="geiger" selected');
    expect(output).toContain('name="audioVolume"');
    expect(output).toContain('value="0.45"');
    expect(output).toContain('name="audioMuted" type="checkbox" checked');
    expect(output).toContain('name="forwardedAlert" type="checkbox" checked');
    expect(output).toContain('name="showUntrustedAdminPosition" type="checkbox"');
    expect(output).not.toContain('name="showUntrustedAdminPosition" type="checkbox" checked');
  });

  it('offers a name-only pin only when one observed contact has that name', () => {
    const nameOnly: TargetProfile = {
      ...target,
      id: 'name-only',
      label: 'Hill repeater',
      identity: { kind: 'name-only', name: 'Hill repeater' },
    };
    const firstKey = '11'.repeat(32);
    const secondKey = '22'.repeat(32);
    const firstContact: TargetProfile = {
      ...target,
      id: 'first-contact',
      label: 'Hill repeater',
      identity: { kind: 'full-pubkey', pubkeyHex: firstKey },
      source: 'contacts',
    };
    const unique = targetScreen({
      ...initialAppState,
      targets: [nameOnly, firstContact],
      activeTarget: nameOnly,
    });
    expect(unique).toContain(`data-pubkey="${firstKey}"`);

    const ambiguous = targetScreen({
      ...initialAppState,
      targets: [
        nameOnly,
        firstContact,
        { ...firstContact, id: 'second-contact', identity: { kind: 'full-pubkey', pubkeyHex: secondKey } },
      ],
      activeTarget: nameOnly,
    });
    expect(ambiguous).not.toContain(`data-pubkey="${firstKey}"`);
    expect(ambiguous).not.toContain(`data-pubkey="${secondKey}"`);
  });

  it('shows estimate area and a map-free cell table contract', () => {
    const output = mapScreen({
      ...initialAppState,
      mapAvailable: false,
      estimate: {
        ready: true,
        reason: 'Enough passes',
        sampleCount: 7,
        cellCount: 3,
        areaM2: 1_234,
        confidence: 'medium',
        generatedAt: 1,
      },
    });
    expect(output).toContain('1,234 m²');
    expect(output).toContain('Confirmed signal cells');
    expect(output).toContain('Enough passes');
  });
});
