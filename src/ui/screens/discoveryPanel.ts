import type { AppState } from '../../app/store';
import { escapeHtml } from '../components';

export function discoveryPanelScreen(state: Readonly<AppState>): string {
  return `<section class="screen" aria-labelledby="discovery-title"><div class="screen-header"><div><span class="eyebrow">Two-second request window</span><h1 id="discovery-title">Target discovery</h1><p>A tagged MeshCore discovery request can help confirm a full public key. Forwarded responses remain excluded from location calculations.</p></div></div>
    <article class="card stack"><div class="row"><div><h2>${escapeHtml(state.activeSession?.targetSnapshot.label ?? state.activeTarget?.label ?? 'No target selected')}</h2><p>Responses are matched to the random request tag; uplink SNR is shown separately from the companion’s downlink observation.</p></div><span class="status-pill ${state.connection === 'connected' ? 'connected' : 'warning'}">${escapeHtml(state.connection)}</span></div><button class="button primary" data-action="discover" ${state.connection === 'connected' && state.activeSession ? '' : 'disabled'}>Discover for 2 seconds</button><p class="fine-print">Start a session first. Manual and automatic discovery share a 60-second minimum; a zero-path response can be confirmed, while a response with path length above zero remains forwarded.</p></article>
  </section>`;
}
