# Privacy and safety

## Lawful use

Use MeshCore Finder only for equipment you own or are explicitly authorised to recover. Obey radio, traffic, privacy, trespass, and surveillance laws. Stay on public land or obtain permission. Do not confront another person. Contact the appropriate authorities if a recovery could become unsafe.

While driving, a passenger must operate the app. Stop legally before inspecting detail, recording a bearing, or changing settings.

## Web-hosted app, device-local data

The HTTPS server supplies the static application. The `meshcore-finder` IndexedDB database stores target profiles, sessions, raw companion/LoRa frames, decoded metadata, classification explanations, RSSI/SNR, accepted and rejected fixes, notes, marks, bearings, verified-observer definitions, target-matched observer reports, query audit events, diagnostics, and settings in the current browser profile. Photos are optional blobs. A writer lock prevents two tabs from appending concurrently; a second tab remains read-only.

IndexedDB belongs to the web origin (scheme, host, and port). Another browser profile, phone, computer, hostname, subdomain, or port has a separate store. There is no application data server, login, analytics library, or automatic cloud sync. Browser/OS backup and device-management policy may still copy browser storage outside the application’s control.

## Untrusted advertised coordinates

A repeater’s advertised coordinates and coordinates copied from a contact can be manually configured by an administrator, stale, intentionally approximate, or simply wrong. MeshCore Finder records them only as untrusted admin metadata. The map layer is hidden by default and labelled **Admin-configured position — unverified** when the user chooses to display it.

That optional layer is display-only. Its coordinates never influence map bounds, signal cells, strongest-area calculations, bearing consensus, or the final-approach zone. Do not treat the marker as evidence that the device has ever been at that location.

## Network and Bluetooth

The browser talks directly to a selected companion through the Nordic UART Service. Device selection requires a user gesture. Automatic reconnect only uses devices already granted by the browser.

The map requests visible raster tiles from OpenStreetMap. The service worker may retain up to 300 tiles for seven days. The tile host can see ordinary request metadata such as IP address, and the requested tile coordinates reveal the geographic area being viewed. Use the map-free signal/cell view if that is unacceptable.

## Smart Wardrive and remote radio traffic

Smart Wardrive is disabled by default. It runs only during a real Drive session while the page is visible and the companion protocol is fully connected. Observer assist also requires the target's full public key; automatic discovery can continue with a shorter selected identity and may provide full-key evidence that the user can review and pin. Manual and automatic discovery share a 60-second minimum, while observer assist has a five-minute minimum. Hiding the page, locking/suspending the browser, losing Bluetooth, or ending the session cancels queued automation before transmission and pauses it. A passenger must operate or monitor the app while a vehicle is moving.

Adding an observer requires the user to confirm query permission and enter independently verified stationary coordinates accurate to 250 m or better. The app does not infer permission, discover trustworthy coordinates automatically, or accept advert/contact coordinates as anchors. It attempts only a blank-password guest login once per observer per Bluetooth connection. It has no password input or storage and does not guess credentials. If a blank response reports elevated access, the app refuses the session and sends no neighbour request.

Observer queries consume shared radio airtime. A cycle visits at most three observers in round-robin order and at most eight newest-first neighbour pages overall, and only a direct record matching the selected target's full key is retained. Unrelated neighbour keys and a repeater's generic last-RSSI/last-SNR state are not stored as target evidence. Query outcome events, verified anchor coordinates, heard time, and target-matched SNR appear in local archives and may reveal network and location information when exported.

## Export and deletion

JSON archives preserve the full technical log and include a SHA-256 digest; CSV and GeoJSON can expose location, bearing, approximate-zone, and identity metadata in easier-to-process forms. Review exports before sharing, store them securely, and remember that a digest detects changes but does not prove who created a file. Archive export/import is the only built-in way to copy an ended log between devices for review; imports are not resumable and there is no background synchronisation.

Delete individual sessions after exporting, or use Diagnostics to delete the entire local database. Browser “clear site data” also removes it. Installed PWA caches and downloaded exports are separate and may require browser/file-system deletion.

## Interpretation

The app records observations and produces relative, approximate search zones. It is not forensic evidence, a tracking service, a measurement of distance, or an exact-position system. One receiver’s RSSI/SNR reading cannot uniquely determine coordinates. Terrain, reflection, blockage, device variation, antenna patterns, and forwarding can dominate signal strength.

Directional bearings can narrow a search only when they are recorded from separated locations with recent confirmed target receptions and useful GPS. Angular uncertainty, phone GPS accuracy, crossing geometry, and residual disagreement all enlarge or weaken the final-approach zone. Remote observers add only a broad relative-SNR likelihood envelope; they do not measure range. The app rejects unsuitable inputs and reports disagreement among remote, directional, and confirmed RSSI zones rather than manufacturing a result. Close-range searching and visual confirmation are still required.
