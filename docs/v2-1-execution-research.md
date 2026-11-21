# V2.1 Execution Layer — Research Proposal

Status: **research-only / backtest required**. This proposal does not change the production V2 discovery gates or automatically place trades.

## Why this exists

V2 is good at answering:

> Which Binance USDT perpetuals are extremely overheated and crowded enough to deserve short-side attention?

It is weaker at answering:

> When, after a candidate appears, is the actual short entry attractive?

Recent manual review of BTRUSDT and PROMUSDT highlighted three recurring execution problems:

1. Funding can fall quickly after the top starts forming, so requiring current funding >= P90 at the exact entry moment may discard a still-valid setup.
2. OI change alone is ambiguous. Price, OI and volume need to be interpreted jointly.
3. A valid bearish thesis can still lose money through early entry, late chasing, or repeated re-entry without new information.

The research goal is to improve execution without turning V2 into an overfit collection of hard gates.

## What stays unchanged

The current V2 discovery universe and risk framework remain the baseline:

- Binance USDⓈ-M perpetuals
- market-cap rank 101–500
- listed >= 90 days
- 24h quote volume >= 20M USDT
- live daily RSI(6) > 93
- 7d return > 20%
- funding >= P90 for the existing `SHORT_SETUP`
- manual `SQUEEZE_RISK` veto
- autoTrade=false
- maximum pilot hold = 72h
- hard stop = +30% against the short

No new execution rule below should become a production hard gate before forward/backtest evidence supports it.

## Hypothesis A — Funding ARMED state

### Motivation

A candidate may reach extreme funding before the reversal begins. Once price starts breaking down, funding can normalize quickly. Requiring funding to still be >= P90 at entry can therefore be too late or can downgrade a candidate exactly when the short setup improves.

### Research rule

When a V2 candidate reaches funding percentile >= P90, mark it:

`ARMED`

Keep that armed state alive for a configurable window after the most recent P90 observation.

Initial windows to test:

- 12h
- 24h
- **48h**
- 72h

The current PR exposes a **48h research field** but does not change `SHORT_SETUP` status logic.

Backtests must calculate funding percentiles with rolling past-only data. Do not use future funding observations when ranking a historical rate.

## Hypothesis B — Price × OI × Volume regime

OI by itself does not reveal whether longs or shorts are "increasing": every futures contract has both sides. The useful information is the combination of price direction, OI direction and participation.

Base four-quadrant interpretation:

| Price | OI | Typical interpretation | Short-side implication |
| --- | --- | --- | --- |
| up | up | new leverage entering an advancing market | avoid blindly fading; trend may still be expanding |
| up | down | short covering / squeeze | wait for squeeze exhaustion |
| down | up | new leverage entering while price falls | bearish continuation candidate |
| down | down | deleveraging / long liquidation | bearish, but can become a poor chase after the flush |

Volume adds participation:

- expanding volume = stronger evidence that the move/regime matters
- contracting volume = more consistent with cooling/exhaustion

A particularly important **do-not-chase** hypothesis to test is:

> price down + OI down + volume down after a large selloff

This often represents a late deleveraging phase rather than fresh short pressure.

Do not assume the interpretation is always correct. Test it empirically.

## Hypothesis C — Failed retest as preferred entry quality

A cleaner entry may occur after the first structural break instead of on the first large red candle.

Research sequence:

1. candidate is ARMED or otherwise remains in the V2 candidate set;
2. 4h structure breaks (for example a close below a recent 4h structural level and/or a researched moving-average reference);
3. price rebounds toward the broken area;
4. the rebound fails to reclaim it;
5. OI rebuilds and volume recovers while price fails to make progress.

This is called a **failed retest / failed rebound**.

EMA30 was useful in manual review, but it is **not yet a validated universal level**. Backtest structural levels and EMA variants rather than hard-coding EMA30 as truth.

Suggested variants:

- broken prior 4h low
- EMA15
- EMA20
- EMA30
- local 4h support/resistance

Suggested touch/reclaim tolerances to sweep:

- 0.5%
- 1.0%
- 1.5%

## Hypothesis D — Re-entry gate

A stop-out must not automatically justify another attempt on the same thesis.

Research policy:

- maximum 2 attempts per symbol per rolling 24h;
- after a stop, a second entry requires **new observable information** that did not exist at the first entry.

Examples of computable new information:

- first confirmed 4h structural break after the previous entry;
- first failed retest after the previous entry;
- transition into price-down / OI-up with renewed volume;
- a new lower high after the previous stop.

The exact definition must be machine-testable. Avoid subjective labels in the backtest.

## Multi-timeframe role

Use timeframes for different jobs rather than forcing one timeframe to do everything.

- **1W:** background only; detect major breakout / long-term regime. Not an entry trigger.
- **1D:** discovery/context; measure extremeness and whether the asset is still in a strong higher-timeframe trend.
- **4H:** primary reversal / structure timeframe.
- **1H:** execution confirmation.
- **15m:** optional timing refinement only.

An important hypothesis is that a 1h/4h short setup occurring inside a still-strong daily/weekly uptrend should be treated as a **short-duration mean-reversion trade**, which is consistent with the existing 72h maximum holding period.

## Backtest variants

At minimum compare:

- **A0 Baseline:** current V2 logic.
- **A1 Armed funding:** P90 observation remains valid for 12/24/48/72h.
- **A2 Regime filter:** avoid/chop entries during price-down + OI-down + volume-down cooling.
- **A3 Failed retest:** require or preferentially enter on a failed retest after structure break.
- **A4 Re-entry rule:** max 2 attempts/24h + new-information requirement.
- **A5 Combined:** best robust combination of A1–A4.

Do not choose the variant with the highest headline return alone.

## Required backtest outputs

For every variant report:

- candidate count
- trade count
- win rate
- mean and median short return
- expectancy per trade
- 24h / 48h / 72h forward return
- MAE and MFE
- +30% hard-stop hit rate
- maximum drawdown
- average holding time
- performance by symbol
- performance by market-cap bucket
- performance by 7d-return bucket
- performance by funding-percentile bucket
- performance by daily/weekly trend context
- sensitivity to execution delay and fees/slippage

Also show whether the new rules improve results by:

- avoiding losers,
- improving entry price,
- reducing repeated losses,
- or merely reducing the number of trades.

## Anti-lookahead requirements

This is mandatory.

At each historical decision timestamp:

- use only candles closed or live values genuinely observable at that timestamp;
- calculate funding percentile from prior history only;
- use OI observations available at that timestamp only;
- never use the final daily/4h close before it actually closes;
- never use future market-cap rank, listing status or token metadata;
- model the exact delay between signal observation and executable entry;
- include fees and realistic slippage.

If data required for a test is missing, report the gap rather than substituting future or approximate information silently.

## Promotion rule

Nothing in this document becomes a V2 hard gate based on intuition alone.

Promote a rule only if it:

1. improves out-of-sample expectancy or materially reduces tail loss;
2. is robust across parameter ranges rather than one magic threshold;
3. works across multiple symbols and market regimes;
4. does not simply remove most trades;
5. survives realistic fees, slippage and execution delay.
