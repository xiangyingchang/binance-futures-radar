# BTC V3 Account Tracking

V3 tracking answers four different questions and keeps the sources separate:

| Layer | File | Meaning | Can change V3.1 signal? |
| --- | --- | --- | --- |
| Strategy Forward Test | `data/btc-v3-forward-test.jsonl` | What V3.1 should hold | No |
| Execution | `data/btc-v3-execution-ledger.jsonl` | What was actually bought or sold | No |
| Capital Flow | `data/btc-v3-capital-flow.jsonl` | BTC deliberately assigned to or removed from V3 | No |
| Account Snapshot | `data/btc-v3-account-snapshots.jsonl` | Observed V3 equity and contract position at a point in time | No |

All four files are append-only JSONL. Corrections are new adjustment, reversal, correction, or replacement observations; historical lines are not edited. Execution, capital, and account data never enter `computeSignal` and do not modify EMA15/30, SMA200, Bear Lock, volatility, valuation, or Margin Cap.

## Initial records

The initial Strategy Equity is `0.5657 BTC`. It is V3-designated capital, not the user's total BTC balance and not a strategy gain. The first execution is the manual `BUY 108 BTCUSD_PERP @ 77424.7`; its `executedAt` is `null` because no exact Binance fill timestamp was supplied, `recordedAt` is the system write time, and `executionTimePrecision` is `approximate`.

The initial manual Account Snapshot records `strategyEquityBtc=0.5657` and `actualContracts=108`. Its mark is intentionally `null`: the fill price is not silently reused as a current account mark. It must be reconciled against a later verified account snapshot.

## Ledger schemas

### Execution Ledger

```json
{
  "recordType": "execution",
  "executionId": "exec_<stable-id>",
  "strategyVersion": "btc-v3.1-coinm",
  "symbol": "BTCUSD_PERP",
  "side": "BUY",
  "contracts": 108,
  "avgFillPrice": 77424.7,
  "executedAt": null,
  "recordedAt": "2026-08-23T14:32:21Z",
  "executionTimePrecision": "approximate",
  "targetExposureAtExecution": 1.25,
  "source": "manual",
  "note": "V3 target execution"
}
```

`BUY` adds signed contracts and `SELL` subtracts them. Same-side fills use weighted average entry. A partial close keeps the remaining cost basis; a full close returns the position to zero. Inverse-contract PnL uses `$100 / contract` and is only an estimate unless fees, funding, and slippage are separately accounted for.

### Capital Flow Ledger

```json
{
  "recordType": "capital_flow",
  "flowId": "flow_<stable-id>",
  "flowType": "CONTRIBUTION",
  "asset": "BTC",
  "amount": 0.01,
  "direction": "IN",
  "effectiveAt": null,
  "recordedAt": "2026-09-01T00:00:00Z",
  "effectiveTimePrecision": "approximate",
  "source": "manual",
  "reason": "DCA",
  "note": ""
}
```

Supported types are `INITIAL_CAPITAL`, `CONTRIBUTION`, `WITHDRAWAL`, and `ADJUSTMENT`. Capital Flow is not PnL. The capital basis is:

```text
netCapital = initial capital + contributions - withdrawals + signed adjustments
```

### Account Snapshot Ledger

```json
{
  "recordType": "account_snapshot",
  "snapshotId": "snapshot_<stable-id>",
  "capturedAt": null,
  "captureTimePrecision": "approximate",
  "strategyEquityBtc": 0.5657,
  "actualContracts": 108,
  "symbol": "BTCUSD_PERP",
  "markPrice": null,
  "recordedAt": "2026-08-23T14:32:21Z",
  "source": "manual",
  "note": ""
}
```

The latest Account Snapshot is authoritative for current Strategy Equity and current actual contracts. If no snapshot exists, the UI falls back to Capital Flow basis for equity and Execution Ledger position for contracts, with that fallback shown explicitly.

## Accounting formulas

For a COIN-M `BTCUSD_PERP` contract size of `$100`:

```text
actualOverlayBtc = actualContracts * 100 / markPrice
actualExposure = 1 + actualOverlayBtc / strategyEquityBtc
targetOverlayBtc = (targetExposure - 1) * strategyEquityBtc
targetContracts = round(targetOverlayBtc * markPrice / 100)
trackingError = actualExposure - targetExposure
strategyPnl = currentStrategyEquityBtc - netCapital
```

Negative contracts produce a negative overlay. Exchange leverage selectors such as 2x or 5x are not portfolio exposure and are not read by this accounting layer. The daily instruction is only `BUY n`, `SELL n`, or `NO ACTION` using the frozen V3.1 daily rebalance model; no additional threshold or no-trade band is introduced here.

`strategyPnl` is labelled snapshot/mark-to-market PnL. It may include unrealized COIN-M PnL, funding, fees, and other account effects that are not yet separately classified. The UI therefore keeps Funding as unavailable (`--`) rather than inventing a value. Contributions and withdrawals change net capital, not Strategy PnL.

## API and security

`GET /api/btc-v3-tracking` returns all three non-strategy ledgers read-only. `POST /api/btc-v3-tracking` accepts `ledgerType=capital-flow` or `ledgerType=account-snapshot`.

Writes require:

```http
Authorization: Bearer <EXECUTION_LEDGER_API_KEY>
Idempotency-Key: <same value as flowId or snapshotId>
```

The Vercel function supplies `recordedAt`, forces `source=manual` and the V3 symbol, and appends through the GitHub Contents API using the server-side `GITHUB_EXECUTION_LEDGER_TOKEN`. The token is never sent to the browser, returned by an API response, written into a ledger, or logged. Same-ID same-intent retries return an idempotent success; same-ID changed economics return HTTP 409.

This repository is public, so ledger rows in GitHub are public. The write key is only an append authorization boundary; it is not a privacy boundary. Production should use a fine-grained token limited to this repository's Contents permission and a separate high-entropy write key stored only in Vercel environment variables.

## Reconcile workflow

1. The Strategy ledger provides the current target exposure.
2. The live public V3 snapshot provides the mark price.
3. Execution Ledger derives a theoretical position and weighted entry.
4. Account Snapshot supplies the observed account truth for current equity/contracts.
5. Reconcile compares snapshot contracts with the execution-derived position and snapshot equity with capital basis.

A position mismatch may indicate an omitted fill, reversal, or external manual adjustment. An equity delta may include inverse futures PnL, funding, fees, or transfers not yet classified. Do not repair by editing old rows or by turning the delta into a Capital Flow without evidence; append the correcting record or a new verified snapshot.
