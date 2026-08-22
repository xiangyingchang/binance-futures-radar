# BTC V3 — Dynamic Exposure / BTC Accumulator

> Status: **Implementation candidate in PR #16; read-only Forward Test only**  
> Research freeze date: **2026-08-22**  
> Strategy version: **`btc-v3.1-coinm`**  
> Canonical derivative: **Binance COIN-M `BTCUSD_PERP`**  
> Signal source: **BTCUSD Index Price, fully closed daily candles**  
> Primary objective: **grow BTC wealth versus 1 BTC HODL without hidden external capital**  
> Auto trading: **disabled**

## 1. Purpose

V1/V2 are altcoin exhaustion-short tools. V3 is intentionally separate.

V3 is a long-biased BTC dynamic-exposure strategy:

> Start with BTC, change portfolio-level BTC beta across market regimes, and try to end with more BTC than passive HODL while avoiding catastrophic leverage risk.

V3 is not a grid, not a generic leveraged BTC long, and not a signal to constantly trade.

## 2. Independent reviewer decision

The 2026-08-22 independent review kept the strategy thesis but found a material accounting flaw in the earlier exploratory implementation: it combined a `1 BTC core` with a USDⓈ-M overlay without fully defining where the USDT margin came from.

The owner approved the reviewer recommendation to make **COIN-M** the canonical V3 model.

Why:

- `BTCUSD_PERP` is BTC-margined and BTC-settled;
- no hidden USDT capital needs to be injected;
- derivative PnL naturally increases or decreases BTC;
- the benchmark can honestly remain `1 BTC -> X BTC`;
- liquidation and funding are modeled on the actual instrument intended for V3.

All older USDⓈ-M V3 results such as `1.62 BTC` or `1.47 BTC` are therefore **exploratory strategy-family evidence only**. They are not canonical V3 performance claims.

## 3. Frozen V3.1 signal model

The following signal parameters were frozen on 2026-08-22. Future wins or losses are not a reason to tune V3.1.

### 3.1 Trend score

Use only fully closed BTCUSD Index Price daily candles.

Add one point for each condition:

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

This means V3 economically hedges BTC beta through COIN-M futures. It does not mean the long-term BTC asset must be sold.

### 3.3 Valuation adjustment

Valuation is subordinate to trend.

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

`2.00x` is a tactical permission, not the normal production target.

The first read-only V3.1 implementation uses:

`public_margin_cap = 1.50x`

Therefore:

`raw_signal_target = bear_lock ? 0 : min(valuation_adjusted_target, volatility_cap, 2.00)`

`final_target = min(raw_signal_target, margin_cap)`

The first review document briefly contained `min(regime_target, valuation_adjusted_target, volatility_cap)`. That formula was a documentation error because it mathematically prevents valuation from ever increasing exposure above the base regime target. The implementation uses the intended logic above; no signal parameter was tuned as part of this correction.

Any future final target above 1.50x requires a separate account-aware margin/liquidation review.

## 4. Exposure interpretation

Net BTC exposure is portfolio beta, **not the exchange leverage selector**.

| Target | Meaning |
| ---: | --- |
| 0.00x | BTC beta economically hedged |
| 0.50x | defensive half-beta |
| 0.75x | defensive long |
| 1.00x | BTC HODL-equivalent beta |
| 1.25x | moderate long overlay |
| 1.50x | normal aggressive V3 upper range |
| 2.00x | tactical research permission only |

For a reference account with `equity_btc` BTC:

`overlay_btc = (target_exposure - 1) * equity_btc`

For a COIN-M contract with USD face value `contract_size_usd`:

`contracts ~= overlay_btc * BTC_price / contract_size_usd`

Contracts are integer-rounded, so very small accounts will have small tracking error versus the theoretical target.

## 5. Canonical COIN-M accounting

The implementation uses inverse-contract payoff math.

For signed contract quantity `q` where positive means long and negative means short:

`PnL_BTC = q * contract_size_usd * (1 / price_start - 1 / price_end)`

Funding is accounted in BTC:

`funding_PnL_BTC = -(q * contract_size_usd / mark_price) * funding_rate`

Positive funding therefore costs longs and pays shorts.

The canonical benchmark starts with **1 BTC and no extra USDT capital**.

## 6. Data separation

To avoid quietly changing the strategy while changing the execution instrument:

- **Signal:** BTCUSD Index Price daily candles
- **Execution instrument:** `BTCUSD_PERP` COIN-M perpetual
- **Funding:** `BTCUSD_PERP` COIN-M funding history
- **Funding/backtest mark:** `BTCUSD_PERP` mark-price candles
- **Contract metadata:** COIN-M exchange info, including `contractSize`, `marginAsset`, onboard date and status

Perpetual basis/funding noise affects execution economics. It does not redefine the frozen BTC trend signal.

## 7. Anti-overfitting and data-bias protocol

### 7.1 No look-ahead

- only fully closed daily candles enter the signal;
- the Forward Test stores candle timestamps and observation timestamps;
- historical signal from T-1 is executed no earlier than T open;
- a funding calculation may use only a mark candle already closed at the funding timestamp;
- current-day high/low/close may never influence the position chosen at that day's open.

### 7.2 Slippage must always hurt

The canonical backtest explicitly prices worse fills against the reference open. A buy fill above the reference price or sell fill below it must reduce BTC equity.

A 2026-08-22 implementation audit caught and fixed an early sign error that had accidentally made adverse slippage look profitable. Results produced before that fix are invalid.

### 7.3 Funding mark must be point-in-time

A 2026-08-22 implementation audit also caught an early look-ahead issue where a 4H mark candle containing the funding timestamp could contribute its future close.

The backtest now selects only the latest mark candle whose **close time is <= funding timestamp**.

Results produced before that fix are invalid.

### 7.4 Instrument availability

Executable COIN-M history begins no earlier than the actual `BTCUSD_PERP` onboard date.

Older BTC history may be used for regime research but cannot be presented as executable COIN-M performance.

### 7.5 Conservative warm-up

The canonical backtest does not import a different pre-launch data source simply to create a one-year indicator warm-up. Until enough canonical index history has accumulated, target exposure remains at the neutral `1.00x` benchmark.

This sacrifices potential historical alpha but avoids cross-source hindsight choices.

### 7.6 Historical margin precision

Historical Binance maintenance-margin tiers are not assumed to equal today's rules.

Where exact point-in-time tier history is unavailable, the research backtest uses a conservative static maintenance-rate stress assumption and labels it approximate rather than fabricating precision.

### 7.7 Costs

Canonical backtest includes:

- inverse COIN-M PnL;
- actual COIN-M funding where retrieved;
- integer contract rounding;
- trading fee assumption;
- execution slippage assumption;
- same-day adverse high/low maintenance stress.

Default sensitivity baseline in `scripts/btc-v3-backtest.js`:

- fee: `5 bps`
- slippage: `5 bps`
- stress maintenance rate: `10%`

These are execution assumptions, not strategy signals.

### 7.8 Forward data outranks more optimization

Once V3.1 starts logging unseen days, new ideas do not rewrite V3.1. A material signal change becomes V3.2 and both versions must be distinguishable.

## 8. Infrastructure and geographic-access constraint

A live test on 2026-08-22 found an important infrastructure fact:

- GitHub-hosted Actions runner region: Azure `eastus`
- direct Binance COIN-M REST request from that runner: HTTP `451`, restricted-location response

Therefore GitHub Actions must **not** be used as the Binance market-data computation environment for V3.

The final Forward Test architecture separates computation from audit persistence:

1. Vercel function runs in `sin1` and computes `/api/btc-v3` from Binance COIN-M public data.
2. The response includes signal details plus deployed code commit provenance where available.
3. GitHub Actions runs at 00:17 UTC and fetches that Vercel snapshot over ordinary HTTPS.
4. GitHub appends the returned snapshot to `data/btc-v3-forward-test.jsonl`.
5. The ledger stores both signal-code SHA and ledger-writer SHA.

This keeps the audit trail Git-native without making the strategy dependent on GitHub Runner geography.

If the Vercel endpoint is unavailable or returns an invalid safety contract, the Action appends a failure record rather than reconstructing the missing signal later.

## 9. Forward-test architecture

Implemented files:

- `lib/btc-v3-strategy.js` — deterministic signal + inverse-contract math
- `lib/binance-coinm.js` — Binance COIN-M public data adapter
- `lib/btc-v3-snapshot.js` — current auditable snapshot builder
- `api/btc-v3.js` — read-only V3 endpoint
- `tests/btc-v3-strategy.test.js` — deterministic strategy tests
- `scripts/btc-v3-backtest.js` — canonical exact-instrument research backtest
- `scripts/btc-v3-forward-test.js` — remote snapshot collector + append-only writer
- `data/btc-v3-forward-test.jsonl` — immutable Forward Test ledger
- `.github/workflows/btc-v3-forward-test.yml` — scheduled audit persistence at 00:17 UTC
- `btc-v3.html`, `btc-v3.js`, `btc-v3.css` — standalone V3 dashboard

The existing V1/V2 signal code is not modified.

## 10. Forward-test record integrity

A successful record stores at minimum:

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
- signal deployment code SHA where available;
- ledger writer SHA;
- `reconstructed=false`;
- `autoTrade=false`.

Integrity rules:

- never overwrite an observed successful date;
- never backfill a missing date and call it live;
- failure is logged instead of hidden;
- reruns do not replace a successful record;
- reconstructed research data, if ever added, must be explicitly tagged and excluded from primary Forward Test statistics.

## 11. Canonical backtest status

The canonical COIN-M backtest code is implemented but **its result is not yet accepted**.

The first automated run on GitHub failed before loading market data because Binance returned HTTP 451 to the eastus runner. That failure is an infrastructure limitation, not a backtest result.

The canonical script must be executed from a Binance-accessible environment or against verified Binance public historical archives. Only then may its result be added to this document.

Do not substitute the old USDⓈ-M numbers.

## 12. V3 and V2 separation

V2 remains the altcoin exhaustion-short Forward Test.

V3 uses explicit `btc-v3-*` naming. Existing historical frontend filenames such as `app-v3.js` are unrelated UI revisions and are not reused.

No V1/V2 entry rule, score or endpoint is changed by V3.

## 13. Automation scope

Current V3 is intentionally:

> **read-only signal + auditable Forward Test**

`autoTrade=false`.

No Binance API key, signed order endpoint, leverage mutation, autonomous order placement or position reconciliation is included.

Live capital requires a separate approval after:

1. canonical COIN-M backtest is successfully run and reviewed;
2. unseen Forward Test data accumulates;
3. account-aware margin/liquidation model is approved, especially for any target above 1.50x;
4. authenticated execution sizing, fill handling, reconciliation and kill-switch logic receive a separate review.

## 14. Acceptance criteria before live capital

- [x] canonical derivative chosen: `BTCUSD_PERP` COIN-M
- [x] BTC margin/settlement model chosen
- [x] deterministic signal module implemented
- [x] inverse payoff/funding math unit-tested
- [x] read-only API implemented
- [x] geographic market-data constraint explicitly handled
- [x] append-only Forward Test architecture implemented
- [x] V3 kept separate from V1/V2
- [x] `autoTrade=false`
- [ ] production `/api/btc-v3` verified against real COIN-M data after deploy
- [ ] first immutable scheduled Forward Test record committed
- [ ] canonical COIN-M backtest successfully run and reviewed
- [ ] meaningful unseen Forward Test sample accumulated
- [ ] account-aware Margin Gate approved for any final target >1.50x
- [ ] authenticated execution receives separate review

## 15. Change log

### 2026-08-22 — Implementation audit v2

- Found GitHub hosted runners receive Binance HTTP 451 from Azure eastus.
- Moved Forward Test market-data computation to Vercel `sin1`; GitHub now only persists immutable snapshots.
- Added deployed-code provenance to `/api/btc-v3` snapshots.
- Separated signal-code SHA from ledger-writer SHA.
- Caught and fixed adverse-slippage sign inversion in the canonical backtest.
- Caught and fixed funding mark-candle look-ahead in the canonical backtest.
- Invalidated any canonical backtest result that would have been produced before those fixes.
- Removed the region-blocked canonical-backtest CI check.

### 2026-08-22 — Implementation candidate / PR #16

- Owner approved COIN-M as the canonical V3 instrument model.
- Frozen `BTCUSD_PERP`, BTC margin/settlement and BTCUSD Index signal source.
- Added deterministic V3.1 signal module and inverse COIN-M accounting.
- Added conservative public Margin Cap of 1.50x.
- Added `/api/btc-v3` read-only endpoint and standalone dashboard.
- Added append-only Forward Test ledger and scheduler.
- Added canonical exact-instrument backtest script.
- Added V3 modules to CI and Vercel Singapore function configuration.
- Auto-trading remains disabled.

### 2026-08-22 — Independent review v1

- Separated V3 from V1/V2.
- Reclassified prior USDⓈ-M results as exploratory evidence.
- Identified derivative/margin accounting as a production blocker.
- Recommended COIN-M and received owner approval.
- Added anti-overfitting, no-backfill and code-provenance requirements.
