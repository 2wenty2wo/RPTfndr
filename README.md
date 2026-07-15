# MeshCore Finder

MeshCore Finder is a mobile-first, web-hosted field tool for the lawful owner of a missing MeshCore repeater. It connects to a MeshCore companion over Web Bluetooth, records received packets with RSSI/SNR and phone GPS, and highlights the strongest **confirmed search area** observed during repeated passes.

“Local-first” means **web-hosted, device-local data**: an HTTPS server delivers the static application, while each browser stores its own sessions in IndexedDB. It does not mean that the app is limited to `localhost` or must run from the development computer.

MeshCore Finder does **not** determine a transmitter’s exact coordinates. A single receiver’s RSSI/SNR cannot uniquely identify a location, and radio signal strength is affected by terrain, buildings, foliage, antenna orientation, transmit power, receiver behaviour, and multipath. Treat every result as a way to prioritise where to search next—not as proof, a surveyed position, or permission to enter property.

## The important safety rule

Only packets whose immediate RF transmitter can be proved to be the selected target feed the finder gauge, cell aggregates, and area estimate. Target-origin packets that arrived through a forwarder, weak prefix matches, direct-route packets with an unprovable final transmitter, malformed packets, and unrelated traffic remain visible in the technical log but are excluded.

See [packet classification](docs/packet-classification.md) for the exact precedence and the deliberate difference between growing flood paths and remaining direct-route instructions.

## Privacy model

- No backend, account, analytics, application telemetry, or automatic synchronisation.
- The HTTPS server delivers static files only. Targets, sessions, raw frames, fixes, notes, classifications, and settings are stored in IndexedDB for that browser profile and web origin.
- Opening the same hosted URL on another phone or computer does not copy the first device’s records. Use a JSON archive export/import for a deliberate manual transfer.
- Search logs and other locally stored records leave the browser only through an export the user initiates (subject to browser/OS backup policy).
- Opening the map requests raster tiles from OpenStreetMap; up to 300 viewed tiles may be cached for seven days. Capture and exports remain usable without a basemap.
- JSON archives include a displayed SHA-256 digest. CSV, GeoJSON, and a human-readable technical summary are also available.
- Coordinates advertised by a repeater or copied from a contact are treated as untrusted admin metadata. They are hidden by default and, if enabled, appear only as **Admin-configured position — unverified**; they never feed map bounds or location calculations.

Read [privacy and safety](docs/privacy-and-safety.md) before field use.

## Supported browsers

| Platform | Capture support | Notes |
| --- | --- | --- |
| iPhone / iPad | Bluefy | Open the deployed HTTPS URL inside Bluefy. Keep the app visible. |
| Android | Chromium-based browser with Web Bluetooth | Chrome is the primary tested route. |
| Desktop | Chrome / Edge with Web Bluetooth | Useful for development and companion testing. |
| Safari / Firefox | Review only | Import, inspect, demo, and export work; Bluetooth capture does not. |

Web Bluetooth requires HTTPS (localhost is allowed for development), a user gesture for the device picker, Bluetooth permission, and location permission for GPS association. See [iOS and Bluefy field testing](docs/ios-bluefy-testing.md) and [the BLE protocol notes](docs/meshcore-ble.md).

## Typical field workflow

1. Open the app and acknowledge the lawful-use, privacy, and estimation limitations.
2. Connect a MeshCore/Meshtastic companion radio.
3. Choose a repeater contact or enter its full 32-byte public key / 4-byte node ID. Shorter prefixes can never create confirmed samples.
4. Start in **drive mode** for broad, passenger-operated coverage. Never handle the app while driving.
5. Make separated passes. Look for a repeatable cluster of confirmed direct receptions, not one peak.
6. Change to **walk mode** near the strongest confirmed search area and approach from several directions.
7. Near the search area, record manual directional-antenna bearings from separated locations. Two eligible bearings are the minimum; three or more are recommended.
8. Treat the shaded final-approach zone as approximate. Poor crossing geometry, GPS error, angular uncertainty, and multipath can move or enlarge it, and a disagreement with the RSSI search area is reported rather than concealed.
9. Search the final area at close range and visually confirm the physical equipment.
10. Export the technical search log before deleting local data or copying an ended log to another device for review. Imported sessions remain ended; start a new local session for further capture.

The gauge shows relative, session-calibrated signal—not distance. “100%” means strong relative to the configured/session range, not “at the repeater.” Details are in [location estimation](docs/location-estimation.md).

## Demo and replay

Choose **Open demo scenario** on the connection screen to use the app without hardware. Demo sessions are structurally separate from real capture, persistently marked **SIMULATED DATA**, and stamped in every export. Replay supports normal, 2×, 10×, and maximum speed for deterministic testing. See [testing with replay](docs/testing-with-replay.md).

## Development

Requirements: Node.js 22.12+ and npm 10+.

```sh
npm ci
npm run dev
```

Quality gates:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:hosting
npm run test:e2e
```

The production output is `dist/`. `test:hosting` builds and inspects both root and configured-subpath PWA variants. Playwright starts `vite preview` on port 4173 and runs both desktop Chromium and Pixel 7 emulation. Unit tests use Vitest, jsdom, and fake-indexeddb.

## Static deployment

The app is a static PWA and may be hosted on any ordinary HTTPS web server. `BASE_PATH` may be set for a subdirectory; it keeps built assets, the manifest, and the service worker under the intended deployment path. The hash router avoids server-side SPA rewrite requirements.

```sh
BASE_PATH=/RPTfndr/ npm run build
```

On PowerShell:

```powershell
$env:BASE_PATH='/RPTfndr/'; npm run build
```

Serve `dist/` over HTTPS. The service worker caches the application for resilient field use, but it does not upload or synchronise IndexedDB records. See [deployment](docs/deployment.md) for root/subdirectory builds, service-worker scope, origin-scoped storage, update behaviour, and the field checklist.

## Design and protocol documentation

- [MeshCore BLE companion protocol](docs/meshcore-ble.md)
- [Packet classification](docs/packet-classification.md)
- [Location estimation](docs/location-estimation.md)
- [iOS / Bluefy testing](docs/ios-bluefy-testing.md)
- [Privacy and safety](docs/privacy-and-safety.md)
- [Replay testing](docs/testing-with-replay.md)
- [Deployment](docs/deployment.md)

## Upstream and licence

MeshCore Finder replaces the application in a fork of [kybl/meshcore-signal-tester](https://github.com/kybl/meshcore-signal-tester). The companion protocol handling, GPS filtering, spatial indexing patterns, CSV rules, audio cues, and other proven behaviours were ported and substantially reworked in strict TypeScript. Upstream attribution is preserved in [NOTICE](NOTICE) and git history.

The project is licensed under the MIT licence. See [LICENSE](LICENSE).
