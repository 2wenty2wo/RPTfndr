import type { AppState } from '../../app/store';
import { observationFromBearingEvent } from '../../location';
import { escapeHtml } from '../components';

function formatArea(areaM2: number | undefined): string {
  if (areaM2 === undefined || !Number.isFinite(areaM2)) return 'Not available';
  return areaM2 >= 1_000_000
    ? `${(areaM2 / 1_000_000).toFixed(2)} km²`
    : `${Math.round(areaM2).toLocaleString()} m²`;
}

export function dfScreen(state: Readonly<AppState>): string {
  const observations = state.events
    .map(observationFromBearingEvent)
    .filter((observation): observation is NonNullable<typeof observation> => observation !== undefined);
  const analysis = state.bearingAnalysis;
  const consensus = state.bearingConsensus;
  const finalApproach = state.finalApproach;
  const exclusions = analysis?.exclusions ?? [];
  const statusClass = finalApproach?.ready
    ? 'good'
    : finalApproach?.disagreement
      ? 'warning'
      : '';
  const status = finalApproach?.ready
    ? 'Approximate zone ready'
    : finalApproach?.disagreement
      ? 'Inputs disagree'
      : 'Collecting evidence';

  return `<section class="screen" aria-labelledby="df-title"><div class="screen-header"><div><span class="eyebrow">Directional finding</span><h1 id="df-title">Final approach</h1><p>Combine manual true bearings from a directional antenna with the confirmed-signal search area. The result is a shaded approximate zone, never a transmitter marker.</p></div><span class="status-pill ${statusClass}">${status}</span></div>
    <div class="grid two">
      <form class="card stack" data-form="bearing">
        <h2>Record a directional bearing</h2>
        <label class="field"><span>Direction (degrees true)</span><input name="degrees" type="number" min="0" max="359" step="1" required inputmode="numeric" /></label>
        <label class="field"><span>Angular uncertainty (± degrees)</span><input name="uncertainty" type="number" min="1" max="90" value="20" required inputmode="numeric" /></label>
        <label class="field"><span>Note</span><input name="note" maxlength="120" placeholder="Antenna orientation / landmark" /></label>
        <button class="button primary" type="submit" ${state.activeSession ? '' : 'disabled'}>Save bearing with phone GPS</button>
        <p class="fine-print">Eligibility requires an accepted phone fix no more than 15 seconds old and a confirmed target reception no more than 30 seconds old. GPS accuracy is saved with the observation.</p>
      </form>
      <article class="card stack">
        <div class="row"><div><h2>Approximate zone status</h2><p class="muted">${escapeHtml(finalApproach?.reason ?? 'Record bearings during an active search session.')}</p></div><span class="status-pill ${statusClass}">${analysis?.eligibleObservationCount ?? 0} eligible</span></div>
        <div class="cluster"><div class="metric"><span>Contributing bearings</span><strong>${finalApproach?.bearingCount ?? 0}</strong></div><div class="metric"><span>Confirmed signal cells</span><strong>${finalApproach?.signalCellCount ?? state.estimate?.cellCount ?? 0}</strong></div><div class="metric"><span>Approximate area</span><strong>${formatArea(finalApproach?.areaM2)}</strong></div></div>
        ${consensus ? `<p class="fine-print">Bearing geometry: ${escapeHtml(consensus.geometryQuality)} · ${Math.round(consensus.radiusM)} m uncertainty radius · ${consensus.rmsCrossTrackErrorM.toFixed(1)} m RMS cross-track error.</p>` : '<p class="fine-print">At least two eligible bearings from separated locations are required; three or more are strongly recommended.</p>'}
        ${finalApproach?.disagreement ? '<p class="warning-text"><strong>Disagreement:</strong> the directional-bearing zone does not overlap the confirmed-signal search area. Recheck antenna direction, multipath, and GPS, then collect another pass.</p>' : ''}
        ${!consensus && state.estimate?.ready ? '<p class="muted">Directional bearings are not ready. Continue using the RSSI-only strongest confirmed search area as lower-precision proximity guidance.</p>' : ''}
        <a class="button" href="#/map">View shaded zones</a>
      </article>
    </div>
    <div class="grid two" style="margin-top:.85rem">
      <article class="card stack"><h2>Bearing observations</h2>${observations.length ? observations.map((observation) => `<div class="row"><div><strong>${observation.bearingDeg.toFixed(0)}° ±${(observation.accuracyDeg ?? 10).toFixed(0)}°</strong><p class="fine-print">GPS ±${observation.gpsAccuracyM?.toFixed(0) ?? '?'} m · ${escapeHtml(observation.note ?? 'No note')}</p></div><span class="code">${escapeHtml(String(observation.id ?? new Date(observation.t).toISOString()))}</span></div>`).join('') : '<p class="muted">No bearings recorded in this session.</p>'}</article>
      <article class="card stack"><h2>Excluded geometry</h2>${exclusions.length ? `<ul class="muted">${exclusions.map((item) => `<li><strong>${escapeHtml(item.reason.replaceAll('-', ' '))}:</strong> ${escapeHtml(item.detail)}</li>`).join('')}</ul>` : '<p class="muted">No bearing exclusions recorded.</p>'}<h2>Field method</h2><ol class="muted"><li>Stop safely and wait for repeated confirmed target receptions.</li><li>Rotate slowly through a full circle and record the strongest repeatable direction.</li><li>Move at least 20 metres—farther when phone GPS is poor—and repeat from a different angle.</li><li>Use the shaded overlap only to guide close-range searching; physically and visually verify the equipment.</li></ol></article>
    </div>
    <p class="fine-print">Active target: ${escapeHtml(state.activeTarget?.label ?? 'none')}</p>
  </section>`;
}
