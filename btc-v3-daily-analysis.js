'use strict';

const SAME_ORIGIN_URL = '/api/btc-v3-daily-analysis';
const RAW_FALLBACK_URL = 'https://raw.githubusercontent.com/xiangyingchang/binance-futures-radar/main/data/btc-v3-daily-analysis.json';

function fmtShanghai(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text ?? '--';
}

function renderDailyAnalysis(data) {
  const status = data?.status || 'error';
  const label = document.getElementById('daily-analysis-label');
  const section = document.getElementById('daily-analysis');

  if (status !== 'ok') {
    if (label) {
      label.textContent = '数据异常';
      label.className = 'brief-label defensive';
    }
    if (section) section.dataset.status = 'error';
    setText('daily-analysis-headline', '今天的自动策略分析没有通过数据完整性检查。');
    setText('daily-analysis-summary', data?.summary || data?.error || '请以实时数据区和前向测试状态为准，暂不根据本模块调仓。');
    setText('daily-analysis-trend', '--');
    setText('daily-analysis-valuation', '--');
    setText('daily-analysis-risk', '--');
    setText('daily-analysis-guidance', '操作结论：暂停使用每日自动分析，等待下一次有效更新。');
  } else {
    if (label) {
      label.textContent = data.label || '已更新';
      label.className = `brief-label ${Number(data.targetExposure) > 1 ? 'risk-on' : Number(data.targetExposure) < 1 ? 'defensive' : ''}`;
    }
    if (section) section.dataset.status = 'ok';
    setText('daily-analysis-headline', data.headline);
    setText('daily-analysis-summary', data.summary);
    setText('daily-analysis-trend', data.trend);
    setText('daily-analysis-valuation', data.valuation);
    setText('daily-analysis-risk', data.risk);
    setText('daily-analysis-guidance', `当日结论：${data.marketGuidance || '--'}`);
  }

  const sourceNote = data?.servedVia === 'vercel-same-origin-proxy' ? ' · 数据通道：同域代理' : '';
  setText('daily-analysis-meta', `对应日线：${data?.candleDate || '--'} UTC · 自动分析更新时间：${fmtShanghai(data?.generatedAt)}（北京时间）${sourceNote}`);
}

async function fetchJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadDailyAnalysis() {
  try {
    const data = await fetchJson(SAME_ORIGIN_URL);
    renderDailyAnalysis(data);
    return;
  } catch (primaryError) {
    try {
      const data = await fetchJson(RAW_FALLBACK_URL);
      renderDailyAnalysis(data);
      return;
    } catch (fallbackError) {
      renderDailyAnalysis({
        status: 'error',
        generatedAt: null,
        candleDate: null,
        error: `每日策略分析读取失败：同域代理 ${primaryError.message || primaryError}；GitHub Raw 备用通道 ${fallbackError.message || fallbackError}`,
      });
    }
  }
}

loadDailyAnalysis();
