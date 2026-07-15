import type { AppState } from '../../app/store';
import { emptyState, escapeHtml } from '../components';

export function sessionsScreen(state: Readonly<AppState>): string {
  const sessions = [...state.sessions].sort((a, b) => b.createdAt - a.createdAt);
  return `<section class="screen" aria-labelledby="sessions-title"><div class="screen-header"><div><span class="eyebrow">On-device logs</span><h1 id="sessions-title">Search sessions</h1><p>Sessions remain in this browser until you export or delete them.</p></div><button class="button small" data-action="import">Import</button></div>
    <div class="stack">${sessions.length ? sessions.map((session) => `<a class="card session-item" href="#/session?id=${encodeURIComponent(session.id)}"><span class="row"><strong>${escapeHtml(session.title)}</strong>${session.demo ? '<span class="demo-stamp">SIMULATED</span>' : `<span class="status-pill ${session.state === 'active' ? 'connected' : ''}">${session.state}</span>`}</span><span class="muted">${new Date(session.startedAt).toLocaleString()} · ${session.counters.receptions} receptions · ${session.counters.confirmed} confirmed</span></a>`).join('') : emptyState('No search sessions yet', 'Choose a target and start a walk or drive session. Demo sessions are stored separately and clearly labelled.', 'go-finder')}</div>
  </section>`;
}
