export function compatibilityScreen(): string {
  const hasBluetooth = 'bluetooth' in navigator;
  const secure = globalThis.isSecureContext ?? (
    location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  );
  return `<section class="screen" aria-labelledby="compat-title"><div class="screen-header"><div><span class="eyebrow">Browser support</span><h1 id="compat-title">Connect from a supported browser</h1><p>Web Bluetooth requires a secure page and a compatible browser. iPhone and iPad users should open the deployed HTTPS URL inside Bluefy.</p></div></div>
    <div class="grid two"><article class="card ${hasBluetooth ? 'accent' : 'warning'}"><h2>Web Bluetooth</h2><p>${hasBluetooth ? 'Available in this browser.' : 'Not exposed by this browser. Safari and Firefox cannot connect directly.'}</p></article><article class="card ${secure ? 'accent' : 'warning'}"><h2>Secure context</h2><p>${secure ? 'This page is in a secure context.' : 'Deploy over HTTPS (localhost is also allowed).'}</p></article></div>
    <article class="card stack" style="margin-top:.85rem"><h2>iPhone / iPad with Bluefy</h2><ol class="muted"><li>Install Bluefy from the App Store.</li><li>Enable Bluetooth and Location permission for Bluefy in iOS Settings.</li><li>Open this app’s HTTPS URL inside Bluefy, not Safari.</li><li>Tap <strong>Choose companion radio</strong> and select the MeshCore/Meshtastic device.</li><li>Keep Bluefy visible and prevent the phone from sleeping during capture.</li></ol><p class="fine-print">You can still review/import/export saved logs and run demo mode in an unsupported browser.</p><div class="button-group"><a class="button primary" href="#/connect">Back to connection</a><button class="button" data-action="import">Import log for review</button></div></article>
  </section>`;
}
