import type { AppState } from '../../app/store';
import { WORDING } from '../../app/wording';
import type { Reception } from '../../types';
import { emptyState, escapeHtml, formatAge, formatSignal } from '../components';

function className(reception: Reception): string {
  if (reception.cls.confirmed) return 'direct';
  if (reception.cls.kind === 'TARGET_ORIGIN_BUT_FORWARDED' || reception.cls.kind === 'TARGET_IN_PATH_BUT_NOT_IMMEDIATE') return 'forwarded';
  if (reception.cls.kind === 'AMBIGUOUS_PREFIX') return 'ambiguous';
  return 'unknown';
}

export function finderScreen(state: Readonly<AppState>): string {
  const target = state.activeSession?.targetSnapshot ?? state.activeTarget;
  if (!target) return `<section class="screen">${emptyState('Choose a target first', 'The finder cannot classify receptions until a target identity is selected.', 'go-target')}</section>`;
  const confirmed = state.receptions.filter((reception) => reception.cls.confirmed);
  const signal = state.signal;
  const percent = (signal?.strengthPercent ?? 0) * 100;
  const stale = !signal?.hasSignal || signal.stale;
  const recent = state.receptions.slice(-8).reverse();
  return `<section class="screen" aria-labelledby="finder-title">
    <div class="screen-header"><div><span class="eyebrow">Live relative signal</span><h1 id="finder-title">Finder</h1><p>${escapeHtml(target.label)} · only confirmed direct samples drive this gauge.</p></div><span class="status-pill ${state.connection === 'connected' ? 'connected' : 'warning'}">${escapeHtml(state.connection)}</span></div>
    ${state.activeSession?.demo ? '<div class="banner demo">SIMULATED DATA</div>' : ''}
    ${state.activeSession ? '' : `<article class="card accent stack"><h2>Start a search log</h2><p>Walk mode uses smaller map cells and heavier smoothing. Drive mode increases cell size and expects a passenger to operate the app.</p><div class="button-group"><button class="button primary" data-action="start-session" data-mode="walk">Start walk</button><button class="button" data-action="start-session" data-mode="drive">Start drive</button></div></article>`}
    <div class="finder-layout" style="margin-top:.85rem">
      <article class="card">
        <div class="signal-stage">
          <div class="gauge ${stale ? 'stale' : ''}" style="--pct:${percent / 100}" role="meter" aria-label="Confirmed relative signal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}">
            <div class="gauge-content"><strong class="gauge-value">${Math.round(percent)}</strong><span class="gauge-unit">relative %</span></div>
          </div>
        </div>
        <div class="grid three">
          <div class="metric"><span>Smoothed RSSI</span><strong>${formatSignal(signal?.rssi, 'dBm')}</strong></div>
          <div class="metric"><span>Smoothed SNR</span><strong>${formatSignal(signal?.snr, 'dB')}</strong></div>
          <div class="metric"><span>Last confirmed</span><strong>${signal?.t ? `${formatAge(signal.t)} ago` : '—'}</strong></div>
        </div>
        <div class="grid three compact-metrics"><div class="metric"><span>Session peak</span><strong>${formatSignal(signal?.sessionPeak?.rssi, 'dBm')}</strong></div><div class="metric"><span>Rolling 2 min peak</span><strong>${formatSignal(signal?.rollingPeak?.rssi, 'dBm')}</strong></div><div class="metric"><span>Confirmed samples</span><strong>${confirmed.length}</strong></div></div>
        <p class="fine-print ${stale ? 'warning-text' : ''}">${stale ? WORDING.staleSignal : WORDING.estimateBasis}</p>
        ${state.activeSession ? `<div class="button-group"><button class="button" data-action="mark">Mark location</button><a class="button" href="#/df">Take bearing</a><button class="button" data-action="calibrate-weak">Set current as weak</button><button class="button" data-action="calibrate-strong">Set current as strong</button><button class="button danger" data-action="end-session">End</button></div>` : ''}
      </article>
      <article class="card">
        <div class="row"><h2>Recent receptions</h2><span class="classification direct">${confirmed.length} confirmed</span></div>
        ${recent.length ? `<ul class="reception-list">${recent.map((reception) => {
          const kind = className(reception);
          return `<li class="reception ${kind}" title="${escapeHtml(reception.cls.explanation)}"><span class="reception-dot"></span><span><strong>${escapeHtml(reception.cls.kind.replaceAll('_', ' '))}</strong><small>${formatAge(reception.t)} ago · ${escapeHtml(reception.cls.explanation)}</small></span><strong>${reception.rssi} dBm</strong></li>`;
        }).join('')}</ul>` : emptyState('Listening for packets', 'Capture continues even without GPS. Unconfirmed packets will appear here but cannot influence the gauge.')}
      </article>
    </div>
  </section>`;
}
