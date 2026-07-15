# MeshCore companion BLE protocol

This document records the byte-level contract used by MeshCore Finder. It is a conservative TypeScript port of the upstream MeshCore Signal Tester exchange and is intended to make hardware debugging auditable.

## Nordic UART Service

- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- Write without response: `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- Notifications: `6e400003-b5a3-f393-e0a9-e50e24dcca9e`
- Device picker filters: names beginning `MeshCore` or `Meshtastic`; NUS is requested as an optional service.

One notification is one complete companion frame. Byte 0 is the opcode; this boundary has no stream framing or length prefix.

The transport retries the initial GATT connection up to three times with 500 ms × attempt backoff, stops any existing notification subscription before starting it, registers disconnect handling only after connection, and polls every three seconds as a missed-disconnect watchdog. Silent reconnect is attempted only through `navigator.bluetooth.getDevices()`—the browser picker is never opened without a fresh user gesture. Reconnect makes at most five attempts with exponential backoff from two seconds, capped at eight seconds; mobile browsers may not expose this capability.

## Handshake and commands

Commands pass through a one-in-flight queue. Unmatched notifications remain available as pushes; timeouts reject and release the queue rather than wedging later commands.

1. `CMD_APP_START` (`0x01`): `[0x01, 0x03, 0x20 × 6, ...UTF-8 app name]`.
2. Response `SELF_INFO` (`0x05`): advertisement type at byte 1, transmit power at bytes 2–3, 32-byte device public key at 4–35, and advertised latitude/longitude as signed little-endian millionths at 36–43.
3. Wait 300 ms.
4. `CMD_GET_CONTACTS` (`0x04`, optionally followed by a little-endian `uint32` last-modified marker).
5. Responses: `0x02` start, zero or more `0x03` contacts, then `0x04` end plus last-modified marker. The queue advances the marker only after the end frame.
6. `CMD_DEVICE_QUERY` (`0x16`) → `0x0d`: signed firmware version, six reserved bytes, 12-byte build string, then model string. Older firmware may omit this; capture remains usable and diagnostics records the warning.

Contact layout: public key (32 bytes) at 1, type at 33 (`2` is repeater), flags at 34, path length at 35, 64-byte out path at 36, 32-byte C string name at 100, last-advert `uint32` at 132, signed latitude/longitude millionths at 136/140, and last-modified at 144. Battery push `0x0c` carries little-endian millivolts at bytes 1–2.

## Receive pushes

For `0x88`, LoRa bytes start at offset 3. For `0x84` and ordinary `0x8e`, they start at offset 4 and byte 3 is the companion path length. All three encode SNR as signed byte 1 divided by four and RSSI as signed byte 2 dBm.

Opcode `0x8e` is overloaded. It is parsed as a discovery response only when the frame has at least five bytes and `(byte[4] & 0xf0) === 0x90`. Its layout is:

- byte 3: path length;
- byte 4: `0x9X`, where X is advertisement type;
- byte 5: remote/uplink SNR as signed quarters of a dB;
- bytes 6–9: little-endian request tag;
- bytes 10 onward: 8- or 32-byte public-key evidence.

The companion’s downlink RSSI/SNR may feed the finder only after classification confirms a zero-path target response. Remote/uplink SNR is stored separately and never substituted into the downlink gauge.

Trace push `0x89` stores path length at byte 2, tag at bytes 4–7, and path/SNR bytes beginning at 12. Packet classification still follows the decoder’s documented Trace semantics.

## Discovery

A request is `[0x37, 0x80, filterMask & 0x0f, tag uint32LE]`. Responses must match the random tag and arrive inside a two-second window. Manual and automatic requests share a hard 60-second cooldown. A matching target at path length zero can be confirmed; a nonzero path is target-origin-but-forwarded and is excluded from location calculations.

Smart Wardrive uses repeater-only filter mask `0x04` and enforces a separate foreground interval of at least 60 seconds. It records whether each request was manual or automatic. Discovery never turns a repeater's advertised coordinates into a verified observer position.

## Blank guest observer exchange

Community observer assist uses a deliberately restricted remote exchange:

1. `CMD_SEND_LOGIN` (`0x1a`) followed by the observer's full 32-byte public key and no password bytes.
2. Companion `SENT` (`0x06`) identifies route, correlation tag, and suggested response timeout.
3. Repeater push `LOGIN_SUCCESS` (`0x85`, legacy or modern layout) or `LOGIN_FAIL` (`0x86`) is correlated by the observer-key prefix. A failure ends login attempts for that observer until Bluetooth reconnects.
4. After success only, `CMD_SEND_BINARY_REQ` (`0x32`) is sent with the observer key and neighbour payload `[0x06, version 0, count, offset uint16LE, order, keyLength 32, nonce × 4]`.
5. `BINARY_RESPONSE` (`0x8c`) is correlated to the `SENT` tag. Its header carries total/result counts; each record is a full 32-byte neighbour key, a `uint32` heard-age in seconds, and signed quarter-dB SNR.

A full-key record is 37 bytes, so the 130-byte response buffer permits at most three records per page. The coordinator serialises entire exchanges, bounds pages, totals, buffered pushes, response sizes, and retained records, and refuses neighbour queries before login. One poll cycle visits at most three observers in round-robin order, uses at most three pages per observer and eight pages overall, and never polls an anchor whose reported uncertainty exceeds 250 m. It retains only a full-key match for the selected target; unrelated neighbour identities are discarded instead of entering the session log. There is no password-bearing builder or administrative-command interface in the app. If a blank login unexpectedly returns admin permission, the session is refused and never used.

## Diagnostics and safe failure

Raw frames are preserved even when parsing or decoding fails. An `0x8e` frame that fails the discovery guard is treated as ordinary RX data; malformed payloads become `DECODE_FAILED` rather than terminating capture. If companion path length disagrees with the decoded MeshCore path, diagnostics records the mismatch and the decoder path wins.

Physical radio, firmware, iOS, and Bluefy combinations must still complete the [hardware checklist](ios-bluefy-testing.md); automated mocks validate the byte exchange but cannot reproduce platform BLE scheduling.
