'use strict';

const $ = (id) => document.getElementById(id);
const pct = (value, digits = 1) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : '--';
const x = (value, digits = 2) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}x` : '--';
const money = (value) => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString(undefined,{maximumFractionDigits:0})}` : '--';

function render(data) {
  const s = data.signal || {};
  const candle = data.latestClosedCandle || {};
  $('target').textContent = x(s.finalTarget);
  $('target-note').textContent = s.bearLock
    ? 'Bear Lock 生效：核心 BTC 被经济对冲'
    : (s.tactical2xRequested ? '原始信号请求 >1.5x，但公开 Margin Cap 已限制' : 'V3.1 Balanced · public margin cap 1.5x');
  $('regime').textContent = s.bearLock ? 'BEAR LOCK' : s.trendScore >= 2 ? 'RISK ON' : 'DEFENSIVE';
  $('regime').className = `regime ${s.bearLock ? 'bear' : s.trendScore >= 2 ? 'bull' : ''}`;
  $('price').textContent = money(candle.close);
  $('candle-date').textContent = candle.openTimeIso ? `完整日线：${candle.openTimeIso.slice(0,10)} UTC` : '--';
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
  $('contracts').textContent = Number.isFinite(ref.signedContracts) ? String(ref.signedContracts) : '--';
  $('side').textContent = ref.side || '--';
  $('contract-size').textContent = data.instrument?.contractSize ? `$${data.instrument.contractSize}` : '--';
  $('updated').textContent = `最后更新：${data.observedAt ? new Date(data.observedAt).toLocaleString() : '--'}`;
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
  } finally {
    $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', load);
load();
