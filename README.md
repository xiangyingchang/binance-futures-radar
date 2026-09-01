# Binance Futures Radar — Exhaustion Short V2

A research radar for finding **small/mid-cap Binance USDT perpetuals after extreme upside**. V2 uses extreme heat/liquidity/rank filters plus funding crowding to surface short candidates; OI and intraday reversal are supporting context, not mandatory entry triggers.

Production domain: `https://binance-futures-radar.vercel.app`

## Strategy layers

- **V1 — High RSI Radar:** broad discovery layer for overheated symbols. A V1 hit is not a direct short signal.
- **V2 — Forward Test strategy:** filters for genuinely extreme short candidates using the rules below.
- **Manual review:** handles catalyst risk, squeeze risk, CEX outflows, fresh-wallet accumulation and other information that should not be inferred automatically.

## V2 strategy

### Hard universe filters

- Binance USDⓈ-M perpetual crypto contracts only
- Current market-cap rank **101–500**
- Listed on Binance Futures for at least **90 days**
- 24h quote volume at least **20M USDT**
- Live current-day Wilder **RSI(6) > 93**
- 7-day return **> 20%**, using the current price versus ~7 days ago
- Stable/pegged/wrapped assets are excluded

The closed daily RSI(6) is reported as confirmation context only; it is **not** the hard gate used by the live scanner.

### Rank verification

Current production rank logic uses:

1. **CoinMarketCap** as the primary rank source
2. **CoinGecko** as a cross-check
3. Binance circulating-supply × price market-cap proxy as an additional cross-check

Safety rules:

- If any trusted source places the asset in the **top 100**, reject it from the V2 target universe.
- Cross-boundary rank conflicts are rejected rather than silently admitted.
- A `SHORT_SETUP` requires CoinMarketCap verification inside the **101–500** target range.

### Funding gate

Funding percentile is measured against roughly 90 days of that symbol's funding history.

- Funding **>= P90** → eligible for `SHORT_SETUP`
- Funding **P75–P90** → `STRONG_WATCH`
- Funding **< P75** → `WATCH`

Funding is the current hard crowding gate. A very negative funding rate is therefore not treated as a short confirmation merely because price and RSI are extreme.

### OI and reversal context

Open interest and intraday reversal signals are **reference/scoring inputs only**. They are deliberately **not hard gates** for V2 entry classification.

Tracked context includes:

- OI change over ~24h and ~7d
- 4h bearish RSI divergence
- 4h close below the previous 4h low
- 1h RSI back below 80 after recently exceeding 90
- 1h close below the prior three-candle low

The radar does not require OI to fall or a fixed number of reversal signals before a symbol can become `SHORT_SETUP`. This is intentional: prior Forward Test review showed that waiting for full reversal confirmation can turn a good fade into a late chase.

### Manual `SQUEEZE_RISK` veto

If credible external evidence shows a combination such as:

- material CEX net outflow
- fresh-wallet accumulation
- shrinking exchange-side available supply

mark the symbol as `SQUEEZE_RISK` and veto new shorts until the squeeze risk is re-evaluated.

This is a **manual veto**, not an automatic on-chain classifier. Wallet ownership, exchange internal addresses, market makers and custodial flows are too easy to misclassify.

### Status logic

- `WATCH`: V2 base heat/liquidity/rank setup exists, but funding has not reached P75
- `STRONG_WATCH`: base setup passes and funding is in P75–P90
- `SHORT_SETUP`: base setup passes, CoinMarketCap rank is verified in 101–500, funding is >= P90, and no manual squeeze veto is active

The numeric score is useful for ranking candidates, but it does **not** replace the gates above.

`SHORT_SETUP` is **not an automatic trade signal**. Every candidate requires catalyst/manual sizing review and `autoTrade=false`.

## V2.1 execution-layer research

A research-only execution layer is proposed in [docs/v2-1-execution-research.md](docs/v2-1-execution-research.md).

It keeps the current V2 discovery gates unchanged and tests four execution hypotheses:

- **Funding ARMED state:** remember a recent P90 funding observation for a limited window instead of requiring crowding to remain extreme at the exact entry moment.
- **Price × OI × Volume regime:** interpret OI jointly with price direction and participation; especially test whether price-down + OI-down + volume-down is a poor late-chase regime.
- **Failed retest:** after a 4h structural break, prefer a failed rebound/retest over blindly shorting the first large red candle.
- **Re-entry gate:** after a stop, require genuinely new observable information and cap repeated attempts per symbol.

The branch exposes a 48h `fundingArmed` research field, but **does not change production `WATCH / STRONG_WATCH / SHORT_SETUP` status logic**. Nothing here becomes a hard gate until it survives backtest / Forward Test validation.

## Forward Test risk rules

- Maximum pilot holding period: **3 days / 72 hours**
- Hard stop: **+30% price move against the short from entry**
- Do not add new hard entry conditions solely because they look intuitive; validate them against Forward Test samples first
- OI/reversal confirmation remains auxiliary until enough evidence shows it improves outcomes without creating systematic late entries

## Architecture

Browser → `/api/radar-v2` Vercel Function → staged market scan

The original `/api/radar` endpoint remains untouched as a compatibility and rollback path.

The staged scanner is intentional: it does not request expensive funding/OI history for all 500+ contracts. Cheap filters run first; detailed data is fetched only for the small number of extreme candidates.

## Validation

```bash
node --check app-v4.js
node --check api/radar-v2.js
node --check lib/strategy.js
node tests/strategy.test.js
python -m py_compile scanner.py scanner_optimized.py
```

## Rollback

The pre-V2 production source is permanently preserved at:

- Branch: `backup/pre-exhaustion-radar-20260815`
- Commit: `0714558f2cb368120e084b3bbdf2fd8c29cf3fdd`
- Vercel production deployment at backup time: `dpl_DCiFKpcutEMgtbKwWUXV2SWqN2RL`

If V2 proves unreliable, restore `main` from the backup branch or repoint production to the preserved Vercel deployment. The old `/api/radar` endpoint also remains in the V2 tree.
