import type { AppState } from '../../app/store';
import { WORDING } from '../../app/wording';
import { escapeHtml } from '../components';

function formatArea(areaM2: number | undefined): string {
  if (areaM2 === undefined || !Number.isFinite(areaM2)) return '—';
  if (areaM2 >= 1_000_000) return `${(areaM2 / 1_000_000).toFixed(2)} km²`;
  return `${Math.round(areaM2).toLocaleString()} m²`;
}

export function mapScreen(state: Readonly<AppState>): string {
  const estimate = state.estimate;
  const cells = [...state.cells].sort((left, right) => right.medianRssi - left.medianRssi);
  return `<section class="screen" aria-labelledby="map-title"><div class="screen-header"><div><span class="eyebrow">Relative-signal aggregation</span><h1 id="map-title">${WORDING.estimateTitle}</h1><p>${WORDING.estimateBasis}</p></div></div>
    <div class="map-wrap">${state.mapAvailable ? '<div id="map" class="map-canvas" aria-label="Search observations map"></div>' : '<div class="empty-state"><h2>Map unavailable</h2><p>The signal gauge, cell table, and exports still work without map tiles.</p></div>'}
      <div class="map-overlay"><div class="row"><div><strong>${estimate?.ready ? `${escapeHtml(estimate.confidence)} confidence` : 'Collecting samples'}</strong><div class="fine-print">${escapeHtml(estimate?.reason ?? WORDING.morePasses)}</div></div><div class="cluster"><div class="metric"><span>Samples / cells</span><strong>${estimate?.sampleCount ?? 0} / ${estimate?.cellCount ?? 0}</strong></div><div class="metric"><span>Estimated area</span><strong>${formatArea(estimate?.areaM2)}</strong></div></div></div></div>
    </div>
    <div class="legend" style="margin-top:.8rem"><span style="color:var(--accent)">Confirmed direct</span><span style="color:var(--forwarded)">Forwarded</span><span style="color:var(--ambiguous)">Ambiguous</span><span>Unconfirmed</span></div>
    <article class="card stack" style="margin-top:.8rem"><div class="row"><div><h2>Confirmed signal cells</h2><p class="fine-print">Derived locally from confirmed, fresh-GPS receptions. Stronger median RSSI sorts first.</p></div><span class="status-pill">${cells.length} cells</span></div>${cells.length ? `<div class="table-wrap"><table><thead><tr><th>Cell</th><th>Samples</th><th>Median RSSI</th><th>Peak</th><th>GPS accuracy</th><th>Confidence</th></tr></thead><tbody>${cells.slice(0, 50).map((cell) => `<tr><td class="code">${escapeHtml(cell.key)}</td><td>${cell.count}</td><td>${cell.medianRssi.toFixed(1)} dBm</td><td>${cell.maxRssi.toFixed(1)} dBm</td><td>${cell.medianGpsAcc.toFixed(0)} m</td><td>${Math.round(cell.confidence * 100)}%</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No confirmed located cells yet. Capture continues without a map or GPS.</p>'}</article>
    <article class="card warning" style="margin-top:.8rem"><strong>Offline map note</strong><p>Previously viewed map tiles may remain cached for up to 7 days (maximum 300). A blank basemap never stops local capture or exports.</p></article>
  </section>`;
}
