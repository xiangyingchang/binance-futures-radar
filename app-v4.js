'use strict';

const ELEMENTS = {
  updatedTime: document.getElementById('last-updated'),
  refreshBtn: document.getElementById('refresh-btn'),
  loading: document.getElementById('loading-indicator'),
  tableBody: document.getElementById('table-body'),
  emptyState: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptyDetail: document.getElementById('empty-detail'),
  totalPairs: document.getElementById('total-pairs'),
  universeCount: document.getElementById('universe-count'),
  candidateCount: document.getElementById('candidate-count'),
  setupCount: document.getElementById('setup-count'),
  strongCount: document.getElementById('strong-count'),
  watchCount: document.getElementById('watch-count'),
  apiStatus: document.getElementById('api-status'),
};

const IS_VERCEL = location.hostname.endsWith('.vercel.app');
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const API_URL = window.RADAR_API_BASE || ((IS_VERCEL || IS_LOCAL) ? '/api/radar-v2' : null);

function setLoading(value) {
  ELEMENTS.refreshBtn.disabled = value;
  ELEMENTS.loading.classList.toggle('hidden', !value);
}

function setStatus(text, level = 'normal') {
  ELEMENTS.apiStatus.textContent = text;
  ELEMENTS.apiStatus.dataset.level = level;
}

function showEmpty(title, detail) {
  ELEMENTS.emptyState.classList.remove('hidden');
  ELEMENTS.emptyTitle.textContent = title;
  ELEMENTS.emptyDetail.textContent = detail;
}

function hideEmpty() {
  ELEMENTS.emptyState.classList.add('hidden');
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

function statusMeta(status) {
  if (status === 'SHORT_SETUP') return { label: 'SHORT SETUP', className: 'status-setup' };
  if (status === 'STRONG_WATCH') return { label: 'STRONG WATCH', className: 'status-strong' };
  return { label: 'WATCH', className: 'status-watch' };
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
  if (Number.isFinite(Number(item?.reversal?.invalidationDistancePct))) {
    pieces.push(`Invalidation ${fmtSigned(item.reversal.invalidationDistancePct, 1)}`);
  }
  if (Array.isArray(item.riskFlags) && item.riskFlags.length) pieces.push('⚠ data/risk flag');
  if (item.catalystReviewRequired) pieces.push('Catalyst check');
  return pieces.join(' · ') || 'Catalyst check';
}

function renderRows(items) {
  ELEMENTS.tableBody.innerHTML = '';
  if (!items.length) {
    showEmpty(
      'No extreme short candidates right now.',
      'The scan completed successfully. This strategy should often return zero rather than force a trade.'
    );
    return;
  }

  hideEmpty();
  for (const item of items) {
    const row = document.createElement('tr');
    const status = statusMeta(item.status);
    const rankSource = item.rankSource === 'coingecko' ? 'CG' : 'proxy';
    const fundingPctl = Number.isFinite(Number(item.fundingPercentile))
      ? `P${Math.round(Number(item.fundingPercentile))}`
      : 'P—';
    const fundingApr = Number.isFinite(Number(item.fundingApr))
      ? `${fmtSigned(item.fundingApr, 1)}/yr`
      : '—';
    const tradeLink = `https://www.binance.com/en/futures/${encodeURIComponent(item.symbol)}`;
    const tierClass = item.rankTier === 'PRIMARY_101_300' ? 'primary-tier' : 'secondary-tier';

    row.innerHTML = `
      <td class="symbol-cell" title="Tap to copy">${item.symbol}</td>
      <td><span class="status-pill ${status.className}">${status.label}</span></td>
      <td><span class="score ${status.className}">${Math.round(Number(item.score || 0))}</span></td>
      <td class="${tierClass}">#${item.rank ?? '—'} <small>${rankSource}</small></td>
      <td class="hot">${fmt(item.dailyRsi, 1)}</td>
      <td class="hot">${fmtSigned(item.return7dPct, 1)}</td>
      <td>${compactUsd(item.quoteVolumeUsd)}</td>
      <td><strong>${fundingPctl}</strong><small>${fundingApr}</small></td>
      <td><strong>${fmtSigned(item.oi24hPct, 1)}</strong><small>${fmtSigned(item.oi7dPct, 1)}</small></td>
      <td class="reversal-cell">${reversalText(item.reversal)}</td>
      <td class="risk-cell">${riskText(item)}</td>
      <td><a class="action-btn" href="${tradeLink}" target="_blank" rel="noopener">Binance</a></td>
    `;

    const symbol = row.querySelector('.symbol-cell');
    symbol.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.symbol);
        const old = symbol.textContent;
        symbol.textContent = 'Copied';
        setTimeout(() => { symbol.textContent = old; }, 700);
      } catch (_) {
        // Clipboard is optional.
      }
    });
    ELEMENTS.tableBody.appendChild(row);
  }
}

async function fetchRadar() {
  if (!API_URL) throw new Error('Open the Vercel deployment; this host has no radar backend.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);
  try {
    const response = await fetch(API_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const upstream = payload?.upstreamStatus ? ` · upstream HTTP ${payload.upstreamStatus}` : '';
      throw new Error(`${payload?.message || `Backend HTTP ${response.status}`}${upstream}`);
    }
    if (!payload?.summary || !Array.isArray(payload?.matches)) {
      throw new Error('Malformed radar response');
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Radar scan timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function updateData() {
  setLoading(true);
  hideEmpty();
  ELEMENTS.tableBody.innerHTML = '';
  setStatus('Running staged Binance scan…');
  try {
    const payload = await fetchRadar();
    renderRows(payload.matches);
    const s = payload.summary;
    ELEMENTS.totalPairs.textContent = `Pairs: ${s.totalPairs}`;
    ELEMENTS.universeCount.textContent = `Universe: ${s.rankedLiquidUniverse}`;
    ELEMENTS.candidateCount.textContent = `Candidates: ${s.matches}`;
    ELEMENTS.setupCount.textContent = s.shortSetups;
    ELEMENTS.strongCount.textContent = s.strongWatch;
    ELEMENTS.watchCount.textContent = s.watch;
    ELEMENTS.updatedTime.textContent = `Last updated: ${new Date(payload.generatedAt).toLocaleString()}`;

    const warnings = payload?.diagnostics?.warnings?.length || 0;
    const errors = Number(s.dailyStageErrors || 0) + Number(s.detailStageErrors || 0);
    const duration = (Number(payload.durationMs || 0) / 1000).toFixed(1);
    const note = [
      warnings ? `${warnings} source warning${warnings > 1 ? 's' : ''}` : '',
      errors ? `${errors} symbol error${errors > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
    setStatus(
      `V2 scan OK · ${duration}s${note ? ` · ${note}` : ''}`,
      (warnings || errors) ? 'warning' : 'success'
    );
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Radar unavailable', 'error');
    showEmpty('Live scan unavailable.', error.message || 'Unknown backend error');
    ['totalPairs', 'universeCount', 'candidateCount'].forEach((key) => {
      ELEMENTS[key].textContent = '—';
    });
    ['setupCount', 'strongCount', 'watchCount'].forEach((key) => {
      ELEMENTS[key].textContent = '—';
    });
  } finally {
    setLoading(false);
  }
}

ELEMENTS.refreshBtn.addEventListener('click', updateData);
updateData();
