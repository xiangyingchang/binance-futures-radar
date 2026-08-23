# BTC V3 Execution Ledger

V3 has four deliberately separate ledgers. This document keeps the execution-specific detail; the complete accounting contract is in [`btc-v3-account-tracking.md`](./btc-v3-account-tracking.md).

- `data/btc-v3-forward-test.jsonl`: immutable Strategy Forward Test observations. It records what V3.1 should hold.
- `data/btc-v3-execution-ledger.jsonl`: append-only manual execution records. It records what was actually done.
- `data/btc-v3-capital-flow.jsonl`: append-only capital records. It records BTC deliberately contributed to or withdrawn from V3.
- `data/btc-v3-account-snapshots.jsonl`: append-only account observations. It records the latest known V3 Strategy Equity and actual contracts for reconcile.

Execution records never enter `computeSignal`, never alter the Forward Test ledger, and never change V3.1 parameters.

## Record shape

Each line is one JSON object:

```json
{
  "recordType": "execution",
  "executionId": "exec_20260823_btcusd_perp_buy_108_77424_7",
  "strategyVersion": "btc-v3.1-coinm",
  "symbol": "BTCUSD_PERP",
  "side": "BUY",
  "contracts": 108,
  "avgFillPrice": 77424.7,
  "executedAt": null,
  "recordedAt": "2026-08-23T13:48:37Z",
  "executionTimePrecision": "approximate",
  "targetExposureAtExecution": 1.25,
  "source": "manual",
  "note": "V3 target execution"
}
```

When the original Binance fill timestamp is unavailable, `executedAt` stays `null`; `recordedAt` is the system write time and `executionTimePrecision` remains explicit.

Corrections are new `adjustment`, `correction`, or `reversal` records. Existing JSONL lines are never edited or deleted.

## API

`GET /api/btc-v3-execution` reads the ledger without write credentials.

`POST /api/btc-v3-execution` appends one record. It requires:

```http
Authorization: Bearer <EXECUTION_LEDGER_API_KEY>
Idempotency-Key: <same value as executionId>
```

The API server supplies `recordedAt`, forces `strategyVersion=btc-v3.1-coinm`, `symbol=BTCUSD_PERP`, and `source=manual`, then appends through the GitHub Contents API. A repeated request with the same `executionId` and economics returns an idempotent success without adding another line; a changed payload with the same ID returns conflict.

Required Vercel environment variables:

- `EXECUTION_LEDGER_API_KEY`: separate write key used by the form; never the GitHub token.
- `GITHUB_EXECUTION_LEDGER_TOKEN`: fine-grained GitHub token with repository Contents read/write permission, server-side only.
- `GITHUB_EXECUTION_LEDGER_REPO` and `GITHUB_EXECUTION_LEDGER_BRANCH`: repository target, defaulting to this repository and `main`.

Neither secret is rendered into the page, persisted in localStorage, returned by the API, or written to the ledger.

## Accounting

COIN-M position accounting uses signed contracts (`BUY` positive, `SELL` negative) and `$100 / contract`:

```text
actualOverlayBtc = signedContracts * 100 / relevantBtcPrice
actualExposure = (btcEquity + actualOverlayBtc) / btcEquity
```

Inverse-contract unrealized BTC PnL is calculated from weighted average entry and current Mark Price. Funding remains `--` until the ledger contains reliable funding cash-flow records; it is not guessed from a short recent funding sample.
