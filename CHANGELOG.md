# Changelog

## 1.0.0 — 2026-07-14

- Replaced the legacy MeshCore Signal Tester root with MeshCore Finder, a strict TypeScript/Vite PWA.
- Added Web Bluetooth companion connection, command serialisation, contact/device metadata, disconnect monitoring, conservative reconnect, discovery correlation, mock transport, and replay.
- Added decoder normalisation and a strict classification engine that limits signal/location calculations to provably direct target transmissions.
- Added collision-aware full-key/node-ID/prefix identity handling and explicit forwarded/ambiguous/unknown reception views.
- Added high-accuracy GPS capture, kinematic filtering, reception association, walk/drive aggregation, signal smoothing/calibration, cell confidence, and a deliberately non-exact search-area estimate.
- Added local IndexedDB sessions with resume/reconcile, writer locking, JSON/CSV/GeoJSON/summary export, archive import validation, and SHA-256.
- Added mobile finder, map-free fallback, bearing notes, audio feedback, diagnostics, privacy/safety, demo/replay, offline PWA support, and installable icons.
- Added Vitest and Playwright coverage, CI, deployment guidance, Bluefy test instructions, and upstream attribution.
