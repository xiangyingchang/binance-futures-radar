'use strict';

const $ = (id) => document.getElementById(id);
const DAY_MS = 86400000;
const FORWARD_TEST_BUFFER_MS = 17 * 60 * 1000;
const DEFAULT_BTC_HOLDINGS = 0.57;
const DEFAULT_CURRENT_CONTRACTS = 0;
const STORAGE_BTC = 'btc-v3-holdings';
const STORAGE_CONTRACTS = 'btc-v3-current-contracts';

let latestSnapshot = null;

const pct = (value, digits = 1) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : '--';
const x = (value, digits = 2) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}x` : '--';
const money = (value) => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '--';
const signed = (value) => Number(value) > 0 ? `+${Number(value)}` : String(Number(value) || 0);

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadSavedNumber(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    const value = finite(saved);
    return value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function saveNumber(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (_) {}
}

function describePosition(contracts) {
  if (!Number.isFinite(contracts) || contracts === 0) return '0 张（无合约仓位）';
  return contracts > 0 ? `+${contracts} 张多单` : `${contracts} 张空单`;
}

function actionLabel(delta) {
  if (delta > 0) return { verb: 'BUY', text: `BUY ${Math.abs(delta)} 张`, className: 'buy' };
  if (delta < 0) return { verb: 'SELL', text: `SELL ${Math.abs(delta)} 张`, className: 'sell' };
  return { verb: 'HOLD', text: 'HOLD · 无需调仓', className: 'hold' };
}

function nextReviewTime(candle) {
  const closeTime = finite(candle?.closeTime);
  if (closeTime === null) return null;
  return closeTime + DAY_MS + FORWARD_TEST_BUFFER_MS + 1;
}

function renderOperation(data) {
  const s = data.signal || {};
  const holdings = Math.max(0, finite($('btc-holdings').value, DEFAULT_BTC_HOLDINGS));
  const currentContracts = Math.round(finite($('current-contracts').value, DEFAULT_CURRENT_CONTRACTS));
  const targetExposure = finite(s.finalTarget);
  const contractSize = finite(data.instrument?.contractSize);
  const markPrice = finite(data.funding?.markPrice, finite(data.latestClosedCandle?.close));

  saveNumber(STORAGE_BTC, holdings);
  saveNumber(STORAGE_CONTRACTS, currentContracts);

  if ([targetExposure, contractSize, markPrice].some((v) => v === null) || contractSize <= 0 || markPrice <= 0) {
    $('action-main').textContent = '仓位数据不足，暂不操作';
    $('action-detail').textContent = '等待有效的 Target / Mark Price / Contract Size。';
    $('action-side').textContent = 'WAIT';
    $('action-side').className = 'action-side';
    return;
  }

  const overlayBtc = (targetExposure - 1) * holdings;
  const overlayUsd = overlayBtc * markPrice;
  const targetContracts = Math.round(overlayUsd / contractSize);
  const deltaContracts = targetContracts - currentContracts;
  const action = actionLabel(deltaContracts);

  $('account-target-contracts').textContent = describePosition(targetContracts);
  $('account-delta-contracts').textContent = deltaContracts === 0 ? '0 张' : signed(deltaContracts) + ' 张';
  $('account-overlay-btc').textContent = `${overlayBtc >= 0 ? '+' : ''}${overlayBtc.toFixed(4)} BTC`;
  $('sizing-price').textContent = money(markPrice);
  $('action-main').textContent = action.text;
  $('action-side').textContent = action.verb;
  $('action-side').className = `action-side ${action.className}`;

  const targetPosition = describePosition(targetContracts);
  const currentPosition = describePosition(currentContracts);
  let exposureMeaning = '维持接近 BTC HODL 的 Beta';
  if (targetExposure === 0) exposureMeaning = 'Bear Lock：用空单经济对冲 BTC Core';
  else if (targetExposure < 1) exposureMeaning = '防守：用空单降低 BTC Beta';
  else if (targetExposure > 1) exposureMeaning = 'Risk On：用多单增加 BTC Beta';

  $('action-detail').textContent = `按 ${holdings.toFixed(4)} BTC、当前 ${currentPosition} 计算；交易后目标为 ${targetPosition}。${exposureMeaning}。`;
}

function render(data) {
  latestSnapshot = data;
  const s = data.signal || {};
  const candle = data.latestClosedCandle || {};

  $('target').textContent = x(s.finalTarget);
  $('target-note').textContent = s.bearLock
    ? 'Bear Lock 生效：核心 BTC 被经济对冲'
    : (s.tactical2xRequested ? '原始信号请求 >1.5x，但生产 Margin Cap 已限制' : 'V3.1 Balanced · production margin cap 1.5x');
  $('regime').textContent = s.bearLock ? 'BEAR LOCK' : s.trendScore >= 2 ? 'RISK ON' : 'DEFENSIVE';
  $('regime').className = `regime ${s.bearLock ? 'bear' : s.trendScore >= 2 ? 'bull' : ''}`;
  $('price').textContent = money(candle.close);
  $('candle-date').textContent = candle.openTimeIso ? `完整日线：${candle.openTimeIso.slice(0, 10)} UTC` : '--';
  $('trend').textContent = Number.isFinite(s.trendScore) ? `${s.trendScore}/3` : '--';
  $('rv').textContent = pct(s.rv30);
  $('drawdown').textContent = pct(s.drawdown365);
  $('ma-dev').textContent = pct(s.ma200Deviation);
  $('ma200').textContent = `MA200 ${money(s.ma200)}`;
  $('funding').textContent = pct(data.funding?.currentRate, 4);
  $('funding-next').textContent = data.funding?.nextFundingTimeIso ? `下次：${new Date(data.funding.nextFundingTimeIso).toLocaleString()}` : '--';
  $('regime-target').textContent = x(s.regimeTarget);
  $('valuation-target').textContent = x(s.valuationAdjustedTarget);
  $('vol-cap').textContent = x(s.volatilityCap);
  $('margin-cap').textContent = x(s.marginCap);
  $('flags').textContent = (data.dataQualityFlags || []).length ? `Data flags: ${(data.dataQualityFlags || []).join(', ')}` : 'Data flags: none';

  const ref = data.referenceSizingForOneBtc || {};
  $('overlay-btc').textContent = Number.isFinite(ref.overlayBtc) ? `${ref.overlayBtc.toFixed(4)} BTC` : '--';
  $('contracts').textContent = Number.isFinite(ref.signedContracts) ? describePosition(ref.signedContracts) : '--';
  $('side').textContent = ref.side || '--';
  $('contract-size').textContent = data.instrument?.contractSize ? `$${data.instrument.contractSize}` : '--';
  $('updated').textContent = `最后更新：${data.observedAt ? new Date(data.observedAt).toLocaleString() : '--'}`;

  const next = nextReviewTime(candle);
  $('next-review').textContent = `下次评估：${next ? new Date(next).toLocaleString() : '--'}`;
  renderOperation(data);
}

async function load() {
  $('refresh').disabled = true;
  try {
    const res = await fetch('/api/btc-v3', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    render(data);
  } catch (error) {
    $('target').textContent = 'ERR';
    $('target-note').textContent = error.message || 'BTC V3 数据暂不可用';
    $('action-main').textContent = '数据异常，今天不要按页面调仓';
    $('action-detail').textContent = error.message || '请等待数据恢复后再操作。';
    $('action-side').textContent = 'STOP';
    $('action-side').className = 'action-side sell';
  } finally {
    $('refresh').disabled = false;
  }
}

function initAccountInputs() {
  $('btc-holdings').value = loadSavedNumber(STORAGE_BTC, DEFAULT_BTC_HOLDINGS);
  $('current-contracts').value = loadSavedNumber(STORAGE_CONTRACTS, DEFAULT_CURRENT_CONTRACTS);
  for (const id of ['btc-holdings', 'current-contracts']) {
    $(id).addEventListener('input', () => {
      if (latestSnapshot) renderOperation(latestSnapshot);
    });
  }
}

initAccountInputs();
$('refresh').addEventListener('click', load);
load();
