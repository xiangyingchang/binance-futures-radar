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
};

const IS_VERCEL = location.hostname.endsWith('.vercel.app');
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const API_BASE = (IS_VERCEL || IS_LOCAL) ? '' : null;
const V2_API = window.RADAR_V2_API || (API_BASE !== null ? `${API_BASE}/api/radar-v2` : null);
const V1_API = window.RADAR_V1_API || (API_BASE !== null ? `${API_BASE}/api/radar` : null);
const FETCH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 800, 2000];

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

function makeFetchError(message, retryable = false, kind = 'backend') {
  const error = new Error(message);
  error.retryable = retryable;
  error.kind = kind;
  return error;
}

async function fetchJsonOnce(url) {
  if (!url) throw makeFetchError('This host has no radar backend.', false, 'config');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const upstream = payload?.upstreamStatus ? ` · upstream HTTP ${payload.upstreamStatus}` : '';
      throw makeFetchError(
        `${payload?.message || `Backend HTTP ${response.status}`}${upstream}`,
        response.status === 429 || response.status >= 500,
        'backend'
      );
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw makeFetchError('Radar scan timed out', true, 'network');
    if (error?.retryable !== undefined) throw error;
    const raw = String(error?.message || error || '').trim();
    const isNetworkFailure = error instanceof TypeError
      || /load failed|failed to fetch|network request failed|networkerror/i.test(raw);
    if (isNetworkFailure) {
      throw makeFetchError('Temporary network failure while contacting the radar backend', true, 'network');
    }
    throw makeFetchError(raw || 'Unable to load radar data', true, 'network');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, label, statusElement) {
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      setStatus(statusElement, `${label} connection interrupted · retrying ${attempt}/${FETCH_ATTEMPTS}…`, 'warning');
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      return await fetchJsonOnce(url);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === FETCH_ATTEMPTS) break;
    }
  }
  if (lastError?.kind === 'network') {
    throw new Error(`${label} network request failed after 3 attempts`);
  }
  throw lastError || new Error(`${label} unavailable`);
}

function statusMeta(status) {
  if (status === 'SHORT_SETUP') return { label: 'SHORT SETUP', className: 'status-setup' };
  if (status === 'STRONG_WATCH') return { label: 'STRONG WATCH', className: 'status-strong' };
  return { label: 'WATCH', className: 'status-watch' };
}

function rankText(item) {
  const primary = Number.isFinite(Number(item.rank)) ? `#${Number(item.rank)}` : '#—';
  const tags = [];
  if (Number.isFinite(Number(item.cmcRank))) tags.push(`CMC ${Number(item.cmcRank)}`);
  if (Number.isFinite(Number(item.coinGeckoRank))) tags.push(`CG ${Number(item.coinGeckoRank)}`);
  if (Number.isFinite(Number(item.binanceProxyRank))) tags.push(`PX ${Number(item.binanceProxyRank)}`);
  return `${primary}<small>${tags.length ? tags.join(' · ') : 'rank unavailable'}</small>`;
}

function reversalText(reversal) {
  if (!reversal) return '—';
  const tags = [];
  if (reversal.bearishDivergence) tags.push('Div');
  if (reversal.structureBreak4h) tags.push('4H break');
  if (reversal.rsi1hCrossBelow80) tags.push('1H RSI↓');
  if (reversal.structureBreak1h) tags.push('1H break');
  if (!tags.length) return `0/4 · 4H RSI ${fmt(reversal.rsi4h, 1)}`;
  return `${reversal.reversalCount || tags.length}/4 · ${tags.join(', ')}`;
}

function riskText(item) {
  const pieces = [];
  const maxHoldDays = Number(item?.maxHoldDays);
  const hardStopPct = Number(item?.hardStopPct);
  pieces.push(Number.isFinite(maxHoldDays) && Number.isFinite(hardStopPct)
    ? `${maxHoldDays}D max · +${hardStopPct.toFixed(0)}% stop`
    : '3D max · +30% stop');
  if (Number.isFinite(Number(item?.reversal?.invalidationDistancePct))) {
    pieces.push(`ATR ref ${fmtSigned(item.reversal.invalidationDistancePct, 1)}`);
  }
  if (item.rankConflict) pieces.push('⚠ rank conflict');
  if (!item.rankVerifiedForShort) pieces.push('⚠ rank not verified');
  if (Array.isArray(item.riskFlags) && item.riskFlags.length) pieces.push('⚠ data/risk flag');
  if (item.catalystReviewRequired) pieces.push('Catalyst check');
  return [...new Set(pieces)].join(' · ');
}

function addCopyHandler(cell, symbol) {
  cell.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(symbol);
      const old = cell.textContent;
      cell.textContent = 'Copied';
      setTimeout(() => { cell.textContent = old; }, 700);
    } catch (_) {
      // Clipboard is optional.
    }
  });
}

function renderV2(items) {
  V2.tableBody.innerHTML = '';
  if (!items.length) {
    showEmpty(V2, 'No V2 candidates right now.', 'The strict V2 scan completed successfully. Staying idle is a valid result.');
    return;
  }
  hideEmpty(V2);
  for (const item of items) {
    const row = document.createElement('tr');
    const status = statusMeta(item.status);
    const fundingPctl = Number.isFinite(Number(item.fundingPercentile)) ? `P${Math.round(Number(item.fundingPercentile))}` : 'P—';
    const fundingApr = Number.isFinite(Number(item.fundingApr)) ? `${fmtSigned(item.fundingApr, 1)}/yr` : '—';
    const tradeLink = `https://www.binance.com/en/futures/${encodeURIComponent(item.symbol)}`;
    const tierClass = item.rankTier === 'TARGET_101_500' || item.rankTier === 'PRIMARY_101_300' ? 'primary-tier' : 'secondary-tier';
    row.innerHTML = `
      <td class="symbol-cell" title="Tap to copy">${item.symbol}</td>
      <td><span class="status-pill ${status.className}">${status.label}</span></td>
      <td><span class="score ${status.className}">${Math.round(Number(item.score || 0))}</span></td>
      <td class="${tierClass}">${rankText(item)}</td>
      <td class="hot">${fmt(item.dailyRsi, 1)}</td>
      <td class="hot">${fmtSigned(item.return7dPct, 1)}</td>
      <td>${compactUsd(item.quoteVolumeUsd)}</td>
      <td><strong>${fundingPctl}</strong><small>${fundingApr}</small></td>
      <td><strong>${fmtSigned(item.oi24hPct, 1)}</strong><small>${fmtSigned(item.oi7dPct, 1)}</small></td>
      <td class="reversal-cell">${reversalText(item.reversal)}</td>
      <td class="risk-cell">${riskText(item)}</td>
      <td><a class="action-btn" href="${tradeLink}" target="_blank" rel="noopener">Binance</a></td>
    `;
    addCopyHandler(row.querySelector('.symbol-cell'), item.symbol);
    V2.tableBody.appendChild(row);
  }
}

function renderV1(items) {
  V1.tableBody.innerHTML = '';
  if (!items.length) {
    showEmpty(V1, 'No V1 matches right now.', 'The legacy V1 scan completed successfully and found no high-RSI matches.');
    return;
  }
  hideEmpty(V1);
  for (const item of items) {
    const row = document.createElement('tr');
    const tradeLink = `https://www.binance.com/en/futures/${encodeURIComponent(item.symbol)}`;
    const rank = Number.isFinite(Number(item.rank)) ? `#${Number(item.rank)}` : '—';
    row.innerHTML = `
      <td class="symbol-cell" title="Tap to copy">${item.symbol}</td>
      <td>${rank}</td>
      <td class="hot">${fmt(item.rsi1h, 1)}</td>
      <td class="hot">${fmt(item.rsi4h, 1)}</td>
      <td>${fmtSigned(item.change24h, 1)}</td>
      <td>${compactUsd(item.volume)}</td>
      <td>${fmtSigned(item.fundingApr, 1)}/yr</td>
      <td>${fmt(item.depthRatio, 2)}</td>
      <td><a class="action-btn" href="${tradeLink}" target="_blank" rel="noopener">Binance</a></td>
    `;
    addCopyHandler(row.querySelector('.symbol-cell'), item.symbol);
    V1.tableBody.appendChild(row);
  }
}

function applyV2(payload) {
  if (!payload?.summary || !Array.isArray(payload?.matches) || !payload?.strategyVersion) {
    throw new Error('Malformed V2 radar response');
  }
  renderV2(payload.matches);
  const s = payload.summary;
  V2.totalPairs.textContent = `Pairs: ${s.totalPairs}`;
  V2.universeCount.textContent = `Universe: ${s.rankedLiquidUniverse}`;
  V2.candidateCount.textContent = `Candidates: ${s.matches}`;
  V2.setupCount.textContent = s.shortSetups;
  V2.strongCount.textContent = s.strongWatch;
  V2.watchCount.textContent = s.watch;
  const warnings = payload?.diagnostics?.warnings?.length || 0;
  const errors = Number(s.dailyStageErrors || 0) + Number(s.detailStageErrors || 0);
  const duration = (Number(payload.durationMs || 0) / 1000).toFixed(1);
  const note = [warnings ? `${warnings} source warning${warnings > 1 ? 's' : ''}` : '', errors ? `${errors} symbol error${errors > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
  setStatus(V2.apiStatus, `V2 OK · ${duration}s${note ? ` · ${note}` : ''}`, warnings || errors ? 'warning' : 'success');
}

function applyV1(payload) {
  const validLegacy = payload?.summary && Array.isArray(payload?.matches) && payload?.strategy?.rsi1h;
  if (!validLegacy) throw new Error('Malformed V1 response or V1 endpoint is not serving the legacy scanner');
  renderV1(payload.matches);
  const s = payload.summary;
  V1.totalPairs.textContent = `Pairs: ${s.totalPairs}`;
  V1.matchCount.textContent = `Matches: ${s.matches}`;
  V1.errorCount.textContent = `Symbol errors: ${s.symbolErrors}`;
  const duration = (Number(payload.durationMs || 0) / 1000).toFixed(1);
  setStatus(V1.apiStatus, `V1 OK · ${duration}s`, Number(s.symbolErrors || 0) ? 'warning' : 'success');
}

function failSection(group, label, error) {
  setStatus(group.apiStatus, error.message || `${label} unavailable`, 'error');
  group.tableBody.innerHTML = '';
  showEmpty(group, `${label} unavailable.`, error.message || 'Unknown backend error');
}

async function updateData() {
  setLoading(true);
  V2.tableBody.innerHTML = '';
  V1.tableBody.innerHTML = '';
  hideEmpty(V2);
  hideEmpty(V1);
  setStatus(V2.apiStatus, 'Running V2 strict scan…');
  setStatus(V1.apiStatus, 'Running V1 legacy scan…');

  const [v2Result, v1Result] = await Promise.allSettled([
    fetchWithRetry(V2_API, 'V2', V2.apiStatus),
    fetchWithRetry(V1_API, 'V1', V1.apiStatus),
  ]);

  const timestamps = [];
  if (v2Result.status === 'fulfilled') {
    try {
      applyV2(v2Result.value);
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
      if (v1Result.value.generatedAt) timestamps.push(new Date(v1Result.value.generatedAt));
    } catch (error) {
      failSection(V1, 'V1', error);
    }
  } else {
    failSection(V1, 'V1', v1Result.reason);
  }

  const validTimes = timestamps.filter((date) => !Number.isNaN(date.getTime()));
  GLOBAL.updatedTime.textContent = validTimes.length
    ? `Last updated: ${new Date(Math.max(...validTimes.map((date) => date.getTime()))).toLocaleString()}`
    : 'Last updated: failed';
  setLoading(false);
}

GLOBAL.refreshBtn.addEventListener('click', updateData);
updateData();
