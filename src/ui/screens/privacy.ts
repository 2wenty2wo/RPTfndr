import { WORDING } from '../../app/wording';

export function privacyScreen(): string {
  return `<section class="screen" aria-labelledby="privacy-title"><div class="screen-header"><div><span class="eyebrow">Local-first by design</span><h1 id="privacy-title">Privacy and safety</h1><p>No account, analytics, or application backend. Your browser communicates directly with the companion and stores logs in IndexedDB.</p></div></div>
    <div class="grid two"><article class="card"><h2>What stays local</h2><p>Targets, raw frames, classifications, location fixes, notes, bearings, session metadata, and generated estimates stay on this device. Those local records leave only through an export you initiate.</p></article><article class="card"><h2>Network requests</h2><p>When the map is open, the browser requests raster tiles from OpenStreetMap. Up to 300 viewed tiles may be cached for 7 days. Tile coordinates reveal the viewed area to that service; capture works without it.</p></article><article class="card warning"><h2>${WORDING.safetyTitle}</h2><p>${WORDING.safetyBody}</p></article><article class="card"><h2>Honest limitations</h2><p>RSSI and SNR are affected by terrain, antenna orientation, obstruction, multipath, transmit power, and receiver behaviour. The result is a strongest observed search area, never an exact position.</p></article></div>
    <a class="button" href="#/diagnostics">Storage and deletion controls</a>
  </section>`;
}
