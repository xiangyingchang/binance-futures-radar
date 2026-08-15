# Binance Futures Radar — Exhaustion Short V2

A research radar for finding **small/mid-cap Binance USDT perpetuals after extreme upside**, then waiting for crowded longs and intraday exhaustion before considering a short.

Production domain: `https://binance-futures-radar.vercel.app`

## V2 strategy

### Hard universe filters

- Binance USDⓈ-M perpetual crypto contracts only
- Current market-cap rank **101–300 primary**, **301–500 secondary**
- Listed on Binance Futures for at least **90 days**
- 24h quote volume at least **20M USDT**
- Daily Wilder RSI(14) **> 90**
- 7-day return **> 50%**
- Stable/pegged/wrapped assets are excluded

Rank source order:

1. CoinGecko current top-500 rank when the ticker is unambiguous
2. Binance spot circulating-supply × price rank as a fallback proxy
3. Unknown rank is rejected rather than silently admitted

### Crowding layer

Only hard-filter survivors receive the expensive requests:

- Current funding percentile versus ~90 days of that symbol's funding history
- Open-interest change over ~24h and ~7d
- 1h / 4h intraday candles
- Top-100 order-book depth

Strong crowding means:

- Funding percentile >= P90
- OI 24h >= +20% **or** OI 7d >= +30%

### Reversal layer

Closed 1h/4h candles are used to avoid repainting the trigger layer. Signals include:

- 4h bearish RSI divergence
- 4h close below the previous 4h low
- 1h RSI back below 80 after recently exceeding 90
- 1h close below the prior three-candle low

### Status logic

- `WATCH`: base setup exists, but crowding/reversal confirmation is weak
- `STRONG_WATCH`: score >= 75
- `SHORT_SETUP`: score >= 85 **and** funding >= P90 **and** strong OI **and** at least two reversal signals **and** critical crowding data is complete

`SHORT_SETUP` is **not an automatic trade signal**. Every candidate is marked `CATALYST_REVIEW_REQUIRED` and `autoTrade=false`.

## Architecture

Browser → `/api/radar-v2` Vercel Function → staged market scan

The original `/api/radar` endpoint remains untouched as a compatibility and rollback path.

The staged scanner is intentional: it does not request 90-day funding/OI history for all 500+ contracts. Cheap filters run first; expensive data is fetched only for the small number of extreme candidates.

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
