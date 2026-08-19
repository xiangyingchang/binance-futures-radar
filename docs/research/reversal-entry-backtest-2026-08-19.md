# Reversal Entry Timing Backtest — 2026-08-19

Research only. Do **not** merge into production strategy from this result alone.

## Question

For the same 19 mature V2-style historical signals used in the prior TP-exit study, is it better to:

1. short immediately when the V2 signal appears, or
2. wait for a reversal trigger before entering?

## Common trade rules

- Signal sample: 19 mature signals from the prior 180d TP research
- Notional: 1,000 USDT per trade (research normalization only)
- Take profit: underlying -20%
- Hard stop: underlying +30%
- Maximum hold: 72h from actual entry
- Delayed trigger max wait: 48h unless otherwise noted
- Entry after trigger: next 1H open (no same-candle lookahead)
- Same-candle TP/SL ambiguity: stop-first (conservative)
- Fees: 0.05% taker on entry and exit
- Funding: excluded in this entry-timing run
- Klines: Binance official public USD-M Futures archive (`data.binance.vision`), corresponding to `/fapi/v1/klines`

Sanity check: immediate TP20 result excluding funding = **+757.906U**. Prior TP20 research including funding = **+776.9U**, with prior funding contribution about **+19.0U**. This near-exact bridge validates that the archive replay and signal timestamps are aligned with the prior study.

## Main comparison

| Entry rule | Trades | Coverage | Win rate | TP20 | SL30 | Net U | PF | Max DD U | Avg MAE | Median MAE | Avg delay |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Immediate** | **19** | **100%** | **68.4%** | **8** | **4** | **+757.9** | **1.60** | **-704.4** | **15.4%** | **12.9%** | 0h |
| 1H RSI cross below 80 | 8 | 42.1% | 50.0% | 4 | 4 | -408.2 | 0.66 | -1005.5 | 22.6% | 33.1% | 3.0h |
| 4H bearish divergence | 12 | 63.2% | 58.3% | 3 | 4 | -334.0 | 0.74 | -837.3 | 16.1% | 7.9% | 8.7h |
| 1H structure break | 19 | 100% | 57.9% | 6 | 6 | -554.1 | 0.72 | -1204.4 | 19.7% | 14.1% | 9.3h |
| **4H structure break (<=48h)** | **18** | **94.7%** | **61.1%** | **6** | **4** | **+299.6** | **1.21** | **-766.5** | **15.7%** | **8.5%** | 18.2h |
| Any 1 of 4 | 19 | 100% | 57.9% | 6 | 6 | -422.7 | 0.78 | -1012.3 | 17.6% | 14.1% | 3.7h |
| Any 2 of 4 | 19 | 100% | 52.6% | 5 | 6 | -526.9 | 0.74 | -1177.3 | 20.8% | 13.5% | 12.6h |
| RSI<80 OR 1H break | 19 | 100% | 57.9% | 6 | 6 | -554.1 | 0.72 | -1033.8 | 19.1% | 14.1% | 4.6h |

### Immediate conclusion

Naive reversal confirmation **does not improve the strategy** on this sample. Most delayed rules reduce win rate, worsen MAE, and turn the positive TP20 baseline into a negative strategy.

The reason is visible trade-by-trade: many triggers occur **after the first dump**, so the delayed entry becomes a chase-short into the rebound instead of a safer top entry.

Examples:

- `BUSDT 2026-05-03`: immediate TP20 +199.1U; 4H break enters after the dump and later stops -301.15U.
- `BEATUSDT 2026-06-12`: immediate TP20 +199.1U; 4H break enters 8h later and stops -301.15U.
- `ORDIUSDT`: immediate TP20 +199.1U; 1H structure-break entry turns into -301.15U.
- `TUTUSDT`: immediate entry stops -301.15U, while later 1H/4H structure break would have converted it into TP20. This is the useful side of confirmation, but it is not consistent enough across the 19 signals.

## Exploratory: 4H structure-break timing window

4H structure break was the only individual delayed trigger that remained profitable at the original <=48h window. Re-cutting the **same sample** by maximum trigger delay gives:

| 4H break must occur within | Trades | Coverage | Win rate | TP20 | SL30 | Net U | PF | Max DD U | Avg MAE | Median MAE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| <=8h | 5 | 26.3% | 40.0% | 1 | 2 | -488.3 | 0.38 | -788.7 | 23.3% | 19.1% |
| <=12h | 9 | 47.4% | 55.6% | 3 | 2 | -46.4 | 0.94 | -598.9 | 17.9% | 11.6% |
| **<=16h** | **13** | **68.4%** | **69.2%** | **6** | **2** | **+713.8** | **1.89** | **-435.9** | **14.2%** | **8.4%** |
| **<=24h** | **14** | **73.7%** | **71.4%** | **6** | **2** | **+779.1** | **1.98** | **-435.9** | **13.8%** | **8.5%** |
| <=36h | 16 | 84.2% | 62.5% | 6 | 3 | +448.6 | 1.40 | -766.5 | 15.3% | 8.5% |
| <=48h | 18 | 94.7% | 61.1% | 6 | 4 | +299.6 | 1.21 | -766.5 | 15.7% | 8.5% |

This suggests a possible **timing window**, not simply “wait longer for confirmation.” If a 4H break occurs relatively soon (roughly 16–24h), the sample looks much better than waiting up to 48h.

However, this 16–24h window was identified **after inspecting the same 19 trades**, so it is post-hoc and highly vulnerable to overfitting. It must not be promoted to a production gate without out-of-sample validation.

A simple early/late split also shows instability: for the <=24h 4H-break variant, the first 9 original signals contribute only about +64.3U (6 triggered trades), while the last 10 contribute about +714.8U (8 triggered trades). That is not yet robust.

## Interpretation

The useful lesson is **not** “reversal confirmation is wrong.” It is:

> A confirmation that arrives after a large first leg down can destroy the short entry price and create rebound risk.

The next entry-timing research should therefore test **non-chasing confirmation**, for example:

- 4H structure break must occur within a fixed early window (pre-register 16h / 24h before running new samples), and/or
- reject delayed entries if price has already fallen too far from the original signal price (e.g. >5% / >10%), and/or
- failed breakout / retest entry rather than first downside break.

## Decision for production

**No production entry-rule change yet.**

The current immediate V2 + TP20 / SL30 / 72h baseline remains the best validated version on the original 19-signal sample. The <=16–24h 4H-break result is interesting enough to forward-test / test out-of-sample, but not strong enough to replace the baseline.
