# Location estimation

MeshCore Finder estimates a **strongest confirmed search area** and, when suitable manual directional bearings exist, an **approximate final-approach zone**. It never claims the radio’s exact position and does not convert RSSI into distance.

A single receiver’s RSSI/SNR cannot uniquely determine coordinates: many possible transmitter locations can produce the same reading, and the propagation environment can dominate received strength. Repeated observations identify a region worth searching, not a point solution.

## Eligible observations

An observation enters aggregation only when:

- classification is `DIRECT_TARGET` or `TARGET_IS_IMMEDIATE_TRANSMITTER`;
- the associated fix is accepted, no more than 10 seconds old, and marked `ok`;
- the fix passes the configured accuracy and kinematic filters; and
- the session is not mixing simulated and real transport data.

Forwarded, ambiguous, unknown, stale-GPS, no-GPS, and decoder-failed observations remain in the technical log but do not affect cells or the area estimate.

Coordinates advertised by the target or copied from a contact are untrusted admin metadata. They are excluded from observation eligibility, map fitting, signal cells, area construction, bearing calculations, and final-approach calculations. Enabling the optional **Admin-configured position — unverified** map layer changes display only.

## Cells

The app uses a fixed latitude-band grid with longitude scaled by cosine(latitude). Walk sessions default to 12 m cells (allowed 8–20 m); drive sessions default to 45 m (allowed 30–60 m). Each cell keeps bounded samples and derives median/max RSSI, median/max SNR, median GPS accuracy, RSSI median absolute deviation, temporally separated passes, approach octants, first/last time, and minimum identity tier.

Cell confidence combines sample count (25%), separated passes (20%), time span (10%), approach directions (10%), GPS quality (15%), RSSI consistency (10%), and identity quality (10%). A live cell older than 30 minutes is discounted. This score measures observation quality, not probability that the repeater sits in the cell.

## Area construction

The default gate requires at least five located confirmed samples across three cells. Eligible cells are within 6 dB of the best cell median and have confidence of at least 0.25. Three or more cells produce a convex hull of buffered cell centres. Fewer eligible cells produce a deliberately low-confidence disc around the strongest cell. The buffer accounts for cell size and median GPS accuracy.

Confidence is `high` only with at least three cells, mean cell confidence above 0.65, and at least three separated passes; `medium` requires mean confidence above 0.40; otherwise it is `low`. The UI always shows the contributing sample/cell counts and the approximate polygon area.

## Directional bearings and final approach

A bearing is a manually observed direction, normally taken with a directional antenna. It records the observer’s phone position, phone GPS accuracy, direction in degrees, angular uncertainty, and time. A bearing is eligible only when it has usable, fresh GPS and follows a recent confirmed reception from the selected target. This keeps an unrelated apparent peak from being combined with the target’s signal area.

At least two bearings from meaningfully separated observer locations are required; three or more are recommended. The solver excludes intersections behind an observer, near-parallel lines that would be dominated by small angular errors, stale or poor GPS, and observations without recent confirmed target evidence. Exclusion reasons remain available for review.

Eligible bearings are combined with weighted least squares. The result is rendered as a shaded convex zone, not as a target marker. Its uncertainty radius incorporates each bearing’s angular uncertainty at the estimated range, phone GPS accuracy, and cross-track residuals. Geometry quality, contributing observation IDs, exclusions, bearing count, cross-track error, and confidence travel with the result.

Consensus work is bounded to the most recent 128 bearing observations so an oversized imported log cannot stall field use. If that limit is reached, the omitted older-record count is reported as an analysis exclusion.

When a confirmed RSSI search polygon is available, the app intersects it with the bearing zone to form the final-approach zone. If the polygons do not overlap, the app shows a disagreement warning and preserves both inputs for review; it does not invent an overlap or choose one as truth. With no suitable directional bearings, RSSI-only proximity guidance remains available as the less precise fallback.

## Community observer likelihood zone

An authorised stationary repeater can contribute a target-attributed neighbour report through MeshCore's blank guest interface. A report is eligible only when the configured observer position was independently surveyed or confirmed by its operator, its uncertainty is within the analysis limit, the neighbour record contains the selected target's full 32-byte public key, the record is direct/zero-hop, and it is no more than five minutes old. Advert/contact coordinates cannot satisfy this requirement and are never promoted automatically.

At least two eligible observer identities at separated positions are required; three or more are recommended. For each observer the newest eligible reports are aggregated. The estimator builds a padded convex envelope around the verified observer network and may trim that envelope only when pairwise SNR differences exceed a conservative terrain/fading allowance. It uses relative ordering only: SNR is never converted into a distance or path-loss radius. A common SNR offset leaves the result unchanged, and remote confidence is capped at `medium` even with good geometry.

The remote zone can be intersected with the local directional final-approach polygon when available, otherwise with the confirmed RSSI search polygon. A non-overlap is preserved as disagreement. Observer anchors and both polygons have separate Leaflet layers; none of them alters the operational viewport, which continues to frame only measured local reception positions.

JSON, GeoJSON, and summary exports identify bearing, remote-observer, community-assisted, and final-approach zones as approximate and include their confidence metadata. Verified observer points in GeoJSON are labelled as observer anchors, never as target positions. Every zone is a field-search aid. Physically identify the equipment at close range before concluding that it has been found.

## How to improve the result

- Make separated passes rather than lingering at one point.
- Approach from different directions and heights where lawful and safe.
- Keep the phone/companion/antenna orientation consistent.
- Switch from drive to walk mode for the final local search.
- Revisit strong cells to test repeatability.
- Treat isolated peaks as possible multipath until another pass reproduces them.
- Record directional bearings from separated locations immediately after recent confirmed target receptions; use three or more where practical.
- Increase angular uncertainty when the peak is broad or unstable instead of forcing a narrow bearing.

Calibration changes the relative gauge only. “Set current as weak/strong” does not change raw RSSI, classification, or historical frames.
