import type { AppState } from '../../app/store';
import { WORDING } from '../../app/wording';
import { escapeHtml } from '../components';

export function sessionDetailScreen(state: Readonly<AppState>, id: string | null): string {
  const session = state.sessions.find((item) => item.id === id) ?? state.activeSession;
  if (!session) return `<section class="screen"><div class="empty-state"><h1>Session not found</h1><p>The log may have been deleted or imported under another ID.</p><a class="button" href="#/sessions">Back to sessions</a></div></section>`;
  return `<section class="screen" aria-labelledby="session-title"><div class="screen-header"><div><span class="eyebrow">${WORDING.technicalLog}</span><h1 id="session-title">${escapeHtml(session.title)}</h1><p>${new Date(session.startedAt).toLocaleString()} · ${escapeHtml(session.mode)} mode</p></div>${session.demo ? '<span class="demo-stamp">SIMULATED DATA</span>' : ''}</div>
    <div class="grid three"><article class="card metric"><span>Receptions</span><strong>${session.counters.receptions}</strong></article><article class="card metric"><span>Confirmed direct</span><strong>${session.counters.confirmed}</strong></article><article class="card metric"><span>Located confirmed</span><strong>${session.counters.located}</strong></article></div>
    <article class="card stack" style="margin-top:.85rem"><h2>Export this log</h2><p>Exports state the classification and preserve raw frames. JSON archives include a displayed SHA-256 digest for integrity checking.</p><div class="button-group"><button class="button primary" data-action="export" data-kind="json" data-id="${escapeHtml(session.id)}">JSON + SHA-256</button><button class="button" data-action="export" data-kind="csv" data-id="${escapeHtml(session.id)}">CSV</button><button class="button" data-action="export" data-kind="geojson" data-id="${escapeHtml(session.id)}">GeoJSON</button><button class="button" data-action="export" data-kind="summary" data-id="${escapeHtml(session.id)}">Summary</button></div></article>
    <article class="card warning" style="margin-top:.85rem"><h2>Interpretation</h2><p>${WORDING.estimateBasis}</p></article>
    <button class="button danger" style="margin-top:.85rem" data-action="delete-session" data-id="${escapeHtml(session.id)}">Delete local session</button>
  </section>`;
}
