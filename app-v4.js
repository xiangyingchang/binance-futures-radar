'use strict';

const GLOBAL = {
  updatedTime: document.getElementById('last-updated'),
  refreshBtn: document.getElementById('refresh-btn'),
  loading: document.getElementById('loading-indicator'),
};

const V2 = {
  apiStatus: document.getElementById('v2-api-status'),
  tableBody: document.getElementById('v2-table-body'),
  emptyState: document.getElementById('v2-empty-state'),
  emptyTitle: document.getElementById('v2-empty-title'),
  emptyDetail: document.getElementById('v2-empty-detail'),
  totalPairs: document.getElementById('v2-total-pairs'),
  universeCount: document.getElementById('v2-universe-count'),
  candidateCount: document.getElementById('v2-candidate-count'),
  setupCount: document.getElementById('v2-setup-count'),
  strongCount: document.getElementById('v2-strong-count'),
  watchCount: document.getElementById('v2-watch-count'),
  hasData: false,
};

const V1 = {
  apiStatus: document.getElementById('v1-api-status'),
  tableBody: document.getElementById('v1-table-body'),
  emptyState: document.getElementById('v1-empty-state'),
  emptyTitle: document.getElementById('v1-empty-title'),
  emptyDetail: document.getElementById('v1-empty-detail'),
  totalPairs: document.getElementById('v1-total-pairs'),
  matchCount: document.getElementById('v1-match-count'),
  errorCount: document.getElementById('v1-error-count'),
  hasData: false,
};

const IS_VERCEL = location.hostname.endsWith('.vercel.app');
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const API_BASE = (IS_VERCEL || IS_LOCAL) ? '' : null;
const V2_API = window.RADAR_V2_API || (API_BASE !== null ? `${API_BASE}/api/radar-v2` : null);
const V1_API = window.RADAR_V1_API || (API_BASE !== null ? `${API_BASE}/api/radar` : null);
const ALT_APP_ORIGIN = 'https://binance-futures-radar-xiangyingchangs-projects.vercel.app';
const V1_BACKUP_ORIGIN = 'https://binance-futures-radar-v1-backend.vercel.app';
const V2_URLS = [V2_API, V2_API, `${ALT_APP_ORIGIN}/api/radar-v2`];
const V1_URLS = [V1_API, V1_API, `${V1_BACKUP_ORIGIN}/api/radar`];
const FETCH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 800, 1800];
const REQUEST_TIMEOUT_MS = 25000;
const CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const CACHE_KEYS = {
  v2: 'binance-radar:v10:v2:last-success',
  v1: 'binance-radar:v10:v1:last-success',
};

function setLoading(value) {
  GLOBAL.refreshBtn.disabled = value;
  GLOBAL.loading.classList.toggle('hidden', !value);
}

function setStatus(element, text, level = 'normal') {
  element.textContent = text;
  element.dataset.level = level;
}

function showEmpty(group, title, detail) {
  group.emptyState.classList.remove('hidden');
  group.emptyTitle.textContent = title;
  group.emptyDetail.textContent = detail;
}

function hideEmpty(group) {
  group.emptyState.classList.add('hidden');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function fmt(value, digits = 1, suffix = '') {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}${suffix}` : '—';
}

function fmtSigned(value, digits = 1, suffix = '%') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}${suffix}`;
}

function compactUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function saveCache(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), payload }));
  } catch (_) {
    // Cache is best-effort only (private mode/storage limits may block it).
  }
}

function loadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const savedAt = Number(parsed?.savedAt || 0);
    if (!savedAt || Date.now() - savedAt > CACHE_MAX_AGE_MS || !parsed?.payload) {
      localStorage.removeItem(key);
      return null;
    }
    return { savedAt, payload: parsed.payload };
  } catch (_) {
    return null;
  }
}

function makeFetchError(message, retryable = false, kind = 'backend') {
  const error = new Error(message);
  error.retryable = retryable;
  error.kind = kind;
  return error;
}

async function fetchJsonOnce(url) {
  if (!url) throw makeFetchError('当前页面没有配置雷达后端。', false, 'config');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const upstream = payload?.upstreamStatus ? ` · 上游 HTTP ${payload.upstreamStatus}` : '';
      throw makeFetchError(
        `${payload?.message || `后端 HTTP ${response.status}`}${upstream}`,
        response.status === 429 || response.status >= 500,
        'backend'
      );
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw makeFetchError(`扫描超过 ${REQUEST_TIMEOUT_MS / 1000} 秒`, true, 'timeout');
    }
    if (error?.retryable !== undefined) throw error;

    const raw = String(error?.message || error || '').trim();
    const isNetworkFailure = error instanceof TypeError
      || /load failed|failed to fetch|network request failed|networkerror/i.test(raw);
    if (isNetworkFailure) {
      throw makeFetchError('连接雷达后端时网络短暂中断', true, 'network');
    }
    throw makeFetchError(raw || '雷达数据加载失败', false, 'client');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(urls, label, statusElement) {
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    const url = urls[Math.min(attempt - 1, urls.length - 1)];
    if (attempt > 1) {
      const usingBackup = attempt === FETCH_ATTEMPTS && url !== urls[0];
      setStatus(
        statusElement,
        usingBackup
          ? `${label} 主地址连接失败 · 正在尝试备用地址…`
          : `${label} 连接中断 · 正在重试 ${attempt}/${FETCH_ATTEMPTS}…`,
        'warning'
      );
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }

    try {
      return await fetchJsonOnce(url);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === FETCH_ATTEMPTS) break;
    }
  }

  if (lastError?.kind === 'timeout') {
    throw makeFetchError(`${label} 扫描连续超时，请稍后刷新`, false, 'timeout');
  }
  if (lastError?.kind === 'network') {
    throw makeFetchError(`${label} 网络连接失败，已尝试备用地址`, false, 'network');
  }
  throw lastError || makeFetchError(`${label} 暂时不可用`, false, 'unknown');
}

function statusMeta(status) {
  if (status === 'SHORT_SETUP') return { label: '做空候选', className: 'status-setup' };
  if (status === 'STRONG_WATCH') return { label: '强关注', className: 'status-strong' };
  return { label: '观察', className: 'status-watch' };
}

function rankText(item) {
  const primary = Number.isFinite(Number(item.rank)) ? `#${Number(item.rank)}` : '#—';
  const tags = [];
  if (Number.isFinite(Number(item.cmcRank))) tags.push(`CMC ${Number(item.cmcRank)}`);
  if (Number.isFinite(Number(item.coinGeckoRank))) tags.push(`CG ${Number(item.coinGeckoRank)}`);
  if (Number.isFinite(Number(item.binanceProxyRank))) tags.push(`PX ${Number(item.binanceProxyRank)}`);
  return `${primary}<small>${tags.length ? tags.join(' · ') : '排名不可用'}</small>`;
}

function reversalText(reversal) {
  if (!reversal) return '—';
  const tags = [];
  if (reversal.bearishDivergence) tags.push('背离');
  if (reversal.structureBreak4h) tags.push('4H 跌破');
  if (reversal.rsi1hCrossBelow80) tags.push('1H RSI 回落');
  if (reversal.structureBreak1h) tags.push('1H 跌破');
  if (!tags.length) return `0/4 · 4H RSI ${fmt(reversal.rsi4h, 1)}`;
  return `${reversal.reversalCount || tags.length}/4 · ${tags.join('、')}`;
}

function riskText(item) {
  const pieces = [];
  const maxHoldDays = Number(item?.maxHoldDays);
  const hardStopPct = Number(item?.hardStopPct);

  pieces.push(Number.isFinite(maxHoldDays) && Number.isFinite(hardStopPct)
    ? `最长 ${maxHoldDays} 天 · +${hardStopPct.toFixed(0)}% 止损`
    : '最长 3 天 · +30% 止损');

  if (Number.isFinite(Number(item?.reversal?.invalidationDistancePct))) {
    pieces.push(`ATR 参考 ${fmtSigned(item.reversal.invalidationDistancePct, 1)}`);
  }
  if (item.rankConflict) pieces.push('⚠ 排名冲突');
  if (!item.rankVerifiedForShort) pieces.push('⚠ 排名未验证');
  if (Array.isArray(item.riskFlags) && item.riskFlags.length) pieces.push('⚠ 数据/风险标记');
  if (item.catalystReviewRequired) pieces.push('需核查事件');
  return [...new Set(pieces)].join(' · ');
}

function addCopyHandler(cell, symbol) {
  cell.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(symbol);
      const old = cell.textContent;
      cell.textContent = '已复制';
      setTimeout(() => { cell.textContent = old; }, 700);
    } catch (_) {
      // Clipboard is optional.
    }
  });
}

function renderV2(items) {
  V2.tableBody.innerHTML = '';
  if (!items.length) {
    showEmpty(V2, '当前没有 V2 候选。', '扫描正常完成。这个策略本来就应该大部分时间没有交易。');
    return;
  }

  hideEmpty(V2);
  for (const item of items) {
    const row = document.createElement('tr');
    const status = statusMeta(item.status);
    const fundingPctl = Number.isFinite(Number(item.fundingPercentile))
      ? `P${Math.round(Number(item.fundingPercentile))}`
      : 'P—';
    const fundingApr = Number.isFinite(Number(item.fundingApr))
      ? `${fmtSigned(item.fundingApr, 1)}/年`
      : '—';
    const tradeLink = `https://www.binance.com/en/futures/${encodeURIComponent(item.symbol)}`;
    const tierClass = item.rankTier === 'TARGET_101_500' || item.rankTier === 'PRIMARY_101_300'
      ? 'primary-tier'
      : 'secondary-tier';

    row.innerHTML = `
      <td data-label="交易对" class="symbol-cell" title="点击复制">${item.symbol}</td>
      <td data-label="状态"><span class="status-pill ${status.className}">${status.label}</span></td>
      <td data-label="评分"><span class="score ${status.className}">${Math.round(Number(item.score || 0))}</span></td>
      <td data-label="市值排名" class="${tierClass}">${rankText(item)}</td>
      <td data-label="日线 RSI(6)" class="hot">${fmt(item.dailyRsi, 1)}</td>
      <td data-label="7 日涨幅" class="hot">${fmtSigned(item.return7dPct, 1)}</td>
      <td data-label="24H 成交额">${compactUsd(item.quoteVolumeUsd)}</td>
      <td data-label="资金费率"><strong>${fundingPctl}</strong><small>${fundingApr}</small></td>
      <td data-label="OI 24H / 7D"><strong>${fmtSigned(item.oi24hPct, 1)}</strong><small>${fmtSigned(item.oi7dPct, 1)}</small></td>
      <td data-label="反转参考" class="reversal-cell">${reversalText(item.reversal)}</td>
      <td data-label="风险 / 计划" class="risk-cell">${riskText(item)}</td>
      <td data-label=""><a class="action-btn" href="${tradeLink}" target="_blank" rel="noopener">打开 Binance</a></td>
    `;

    addCopyHandler(row.querySelector('.symbol-cell'), item.symbol);
    V2.tableBody.appendChild(row);
  }
}

function renderV1(items) {
  V1.tableBody.innerHTML = '';
  if (!items.length) {
    showEmpty(V1, '当前没有 V1 命中。', '旧版扫描正常完成，目前没有高 RSI 标的。');
    return;
  }

  hideEmpty(V1);
  for (const item of items) {
    const row = document.createElement('tr');
    const tradeLink = `https://www.binance.com/en/futures/${encodeURIComponent(item.symbol)}`;
    const rank = Number.isFinite(Number(item.rank)) ? `#${Number(item.rank)}` : '—';

    row.innerHTML = `
      <td data-label="交易对" class="symbol-cell" title="点击复制">${item.symbol}</td>
      <td data-label="市值排名">${rank}</td>
      <td data-label="1H RSI" class="hot">${fmt(item.rsi1h, 1)}</td>
      <td data-label="4H RSI" class="hot">${fmt(item.rsi4h, 1)}</td>
      <td data-label="24H 涨幅">${fmtSigned(item.change24h, 1)}</td>
      <td data-label="24H 成交额">${compactUsd(item.volume)}</td>
      <td data-label="资金费率年化">${fmtSigned(item.fundingApr, 1)}/年</td>
      <td data-label="盘口比">${fmt(item.depthRatio, 2)}</td>
      <td data-label=""><a class="action-btn" href="${tradeLink}" target="_blank" rel="noopener">打开 Binance</a></td>
    `;

    addCopyHandler(row.querySelector('.symbol-cell'), item.symbol);
    V1.tableBody.appendChild(row);
  }
}

function applyV2(payload) {
  if (!payload?.summary || !Array.isArray(payload?.matches) || !payload?.strategyVersion) {
    throw new Error('V2 返回数据格式异常');
  }

  renderV2(payload.matches);
  const s = payload.summary;
  V2.totalPairs.textContent = `交易对：${s.totalPairs}`;
  V2.universeCount.textContent = `筛选池：${s.rankedLiquidUniverse}`;
  V2.candidateCount.textContent = `候选：${s.matches}`;
  V2.setupCount.textContent = s.shortSetups;
  V2.strongCount.textContent = s.strongWatch;
  V2.watchCount.textContent = s.watch;
  V2.hasData = true;

  const warnings = payload?.diagnostics?.warnings?.length || 0;
  const errors = Number(s.dailyStageErrors || 0) + Number(s.detailStageErrors || 0);
  const duration = (Number(payload.durationMs || 0) / 1000).toFixed(1);
  const note = [
    warnings ? `${warnings} 个数据源警告` : '',
    errors ? `${errors} 个标的异常` : '',
  ].filter(Boolean).join(' · ');

  setStatus(
    V2.apiStatus,
    `V2 正常 · ${duration} 秒${note ? ` · ${note}` : ''}`,
    warnings || errors ? 'warning' : 'success'
  );
}

function applyV1(payload) {
  const validLegacy = payload?.summary && Array.isArray(payload?.matches) && payload?.strategy?.rsi1h;
  if (!validLegacy) throw new Error('V1 返回数据格式异常，或旧版接口配置错误');

  renderV1(payload.matches);
  const s = payload.summary;
  V1.totalPairs.textContent = `交易对：${s.totalPairs}`;
  V1.matchCount.textContent = `命中：${s.matches}`;
  V1.errorCount.textContent = `异常：${s.symbolErrors}`;
  V1.hasData = true;

  const duration = (Number(payload.durationMs || 0) / 1000).toFixed(1);
  setStatus(
    V1.apiStatus,
    `V1 正常 · ${duration} 秒`,
    Number(s.symbolErrors || 0) ? 'warning' : 'success'
  );
}

function restoreCachedData() {
  const timestamps = [];
  const cachedV2 = loadCache(CACHE_KEYS.v2);
  if (cachedV2) {
    try {
      applyV2(cachedV2.payload);
      setStatus(V2.apiStatus, `V2 缓存 · ${formatTime(cachedV2.savedAt)} · 正在刷新…`, 'warning');
      timestamps.push(cachedV2.savedAt);
    } catch (_) {}
  }

  const cachedV1 = loadCache(CACHE_KEYS.v1);
  if (cachedV1) {
    try {
      applyV1(cachedV1.payload);
      setStatus(V1.apiStatus, `V1 缓存 · ${formatTime(cachedV1.savedAt)} · 正在刷新…`, 'warning');
      timestamps.push(cachedV1.savedAt);
    } catch (_) {}
  }

  if (timestamps.length) {
    GLOBAL.updatedTime.textContent = `缓存时间：${formatTime(Math.max(...timestamps))}`;
  }
}

function failSection(group, label, error) {
  if (group.hasData) {
    setStatus(group.apiStatus, `${label} 刷新失败 · 保留上次结果 · ${error.message || '未知错误'}`, 'warning');
    return;
  }
  setStatus(group.apiStatus, error.message || `${label} 暂时不可用`, 'error');
  showEmpty(group, `${label} 暂时不可用。`, error.message || '未知后端错误');
}

async function updateData() {
  setLoading(true);
  setStatus(V2.apiStatus, V2.hasData ? '正在刷新 V2 · 当前结果暂时保留…' : '正在运行 V2 严格扫描…');
  setStatus(V1.apiStatus, V1.hasData ? '正在刷新 V1 · 当前结果暂时保留…' : '正在运行 V1 旧版扫描…');

  const [v2Result, v1Result] = await Promise.allSettled([
    fetchWithRetry(V2_URLS, 'V2', V2.apiStatus),
    fetchWithRetry(V1_URLS, 'V1', V1.apiStatus),
  ]);

  const timestamps = [];
  if (v2Result.status === 'fulfilled') {
    try {
      applyV2(v2Result.value);
      saveCache(CACHE_KEYS.v2, v2Result.value);
      if (v2Result.value.generatedAt) timestamps.push(new Date(v2Result.value.generatedAt));
    } catch (error) {
      failSection(V2, 'V2', error);
    }
  } else {
    failSection(V2, 'V2', v2Result.reason);
  }

  if (v1Result.status === 'fulfilled') {
    try {
      applyV1(v1Result.value);
      saveCache(CACHE_KEYS.v1, v1Result.value);
      if (v1Result.value.generatedAt) timestamps.push(new Date(v1Result.value.generatedAt));
    } catch (error) {
      failSection(V1, 'V1', error);
    }
  } else {
    failSection(V1, 'V1', v1Result.reason);
  }

  const validTimes = timestamps.filter((date) => !Number.isNaN(date.getTime()));
  if (validTimes.length) {
    GLOBAL.updatedTime.textContent = `最后更新：${formatTime(Math.max(...validTimes.map((date) => date.getTime())))}`;
  } else if (!V1.hasData && !V2.hasData) {
    GLOBAL.updatedTime.textContent = '最后更新：失败';
  }

  setLoading(false);
}

restoreCachedData();
GLOBAL.refreshBtn.addEventListener('click', updateData);
updateData();