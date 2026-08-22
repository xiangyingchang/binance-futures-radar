# BTC V3 — Dynamic Exposure / BTC Accumulator

> Status: **Implementation candidate in PR #16; read-only Forward Test only**  
> Research freeze date: **2026-08-22**  
> Canonical instrument approved: **Binance COIN-M `BTCUSD_PERP`**  
> Signal price source: **Binance BTCUSD Index Price daily candles**  
> Strategy version: **`btc-v3.1-coinm`**  
> Primary objective: **increase BTC wealth versus 1 BTC HODL without hidden external capital**

## 1. Purpose

V1/V2 are altcoin exhaustion-short tools. V3 is intentionally separate.

V3 is a long-biased BTC inventory / dynamic-beta strategy:

> Start with BTC, change net BTC exposure across market regimes, and try to finish with more BTC than passive HODL while controlling catastrophic drawdown risk.

V3 is not a grid, not a generic 2x BTC strategy, and not an automatic trading system.

## 2. Independent reviewer decision

The 2026-08-22 review kept the core thesis but found that earlier exploratory backtests had not fully specified futures collateral. That was a material accounting problem.

The owner approved the reviewer recommendation to use **COIN-M** as the canonical implementation.

Why:

- `BTCUSD_PERP` is BTC-margined and BTC-settled;
- no extra USDT reserve is required to make the strategy work;
- derivative PnL naturally increases or decreases BTC;
- the benchmark can honestly remain `1 BTC -> X BTC`;
- USDⓈ-M exploratory results do not get silently carried into the production statistics.

All old V3 USDⓈ-M results (`1.62 BTC`, `1.47 BTC`, etc.) are therefore classified as **strategy-family exploration only**, not canonical V3 performance.

## 3. Frozen V3.1 signal model

These parameters were frozen on 2026-08-22. Future performance is not a reason to tune V3.1.

### 3.1 Trend score

Use **fully closed BTCUSD Index Price daily candles**.

Add one point for each:

1. `Close > MA200`
2. `EMA15 > EMA30`
3. `MA200 slope over 30 days > 0`

| Trend score | Base target exposure |
| --- | ---: |
| 0 | 0.50x |
| 1 | 0.75x |
| 2 | 1.00x |
| 3 | 1.25x |

### 3.2 Bear Lock

If both are true:

- `Close < MA200`
- `MA200 30D slope < 0`

then:

`valuation_adjusted_target = 0.00x`

This is an economic hedge of the BTC beta using COIN-M futures. It does not mean V3 sells the long-term BTC asset by default.

### 3.3 Valuation adjustment

Valuation can increase exposure only when trend has already improved.

- `cheap`: trailing 365D drawdown <= -20% **or** MA200 deviation <= -10%
- `very cheap`: trailing 365D drawdown <= -35% **or** MA200 deviation <= -20%

Adjustment:

- Trend 2 + cheap -> up to `1.25x`
- Trend 3 + cheap -> up to `1.50x`
- Trend 3 + very cheap -> raw tactical request may reach `2.00x`

A falling market never gets 2.00x simply because price is cheap.

### 3.4 Volatility gate

Use 30D realized volatility from closed daily simple returns, annualized with 365 days.

`volatility_cap = clamp(0.60 / RV30, 0.50, 2.00)`

### 3.5 Margin gate

`2.00x` remains a tactical permission, not the normal production target.

The first public/read-only V3.1 implementation uses a conservative static:

`public_margin_cap = 1.50x`

Therefore:

`raw_signal_target = bear_lock ? 0 : min(valuation_adjusted_target, volatility_cap, 2.00)`

`final_target = min(raw_signal_target, margin_cap)`

This corrects a formula typo in the first review document. The previous written formula included `regime_target` inside the final `min(...)`, which would have made the valuation adjustment mathematically unable to increase exposure. The implementation follows the intended and previously backtested logic above.

A future account-aware implementation may allow a final target above 1.50x only after a separate margin/liquidation review. That would be a new implementation revision, not a silent V3.1 parameter edit.

## 4. Exposure meaning

Net BTC exposure is portfolio beta, **not the Binance leverage selector**.

| Target | Meaning |
| ---: | --- |
| 0.00x | BTC beta economically hedged |
| 0.50x | defensive half-beta |
| 0.75x | defensive long |
| 1.00x | BTC HODL-equivalent beta |
| 1.25x | moderate long overlay |
| 1.50x | normal aggressive V3 upper range |
| 2.00x | tactical research permission only |

For a 1 BTC reference account and a $100 COIN-M contract size, the futures overlay is approximately:

`overlay_btc = (target_exposure - 1) * equity_btc`

`contracts ~= overlay_btc * BTC_price / contract_size_usd`

Contract quantity is integer-rounded, so realized exposure will not exactly equal the theoretical target for very small accounts.

## 5. Canonical COIN-M accounting

The implementation uses inverse COIN-M payoff math.

For signed contract quantity `q` (positive long, negative short):

`PnL_BTC = q * contract_size_usd * (1 / price_start - 1 / price_end)`

Funding is modeled in BTC from actual COIN-M funding rates:

`funding_PnL_BTC = -(q * contract_size_usd / mark_price) * funding_rate`

Positive funding therefore costs long positions and pays short positions.

The strategy starts from **1 BTC**, with no extra USDT capital injected into the benchmark.

## 6. Data separation

To avoid silently changing the strategy:

- **Signal:** BTCUSD Index Price daily candles
- **Execution instrument:** `BTCUSD_PERP` COIN-M perpetual
- **Funding:** `BTCUSD_PERP` COIN-M funding history
- **Mark price for funding/backtest:** `BTCUSD_PERP` mark-price candles
- **Contract metadata:** COIN-M exchange info, including live `contractSize` and `marginAsset`

Using index price for the signal preserves the frozen BTC-market regime logic. Perpetual basis/funding noise should affect execution economics, not redefine the trend signal.

## 7. Anti-overfitting / data-bias protocol

### 7.1 No look-ahead

- only fully closed daily candles enter the signal;
- the snapshot stores candle timestamps and observation timestamps;
- historical backtest signal for day T is executed no earlier than the next day;
- same-timestamp midnight funding is processed before the next rebalance in the canonical backtest model.

### 7.2 Instrument availability

Executable COIN-M backtest begins no earlier than the actual `BTCUSD_PERP` onboard date returned by Binance exchange metadata.

Older BTC history can be used for regime research only.

### 7.3 Point-in-time limits

Historical exchange maintenance-margin tiers are not assumed to be identical to today's rules. When exact historical tier data is unavailable, the canonical backtest uses a deliberately conservative static maintenance-rate stress test and labels it approximate.

Do not manufacture false precision.

### 7.4 Costs

Canonical backtest includes:

- inverse COIN-M payoff;
- trading fee assumption;
- slippage assumption;
- actual historical COIN-M funding;
- integer contract rounding;
- intraday high/low maintenance stress.

Default research assumptions in `scripts/btc-v3-backtest.js`:

- futures fee: `5 bps`
- execution slippage: `5 bps`
- stress maintenance rate: `10%`

These may be changed only for explicit sensitivity analysis. They are not signal parameters.

### 7.5 Forward data outranks more optimization

V3.1 remains frozen after launch. A material signal change creates V3.2 while V3.1 continues to log.

## 8. Forward-test architecture

Vercel functions are stateless, so the live API is not the forward-test ledger.

Implemented structure:

- `lib/btc-v3-strategy.js` — deterministic signal + inverse-contract math
- `lib/binance-coinm.js` — Binance COIN-M public market-data adapter
- `lib/btc-v3-snapshot.js` — auditable current snapshot builder
- `api/btc-v3.js` — current read-only V3 endpoint
- `tests/btc-v3-strategy.test.js` — deterministic strategy tests
- `scripts/btc-v3-backtest.js` — exact-instrument canonical research backtest
- `scripts/btc-v3-forward-test.js` — append-only live observation writer
- `data/btc-v3-forward-test.jsonl` — immutable observation ledger
- `.github/workflows/btc-v3-forward-test.yml` — scheduled daily snapshot after UTC candle close
- `btc-v3.html` / `btc-v3.js` / `btc-v3.css` — independent V3 dashboard

The scheduled workflow runs at **00:17 UTC**. This intentionally leaves a short buffer after the 00:00 UTC daily close.

## 9. Forward-test integrity rules

Each successful record stores:

- strategy version;
- candle date and closed OHLC;
- EMA15 / EMA30 / MA200;
- MA200 30D slope;
- 365D drawdown;
- MA200 deviation;
- RV30;
- Trend score / Bear Lock;
- cheap / very-cheap flags;
- regime / valuation / volatility / margin gates;
- raw and final target exposure;
- current funding context;
- 1 BTC reference contract sizing;
- data-quality flags;
- code commit SHA;
- `reconstructed=false`;
- `autoTrade=false`.

Rules:

- never overwrite an observed date;
- never backfill a missing date and call it live;
- a failed fetch is appended as a failure record instead of disappearing;
- reruns do not overwrite a successful record;
- reconstructed research data, if ever added, must be explicitly tagged and excluded from primary Forward Test stats.

## 10. V3 and V2 separation

V2 remains the altcoin exhaustion-short Forward Test.

V3 code uses explicit `btc-v3-*` naming. Existing historical frontend files such as `app-v3.js` are unrelated UI versions and must not be reused for the BTC strategy.

No V1/V2 entry rule is changed by V3.

## 11. Automation scope

Current implementation is intentionally:

> **read-only signal + auditable Forward Test**

`autoTrade=false`.

No API key, signed order endpoint, leverage-change endpoint or autonomous execution code is included in V3.1.

Live capital requires a separate approval after:

1. canonical COIN-M backtest completes and is reviewed;
2. Forward Test accumulates real unseen observations;
3. account-aware margin/liquidation model is reviewed;
4. execution sizing, fill handling and kill-switch logic receive a separate code review.

## 12. Acceptance criteria before live capital

- [x] canonical derivative chosen: `BTCUSD_PERP` COIN-M
- [x] BTC margin/settlement model chosen
- [x] deterministic signal module implemented
- [x] inverse payoff/funding math tested
- [x] read-only API implemented
- [x] append-only daily Forward Test implemented
- [x] V3 kept separate from V1/V2
- [x] `autoTrade=false`
- [ ] canonical COIN-M backtest run reviewed and recorded
- [ ] meaningful unseen Forward Test sample accumulated
- [ ] account-aware Margin Gate approved for any target >1.50x
- [ ] authenticated execution receives separate review

## 13. Change log

### 2026-08-22 — Implementation candidate / PR #16

- Owner approved COIN-M as the canonical V3 instrument model.
- Frozen `BTCUSD_PERP`, BTC margin/settlement and BTCUSD Index signal source.
- Added deterministic V3.1 signal module.
- Added inverse COIN-M PnL and funding helpers.
- Added conservative public Margin Cap of 1.50x; tactical 2.00x remains non-executable in the read-only public model.
- Added current `/api/btc-v3` signal endpoint.
- Added standalone `/btc-v3.html` dashboard.
- Added append-only GitHub Actions Forward Test at 00:17 UTC.
- Added canonical exact-instrument backtest script using index, perpetual, mark-price and funding data.
- Added V3 files to CI and Vercel Singapore region configuration.
- Corrected the first-review final-target formula typo; no strategy parameter was tuned.
- Auto-trading remains disabled.

### 2026-08-22 — Independent review v1

- Separated V3 from V1/V2.
- Reclassified prior USDⓈ-M results as exploratory evidence.
- Identified the derivative/margin model as a blocker.
- Recommended COIN-M for owner approval.
- Added append-only persistence, provenance and no-backfill requirements.
