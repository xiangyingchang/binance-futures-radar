# Exhaustion Short Strategy

> Status: **Live forward-test / pilot**  
> Production strategy version: `exhaustion-short-radar-v5-rsi6-funding-pilot`  
> Last updated: 2026-08-15

## 1. Goal

This strategy looks for **short-term exhaustion in overheated altcoin perpetual futures**. The thesis is not “a coin rose too much, therefore short it”. The intended setup is:

> Smaller-cap altcoin + extreme short-term price acceleration + crowded longs + no clear value re-rating + defined risk.

The radar is a **screening and research tool**, not an automatic trading system.

## 2. Current live strategy (frozen pilot rule)

A symbol is eligible for the live pilot only when all hard filters below are satisfied.

### 2.1 Universe

- Binance USDⓈ-M USDT perpetual contract.
- Exclude stablecoins, wrapped assets and obvious non-target assets.
- Listed for at least **90 days**.
- 24H quote volume at least **20M USDT**.
- Target market-cap rank: **101–500**.
- **Top 100 is a hard exclusion.**

### 2.2 Heat gate

- Live Daily **Wilder RSI(6) > 93**.
- 7-day return **> 20%** using current live price.

RSI(6) is intentionally used instead of RSI(14) for this strategy because the latest 180-day research pass showed better separation of short-term speculative blow-offs. This is strategy-specific and should not be generalized to all RSI use cases.

### 2.3 Crowding gate

- Current perpetual funding rate percentile over the symbol's trailing 90-day funding history must be **>= P90**.

Status convention:

- `SHORT_SETUP`: hard universe/heat gate passed + Funding >= P90.
- `STRONG_WATCH`: hard universe/heat gate passed + Funding P75–P90.
- `WATCH`: heat gate passed but funding crowding is incomplete.

### 2.4 Reference-only signals

The following are recorded and scored but are **not hard gates** in the current pilot:

- OI 24H / 7D change.
- 1H RSI exhaustion.
- 4H RSI exhaustion.
- 1H / 4H structure break.
- Bearish divergence.

They may become hard gates in a later version only if forward-test / out-of-sample evidence supports it.

## 3. Manual catalyst review

Every `SHORT_SETUP` still requires manual review before a trade.

Reject or downgrade the setup when the move is plausibly a genuine value re-rating or event-driven repricing, including but not limited to:

- major listing / relisting;
- token migration or supply change;
- material protocol upgrade;
- acquisition / partnership with meaningful economics;
- large buyback or tokenomics change;
- regulatory event;
- major revenue / business-model change;
- security incident recovery or compensation plan.

The radar must never treat RSI or funding as a substitute for catalyst analysis.

## 4. Exit rule — current forward-test version

For the frozen pilot:

- **Maximum holding period: 72 hours / 3 days.**
- **Hard stop: underlying price +30% from actual entry price.**
- No fixed take-profit in the current pilot.
- No adding to a losing short.
- Do not widen the stop after entry.

This exit rule is intentionally kept unchanged during forward testing so live trades remain comparable with the research version.

## 5. Position sizing

The +30% hard stop is a **price-distance parameter**, not an acceptable account-level loss.

Use:

`notional = allowed_account_loss / stop_distance_pct`

Example:

- Account: 1,000 USDT
- Allowed loss per trade: 1% = 10 USDT
- Stop distance: 30%
- Maximum notional ≈ 33 USDT

Leverage should only reduce margin usage. It must not be used to increase the strategy's allowed account loss.

## 6. Data sources

### Binance

Used for:

- futures universe;
- klines;
- 24H quote volume;
- funding rate / funding history;
- OI history;
- intraday reference signals.

### Market-cap rank

**This is currently the most important known data-quality issue.**

The production code currently prefers **CoinGecko** rank and falls back to a Binance-derived market-cap proxy. Binance's app displays market-cap information sourced from **CoinMarketCap (CMC)**.

On 2026-08-15, `HUSDT / Humanity` exposed a material disagreement:

- Production radar / CoinGecko path: approximately **#134**.
- Binance app / CMC display: **#69**.

Because **Top 100 is a hard exclusion**, a rank-source disagreement around the #100 boundary can create a false `SHORT_SETUP`.

### Required conservative rule going forward

Until a reliable authoritative CMC point-in-time rank source is integrated:

1. If any trusted rank source shows `rank <= 100`, the symbol should be **rejected from SHORT_SETUP**.
2. If rank sources disagree across the Top-100 boundary, status should become `RANK_CONFLICT / REVIEW`, never `SHORT_SETUP`.
3. Rank source and observed rank must be stored with every forward-test entry.
4. Historical backtests must use point-in-time rank where possible; current rank must not silently substitute for historical rank.

## 7. Current research evidence

The latest internal research pass used the following frozen candidate rule:

- Rank 101–500
- listed >=90d
- 24H volume >=20M
- Daily RSI(6) >93
- 7D return >20%
- Funding >= trailing 90D P90
- max hold 3D
- +30% hard stop

The 180-day sample was promising but small (roughly low-double-digit mature trades), so it is **not sufficient to establish long-run profitability**. Forward-test results must be accumulated before increasing risk.

Do not optimize parameters after every individual trade.

## 8. Forward-test logging

Human-readable log:

- `FORWARD_TEST_LOG.md`

Machine-readable source:

- `data/forward-tests.jsonl`

For every live trade, record at minimum:

- trade ID;
- entry time / price;
- notional;
- strategy version;
- rank + rank source;
- RSI(6);
- 7D return;
- funding percentile and raw funding;
- OI reference;
- catalyst-review result;
- stop price;
- exit time / price;
- realized PnL;
- fees;
- funding received / paid;
- MAE;
- MFE;
- exit reason;
- any data-quality issue.

## 9. Strategy change policy

A production strategy change should follow this order:

1. State the hypothesis.
2. Backtest without changing production.
3. Freeze candidate parameters.
4. Validate on a longer / out-of-sample window.
5. Record limitations and bias risks.
6. Deploy only after review.
7. Forward-test with small risk.
8. Reassess after a meaningful sample, preferably 20 / 50 / 100 trades.

Avoid changing parameters because of one winning or losing trade.

## 10. Acceptance metrics for future versions

Metrics to track:

- trade count;
- win rate;
- expectancy per trade;
- profit factor;
- max drawdown;
- max consecutive losses;
- worst trade;
- MAE / MFE distribution;
- performance by market-cap bucket;
- performance by RSI bucket;
- performance by funding percentile bucket;
- performance by holding period;
- bull / bear / sideways regime robustness.

A higher win rate alone is not sufficient. Short strategies must be evaluated primarily on **expectancy and tail loss control**.

## 11. Version notes

### 2026-08-15 — Pilot v5

- Switched core heat filter from RSI(14)>90 to **RSI(6)>93**.
- Changed 7D return threshold from >50% to **>20%**.
- Expanded target rank to **101–500**.
- Funding >=P90 became the main crowding hard gate.
- OI and 1H/4H reversal signals changed to reference-only.
- Frozen exit at **3D max hold / +30% stop / no fixed TP**.
- Added forward-test ledger.
- Identified Top-100 **rank-source conflict** after HUSDT was #134 on the CoinGecko path but #69 in Binance's CMC display.
