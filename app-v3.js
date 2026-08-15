const ELEMENTS = {
  updatedTime: document.getElementById('last-updated'),
  refreshBtn: document.getElementById('refresh-btn'),
  loading: document.getElementById('loading-indicator'),
  tableBody: document.getElementById('table-body'),
  emptyState: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptyDetail: document.getElementById('empty-detail'),
  totalPairs: document.getElementById('total-pairs'),
  filteredPairs: document.getElementById('filtered-pairs'),
  apiStatus: document.getElementById('api-status'),
};

const IS_VERCEL = location.hostname.endsWith('.vercel.app');
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const API_URL = window.RADAR_API_BASE || ((IS_VERCEL || IS_LOCAL) ? '/api/radar' : null);

function setStatus(text, level = 'normal') {
  if (!ELEMENTS.apiStatus) return;
  ELEMENTS.apiStatus.textContent = text;
  ELEMENTS.apiStatus.dataset.level = level;
}

function setEmptyState(title, detail) {
  ELEMENTS.emptyState.classList.remove('hidden');
  if (ELEMENTS.emptyTitle) ELEMENTS.emptyTitle.textContent = title;
  if (ELEMENTS.emptyDetail) ELEMENTS.emptyDetail.textContent = detail;
}

function clearEmptyState() {
  ELEMENTS.emptyState.classList.add('hidden');
}

function setLoading(isLoading) {
  ELEMENTS.refreshBtn.disabled = isLoading;
  ELEMENTS.loading.classList.toggle('hidden', !isLoading);
}

function formatCompactUsd(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}b`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}k`;
  return value.toFixed(0);
}

function getDepthAdvice(ratio) {
  if (!Number.isFinite(ratio)) return { icon: '⚪️', text: 'Unavailable', className: '' };
  if (ratio >= 2.0) return { icon: '🟢', text: 'Strong Support', className: 'funding-positive' };
  if (ratio >= 1.2) return { icon: '🟢', text: 'Bullish Pressure', className: 'funding-positive' };
  if (ratio <= 0.5) return { icon: '🔴', text: 'Strong Resistance', className: 'funding-negative' };
  if (ratio <= 0.8) return { icon: '🔴', text: 'Bearish Pressure', className: 'funding-negative' };
  return { icon: '⚪️', text: 'Neutral', className: '' };
}

function renderTable(items) {
  ELEMENTS.tableBody.innerHTML = '';

  if (!items.length) {
    setEmptyState(
      'No pairs match the strategy right now.',
      'The server-side Binance scan completed successfully; no symbol currently passes every filter.'
    );
    return;
  }

  clearEmptyState();

  for (const item of items) {
    const row = document.createElement('tr');
    const rankDisplay = item.rank ? `#${item.rank}` : '-';
    const fundingApr = Number(item.fundingApr || 0);
    const fundingClass = fundingApr >= 0 ? 'funding-positive' : 'funding-negative';
    const ratio = Number(item.depthRatio);
    const depthAdvice = getDepthAdvice(ratio);
    const depthDisplay = Number.isFinite(ratio)
      ? `${depthAdvice.icon} ${ratio.toFixed(2)}X (${formatCompactUsd(Number(item.bidPower))}/${formatCompactUsd(Number(item.askPower))})`
      : `${depthAdvice.icon} -`;
    const tradeLink = `https://www.binance.com/en/futures/${encodeURIComponent(item.symbol)}`;

    row.innerHTML = `
      <td class="symbol-cell" title="Click to copy">${item.symbol}</td>
      <td class="rank-cell">${rankDisplay}</td>
      <td class="${fundingClass}">${fundingApr >= 0 ? '+' : ''}${fundingApr.toFixed(2)}% <span class="interval-tag">(${item.interval || 8}h)</span></td>
      <td class="rsi-extreme">${Number(item.rsi1h).toFixed(1)}</td>
      <td class="rsi-extreme">${Number(item.rsi4h).toFixed(1)}</td>
      <td class="depth-cell ${depthAdvice.className}">${depthDisplay}<div class="depth-advice">${depthAdvice.text}</div></td>
      <td><a href="${tradeLink}" target="_blank" rel="noopener" class="action-btn">Trade</a></td>
    `;

    const symbolCell = row.querySelector('.symbol-cell');
    symbolCell.style.cursor = 'copy';
    symbolCell.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.symbol);
        const original = symbolCell.textContent;
        symbolCell.textContent = 'Copied!';
        setTimeout(() => { symbolCell.textContent = original; }, 800);
      } catch (_) {
        // Clipboard is optional and should never break the table.
      }
    });

    ELEMENTS.tableBody.appendChild(row);
  }
}

async function fetchRadar() {
  if (!API_URL) {
    throw new Error('Server backend is not configured for this host. Open the Vercel deployment instead of GitHub Pages.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);

  try {
    const response = await fetch(API_URL, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      // HTTP status still gives us a useful error.
    }

    if (!response.ok) {
      const upstream = payload?.upstreamStatus ? ` · Binance HTTP ${payload.upstreamStatus}` : '';
      throw new Error(`${payload?.message || `Backend HTTP ${response.status}`}${upstream}`);
    }

    if (!Array.isArray(payload?.matches) || !payload?.summary) {
      throw new Error('Radar backend returned malformed data.');
    }

    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Radar scan timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function updateData() {
  setLoading(true);
  clearEmptyState();
  ELEMENTS.tableBody.innerHTML = '';
  ELEMENTS.totalPairs.textContent = 'Scanning…';
  ELEMENTS.filteredPairs.textContent = 'Matches: --';
  setStatus('Running server-side Binance Futures scan…');

  try {
    const payload = await fetchRadar();
    renderTable(payload.matches);

    const generatedAt = payload.generatedAt ? new Date(payload.generatedAt) : new Date();
    ELEMENTS.updatedTime.textContent = `Last Updated: ${generatedAt.toLocaleTimeString()}`;
    ELEMENTS.totalPairs.textContent = `Scanned: ${payload.summary.totalPairs}`;
    ELEMENTS.filteredPairs.textContent = `Matches: ${payload.summary.matches}`;

    const duration = Number(payload.durationMs || 0) / 1000;
    const errors = Number(payload.summary.symbolErrors || 0);
    const rankNote = payload.summary.rankAvailable ? '' : ' · rank source unavailable';
    const errorNote = errors ? ` · ${errors} symbol API errors` : '';
    setStatus(`Server scan OK · ${duration.toFixed(1)}s${errorNote}${rankNote}`, errors ? 'warning' : 'success');
  } catch (error) {
    console.error('Radar load failed', error);
    ELEMENTS.totalPairs.textContent = 'Pairs: --';
    ELEMENTS.filteredPairs.textContent = 'Matches: --';
    ELEMENTS.updatedTime.textContent = 'Last Updated: --:--';
    setStatus(error.message || 'Radar backend unavailable', 'error');
    setEmptyState('Live market data is unavailable.', error.message || 'Radar backend unavailable');
  } finally {
    setLoading(false);
  }
}

ELEMENTS.refreshBtn.addEventListener('click', updateData);
updateData();
