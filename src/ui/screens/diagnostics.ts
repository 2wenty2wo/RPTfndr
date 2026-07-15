import type { AppState } from '../../app/store';
import { APP_COMMIT, APP_VERSION, DECODER_VERSION } from '../../app/version';
import { escapeHtml } from '../components';

export function diagnosticsScreen(state: Readonly<AppState>): string {
  const device = state.device;
  return `<section class="screen" aria-labelledby="diagnostics-title"><div class="screen-header"><div><span class="eyebrow">Local diagnostics</span><h1 id="diagnostics-title">Diagnostics</h1><p>Use this page during Bluefy field testing. Debug exports may contain raw packet and coarse location data; inspect before sharing.</p></div></div>
    <div class="grid two"><article class="card stack"><h2>Runtime</h2><div class="row"><span>App</span><span class="code">${escapeHtml(APP_VERSION)} (${escapeHtml(APP_COMMIT)})</span></div><div class="row"><span>Decoder</span><span class="code">${DECODER_VERSION}</span></div><div class="row"><span>Connection</span><span>${escapeHtml(state.connection)}</span></div><div class="row"><span>GPS</span><span>${escapeHtml(state.gpsState)}</span></div><div class="row"><span>Writer lock</span><span>${state.writer ? 'held' : 'read-only'}</span></div></article>
    <article class="card stack"><h2>Companion</h2><div class="row"><span>Model</span><span>${escapeHtml(device?.model ?? state.deviceName ?? 'not connected')}</span></div><div class="row"><span>Public key</span><span class="code">${escapeHtml(device?.pubkeyHex ?? '—')}</span></div><div class="row"><span>Firmware</span><span class="code">${device?.fwVer ?? '—'}${device?.fwBuild ? ` · ${escapeHtml(device.fwBuild)}` : ''}</span></div><div class="row"><span>Battery</span><span>${device?.battMv ? `${device.battMv} mV` : '—'}</span></div></article>
    <article class="card stack"><h2>Local storage</h2><p id="storage-usage">Checking browser quota…</p><button class="button" data-action="refresh-storage">Refresh usage</button><button class="button" data-action="debug-export">Create debug bundle</button></article></div>
    <article class="card danger" style="margin-top:.85rem"><h2>Delete all local data</h2><p>Export anything you want to keep. This removes targets, sessions, receptions, fixes, events, settings, and stored photos from this browser.</p><button class="button danger" data-action="delete-all">Delete all local data</button></article>
  </section>`;
}
