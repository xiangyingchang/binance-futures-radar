# BTC V3 — Dynamic Exposure / BTC Accumulator

> Status: **Independent review complete; implementation blocked on contract/margin model decision**  
> Research freeze date: **2026-08-22**  
> Intended forward-test start: **2026-08-23 or the first day after implementation is merged**  
> Strategy family: **Long-biased BTC dynamic exposure**  
> Primary objective: **increase BTC-equivalent NAV versus 1 BTC HODL without relying on hidden external capital**

## 1. Why V3 exists

V1/V2 are altcoin exhaustion-short research tools. V3 is intentionally separate.

V3 is designed for a different objective:

> Keep BTC as the long-term asset, dynamically change net BTC exposure through market regimes, and end with more BTC-equivalent wealth than passive BTC HODL.

V3 is **not** an altcoin short strategy, not a fixed grid, and not a generic leveraged BTC long strategy.

## 2. Reviewer conclusion

The core strategy thesis remains valid:

- BTC has a long-run positive drift, so the strategy should remain structurally long-biased.
- Trend should decide whether risk can be increased.
- Valuation should influence how much risk to take, but should not independently trigger aggressive dip-buying.
- Realized volatility should cap exposure.
- A slow bear-regime lock is more robust than reacting to fast moving-average noise.
- 2.0x should be a tactical permission, not the normal target.

However, the independent review found two implementation blockers that must be resolved before production code is allowed to place or model real trades:

1. **The derivative instrument / margin model was never fully specified.**
2. **A live API alone cannot provide auditable forward-test history on the current Vercel architecture.**

The first blocker changes strategy accounting and liquidation risk, so it requires explicit owner approval before implementation.

## 3. Frozen V3.1 signal model

These parameters are frozen as the V3.1 research baseline. Do not tune them after observing future performance.

### 3.1 Trend score

Daily closed candles only.

Add one point for each condition:

1. `Close > MA200`
2. `EMA15 > EMA30`
3. `MA200 slope over 30 days > 0`

Base target exposure:

| Trend score | Base target |
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

`signal target exposure = 0.00x`

This means the portfolio is hedged to approximately zero net BTC beta. It does **not** mean selling the long-term BTC core by default.

### 3.3 Valuation adjustment

Valuation is subordinate to trend.

Research baseline:

- `cheap`: drawdown from trailing 365D high <= -20% **or** price <= 90% of MA200
- `very cheap`: drawdown from trailing 365D high <= -35% **or** price <= 80% of MA200

Adjustment:

- Trend score 2 + cheap → target up to 1.25x
- Trend score 3 + cheap → target up to 1.50x
- Trend score 3 + very cheap → tactical target may request up to 2.00x

A falling market is never allowed to request 2.00x solely because price is cheap.

### 3.4 Volatility cap

Use 30D realized volatility from closed daily returns.

Research baseline:

`volatility_cap = clamp(0.60 / RV30, 0.50, 2.00)`

The current V3.1 Balanced version uses a 60% target portfolio volatility.

### 3.5 Final signal target

Before margin constraints:

`signal_target = min(regime_target, valuation_adjusted_target, volatility_cap)`

After the live account model is defined:

`final_target = min(signal_target, margin_cap)`

The margin cap is not optional.

## 4. Exposure interpretation

Net exposure is portfolio-level BTC beta, not exchange leverage setting.

Conceptual examples:

| Net BTC exposure | Meaning |
| ---: | --- |
| 0.00x | BTC core economically hedged |
| 0.50x | half BTC beta |
| 0.75x | defensive long |
| 1.00x | equivalent to BTC HODL beta |
| 1.25x | moderate tactical long overlay |
| 1.50x | aggressive but normal V3 upper range |
| 2.00x | rare tactical maximum only |

The exchange leverage selector must never be confused with target net exposure.

## 5. Independent review blocker: derivative and margin model

This is the largest issue found in review.

The earlier exploratory backtests implicitly combined:

- `1 BTC spot core`
- a USDⓈ-M futures overlay
- portfolio-level accounting

but did not fully specify where futures margin came from.

That creates three materially different systems.

### Option A — USDⓈ-M with dedicated USDT reserve

Pros:

- simple linear PnL;
- easy to model;
- operationally clear.

Problem:

- if the initial state is `1 BTC + extra USDT`, the strategy has external capital and cannot honestly report `1 BTC → X BTC` against a pure 1 BTC benchmark;
- if BTC is sold to create the USDT reserve, the portfolio no longer starts with a 1 BTC core.

### Option B — USDⓈ-M using BTC as collateral / portfolio or multi-asset margin

Pros:

- preserves the visible BTC core;
- keeps linear BTCUSDT futures exposure.

Problems:

- collateral haircut must be modeled;
- BTC collateral and long futures deteriorate together during a crash (wrong-way collateral risk);
- historical margin rules, collateral ratios and liquidation mechanics can change over time;
- the earlier simplified liquidation stress test is not a production-grade margin simulation.

### Option C — COIN-M BTC-margined perpetual

Pros:

- margined and settled in BTC;
- no hidden external USDT capital is required;
- realized derivative PnL naturally accumulates or loses BTC;
- accounting aligns directly with the V3 objective.

Problems:

- COIN-M contracts have different payoff mechanics from USDⓈ-M;
- historical funding and contract data must be rebuilt from COIN-M data;
- all earlier USDⓈ-M backtest numbers become exploratory evidence only and cannot be carried forward as production statistics.

### Reviewer recommendation

**Prefer Option C (COIN-M) for the canonical V3 forward-test model**, because the strategy objective is explicitly BTC accumulation and the benchmark starts from BTC without external capital.

USDⓈ-M can remain a secondary implementation later if the account-level capital model is explicitly defined.

This recommendation is a **major strategy implementation change** and requires owner approval before code proceeds.

## 6. Historical evidence: how to treat prior backtests

Earlier research found promising results for the V3 family, including materially higher BTC-equivalent terminal wealth than HODL and lower drawdown after adding Bear Lock.

These results are now classified as:

> **Exploratory strategy-family evidence, not production backtest evidence.**

Reasons:

- earlier runs did not fully freeze the execution instrument;
- some runs used simplified carry assumptions before real funding was added;
- execution timing assumptions changed during review;
- the exact margin source was not fully specified;
- pre-instrument periods cannot be treated as executable history.

No production claim should quote the old `1.62 BTC`, `1.47 BTC`, or similar values without also stating the exact instrument, data period and execution model.

Once the derivative model is approved, V3 must receive a new canonical backtest using only point-in-time available data for that exact instrument.

## 7. Anti-overfitting protocol

### 7.1 Frozen research family

V3.1 parameters above are frozen on 2026-08-22.

Future poor or good performance is not a reason to edit V3.1.

A material signal change must create a new version, e.g. V3.2, while V3.1 keeps running.

### 7.2 No look-ahead

- Only fully closed daily candles may enter the signal.
- Signal timestamp and candle close timestamp must be recorded.
- Execution must happen only after the signal is known.
- Backtests must model the chosen execution delay explicitly.

### 7.3 Point-in-time data

Do not use today's exchange rules, collateral ratios, funding history or contract metadata as if they existed unchanged in prior years.

If point-in-time risk parameters are unavailable, use conservative stress assumptions and label the result as approximate rather than fabricating precision.

### 7.4 Instrument availability

No period before the selected production instrument existed may count as executable backtest performance.

Older BTC price history may be used only for regime robustness research.

### 7.5 Costs

Canonical backtests must include:

- trading fees;
- slippage assumption;
- actual historical funding where available;
- conversion / spot fees when the implementation requires spot conversion;
- liquidation / margin constraints.

### 7.6 Parameter robustness

A new rule is not accepted because one exact parameter point looks good.

Requirements:

- nearby parameters should retain the same qualitative behavior;
- ablation should show which module contributes value;
- forward-test evidence outranks further in-sample optimization.

## 8. Forward-test architecture requirement

The current repository is deployed mainly as stateless Vercel Functions. A real-time endpoint can calculate today's signal but cannot by itself create a trustworthy historical forward-test ledger.

V3 therefore needs an append-only daily snapshot mechanism.

Recommended repository-native first version:

1. `lib/btc-v3-strategy.js` — pure deterministic signal calculations
2. `api/btc-v3.js` — current read-only signal endpoint
3. `tests/btc-v3-strategy.test.js` — deterministic unit tests
4. `data/btc-v3-forward-test.jsonl` — append-only observed snapshots
5. `.github/workflows/btc-v3-forward-test.yml` — scheduled daily runner that calculates the signal after candle close and commits one immutable observation
6. `BTC_V3_STRATEGY.md` — this continuously maintained decision record

If GitHub Actions proves unreliable for market data access, move persistence to a dedicated database, but do not silently replace missing dates with reconstructed history.

## 9. Forward-test record schema

Every observed day should record at minimum:

- strategy version;
- observation timestamp;
- latest closed candle open/close time;
- OHLC;
- EMA15;
- EMA30;
- MA200;
- MA200 slope 30D;
- trailing 365D drawdown;
- MA200 deviation;
- RV30;
- trend score;
- Bear Lock state;
- cheap / very-cheap flags;
- raw regime target;
- volatility cap;
- signal target;
- margin cap if account-aware;
- final target;
- data source;
- source request timestamp;
- data-quality flags;
- code commit SHA.

If execution is later enabled, additionally record actual fill time, fill price, quantity, fee, funding, account equity, margin ratio and execution error.

## 10. Forward-test integrity rules

- Never backfill a missing daily observation as if it had been observed live.
- A reconstructed date must be explicitly tagged `reconstructed=true` and excluded from primary forward-test statistics.
- A failed data fetch is a valid observation and should be logged as failure, not hidden.
- Daily records are append-only; corrections should be new records referencing the original record rather than editing historical values in place.
- Store the code commit SHA with each observation so a future reviewer can reproduce the exact signal logic.

## 11. V3 must stay separate from V2

Current repository naming already contains old frontend files named `app-v2.js`, `app-v3.js`, and `app-v4.js`. These are UI iteration names, not strategy versions.

To avoid collisions, new BTC strategy code must use explicit names such as:

- `btc-v3-strategy.js`
- `btc-v3.js`
- `btc-v3-forward-test.jsonl`

Do not reuse `app-v3.js` for the BTC strategy.

V2 altcoin logic must remain untouched while V3 is developed.

## 12. Automation scope

V3 implementation should begin as:

> **read-only signal + auditable forward test**

not automatic trading.

`autoTrade=false` remains the default until:

- the derivative/margin model is approved;
- the canonical exact-instrument backtest is complete;
- forward-test data accumulates;
- authenticated execution code has separate risk review.

## 13. Acceptance criteria before live capital

At minimum:

1. Exact production derivative instrument is frozen.
2. Exact margin source and collateral model are frozen.
3. Canonical backtest is rerun on that instrument.
4. No look-ahead / timing audit passes.
5. Fees, funding and slippage are included.
6. Liquidation stress test passes.
7. Daily forward-test snapshots are persisted without backfill.
8. Strategy code has deterministic unit tests.
9. V3.1 remains frozen while forward testing.
10. Auto-trading stays disabled until a separate execution review.

## 14. Change log

### 2026-08-22 — Independent review v1

- Separated V3 conceptually from V1/V2.
- Reclassified prior V3 backtests as exploratory evidence because the derivative/margin model was underspecified.
- Identified instrument/margin model as a production blocker.
- Recommended COIN-M as the canonical model for owner review because it aligns settlement and collateral with the BTC accumulation objective.
- Added append-only forward-test persistence requirement.
- Added code-commit provenance and no-backfill rules.
- Added explicit naming rule to avoid conflict with the existing historical `app-v3.js` frontend file.
- Kept V3.1 signal parameters frozen; no parameter tuning was performed during this review.
