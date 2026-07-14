# Location estimation

MeshCore Finder estimates a **strongest confirmed search area**. It never claims the radio’s exact position and does not convert RSSI into distance.

## Eligible observations

An observation enters aggregation only when:

- classification is `DIRECT_TARGET` or `TARGET_IS_IMMEDIATE_TRANSMITTER`;
- the associated fix is accepted, no more than 10 seconds old, and marked `ok`;
- the fix passes the configured accuracy and kinematic filters; and
- the session is not mixing simulated and real transport data.

Forwarded, ambiguous, unknown, stale-GPS, no-GPS, and decoder-failed observations remain in the technical log but do not affect cells or the area estimate.

## Cells

The app uses a fixed latitude-band grid with longitude scaled by cosine(latitude). Walk sessions default to 12 m cells (allowed 8–20 m); drive sessions default to 45 m (allowed 30–60 m). Each cell keeps bounded samples and derives median/max RSSI, median/max SNR, median GPS accuracy, RSSI median absolute deviation, temporally separated passes, approach octants, first/last time, and minimum identity tier.

Cell confidence combines sample count (25%), separated passes (20%), time span (10%), approach directions (10%), GPS quality (15%), RSSI consistency (10%), and identity quality (10%). A live cell older than 30 minutes is discounted. This score measures observation quality, not probability that the repeater sits in the cell.

## Area construction

The default gate requires at least five located confirmed samples across three cells. Eligible cells are within 6 dB of the best cell median and have confidence of at least 0.25. Three or more cells produce a convex hull of buffered cell centres. Fewer eligible cells produce a deliberately low-confidence disc around the strongest cell. The buffer accounts for cell size and median GPS accuracy.

Confidence is `high` only with at least three cells, mean cell confidence above 0.65, and at least three separated passes; `medium` requires mean confidence above 0.40; otherwise it is `low`. The UI always shows the contributing sample/cell counts and the approximate polygon area.

## How to improve the result

- Make separated passes rather than lingering at one point.
- Approach from different directions and heights where lawful and safe.
- Keep the phone/companion/antenna orientation consistent.
- Switch from drive to walk mode for the final local search.
- Revisit strong cells to test repeatability.
- Treat isolated peaks as possible multipath until another pass reproduces them.

Calibration changes the relative gauge only. “Set current as weak/strong” does not change raw RSSI, classification, or historical frames.
