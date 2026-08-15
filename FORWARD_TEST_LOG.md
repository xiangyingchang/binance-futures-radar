# Forward Test Log

This file is the human-readable index for live strategy validation. The machine-readable source of truth is [`data/forward-tests.jsonl`](data/forward-tests.jsonl).

## Rules for logging

- One immutable record per trade ID; updates should preserve the original entry snapshot and add exit / MAE / MFE fields rather than rewriting history.
- Record the radar signal snapshot at entry so later analysis does not use future information.
- Do not store exchange account IDs, balances, API keys, or other sensitive account data.
- For the current pilot, `SHORT_SETUP` still requires manual catalyst review and independent position sizing.

## FT-001 — HUSDT SHORT — CLOSED · DATA QUALITY INVALID SAMPLE

- Recorded: 2026-08-15 21:11 +08:00
- Strategy: `exhaustion-short-radar-v5-rsi6-funding-pilot`
- Actual entry time: `2026-08-15 21:05:55 +08:00`
- Entry price: `0.13958`
- Notional at entry: approximately `99.88 USDT`
- Margin: `49.99 USDT`
- Leverage / mode: `2x / Cross`
- Hard stop planned: `0.18145387` (+30% from entry)
- Max hold planned: `3 days`
- Add to loser: `No`

### Risk-control execution

- Stop order confirmed: `2026-08-15 21:12:20 +08:00`
- Order type: `Stop Market / Close Short`
- Trigger: latest price `>= 0.1814500`
- Reduce-only: `Yes`
- No fixed take-profit was used.

### Entry signal snapshot

- Market-cap rank used by radar: `#134` (`CoinGecko`)
- Live Daily RSI(6): `97.98`
- Closed Daily RSI(6): `96.50`
- 7D return: `+74.05%`
- Funding percentile (90D): `P97.13`
- Funding rate: `0.076585% / 4h`
- OI 24H / 7D: `+1.10% / +6.53%`
- Reversal signals: `1`
- Radar status: `SHORT_SETUP`

### Data-quality issue discovered after entry

- Discovered: `2026-08-15 21:16 +08:00`
- Binance app market data (explicitly labelled as sourced from CoinMarketCap) displayed Humanity at **market-cap rank #69**.
- This conflicted with the production radar's CoinGecko rank of approximately **#134**.
- Because the strategy defines **Top 100 as a hard exclusion**, FT-001 is **not a clean strategy-validation sample**.
- Keep the trade record for operational learning, but exclude it from clean strategy performance statistics.

### Exit / review

- Exit time: `2026-08-15 23:24:09 +08:00`
- Exit price: `0.1356786`
- Position closed: `716 H`
- Holding time: `2h 18m 14s`
- Binance displayed realized PnL: **`+2.72 USDT`**
- Binance displayed ROI: **`+5.45%`**
- Exit reason: **manual close after market-cap rank data-quality invalidation**.
- Planned +30% stop was not hit.
- Fees: `Pending / not visible in supplied screenshot`.
- Funding received/paid: `Pending / not visible in supplied screenshot`.
- MAE / MFE: `Pending`.
- Clean strategy sample: **No**.

Operational lesson: the trade happened to close profitably, but the result must not be used as evidence that the v5 signal was valid. The entry violated the intended Top-100 exclusion once the rank-source conflict was discovered.
