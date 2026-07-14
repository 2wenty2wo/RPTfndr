# Packet classification

MeshCore Finder is deliberately conservative. A strong signal is useful only when the receiving
radio can prove who made the final RF transmission. The app therefore records every reception but
feeds only two classifications into the signal gauge, search cells, and area estimate:

- `DIRECT_TARGET`
- `TARGET_IS_IMMEDIATE_TRANSMITTER`

These labels prove a direct target transmission under the rules below. They do **not** prove the
repeater's position, a distance, or an exact location. RSSI and SNR vary with antennas, terrain,
orientation, interference, and multipath.

## Identity strength

MeshCore identities form a prefix chain:

1. full public key: 32 bytes;
2. node ID: the first 4 bytes;
3. routing/path hash: the first 1–3 bytes;
4. name: a human label, which is not unique.

A target saved only by a prefix shorter than four bytes or by name can never produce a confirmed
sample. A matching advert, contact, or discovery response can be used to pin a stronger identity.

The identity universe contains synced contacts, public keys observed in adverts and anonymous
requests, discovery identities, and target profiles. Two distinct full public keys matching the
same evidence bytes make that evidence a collision. Universe growth can therefore make an older
classification unsafe. When a new collision appears, the app warns the user and re-runs the pure
classifier over stored receptions before rebuilding signal cells and estimates.

## Why route type matters

Flood and transport-flood paths grow as a packet travels. The final header-path entry is the node
that transmitted the received RF copy. An empty flood path means the originator was heard without
a forwarding hop.

Direct and transport-direct paths mean something different: they contain **remaining forwarding
instructions** and shrink in flight. Neither a non-empty path nor an empty path proves the
immediate transmitter. This intentionally differs from the old signal tester, which attributed a
direct packet to the last path entry. Finder classifies non-trace direct-route packets as
`UNKNOWN_TRANSMITTER`, even when the payload proves that the target originated the packet.

Trace packets are a special case. Their real node hops are `payload.decoded.pathHashes`; the header
path contains SNR bytes. Path payloads (type 8) are the opposite: their decoded `pathHashes` can be
misinterpreted ciphertext, so Finder uses only the normal header path for them.

## Precedence

The first matching rule wins:

| Order | Evidence | Classification | Confirmed? |
| --- | --- | --- | --- |
| 0 | Decoder throws, rejects the packet, or rejects its typed payload | `DECODE_FAILED` | No |
| 1 | Select Trace decoded hops; otherwise select header hops | Continue | — |
| 2 | Direct/transport-direct and not Trace | `UNKNOWN_TRANSMITTER` | No |
| 3a | Empty flood/Trace path; full advert or anonymous-request origin uniquely matches a full-key or collision-free node-ID target | `DIRECT_TARGET` | Yes |
| 3a | Same origin matches only a short prefix/name, or collides | `AMBIGUOUS_PREFIX` | No |
| 3a | Full origin disproves the target | `NON_TARGET` | No |
| 3b | Empty path; one-byte source hash mismatches | `NON_TARGET` | No |
| 3b | Empty path; one-byte source hash matches | `AMBIGUOUS_PREFIX` | No |
| 3c | Empty path; no payload identity | `UNKNOWN_TRANSMITTER` | No |
| 4a | Non-empty flood/Trace path; final hop uniquely matches a target known by node ID or full key | `TARGET_IS_IMMEDIATE_TRANSMITTER` | Yes |
| 4a | Final hop match is weak or colliding | `AMBIGUOUS_PREFIX` | No |
| 4b | A different final hop forwarded a packet whose full origin is the target | `TARGET_ORIGIN_BUT_FORWARDED` | No |
| 4c | Target matches an earlier, non-final hop | `TARGET_IN_PATH_BUT_NOT_IMMEDIATE` | No |
| 4d | No target match | `NON_TARGET` | No |

If both origin and final hop identify the target, rule 4a wins and the explanation notes that the
packet was self-forwarded. This is still confirmed because the last hop proves that the target made
the RF transmission received by the companion.

Malformed and unknown packets are retained with their raw companion frame and LoRa bytes. A decode
failure never stops capture.

## Discovery responses and opcode `0x8e`

Companion opcode `0x8e` is overloaded. Finder treats it as a discovery response only when byte 4's
high nibble is `0x9`. It then parses downlink SNR, RSSI, companion path length, node type, uplink SNR,
the reflected 32-bit tag, and an 8- or 32-byte public key. Any other `0x8e` frame remains a normal
LoRa RX frame whose packet begins at byte 4.

Discovery commands contain a random tag and open a two-second response window. Responses with a
different tag or outside that window are not correlated with the command. A matching target with
companion path length zero is `DIRECT_TARGET`; a positive path length is
`TARGET_ORIGIN_BUT_FORWARDED`. Prefix collisions and weak target profiles remain ambiguous.

The response's RSSI and outer SNR describe target-to-companion reception. Its `uplinkSnr` describes
the reverse direction reported by the remote node. Finder stores and displays uplink SNR separately
and never feeds it into the downlink signal gauge.

## Duplicates and diagnostics

MeshCore may deliver the same message hash through multiple routes. Finder retains each reception,
classifies it independently, and links later copies to the first recent copy; duplicates are not
suppressed. This matters because one forwarded copy can be unconfirmed while another copy heard
directly is confirmed.

The companion's path-length byte and the decoded LoRa header can disagree. Finder records a
diagnostic warning and uses the decoder's path because classification depends on MeshCore route
semantics, not the companion's summary byte.
