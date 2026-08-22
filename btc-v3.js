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
const signedPct = (value, digits = 1) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(digits)}%` : '--';

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

function accountSizing(data) {
  const holdings = Math.max(0, finite($('btc-holdings').value, DEFAULT_BTC_HOLDINGS));
  const currentContracts = Math.round(finite($('current-contracts').value, DEFAULT_CURRENT_CONTRACTS));
  const targetExposure = finite(data.signal?.finalTarget);
  const contractSize = finite(data.instrument?.contractSize);
  const markPrice = finite(data.funding?.markPrice, finite(data.latestClosedCandle?.close));
  if ([targetExposure, contractSize, markPrice].some((v) => v === null) || contractSize <= 0 || markPrice <= 0) return null;
  const overlayBtc = (targetExposure - 1) * holdings;
  const overlayUsd = overlayBtc * markPrice;
  const targetContracts = Math.round(overlayUsd / contractSize);
  return {
    holdings,
    currentContracts,
    targetExposure,
    contractSize,
    markPrice,
    overlayBtc,
    overlayUsd,
    targetContracts,
    deltaContracts: targetContracts - currentContracts,
  };
}

function renderNarrative(data) {
  const s = data.signal || {};
  const sizing = accountSizing(data);
  const close = finite(s.close);
  const ma200 = finite(s.ma200);
  const slope = finite(s.ma200Slope30);
  const drawdown = finite(s.drawdown365);
  const rv = finite(s.rv30);
  const volCap = finite(s.volatilityCap);
  const target = finite(s.finalTarget);
  const funding = finite(data.funding?.currentRate);

  let label = '中性';
  if (s.bearLock) label = '熊市防守';
  else if (target > 1) label = '适度进攻';
  else if (target < 1) label = '防守';
  $('brief-label').textContent = label;
  $('brief-label').className = `brief-label ${s.bearLock || target < 1 ? 'defensive' : target > 1 ? 'risk-on' : ''}`;

  if (s.bearLock) {
    $('brief-summary').textContent = `当前长期趋势仍处于 Bear Lock：价格在 MA200 下方且 MA200 继续向下。V3 的首要任务不是抄底，而是把净 BTC 敞口压到 ${x(target)}，先保护 BTC 本位资产。`;
  } else if (target > 1) {
    $('brief-summary').textContent = `当前市场已经允许适度增加 BTC 风险，但还不是“全面牛市确认”。趋势修复和低估条件共同把目标推到 ${x(target)}；波动率和 Margin Gate 仍在限制进一步加仓，所以这里更接近“有条件进攻”，不是追涨或 2x 梭哈。`;
  } else if (target < 1) {
    $('brief-summary').textContent = `当前趋势不足以支撑满仓 BTC Beta，V3 选择 ${x(target)} 的防守敞口。含义不是看空 BTC 长期价值，而是暂时用 COIN-M 空单降低组合对下跌的敏感度。`;
  } else {
    $('brief-summary').textContent = '当前多空信号大致平衡，V3 维持接近 1.00x 的 BTC HODL Beta，不主动放大也不主动对冲。';
  }

  const priceVsMa = close !== null && ma200 !== null && ma200 > 0 ? (close / ma200) - 1 : null;
  const emaText = s.emaBull ? 'EMA15 已高于 EMA30，短中期动量偏多' : 'EMA15 仍低于 EMA30，短中期动量偏弱';
  const maText = s.aboveMa200 ? `价格高于 MA200 ${signedPct(priceVsMa)}` : `价格低于 MA200 ${signedPct(priceVsMa)}`;
  const slopeText = slope !== null
    ? (slope > 0 ? `MA200 的 30 日斜率为 ${signedPct(slope)}，长期趋势也在改善` : `但 MA200 的 30 日斜率仍为 ${signedPct(slope)}，长期趋势还没有完全转正`)
    : 'MA200 斜率暂不可用';
  $('brief-trend').textContent = `Trend Score ${s.trendScore ?? '--'}/3：${maText}，${emaText}；${slopeText}。因此基础 Regime Target 是 ${x(s.regimeTarget)}。`;

  let valuationText = '估值没有额外提高仓位。';
  if (s.veryCheap) valuationText = `过去 365 天仍较高点回撤 ${pct(drawdown)}，触发 Very Cheap；但 V3 不会因为“便宜”直接上高杠杆，只有趋势已经修复后才允许加仓。当前把目标从 ${x(s.regimeTarget)} 提高到 ${x(s.valuationAdjustedTarget)}。`;
  else if (s.cheap) valuationText = `过去 365 天回撤 ${pct(drawdown)}，当前被判定为 Cheap。因为趋势已经具备一定确认，估值层把目标从 ${x(s.regimeTarget)} 调整到 ${x(s.valuationAdjustedTarget)}。`;
  else valuationText = `365D 回撤为 ${pct(drawdown)}，当前没有 Cheap 加成，因此估值层维持 ${x(s.valuationAdjustedTarget)}。`;
  $('brief-valuation').textContent = valuationText;

  let riskText = `30D 实现波动率 ${pct(rv)}，对应 Volatility Cap ${x(volCap)}；生产 Margin Cap 为 ${x(s.marginCap)}。`;
  if (target !== null && volCap !== null && volCap <= finite(s.valuationAdjustedTarget, Infinity)) riskText += ' 当前主要是波动率在压制仓位，说明市场还不够稳定。';
  else riskText += ' 当前波动率没有进一步压低最终目标。';
  if (funding !== null) {
    if (funding > 0) riskText += ` Funding 为 ${pct(funding, 4)}，多头需要向空头付费，是轻微持仓成本，不是加仓理由。`;
    else if (funding < 0) riskText += ` Funding 为 ${pct(funding, 4)}，多头当前收取 Funding，但 V3 不把 Funding 当方向信号。`;
    else riskText += ' Funding 接近 0，对当前仓位影响很小。';
  }
  $('brief-risk').textContent = riskText;

  if (!sizing) {
    $('brief-action').textContent = '操作结论：仓位数据不足，今天先不要调仓。';
    return;
  }
  const action = actionLabel(sizing.deltaContracts);
  const actionSentence = sizing.deltaContracts === 0
    ? `按你当前 ${sizing.holdings.toFixed(4)} BTC 和 ${describePosition(sizing.currentContracts)}，现在已经接近目标 ${describePosition(sizing.targetContracts)}，今天无需调仓。`
    : `按你当前 ${sizing.holdings.toFixed(4)} BTC 和 ${describePosition(sizing.currentContracts)}，目标是 ${describePosition(sizing.targetContracts)}，所以今天需要 ${action.text}。`;
  $('brief-action').textContent = `操作结论：${actionSentence} 这会把整个组合调整到约 ${x(sizing.targetExposure)} 的 BTC 净敞口。`;
}

function renderOperation(data) {
  const sizing = accountSizing(data);
  const holdings = Math.max(0, finite($('btc-holdings').value, DEFAULT_BTC_HOLDINGS));
  const currentContracts = Math.round(finite($('current-contracts').value, DEFAULT_CURRENT_CONTRACTS));

  saveNumber(STORAGE_BTC, holdings);
  saveNumber(STORAGE_CONTRACTS, currentContracts);

  if (!sizing) {
    $('action-main').textContent = '仓位数据不足，暂不操作';
    $('action-detail').textContent = '等待有效的 Target / Mark Price / Contract Size。';
    $('action-side').textContent = 'WAIT';
    $('action-side').className = 'action-side';
    renderNarrative(data);
    return;
  }

  const action = actionLabel(sizing.deltaContracts);
  $('account-target-contracts').textContent = describePosition(sizing.targetContracts);
  $('account-delta-contracts').textContent = sizing.deltaContracts === 0 ? '0 张' : signed(sizing.deltaContracts) + ' 张';
  $('account-overlay-btc').textContent = `${sizing.overlayBtc >= 0 ? '+' : ''}${sizing.overlayBtc.toFixed(4)} BTC`;
  $('sizing-price').textContent = money(sizing.markPrice);
  $('action-main').textContent = action.text;
  $('action-side').textContent = action.verb;
  $('action-side').className = `action-side ${action.className}`;

  let exposureMeaning = '维持接近 BTC HODL 的 Beta';
  if (sizing.targetExposure === 0) exposureMeaning = 'Bear Lock：用空单经济对冲 BTC Core';
  else if (sizing.targetExposure < 1) exposureMeaning = '防守：用空单降低 BTC Beta';
  else if (sizing.targetExposure > 1) exposureMeaning = 'Risk On：用多单增加 BTC Beta';
  $('action-detail').textContent = `按 ${sizing.holdings.toFixed(4)} BTC、当前 ${describePosition(sizing.currentContracts)} 计算；交易后目标为 ${describePosition(sizing.targetContracts)}。${exposureMeaning}。`;
  renderNarrative(data);
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
    $('brief-label').textContent = '数据异常';
    $('brief-summary').textContent = '无法取得可信的完整日线或 COIN-M 数据，因此今天不生成自然语言交易判断。';
    $('brief-action').textContent = '操作结论：STOP，等待数据恢复后再评估。';
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
