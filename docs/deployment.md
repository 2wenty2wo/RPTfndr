# Deployment

MeshCore Finder is a static Vite PWA. Production capture must be served from a secure context: HTTPS, or localhost during development.

## Build

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

`dist/` is the deployable directory. Preview exactly that output with `npm run preview`.

For a subdirectory, set the public base before building:

```powershell
$env:BASE_PATH='/RPTfndr/'
npm run build
```

The app uses a hash router, so a static host does not need SPA rewrite rules. Do not add a Mapy or other private API key; the included tile endpoints require none.

## Service worker

The generated service worker precaches the application shell, supplies an offline navigation fallback, and caches at most 300 map tiles for seven days. Updates use a prompt so a capture is not replaced mid-session. `?nosw=1` disables registration for automated tests and troubleshooting.

Serve `manifest.webmanifest`, JavaScript, CSS, icons, and the service worker with correct content types. Avoid permanently immutable caching for `index.html`, the manifest, and service-worker entry. A service worker controls only its deployment scope, so verify the configured base path before publishing.

## Pre-field checklist

1. Open the final HTTPS URL on the intended device/browser.
2. Confirm the compatibility page reports a secure context and Web Bluetooth where expected.
3. Install the PWA, reload offline, and verify map failure does not affect capture.
4. Connect a companion, sync contacts/device metadata, run a real direct-vs-forwarded classification check, and export/import a short session.
5. Test resume after reload, writer-lock/read-only behaviour in a second tab, service-worker update prompt, storage quota display, and delete-all.
6. On iOS, complete the [Bluefy checklist](ios-bluefy-testing.md) with the actual hardware/firmware.

Static hosting does not provide an application backend. Map-tile hosts remain external, and downloaded exports are outside browser storage controls.
