# BTC V3 Execution Ledger

V3 has four deliberately separate ledgers. This document keeps the execution-specific detail; the complete accounting contract is in [`btc-v3-account-tracking.md`](./btc-v3-account-tracking.md).

- `data/btc-v3-forward-test.jsonl`: immutable Strategy Forward Test observations. It records what V3.1 should hold.
- Private repo `data/btc-v3-execution-ledger.jsonl`: append-only manual execution records. It records what was actually done.
- Private repo `data/btc-v3-capital-flow.jsonl`: append-only capital records. It records BTC deliberately contributed to or withdrawn from V3.
- Private repo `data/btc-v3-account-snapshots.jsonl`: append-only account observations. It records the latest known V3 Strategy Equity and actual contracts for reconcile.

The three tracking ledgers live in the private repository `xiangyingchang/binance-futures-radar-private-data`, not in this public code repository.

Execution records never enter `computeSignal`, never alter the Forward Test ledger, and never change V3.1 parameters.

## Record shape

Each line is one JSON object:

```json
{
  "recordType": "execution",
  "executionId": "exec_SAMPLE_btcusd_perp_buy_42_61234_5",
  "strategyVersion": "btc-v3.1-coinm",
  "symbol": "BTCUSD_PERP",
  "side": "BUY",
  "contracts": 42,
  "avgFillPrice": 61234.5,
  "executedAt": null,
  "recordedAt": "2026-08-23T13:48:37Z",
  "executionTimePrecision": "approximate",
  "targetExposureAtExecution": 1.25,
  "source": "manual",
  "note": "V3 target execution"
}
```

When the original Binance fill timestamp is unavailable, `executedAt` stays `null`; `recordedAt` is the system write time and `executionTimePrecision` remains explicit.

Corrections are new `reversal` records followed by a new `execution` record. Existing JSONL lines are never edited or deleted. `adjustment` and `correction` record types are intentionally not supported to avoid ambiguous accounting.

## API

`GET /api/btc-v3-execution` reads the private ledger. It requires the same access key as writes.

`POST /api/btc-v3-execution` appends one record. It requires:

```http
Authorization: Bearer <V3_TRACKING_ACCESS_KEY>
Idempotency-Key: <same value as executionId>
```

The API server supplies `recordedAt`, forces `strategyVersion=btc-v3.1-coinm`, `symbol=BTCUSD_PERP`, and `source=manual`, then appends through the GitHub Contents API. A repeated request with the same `executionId` and economics returns an idempotent success without adding another line; a changed payload with the same ID returns conflict.

Required Vercel environment variables:

- `V3_TRACKING_ACCESS_KEY`: separate access key used by the form for GET and POST; never the GitHub token.
- `GITHUB_V3_TRACKING_DATA_TOKEN`: fine-grained GitHub token with Contents permission on the private data repository only, server-side only.
- `GITHUB_V3_TRACKING_DATA_REPO`: must be `xiangyingchang/binance-futures-radar-private-data`; the API refuses to fall back to the public code repository.
- `GITHUB_V3_TRACKING_DATA_BRANCH`: private data branch, default `main`.

Neither secret is rendered into the page, persisted in localStorage, returned by the API, or written to the ledger.

The GitHub credential must be a fine-grained token restricted to `xiangyingchang/binance-futures-radar-private-data` with only Contents read/write permission. A classic or organization-wide token is not an acceptable Preview/Production configuration.

## Accounting

COIN-M position accounting uses signed contracts (`BUY` positive, `SELL` negative) and `$100 / contract`:

```text
actualOverlayBtc = signedContracts * 100 / relevantBtcPrice
actualExposure = (btcEquity + actualOverlayBtc) / btcEquity
```

Inverse-contract unrealized BTC PnL is calculated from the harmonic-equivalent average entry (COIN-M inverse contract) and current Mark Price. Same-side fills use `avgEntry = sum(q_i) / sum(q_i / price_i)`, not an arithmetic weighted average. Funding remains `--` until the ledger contains reliable funding cash-flow records; it is not guessed from a short recent funding sample.
