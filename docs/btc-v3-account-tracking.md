# BTC V3 Account Tracking

V3 tracking answers four different questions and keeps the sources separate:

| Layer | File | Meaning | Can change V3.1 signal? |
| --- | --- | --- | --- |
| Strategy Forward Test | `data/btc-v3-forward-test.jsonl` | What V3.1 should hold | No |
| Execution | private repo `data/btc-v3-execution-ledger.jsonl` | What was actually bought or sold | No |
| Capital Flow | private repo `data/btc-v3-capital-flow.jsonl` | BTC deliberately assigned to or removed from V3 | No |
| Account Snapshot | private repo `data/btc-v3-account-snapshots.jsonl` | Observed V3 equity and contract position at a point in time | No |

All four files are append-only JSONL. Execution corrections use an explicit `reversal` referencing the original `execution`, followed by a new corrected `execution`; capital and account corrections are new flow or snapshot records. Historical lines are never edited. Execution, capital, and account data never enter `computeSignal` and do not modify EMA15/30, SMA200, Bear Lock, volatility, valuation, or Margin Cap.

## Initial records

All personal tracking records (initial capital, executions, snapshots) now live in the private repository `xiangyingchang/binance-futures-radar-private-data`. This public documentation intentionally contains only clearly-fictional SAMPLE values.

## Ledger schemas

### Execution Ledger

```json
{
  "recordType": "execution",
  "executionId": "exec_<stable-id>",
  "strategyVersion": "btc-v3.1-coinm",
  "symbol": "BTCUSD_PERP",
  "side": "BUY",
  "contracts": 42,
  "avgFillPrice": 61234.5,
  "executedAt": null,
  "recordedAt": "2026-08-23T14:32:21Z",
  "executionTimePrecision": "approximate",
  "targetExposureAtExecution": 1.25,
  "source": "manual",
  "note": "V3 target execution"
}
```

`BUY` adds signed contracts and `SELL` subtracts them. Same-side fills use the COIN-M harmonic equivalent entry: `avgEntry = sum(q_i) / sum(q_i / price_i)`. A partial close keeps the remaining cost basis; a full close returns the position to zero. Inverse-contract PnL uses `$100 / contract` and is only an estimate unless fees, funding, and slippage are separately accounted for.

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
  "strategyEquityBtc": 0.1250,
  "actualContracts": 42,
  "symbol": "BTCUSD_PERP",
  "markPrice": null,
  "recordedAt": "2026-08-23T14:32:21Z",
  "source": "manual",
  "note": ""
}
```

The latest Account Snapshot (ordered by `capturedAt ?? recordedAt`) is the last observed equity and position. If capital flows, executions, or market movement happen after it, the UI shows a Capital-adjusted Equity estimate with `equityStatus=ESTIMATED`, never presenting it as a live exchange account equity.

When a user submits a new snapshot without a mark, the browser supplies the current public V3 `BTCUSD_PERP` mark and records that provenance in the note. This is public market data at capture time, not a Binance private-account response. The historical SAMPLE snapshot above keeps `markPrice=null` when no mark was recorded.

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

The UI labels `current/estimated equity - netCapital` as `Estimated Strategy PnL`. It may include realized or unrealized COIN-M PnL, funding, fees, and reconciliation differences that are not separately classified. The UI therefore keeps Funding as unavailable (`--`) rather than inventing a value. Contributions and withdrawals change net capital, not Strategy PnL.

## API and security

`GET /api/btc-v3-tracking` returns all three non-strategy ledgers. `POST /api/btc-v3-tracking` accepts `ledgerType=capital-flow` or `ledgerType=account-snapshot`. Both require `Authorization: Bearer <V3_TRACKING_ACCESS_KEY>`.

Writes require:

```http
Authorization: Bearer <V3_TRACKING_ACCESS_KEY>
Idempotency-Key: <same value as flowId or snapshotId>
```

The Vercel function supplies `recordedAt`, forces `source=manual` and the V3 symbol, and appends through the GitHub Contents API using the server-side `GITHUB_V3_TRACKING_DATA_TOKEN` scoped to the private data repository only. The token is never sent to the browser, returned by an API response, written into a ledger, or logged. Same-ID same-intent retries return an idempotent success; same-ID changed economics return HTTP 409.

Tracking data lives in a private repository. The access key protects reads and writes; the GitHub token is a separate server-side credential with Contents permission on the private data repository only. There is deliberately no fallback to the public code repository.

## Reconcile workflow

1. The Strategy ledger provides the current target exposure.
2. The live public V3 snapshot provides the mark price.
3. Execution Ledger derives a theoretical position and harmonic-equivalent entry.
4. Account Snapshot supplies the observed account truth for current equity/contracts.
5. Reconcile compares snapshot contracts with the execution-derived position and snapshot equity with capital basis.

A position mismatch may indicate an omitted fill, reversal, or external manual adjustment. An equity delta may include inverse futures PnL, funding, fees, or transfers not yet classified. Do not repair by editing old rows or by turning the delta into a Capital Flow without evidence; append the correcting record or a new verified snapshot.
