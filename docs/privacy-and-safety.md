# Privacy and safety

## Lawful use

Use MeshCore Finder only for equipment you own or are explicitly authorised to recover. Obey radio, traffic, privacy, trespass, and surveillance laws. Stay on public land or obtain permission. Do not confront another person. Contact the appropriate authorities if a recovery could become unsafe.

While driving, a passenger must operate the app. Stop legally before inspecting detail, recording a bearing, or changing settings.

## Data stored on this device

The `meshcore-finder` IndexedDB database stores target profiles, sessions, raw companion/LoRa frames, decoded metadata, classification explanations, RSSI/SNR, accepted and rejected fixes, notes, marks, bearings, diagnostics, and settings. Photos are optional blobs. A writer lock prevents two tabs from appending concurrently; a second tab remains read-only.

There is no application server, login, analytics library, or automatic cloud sync. Browser/OS backup and device-management policy may still copy browser storage outside the application’s control.

## Network and Bluetooth

The browser talks directly to a selected companion through the Nordic UART Service. Device selection requires a user gesture. Automatic reconnect only uses devices already granted by the browser.

The map requests visible raster tiles from OpenStreetMap. The service worker may retain up to 300 tiles for seven days. The tile host can see ordinary request metadata such as IP address, and the requested tile coordinates reveal the geographic area being viewed. Use the map-free signal/cell view if that is unacceptable.

## Export and deletion

JSON archives preserve the full technical log and include a SHA-256 digest; CSV and GeoJSON can expose location and identity metadata in easier-to-process forms. Review exports before sharing, store them securely, and remember that a digest detects changes but does not prove who created a file.

Delete individual sessions after exporting, or use Diagnostics to delete the entire local database. Browser “clear site data” also removes it. Installed PWA caches and downloaded exports are separate and may require browser/file-system deletion.

## Interpretation

The app records observations and produces a relative strongest search area. It is not forensic evidence, a tracking service, a measurement of distance, or an exact-position system. Terrain, reflection, blockage, device variation, antenna patterns, and forwarding can dominate signal strength.
