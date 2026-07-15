# Deployment

MeshCore Finder is a static Vite PWA that can be published on an ordinary web server, object host, or static-site host. Production capture must be served from a secure context: HTTPS, or `localhost` during development. No application server, database service, login service, or WebSocket endpoint is required.

Hosting the application does not host its search records. The server delivers HTML, JavaScript, CSS, icons, and the service worker; each browser profile keeps its own records in IndexedDB.

## Build

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:hosting
```

`dist/` is the deployable directory. Preview exactly that output with `npm run preview`.

For a root deployment, the default relative base is suitable. For a subdirectory, set the public base before building, including both leading and trailing slashes:

```powershell
$env:BASE_PATH='/RPTfndr/'
npm run build
```

The example produces URLs and service-worker scope beneath `/RPTfndr/`. Rebuild with the real public path whenever that path changes. The app uses a hash router, so a static host does not need SPA rewrite rules. Do not add a Mapy or other private API key; the included tile endpoints require none.


## GitHub Actions FTP deployment

The repository includes a `Deploy FTP` workflow that builds `dist/` and publishes it with [`SamKirkland/FTP-Deploy-Action`](https://github.com/SamKirkland/FTP-Deploy-Action). It runs on pushes to `main` and can also be started manually from the Actions tab.

Configure these required repository or environment secrets before running the workflow:

- `FTP_SERVER` — FTP or FTPS hostname.
- `FTP_USERNAME` — deployment user.
- `FTP_PASSWORD` — deployment password.

Optional repository or environment variables customize the deployment without editing the workflow:

- `BASE_PATH` — Vite base path for subdirectory deployments, such as `/RPTfndr/`. Leave unset for root deployments.
- `FTP_PROTOCOL` — defaults to `ftps`; set to `ftp` only when your host does not support FTPS.
- `FTP_PORT` — defaults to `21`; set this if your host uses a custom FTP/FTPS port.
- `FTP_SERVER_DIR` — defaults to `./`; set this to the remote publish directory, such as `public_html/`. The value must end with `/`.

The workflow intentionally deploys only `dist/`, after `npm ci`, typechecking, linting, unit tests, production build, and the hosted-build verification pass.

## Service worker

The generated service worker precaches the application shell, supplies an offline navigation fallback, and caches at most 300 map tiles for seven days. This cache makes the hosted UI more resilient in the field; it is not a backup or synchronisation mechanism for IndexedDB. Updates use a prompt so a capture is not replaced mid-session. `?nosw=1` disables registration for automated tests and troubleshooting.

Serve `manifest.webmanifest`, JavaScript, CSS, icons, and the service worker with correct content types. Avoid permanently immutable caching for `index.html`, the manifest, and service-worker entry. A service worker controls only its deployment scope. Verify that the installed manifest start URL, manifest scope, and service-worker scope all remain beneath the configured `BASE_PATH` before publishing.

## Device-local storage and transfer

IndexedDB is scoped to the web origin: the combination of scheme, host, and port. A deployment at a different hostname, subdomain, port, or HTTP/HTTPS scheme has a separate data store. Different paths on the same origin are not separate IndexedDB security boundaries, even though each service worker has its own path-based scope.

There is no account or automatic transfer between browsers. Opening the hosted app on a second device starts with that device’s own store. To move a completed log for review, export a JSON archive on the source device, move that downloaded file by a method you trust, and import it on the destination device. Imported sessions remain ended and their zones are not merged into later capture; start a new session on the destination device to continue field work. Verify the displayed archive digest and retain the source archive until the imported session has been checked. Browser eviction or “clear site data” can remove the local store, so make deliberate exports during long searches.

## Pre-field checklist

1. Open the final HTTPS URL on the intended device/browser.
2. Confirm the compatibility page reports a secure context and Web Bluetooth where expected.
3. Install the PWA, reload offline, and verify map failure does not affect capture.
4. Connect a companion, sync contacts/device metadata, run a real direct-vs-forwarded classification check, and export/import a short session between the devices that will be used.
5. Test resume after reload, writer-lock/read-only behaviour in a second tab, service-worker update prompt, storage quota display, and delete-all.
6. On iOS, complete the [Bluefy checklist](ios-bluefy-testing.md) with the actual hardware/firmware.

Static hosting does not provide an application backend, account, shared database, or synchronisation service. Map-tile hosts remain external, and downloaded exports are outside browser storage controls.
