'use strict';

const $ = (id) => document.getElementById(id);
const setTextIfPresent = (id, value) => {
  const node = $(id);
  if (node) node.textContent = value;
};
const DAY_MS = 86400000;
const FORWARD_TEST_BUFFER_MS = 17 * 60 * 1000;
const DEFAULT_BTC_HOLDINGS = 0.57;
const STORAGE_BTC = 'btc-v3-holdings';
const STORAGE_CONTRACTS = 'btc-v3-current-contracts';
let latestSnapshot = null;

const finite = (v, fallback = null) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const pct = (v, d = 1) => finite(v) === null ? '--' : `${(Number(v) * 100).toFixed(d)}%`;
const signedPct = (v, d = 1) => finite(v) === null ? '--' : `${Number(v) >= 0 ? '+' : ''}${(Number(v) * 100).toFixed(d)}%`;
const x = (v, d = 2) => finite(v) === null ? '--' : `${Number(v).toFixed(d)}x`;
const money = (v) => finite(v) === null ? '--' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

function savedNumber(key, fallback) {
  try {
    const v = finite(localStorage.getItem(key));
    return v === null ? fallback : v;
  } catch (_) { return fallback; }
}

function saveNumber(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (_) {}
}

function describePosition(q) {
  if (!Number.isFinite(q) || q === 0) return '0 张（无合约仓位）';
  return q > 0 ? `+${q} 张多单` : `${q} 张空单`;
}

function actionLabel(delta) {
  if (delta > 0) return { verb: 'BUY', text: `BUY ${Math.abs(delta)} 张`, css: 'buy' };
  if (delta < 0) return { verb: 'SELL', text: `SELL ${Math.abs(delta)} 张`, css: 'sell' };
  return { verb: 'HOLD', text: 'HOLD · 无需调仓', css: 'hold' };
}

function accountSizing(data) {
  const holdings = Math.max(0, finite($('btc-holdings')?.value, DEFAULT_BTC_HOLDINGS));
  const currentContracts = Math.round(finite($('current-contracts')?.value, 0));
  const targetExposure = finite(data.signal?.finalTarget);
  const contractSize = finite(data.instrument?.contractSize);
  const markPrice = finite(data.funding?.markPrice, finite(data.latestClosedCandle?.close));
  if ([targetExposure, contractSize, markPrice].some((v) => v === null) || contractSize <= 0 || markPrice <= 0) return null;
  const overlayBtc = (targetExposure - 1) * holdings;
  const targetContracts = Math.round((overlayBtc * markPrice) / contractSize);
  return { holdings, currentContracts, targetExposure, contractSize, markPrice, overlayBtc, targetContracts, deltaContracts: targetContracts - currentContracts };
}

function renderNarrative(data) {
  const s = data.signal || {};
  const sizing = accountSizing(data);
  const target = finite(s.finalTarget);
  const close = finite(s.close);
  const ma200 = finite(s.ma200);
  const slope = finite(s.ma200Slope30);
  const drawdown = finite(s.drawdown365);
  const rv = finite(s.rv30);
  const volCap = finite(s.volatilityCap);
  const funding = finite(data.funding?.currentRate);
  const label = s.bearLock ? '熊市防守' : target > 1 ? '适度进攻' : target < 1 ? '防守' : '中性';
  const briefLabel = $('brief-label');
  if (briefLabel) {
    briefLabel.textContent = label;
    briefLabel.className = `brief-label ${s.bearLock || target < 1 ? 'defensive' : target > 1 ? 'risk-on' : ''}`;
  }

  if (s.bearLock) setTextIfPresent('brief-summary', `当前 Bear Lock 生效：价格在 MA200 下方且 MA200 继续向下。V3 优先把净 BTC 敞口压到 ${x(target)}，先保护 BTC 本位资产。`);
  else if (target > 1) setTextIfPresent('brief-summary', `当前允许适度增加 BTC 风险，但还不是全面牛市确认。趋势修复与低估共同把目标推到 ${x(target)}，波动率和 Margin Gate 继续限制更激进的仓位。`);
  else if (target < 1) setTextIfPresent('brief-summary', `当前趋势不足以支撑满仓 BTC Beta，V3 采用 ${x(target)} 防守敞口，用 COIN-M 空单降低组合对下跌的敏感度。`);
  else setTextIfPresent('brief-summary', '当前多空信号大致平衡，V3 维持接近 1.00x 的 BTC HODL Beta。');

  const priceVsMa = close !== null && ma200 > 0 ? (close / ma200) - 1 : null;
  const maText = s.aboveMa200 ? `价格高于 MA200 ${signedPct(priceVsMa)}` : `价格低于 MA200 ${signedPct(priceVsMa)}`;
  const emaText = s.emaBull ? 'EMA15 已高于 EMA30，短中期偏多' : 'EMA15 仍低于 EMA30，短中期偏弱';
  const slopeText = slope === null ? 'MA200 斜率不可用' : slope > 0 ? `MA200 30D slope ${signedPct(slope)}，长期趋势改善` : `MA200 30D slope ${signedPct(slope)}，长期趋势仍未完全转正`;
  setTextIfPresent('brief-trend', `Trend Score ${s.trendScore ?? '--'}/3：${maText}；${emaText}；${slopeText}。基础目标 ${x(s.regimeTarget)}。`);

  if (s.veryCheap) setTextIfPresent('brief-valuation', `365D 回撤 ${pct(drawdown)}，触发 Very Cheap。只有趋势先改善后才允许低估加仓，当前估值层目标 ${x(s.valuationAdjustedTarget)}。`);
  else if (s.cheap) setTextIfPresent('brief-valuation', `365D 回撤 ${pct(drawdown)}，当前属于 Cheap，估值层目标 ${x(s.valuationAdjustedTarget)}。`);
  else setTextIfPresent('brief-valuation', `365D 回撤 ${pct(drawdown)}，没有 Cheap 加成，估值层维持 ${x(s.valuationAdjustedTarget)}。`);

  let riskText = `30D RV ${pct(rv)}，Volatility Cap ${x(volCap)}，Margin Cap ${x(s.marginCap)}。`;
  if (volCap !== null && volCap <= finite(s.valuationAdjustedTarget, Infinity)) riskText += ' 当前波动率正在压制仓位。';
  else riskText += ' 当前波动率没有进一步压低目标。';
  if (funding > 0) riskText += ` Funding ${pct(funding, 4)}，多头支付 Funding，是轻微成本而不是方向信号。`;
  else if (funding < 0) riskText += ` Funding ${pct(funding, 4)}，多头收取 Funding，但不作为方向信号。`;
  setTextIfPresent('brief-risk', riskText);

  if (!sizing) return void setTextIfPresent('brief-action', '操作结论：仓位数据不足，今天先不要调仓。');
  const action = actionLabel(sizing.deltaContracts);
  const sentence = sizing.deltaContracts === 0
    ? `按 ${sizing.holdings.toFixed(4)} BTC 和 ${describePosition(sizing.currentContracts)}，已接近目标 ${describePosition(sizing.targetContracts)}，今天无需调仓。`
    : `按 ${sizing.holdings.toFixed(4)} BTC 和 ${describePosition(sizing.currentContracts)}，目标是 ${describePosition(sizing.targetContracts)}，今天需要 ${action.text}。`;
  setTextIfPresent('brief-action', `操作结论：${sentence} 调整后组合约为 ${x(sizing.targetExposure)} BTC 净敞口。`);
}

function renderOperation(data) {
  const sizing = accountSizing(data);
  const holdings = Math.max(0, finite($('btc-holdings').value, DEFAULT_BTC_HOLDINGS));
  const currentContracts = Math.round(finite($('current-contracts').value, 0));
  saveNumber(STORAGE_BTC, holdings);
  saveNumber(STORAGE_CONTRACTS, currentContracts);
  if (!sizing) {
    $('action-main').textContent = '仓位数据不足，暂不操作';
    $('action-detail').textContent = '等待有效的 Target / Mark Price / Contract Size。';
    $('action-side').textContent = 'WAIT';
    $('action-side').className = 'action-side';
    return renderNarrative(data);
  }
  const action = actionLabel(sizing.deltaContracts);
  $('account-target-contracts').textContent = describePosition(sizing.targetContracts);
  $('account-delta-contracts').textContent = `${sizing.deltaContracts > 0 ? '+' : ''}${sizing.deltaContracts} 张`;
  $('account-overlay-btc').textContent = `${sizing.overlayBtc >= 0 ? '+' : ''}${sizing.overlayBtc.toFixed(4)} BTC`;
  $('sizing-price').textContent = money(sizing.markPrice);
  $('action-main').textContent = action.text;
  $('action-side').textContent = action.verb;
  $('action-side').className = `action-side ${action.css}`;
  const meaning = sizing.targetExposure === 0 ? 'Bear Lock：经济对冲 BTC Core' : sizing.targetExposure < 1 ? '防守：降低 BTC Beta' : sizing.targetExposure > 1 ? 'Risk On：增加 BTC Beta' : '维持 HODL Beta';
  $('action-detail').textContent = `按 ${sizing.holdings.toFixed(4)} BTC、当前 ${describePosition(sizing.currentContracts)} 计算；交易后目标 ${describePosition(sizing.targetContracts)}。${meaning}。`;
  renderNarrative(data);
}

function render(data) {
  latestSnapshot = data;
  const s = data.signal || {};
  const c = data.latestClosedCandle || {};
  $('target').textContent = x(s.finalTarget);
  $('target-note').textContent = s.bearLock ? 'Bear Lock 生效：核心 BTC 被经济对冲' : s.tactical2xRequested ? '原始信号请求 >1.5x，但生产 Margin Cap 已限制' : 'V3.1 Balanced · production margin cap 1.5x';
  $('regime').textContent = s.bearLock ? 'BEAR LOCK' : s.trendScore >= 2 ? 'RISK ON' : 'DEFENSIVE';
  $('regime').className = `regime ${s.bearLock ? 'bear' : s.trendScore >= 2 ? 'bull' : ''}`;
  $('price').textContent = money(c.close);
  $('candle-date').textContent = c.openTimeIso ? `完整日线：${c.openTimeIso.slice(0, 10)} UTC` : '--';
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
  $('flags').textContent = (data.dataQualityFlags || []).length ? `Data flags: ${data.dataQualityFlags.join(', ')}` : 'Data flags: none';
  const ref = data.referenceSizingForOneBtc || {};
  $('overlay-btc').textContent = Number.isFinite(ref.overlayBtc) ? `${ref.overlayBtc.toFixed(4)} BTC` : '--';
  $('contracts').textContent = Number.isFinite(ref.signedContracts) ? describePosition(ref.signedContracts) : '--';
  $('side').textContent = ref.side || '--';
  $('contract-size').textContent = data.instrument?.contractSize ? `$${data.instrument.contractSize}` : '--';
  $('updated').textContent = `实时数据更新：${data.observedAt ? new Date(data.observedAt).toLocaleString() : '--'}`;
  const next = finite(c.closeTime) === null ? null : finite(c.closeTime) + DAY_MS + FORWARD_TEST_BUFFER_MS + 1;
  $('next-review').textContent = `下次日级评估：${next ? new Date(next).toLocaleString() : '--'}`;
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
    $('action-detail').textContent = error.message || '等待数据恢复后再操作。';
    $('action-side').textContent = 'STOP';
    $('action-side').className = 'action-side sell';
  } finally { $('refresh').disabled = false; }
}

$('btc-holdings').value = savedNumber(STORAGE_BTC, DEFAULT_BTC_HOLDINGS);
$('current-contracts').value = savedNumber(STORAGE_CONTRACTS, 0);
for (const id of ['btc-holdings', 'current-contracts']) $(id).addEventListener('input', () => latestSnapshot && renderOperation(latestSnapshot));
$('refresh').addEventListener('click', load);
load();
