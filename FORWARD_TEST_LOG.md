# Forward Test Log

This file is the human-readable index for live strategy validation. The machine-readable source of truth is [`data/forward-tests.jsonl`](data/forward-tests.jsonl).

## Rules for logging

- One immutable record per trade ID; updates should preserve the original entry snapshot and add exit / MAE / MFE fields rather than rewriting history.
- Record the radar signal snapshot at entry so later analysis does not use future information.
- Do not store exchange account IDs, balances, API keys, or other sensitive account data.
- For the current pilot, `SHORT_SETUP` still requires manual catalyst review and independent position sizing.

## FT-001 — HUSDT SHORT — OPEN · DATA QUALITY FLAG

- Recorded: 2026-08-15 21:11 +08:00
- Strategy: `exhaustion-short-radar-v5-rsi6-funding-pilot`
- Entry price: `0.1395799`
- Notional: `99.88 USDT`
- Margin: `49.99 USDT`
- Leverage / mode: `2x / Cross`
- Hard stop: `0.18145387` (+30% from entry)
- Max hold: `3 days`
- Add to loser: `No`

### Risk-control execution

- Stop order confirmed: `2026-08-15 21:12:20 +08:00`
- Order type: `Stop Market / Close Short`
- Trigger: latest price `>= 0.1814500`
- Reduce-only: `Yes`
- No fixed take-profit for FT-001; exit rule remains `hard stop OR 72h max hold` so the live test stays comparable with the frozen backtest rule.

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
- This conflicts with the production radar's CoinGecko rank of approximately **#134**.
- Because the strategy defines **Top 100 as a hard exclusion**, FT-001 is **not a clean strategy-validation sample**.
- Keep the trade record for operational learning, but exclude it from clean strategy performance statistics unless the rank-source policy is later resolved in a way that validates the original entry.

### Exit / review

Pending. On close, append actual exit time/price, realized PnL, fees, funding, MAE, MFE, exit reason, and whether the signal remained valid during the trade.
