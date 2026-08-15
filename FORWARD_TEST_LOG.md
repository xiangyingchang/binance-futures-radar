# Forward Test Log

This file is the human-readable index for live strategy validation. The machine-readable source of truth is [`data/forward-tests.jsonl`](data/forward-tests.jsonl).

## Rules for logging

- One immutable record per trade ID; updates should preserve the original entry snapshot and add exit / MAE / MFE fields rather than rewriting history.
- Record the radar signal snapshot at entry so later analysis does not use future information.
- Do not store exchange account IDs, balances, API keys, or other sensitive account data.
- For the current pilot, `SHORT_SETUP` still requires manual catalyst review and independent position sizing.

## FT-001 — HUSDT SHORT — OPEN

- Recorded: 2026-08-15 21:11 +08:00
- Strategy: `exhaustion-short-radar-v5-rsi6-funding-pilot`
- Entry price: `0.1395799`
- Notional: `99.88 USDT`
- Margin: `49.99 USDT`
- Leverage / mode: `2x / Cross`
- Hard stop: `0.18145387` (+30% from entry)
- Max hold: `3 days`
- Add to loser: `No`

### Entry signal snapshot

- Market-cap rank: `#134`
- Live Daily RSI(6): `97.98`
- Closed Daily RSI(6): `96.50`
- 7D return: `+74.05%`
- Funding percentile (90D): `P97.13`
- Funding rate: `0.076585% / 4h`
- OI 24H / 7D: `+1.10% / +6.53%`
- Reversal signals: `1`
- Radar status: `SHORT_SETUP`

### Exit / review

Pending. On close, append actual exit time/price, realized PnL, fees, funding, MAE, MFE, exit reason, and whether the signal remained valid during the trade.
