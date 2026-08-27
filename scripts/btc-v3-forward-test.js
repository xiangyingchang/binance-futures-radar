'use strict';

const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', 'data', 'btc-v3-forward-test.jsonl');
const SNAPSHOT_URLS = (process.env.BTC_V3_SNAPSHOT_URLS
  || 'https://binance-futures-radar.vercel.app/api/btc-v3,https://binance-futures-radar-v3.vercel.app/api/btc-v3')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const REQUEST_TIMEOUT_MS = Number(process.env.BTC_V3_SNAPSHOT_TIMEOUT_MS || 30000);

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function append(record) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(record)}\n`, 'utf8');
}

async function fetchRemoteSnapshot() {
  const errors = [];
  let lastSnapshot = null;
  let lastUrl = null;
  for (const url of SNAPSHOT_URLS) {
    if (lastSnapshot) break;
    try {
      const snapshot = await fetchSnapshotFrom(url);
      lastSnapshot = snapshot;
      lastUrl = url;
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  if (!lastSnapshot) {
    throw new Error(`all snapshot sources failed: ${errors.join(' | ')}`);
  }
  if (SNAPSHOT_URLS.length > 1 && lastUrl !== SNAPSHOT_URLS[0]) {
    console.warn(`BTC_V3_INFO primary snapshot source unavailable; captured from fallback ${lastUrl}`);
  }
  return { snapshot: lastSnapshot, snapshotUrl: lastUrl };
}

async function fetchSnapshotFrom(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'btc-v3-forward-test-ledger/1.0' },
      cache: 'no-store',
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload?.message || payload?.error || `snapshot HTTP ${response.status}`);
    if (!payload || payload.autoTrade !== false || payload.executionMode !== 'READ_ONLY_FORWARD_TEST') {
      throw new Error('snapshot safety contract invalid');
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function getLedgerSummary(existing) {
  const signals = existing.filter((item) => item.recordType === 'signal');
  const latest = signals[signals.length - 1] || null;
  return {
    signalRecords: signals.length,
    latestSignalCandleDate: latest?.candleDate || null,
    latestSignalObservedAt: latest?.observedAt || null,
  };
}

function compactSnapshot(snapshot) {
  const candle = snapshot.latestClosedCandle;
  const signal = snapshot.signal;
  const candleDate = candle?.openTimeIso?.slice(0, 10) || null;
  return {
    recordType: 'signal',
    strategyVersion: snapshot.strategyVersion,
    candleDate,
    observedAt: snapshot.observedAt,
    collectedAt: new Date().toISOString(),
    signalPriceSource: snapshot.signalPriceSource,
    latestClosedCandle: candle,
    instrument: snapshot.instrument,
    signal: {
      close: signal.close,
      ema15: signal.ema15,
      ema30: signal.ema30,
      ma200: signal.ma200,
      ma200Past: signal.ma200Past,
      ma200Slope30: signal.ma200Slope30,
      drawdown365: signal.drawdown365,
      ma200Deviation: signal.ma200Deviation,
      rv30: signal.rv30,
      trendScore: signal.trendScore,
      bearLock: signal.bearLock,
      cheap: signal.cheap,
      veryCheap: signal.veryCheap,
      regimeTarget: signal.regimeTarget,
      valuationAdjustedTarget: signal.valuationAdjustedTarget,
      volatilityCap: signal.volatilityCap,
      rawSignalTarget: signal.rawSignalTarget,
      marginCap: signal.marginCap,
      finalTarget: signal.finalTarget,
      tactical2xRequested: signal.tactical2xRequested,
    },
    funding: {
      currentRate: snapshot.funding.currentRate,
      markPrice: snapshot.funding.markPrice,
      indexPrice: snapshot.funding.indexPrice,
      intervalHours: snapshot.funding.intervalHours,
      nextFundingTime: snapshot.funding.nextFundingTime,
    },
    referenceSizingForOneBtc: snapshot.referenceSizingForOneBtc,
    dataQualityFlags: snapshot.dataQualityFlags,
    signalCodeCommitSha: snapshot.codeCommitSha || 'deployment-sha-unavailable',
    signalDeploymentUrl: snapshot.deploymentUrl || null,
    signalExecutionRegion: snapshot.executionRegion || null,
    deploymentEnvironment: snapshot.deploymentEnvironment || null,
    ledgerWriterCommitSha: process.env.GITHUB_SHA || 'writer-sha-unavailable',
    reconstructed: false,
    autoTrade: false,
  };
}

async function main() {
  const existing = readLedger();
  const ledgerBefore = getLedgerSummary(existing);
  try {
    const { snapshot, snapshotUrl } = await fetchRemoteSnapshot();
    const record = compactSnapshot(snapshot);
    record.snapshotUrl = snapshotUrl;
    if (!record.candleDate) throw new Error('latest closed candle date unavailable');
    if (!snapshot.signal?.ready) throw new Error(`snapshot signal not ready: ${snapshot.signal?.reason || 'unknown'}`);
    const alreadyObserved = existing.some((item) => item.recordType === 'signal'
      && item.candleDate === record.candleDate
      && item.reconstructed !== true);
    if (alreadyObserved) {
      console.log(`BTC_V3_INFO action=skip productionCandleDate=${record.candleDate} ledgerLatestCandleDate=${ledgerBefore.latestSignalCandleDate} reconstructed=${record.reconstructed} target=${record.signal.finalTarget.toFixed(4)}x source=${snapshotUrl}`);
      return;
    }
    append(record);
    console.log(`BTC_V3_INFO action=append productionCandleDate=${record.candleDate} ledgerLatestCandleDate=${ledgerBefore.latestSignalCandleDate} reconstructed=${record.reconstructed} target=${record.signal.finalTarget.toFixed(4)}x source=${snapshotUrl} flags=${JSON.stringify(record.dataQualityFlags || [])}`);
  } catch (error) {
    const now = new Date();
    const intended = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000)
      .toISOString().slice(0, 10);
    const failure = {
      recordType: 'failure',
      strategyVersion: 'btc-v3.1-coinm',
      candleDate: intended,
      observedAt: now.toISOString(),
      snapshotUrl: SNAPSHOT_URLS.join(','),
      error: error.name === 'AbortError' ? `snapshot timeout after ${REQUEST_TIMEOUT_MS}ms` : (error.message || 'unknown forward-test failure'),
      ledgerWriterCommitSha: process.env.GITHUB_SHA || 'writer-sha-unavailable',
      reconstructed: false,
      autoTrade: false,
    };
    append(failure);
    console.error(`BTC_V3_INFO action=error productionCandleDate=unavailable ledgerLatestCandleDate=${ledgerBefore.latestSignalCandleDate} intendedCandleDate=${failure.candleDate} error=${JSON.stringify(failure.error)}`);
    console.error(error);
    process.exitCode = 1;
  }
}

main();
