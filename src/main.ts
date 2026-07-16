import './styles.css';

import { AppController, type ExportKind } from './app/controller';
import { HashRouter, type Route } from './app/router';
import type { AppState } from './app/store';
import { FinderMap } from './map';
import { acknowledgementHtml, bindAcknowledgement } from './ui/ack';
import { downloadBlob, escapeHtml } from './ui/components';
import { navHtml } from './ui/nav';
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
} from './ui/screens';
import { applyTheme, type Theme, THEMES } from './ui/theme';
import type { GpsFix } from './types';

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('Application root is missing');
const root: HTMLDivElement = appRoot;

const controller = new AppController();
const router = new HashRouter();
const finderMap = new FinderMap();
const query = new URLSearchParams(location.search);
const e2e = query.get('e2e') === '1';
let route: Route = router.current();
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;

function screenHtml(state: Readonly<AppState>): string {
  switch (route.name) {
    case 'connect': return connectScreen(state);
    case 'target': return targetScreen(state);
    case 'finder': return finderScreen(state);
    case 'df': return dfScreen(state);
    case 'map': return mapScreen(state);
    case 'sessions': return sessionsScreen(state);
    case 'session': return sessionDetailScreen(state, route.params.get('id'));
    case 'discovery': return discoveryPanelScreen(state);
    case 'diagnostics': return diagnosticsScreen(state);
    case 'settings': return settingsScreen(state);
    case 'privacy': return privacyScreen();
    case 'compat': return compatibilityScreen();
  }
}

function noticesHtml(state: Readonly<AppState>): string {
  if (!state.notices.length) return '';
  return `<div class="toast-stack" role="status" aria-live="polite">${state.notices.map((notice) => `<div class="toast ${notice.kind}" data-notice="${escapeHtml(notice.id)}"><span>${escapeHtml(notice.message)}</span><span class="cluster">${notice.action ? `<button class="button small" data-action="notice-action" data-id="${escapeHtml(notice.id)}">${escapeHtml(notice.action.label)}</button>` : ''}<button class="button ghost small" data-action="dismiss-notice" data-id="${escapeHtml(notice.id)}" aria-label="Dismiss notification">×</button></span></div>`).join('')}</div>`;
}

function resumeHtml(state: Readonly<AppState>): string {
  const session = state.resumeCandidate;
  if (!session || !state.acknowledged) return '';
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="resume-title"><span class="eyebrow">Unfinished local log</span><h1 id="resume-title">Resume search session?</h1><p><strong>${escapeHtml(session.title)}</strong></p><p class="muted">${session.counters.receptions} receptions were safely stored. Resume rebuilds signal/cell state from append-only records; end closes the log without deleting it.</p><div class="button-group"><button class="button primary" data-action="resume-session" data-id="${escapeHtml(session.id)}">Resume</button><button class="button" data-action="end-resume" data-id="${escapeHtml(session.id)}">End session</button></div></section></div>`;
}

function render(state: Readonly<AppState>): void {
  const retainedMap = route.name === 'map' && state.mapAvailable && finderMap.mounted
    ? root.querySelector<HTMLElement>('#map')
    : null;
  retainedMap?.remove();
  if (!retainedMap) finderMap.destroy();
  const connected = state.connection === 'connected';
  const banners = [
    !state.writer ? '<div class="banner warning">Read-only: another tab owns the capture writer lock.</div>' : '',
    state.activeSession?.demo ? '<div class="banner demo">SIMULATED DATA · NEVER MIXED WITH REAL CAPTURE</div>' : '',
  ].join('');
  root.innerHTML = `<div class="app-shell">
    <header class="topbar"><a class="brand" href="#/connect"><span class="brand-mark" aria-hidden="true"></span><span>MeshCore Finder</span></a><div class="cluster"><span class="status-pill ${connected ? 'connected' : ''}">${connected ? escapeHtml(state.deviceName ?? 'connected') : escapeHtml(state.connection)}</span><a class="button ghost small" href="#/settings" aria-label="Settings">Settings</a></div></header>
    ${banners}
    <main id="main-content">${screenHtml(state)}</main>
    ${navHtml(route.name)}
    ${noticesHtml(state)}
    ${!state.acknowledged ? acknowledgementHtml() : ''}
    ${resumeHtml(state)}
  </div>`;
  bindAcknowledgement(root);
  if (route.name === 'map' && state.mapAvailable) {
    const element = root.querySelector<HTMLElement>('#map');
    if (element) {
      try {
        const target = state.activeSession?.targetSnapshot ?? state.activeTarget;
        if (retainedMap) {
          element.replaceWith(retainedMap);
          finderMap.update(
            state.receptions,
            state.estimate,
            state.events,
            target,
            state.bearingConsensus,
            state.finalApproach,
            state.observerEvidence,
            state.remoteObserverAnalysis,
            state.communityAssistedZone,
          );
          finderMap.invalidateSize();
        } else {
          finderMap.mount(
            element,
            state.receptions,
            state.estimate,
            state.events,
            target,
            state.showUntrustedAdminPosition,
            state.bearingConsensus,
            state.finalApproach,
            state.observerEvidence,
            state.remoteObserverAnalysis,
            state.communityAssistedZone,
          );
        }
      } catch (error) {
        controller.store.set({ mapAvailable: false });
        controller.notice('warning', error instanceof Error ? `Map unavailable: ${error.message}` : 'Map unavailable.');
      }
    }
  }
  if (route.name === 'diagnostics') void updateStorageUsage();
}

async function runAction(button: HTMLElement, action: string): Promise<void> {
  switch (action) {
    case 'acknowledge':
      await controller.acknowledge();
      break;
    case 'connect':
      try {
        await controller.connectReal();
      } catch (error) {
        if (!('bluetooth' in navigator)) router.navigate('compat');
        throw error;
      }
      break;
    case 'disconnect':
      await controller.disconnect();
      break;
    case 'poll-observers':
      await controller.queryObservers();
      break;
    case 'start-demo':
      await controller.startDemo('approach-and-pass');
      router.navigate('finder');
      break;
    case 'select-target':
      await controller.selectTarget(button.dataset.id ?? '');
      break;
    case 'pin-target':
      await controller.pinTarget(button.dataset.pubkey ?? '');
      break;
    case 'start-session':
      await controller.startSession(button.dataset.mode === 'drive' ? 'drive' : 'walk');
      break;
    case 'end-session':
      if (confirm('End this search session? The local log will remain available for export.')) await controller.endSession();
      break;
    case 'mark':
      await controller.addMark();
      break;
    case 'calibrate-weak':
      await controller.calibrateSignal('weak');
      break;
    case 'calibrate-strong':
      await controller.calibrateSignal('strong');
      break;
    case 'go-target':
      router.navigate('target');
      break;
    case 'go-finder':
      router.navigate('finder');
      break;
    case 'discover':
      await controller.discover();
      break;
    case 'resume-session':
      await controller.resumeSession(button.dataset.id ?? '');
      router.navigate('finder');
      break;
    case 'end-resume':
      await controller.endResumeCandidate(button.dataset.id ?? '');
      break;
    case 'export': {
      const artifact = await controller.exportSession(button.dataset.id ?? '', button.dataset.kind as ExportKind);
      downloadBlob(artifact.name, artifact.blob);
      controller.notice('success', artifact.digest ? `JSON exported · SHA-256 ${artifact.digest}` : `${artifact.name} exported.`);
      break;
    }
    case 'import':
      importArchiveFromPicker();
      break;
    case 'delete-session':
      if (confirm('Permanently delete this local session and its receptions, fixes, and events?')) {
        await controller.deleteSession(button.dataset.id ?? '');
        router.navigate('sessions');
      }
      break;
    case 'delete-all':
      if (confirm('Delete ALL MeshCore Finder data from this browser? This cannot be undone.')) {
        await controller.deleteAll();
        router.navigate('connect');
      }
      break;
    case 'refresh-storage':
      await updateStorageUsage();
      break;
    case 'debug-export':
      await exportDebugBundle();
      break;
    case 'dismiss-notice':
      controller.dismissNotice(button.dataset.id ?? '');
      break;
    case 'notice-action': {
      const notice = controller.store.value.notices.find((item) => item.id === button.dataset.id);
      notice?.action?.run();
      controller.dismissNotice(button.dataset.id ?? '');
      break;
    }
    case 'apply-update':
      await updateServiceWorker?.(true);
      break;
    case 'toggle-observer':
      await controller.setObserverEnabled(button.dataset.id ?? '', button.dataset.enabled === 'true');
      break;
    case 'delete-observer':
      await controller.deleteObserver(button.dataset.id ?? '');
      break;
    case 'review-observer-candidate':
      await controller.reviewObserverCandidate(button.dataset.id ?? '');
      break;
    case 'authorise-observer-candidate':
      await controller.authoriseObserverCandidate(button.dataset.id ?? '');
      break;
    case 'toggle-observer-candidate-assist':
      await controller.setObserverCandidateAssist(button.dataset.id ?? '', button.dataset.enabled === 'true');
      break;
    case 'copy-observer-candidate': {
      controller.notice('info', 'Candidate public key copied. Enter independently verified coordinates before saving.');
      const form = root.querySelector<HTMLFormElement>('[data-form="observer"]');
      const pubkey = form?.querySelector<HTMLInputElement>('[name="pubkey"]');
      if (pubkey) pubkey.value = button.dataset.pubkey ?? '';
      const label = form?.querySelector<HTMLInputElement>('[name="label"]');
      if (label) label.value = button.dataset.label ?? '';
      form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    }
  }
}

root.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (!action) return;
  event.preventDefault();
  void runAction(button, action).catch((error: unknown) => {
    controller.notice('error', error instanceof Error ? error.message : String(error));
  });
});

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  void (async () => {
    if (form.dataset.form === 'target') {
      await controller.saveTarget(String(data.get('label') ?? ''), String(data.get('identity') ?? ''), String(data.get('notes') ?? ''));
      form.reset();
      controller.notice('success', 'Target saved and selected.');
    } else if (form.dataset.form === 'bearing') {
      await controller.addBearing(Number(data.get('degrees')), Number(data.get('uncertainty')), String(data.get('note') ?? ''));
    } else if (form.dataset.form === 'settings') {
      const themeValue = String(data.get('theme'));
      if (THEMES.includes(themeValue as Theme)) applyTheme(themeValue as Theme);
      await controller.saveSettings({
        audioMode: String(data.get('audioMode')) as 'chime' | 'tone' | 'geiger' | 'off',
        audioVolume: Number(data.get('audioVolume')),
        audioMuted: data.get('audioMuted') === 'on',
        forwardedAlert: data.get('forwardedAlert') === 'on',
        cellSizeM: Number(data.get('cellSizeM')),
        minSamples: Number(data.get('minSamples')),
        minCells: Number(data.get('minCells')),
        smoothingWindow: Number(data.get('smoothingWindow')),
        emaAlpha: Number(data.get('emaAlpha')),
        maxGpsAccuracyM: Number(data.get('maxGpsAccuracyM')),
        smartWardriveEnabled: data.get('smartWardriveEnabled') === 'on',
        autoDiscoveryEnabled: data.get('autoDiscoveryEnabled') === 'on',
        autoDiscoveryIntervalSec: Number(data.get('autoDiscoveryIntervalSec')),
        observerAssistEnabled: data.get('observerAssistEnabled') === 'on',
        observerPollIntervalMin: Number(data.get('observerPollIntervalMin')),
      }, data.get('showUntrustedAdminPosition') === 'on');
    } else if (form.dataset.form === 'observer') {
      await controller.saveObserver({
        label: String(data.get('label') ?? ''),
        repeaterPubkeyHex: String(data.get('pubkey') ?? ''),
        lat: Number(data.get('lat')),
        lon: Number(data.get('lon')),
        accuracyM: Number(data.get('accuracyM')),
        verification: String(data.get('verification')) as 'user-surveyed' | 'operator-confirmed',
        permissionConfirmed: data.get('permissionConfirmed') === 'on',
      });
      form.reset();
    }
  })().catch((error: unknown) => controller.notice('error', error instanceof Error ? error.message : String(error)));
});

function importArchiveFromPicker(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json,application/vnd.meshcore-finder.session+json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text()
      .then((text) => controller.importArchive(text))
      .catch((error: unknown) => controller.notice('error', error instanceof Error ? error.message : String(error)));
  }, { once: true });
  input.click();
}

async function updateStorageUsage(): Promise<void> {
  const output = root.querySelector<HTMLElement>('#storage-usage');
  if (!output) return;
  const estimate = await controller.storageEstimate();
  if (!estimate?.quota) {
    output.textContent = 'Storage quota details are unavailable in this browser.';
    return;
  }
  const used = estimate.usage ?? 0;
  const mib = (value: number): string => `${(value / 1024 / 1024).toFixed(1)} MiB`;
  output.textContent = `${mib(used)} used of approximately ${mib(estimate.quota)} (${((used / estimate.quota) * 100).toFixed(1)}%).`;
}

async function exportDebugBundle(): Promise<void> {
  const session = controller.store.value.activeSession ?? controller.store.value.sessions[0];
  if (session) {
    const artifact = await controller.exportSession(session.id, 'json');
    downloadBlob(artifact.name.replace('.json', '-debug.json'), artifact.blob);
    controller.notice('success', `Debug archive exported · SHA-256 ${artifact.digest ?? 'unavailable'}`);
    return;
  }
  const payload = JSON.stringify({
    generatedAt: new Date().toISOString(),
    connection: controller.store.value.connection,
    gps: controller.store.value.gpsState,
    userAgent: navigator.userAgent,
    note: 'No session records were available.',
  }, null, 2);
  downloadBlob('meshcore-finder-debug.json', new Blob([payload], { type: 'application/json' }));
}

const ready = controller.init().then(() => {
  if (!('bluetooth' in navigator) && !e2e && route.name === 'connect') router.navigate('compat');
}).catch((error: unknown) => {
  root.innerHTML = `<main class="boot"><section class="card danger"><h1>Unable to open MeshCore Finder</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><button class="button" onclick="location.reload()">Try again</button></section></main>`;
  throw error;
});

controller.store.subscribe((state) => render(state));
router.start((next) => {
  route = next;
  controller.store.set({ route: next.name });
});

if (e2e) {
  window.__finderTest = {
    ready,
    acknowledge: () => controller.acknowledge(),
    connectMock: () => controller.connectMock(),
    injectFrame: (frame) => controller.injectMockFrame(frame),
    injectGps: (fix: Omit<GpsFix, 'sessionId' | 'acceptedNum'>) => controller.injectGps(fix),
    addBearing: (bearingDeg: number, accuracyDeg: number, note?: string) => controller.addBearing(bearingDeg, accuracyDeg, note),
    injectObserverEvidence: (evidence) => controller.injectObserverEvidenceForTest(evidence),
    dropConnection: () => controller.dropMockConnection(),
    restoreConnection: () => controller.restoreMockConnection(),
    receptions: () => controller.store.value.receptions,
    finalApproach: () => controller.store.value.finalApproach,
    communityAssistedZone: () => controller.store.value.communityAssistedZone,
    activeTarget: () => controller.store.value.activeTarget,
    clear: () => controller.deleteAll(),
  };
}

if (!query.has('nosw') && 'serviceWorker' in navigator) {
  void import('virtual:pwa-register').then(({ registerSW }) => {
    updateServiceWorker = registerSW({
      immediate: false,
      onNeedRefresh: () => controller.notice('info', 'An app update is ready.', { label: 'Update', run: () => { void updateServiceWorker?.(true); } }),
      onOfflineReady: () => controller.notice('success', 'App shell is ready for offline use.'),
      onRegisterError: (error: unknown) => controller.notice('warning', `Offline support could not start: ${String(error)}`),
    });
  });
}

addEventListener('pagehide', () => { void controller.destroy(); }, { once: true });
