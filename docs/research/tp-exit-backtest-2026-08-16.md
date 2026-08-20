# 180D Take-Profit Exit Comparison — 2026-08-16

Status: **research only / not production**

## Frozen entry rule

- Binance USDT perpetual
- Current v6 conservative rank proxy: CMC rank 101–500, with CoinGecko Top-100 conflict exclusion
- Listed >= 90 days
- Historical 24H quote volume >= 20M USDT
- Live Daily Wilder RSI(6) > 93 at 00:00 UTC+8
- 7D return > 20%
- Funding percentile >= trailing 90D P90
- Same-symbol cooldown: 72h
- Entry: next 1H open

## Common exit/risk assumptions

- 1,000 USDT notional per trade for comparison only
- Hard stop: underlying +30% from entry
- Maximum hold: 72h
- Taker fee: 0.05% per fill side
- Settled funding included
- Conservative intrabar assumption: if stop and TP are both touched inside the same 1H candle, stop is assumed first

## Sample

- Window: approximately 2026-02-15 through 2026-08-13
- Mature signals: **19**
- The initial full-universe run hit Binance rate limits on 18 symbols; those symbols were separately re-scanned. One additional valid signal, CYSUSDT on 2026-08-12, was found and added before final comparison.

## Results

| Exit | Trades | Win rate | Net PnL (U) | Avg/trade (U) | PF | Max DD (U) |
|---|---:|---:|---:|---:|---:|---:|
| Baseline: 72h / no TP | 19 | 57.9% | +381.9 | +20.1 | 1.21 | -606.9 |
| TP 10% | 19 | 68.4% | +26.3 | +1.4 | 1.02 | -704.5 |
| TP 15% | 19 | 68.4% | +373.3 | +19.6 | 1.29 | -628.9 |
| **TP 20%** | **19** | **68.4%** | **+776.9** | **+40.9** | **1.61** | **-601.9** |
| TP 25% | 19 | 63.2% | +598.0 | +31.5 | 1.38 | -601.9 |
| TP15 half + remainder 72h | 19 | 57.9% | +377.6 | +19.9 | 1.27 | -601.9 |
| TP15 half + remainder breakeven | 19 | 68.4% | +28.9 | +1.5 | 1.02 | -601.9 |
| Profit 10% -> 5% trail | 19 | 68.4% | -465.2 | -24.5 | 0.63 | -794.5 |
| Profit 10% -> 8% trail | 19 | 68.4% | -311.4 | -16.4 | 0.76 | -789.3 |
| Profit 10% -> 10% trail | 19 | 68.4% | -297.9 | -15.7 | 0.77 | -603.5 |
| TP15 half + 5% trail remainder | 19 | 68.4% | +330.1 | +17.4 | 1.26 | -604.6 |
| TP15 half + 8% trail remainder | 19 | 68.4% | +567.7 | +29.9 | 1.45 | -601.9 |
| TP15 half + 10% trail remainder | 19 | 68.4% | +580.4 | +30.5 | 1.46 | -601.9 |

## Interpretation

The strongest tested exit was a **full fixed TP at -20% underlying move**, while retaining the existing +30% hard stop and 72h time stop.

Why it helped in this sample: several trades experienced the intended sharp mean-reversion drop of ~20% and then rebounded materially. A fixed TP20 captured that transient reversal; the baseline later gave much of it back, and some positions ultimately became large losers. Conversely, TP10 exited too early and destroyed payoff asymmetry, while pure trailing exits activated too early and repeatedly cut winners before the larger reversal developed.

Partial TP15 + trailing the remainder was more robust than pure trailing, especially with 8–10% trail distances, but still underperformed fixed TP20 on both net PnL and profit factor.

## Important limitations

- Only 19 mature signals: too small to claim a universal optimum.
- Market-cap ranks are current-rank proxies, not point-in-time historical ranks.
- Only currently active Binance perpetual contracts are included, so survivorship bias remains.
- Historical catalyst/news veto is not replayed.
- 1H OHLC cannot resolve exact intrabar ordering; conservative stop-first logic is used.
- A 30% underlying stop on 1,000U notional means ~300U tail loss per stopped trade. Position sizing remains more important than the TP choice.

## Research conclusion

For the next forward-test iteration, the leading candidate is:

> **Full TP at -20% / hard stop +30% / max hold 72h / no loser averaging / 72h same-symbol cooldown.**

Do not update production solely from this sample without explicitly accepting the small-sample and rank-history limitations.
