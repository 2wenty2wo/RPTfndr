import type { AppState } from '../../app/store';
import { escapeHtml } from '../components';

export function connectScreen(state: Readonly<AppState>): string {
  const connected = state.connection === 'connected';
  const busy = ['requesting', 'connecting', 'reconnecting'].includes(state.connection);
  return `<section class="screen" aria-labelledby="connect-title">
    <div class="hero">
      <span class="eyebrow">Step 1 · Companion radio</span>
      <h1 id="connect-title">Connect to MeshCore</h1>
      <p>The companion receives LoRa packets and sends them to this device over Bluetooth. Connecting does not transmit your phone location.</p>
    </div>
    <div class="grid two">
      <article class="card accent stack">
        <div class="row"><div><h2>${connected ? 'Radio connected' : 'Web Bluetooth'}</h2><p>${connected ? escapeHtml(state.deviceName ?? 'MeshCore companion') : 'Use Chrome on desktop/Android or Bluefy on iPhone and iPad.'}</p></div><span class="status-pill ${connected ? 'connected' : ''}">${escapeHtml(state.connection)}</span></div>
        ${connected
          ? `<div class="button-group"><a class="button primary" href="#/target">Choose target</a><button class="button" data-action="disconnect">Disconnect</button></div>`
          : `<button class="button primary" data-action="connect" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Choose companion radio'}</button>`}
        <p class="fine-print">The browser only opens the Bluetooth picker after a tap. Silent reconnect is attempted only where the browser exposes previously permitted devices.</p>
      </article>
      <article class="card stack">
        <div><h2>Try without hardware</h2><p>Run a clearly marked simulated search that exercises direct, forwarded, GPS-gap, and collision cases.</p></div>
        <button class="button" data-action="start-demo">Open demo scenario</button>
        <a href="#/compat">Browser and Bluefy setup</a>
      </article>
    </div>
    <article class="card warning" style="margin-top:.85rem"><h2>Before field use</h2><p>Keep the screen awake, mount the phone safely, and ask a passenger to operate it while driving. Never trespass or confront anyone.</p></article>
  </section>`;
}
