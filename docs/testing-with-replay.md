# Testing with replay and demo mode

Replay provides deterministic field-like input without a radio. It drives the same recorder, decoder, classification, GPS association, persistence, signal, cell, estimate, map, and export paths as live capture.

## Data separation

Built-in transports declare their provenance as `real` or `simulated`. The recorder rejects simulated frames entering a real session and real frames entering a demo session. Demo sessions show a persistent **SIMULATED DATA** banner, use demo styling in the session list, and set `simulatedData: true` in JSON/GeoJSON/summary output. This is structural, not merely a visual convention.

## Scenarios

`src/demo/scenarios.ts` supplies eight scripts:

- **Approach and pass** — direct receptions strengthen then weaken along a walking track.
- **Forwarded only** — strong target-origin packets arrive through another transmitter and must leave gauge/cells unchanged.
- **GPS gap** — fixes become fresh, stale, absent, then recover while capture continues.
- **Poor accuracy** — degraded and hard-rejected fixes demonstrate location exclusion.
- **Prefix collision** — identity-universe growth turns short matching evidence ambiguous and triggers reclassification.
- **Multiple passes** — time-separated approaches exercise pass/direction confidence.
- **Multipath outlier** — an isolated implausibly strong point tests median/MAD aggregation.
- **Bluetooth drop** — scripted disconnect and reconnect preserve session continuity.

Packet builders use the official header/path/payload layout and round-trip through the real decoder. Anonymous requests expose a deterministic full sender key without relying on an advert signature, so demo classifications remain meaningful offline.

## Playback

`ReplayTransport` accepts ordered events `{atMs, kind}` where kind is `frame`, `gps`, `drop`, or `reconnect`. Playback supports 1×, 2×, 10×, and `max`, plus pause, resume, restart, and seek. `max` preserves ordering and yields in bounded batches. Archived receptions/fixes can also be converted into replay events.

In the UI, choose **Open demo scenario**. The default approach-and-pass scenario runs at 10×. A blank or failed map does not affect replay capture.

## Automated tests

Unit tests cover frame/packet round trips, replay timing/acceleration/drop events, provenance rejection, every classification branch, GPS boundaries, aggregation, exports, audio, storage, recorder fan-out, foreground Smart Wardrive scheduling, blank guest protocol correlation/pagination, and conservative multi-observer geometry. Guest tests use a deterministic command queue; they do not contact public repeaters.

Playwright builds and previews the production app, then runs desktop Chromium and Pixel 7 emulation:

```sh
npm run test:e2e
```

- `unsupported.spec.ts`: Web Bluetooth absent → Bluefy guidance; archive import remains available for review.
- `workflow.spec.ts`: acknowledgement, mock companion, target, session, direct/forwarded/ambiguous frames, confirmed-only gauge, JSON/CSV/GeoJSON downloads, SHA-256 verification, and JSON re-import.
- `resume.spec.ts`: reload mid-session, resume prompt, reconstruction from IndexedDB, and classification persistence.

Remote observer math tests inject deliberately false target advert coordinates and prove they do not alter eligible anchors, the remote likelihood polygon, the local search polygon, map bounds, or the community-assisted overlap. Archive tests cover v1/v2-to-v3 migration, verified report validation, GeoJSON observer-anchor labelling, and disagreement metadata. Hardware validation must still confirm that the intended observer has blank guest access enabled and that its operator has authorised the query.

Use `?e2e=1` only for automation; it exposes `window.__finderTest`. Use `?nosw=1` to prevent service-worker state from making browser tests nondeterministic.

## Adding a regression

Prefer the smallest layer that proves the behaviour: a pure unit case for classification/math, a recorder test for decode→persist→aggregate fan-out, or Playwright only for a real user-flow contract. Every new raw fixture must successfully decode through `DecoderAdapter`; do not invent a decoded object that bypasses the parser unless the test is specifically testing adapter failure handling.
