import type { AppState } from '../../app/store';
import { escapeHtml } from '../components';

export function dfScreen(state: Readonly<AppState>): string {
  return `<section class="screen" aria-labelledby="df-title"><div class="screen-header"><div><span class="eyebrow">Directional finding</span><h1 id="df-title">Bearing notes</h1><p>Rotate or move the antenna, watch repeated confirmed samples, then record a human-observed bearing. Multipath can produce misleading peaks.</p></div></div>
    <div class="grid two">
      <form class="card stack" data-form="bearing">
        <h2>Record a bearing</h2>
        <label class="field"><span>Direction (degrees true)</span><input name="degrees" type="number" min="0" max="359" step="1" required inputmode="numeric" /></label>
        <label class="field"><span>Uncertainty (± degrees)</span><input name="uncertainty" type="number" min="1" max="90" value="20" required inputmode="numeric" /></label>
        <label class="field"><span>Note</span><input name="note" maxlength="120" placeholder="Antenna orientation / landmark" /></label>
        <button class="button primary" type="submit" ${state.activeSession ? '' : 'disabled'}>Save bearing with GPS</button>
      </form>
      <article class="card stack"><h2>Field method</h2><ol class="muted"><li>Stop safely and wait for several confirmed receptions.</li><li>Rotate slowly through a full circle, keeping antenna height consistent.</li><li>Repeat from another place; trust trends across passes, not a single peak.</li></ol><p class="warning-text">Do not interpret a bearing intersection as an exact transmitter location.</p><a class="button" href="#/map">View search area</a></article>
    </div>
    <p class="fine-print">Active target: ${escapeHtml(state.activeTarget?.label ?? 'none')}</p>
  </section>`;
}
