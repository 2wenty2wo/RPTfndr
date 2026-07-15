# iOS and Bluefy field testing

Apple’s Safari WebKit does not expose Web Bluetooth. On iPhone and iPad, open MeshCore Finder’s **HTTPS** deployment inside Bluefy. Hardware behaviour cannot be fully automated, so complete this checklist against every companion firmware family you intend to use.

## Preparation

1. Install Bluefy and enable Bluetooth permission in iOS Settings.
2. Enable precise Location permission for Bluefy. MeshCore Finder uses it only for on-device reception association.
3. Disable Low Power Mode for a long test, charge the phone and companion, and prevent auto-lock while capturing.
4. Verify the deployment certificate is valid and the URL is not inside another app’s embedded browser.
5. Place the companion close enough for a stable BLE link but keep it and its antenna in a consistent field position.

## Connection checklist

1. Tap **Choose companion radio**; the picker must never appear without that gesture.
2. Select a device whose name begins `MeshCore` or `Meshtastic`.
3. Confirm SELF_INFO, contacts, firmware/build/model, and battery appear in diagnostics.
4. Disconnect at the companion. The UI should notice within the 3-second watchdog window and sound the optional alarm.
5. Return after a brief background/foreground cycle. A suspension-gap event should appear when the arrival-clock gap is material.
6. If Bluefy exposes previously granted devices, verify conservative reconnect. The app must not open the picker during automatic reconnect.

## Capture checklist

1. Select a repeater using a full public key when possible.
2. Inject or transmit known zero-hop flood adverts and confirm only these drive the gauge.
3. Repeat through one and several forwarders. These must appear purple/forwarded and leave the gauge/sample count unchanged.
4. Test a direct-route packet with empty and non-empty remaining path. Both must be `UNKNOWN_TRANSMITTER` unless separate discovery evidence proves the case.
5. Test a prefix collision and confirm the app offers full-key pinning but does not count the ambiguous sample.
6. Allow GPS permission, deny it, and restore it. Capture must continue in every state; only fresh accepted fixes make located samples.
7. Lock/background the device long enough for iOS to suspend the page. Confirm the UI warns honestly and logs the gap after return.

## Long-run test

Run at least 60 minutes with the screen awake. Check battery reporting, notification continuity, memory, IndexedDB growth, map-tile failure, export/download behaviour, and a reload/resume. Export a debug bundle before deleting the test session.

Record the iOS version, Bluefy version, phone model, companion firmware/build/model, steps, timestamps, and the debug-bundle SHA-256 with every defect report. Debug bundles can contain raw radio and coarse location data; inspect before sharing.
