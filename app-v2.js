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

const CONFIG = {
  endpoint: '/api/radar',
  requestTimeoutMs: 65000,
};

class RadarError extends Error {
  constructor(message, status = null, upstreamStatus = null) {
    super(message);
    this.name = 'RadarError';
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

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
      'The server completed a live Binance Futures scan successfully, but no symbol currently passes every filter.'
    );
    return;
  }

  clearEmptyState();

  items.forEach((item) => {
    const row = document.createElement('tr');
    const rankDisplay = item.rank ? `#${item.rank}` : '-';
    const fundingClass = item.fundingApr >= 0 ? 'funding-positive' : 'funding-negative';
    const depthAdvice = getDepthAdvice(item.depthRatio);
    const depthDisplay = Number.isFinite(item.depthRatio)
      ? `${depthAdvice.icon} ${item.depthRatio.toFixed(2)}X (${formatCompactUsd(item.bidPower)}/${formatCompactUsd(item.askPower)})`
      : `${depthAdvice.icon} -`;
    const tradeLink = `https://www.binance.com/en/futures/${encodeURIComponent(item.symbol)}`;

    row.innerHTML = `
      <td class="symbol-cell" title="Click to copy">${item.symbol}</td>
      <td class="rank-cell">${rankDisplay}</td>
      <td class="${fundingClass}">${item.fundingApr >= 0 ? '+' : ''}${item.fundingApr.toFixed(2)}% <span class="interval-tag">(${item.interval}h)</span></td>
      <td class="rsi-extreme">${item.rsi1h.toFixed(1)}</td>
      <td class="rsi-extreme">${item.rsi4h.toFixed(1)}</td>
      <td class="depth-cell ${depthAdvice.className}" title="Top 100 levels">${depthDisplay}<div class="depth-advice">${depthAdvice.text}</div></td>
      <td><a href="${tradeLink}" target="_blank" rel="noopener noreferrer" class="action-btn">Trade</a></td>
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
        // Clipboard may be unavailable in embedded browsers.
      }
    });

    ELEMENTS.tableBody.appendChild(row);
  });
}

async function fetchRadar() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

  try {
    const response = await fetch(CONFIG.endpoint, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      // Preserve HTTP status even if an unexpected response is not JSON.
    }

    if (!response.ok) {
      throw new RadarError(
        payload?.message || payload?.error || `HTTP ${response.status}`,
        response.status,
        payload?.upstreamStatus ?? null
      );
    }

    if (!payload || !Array.isArray(payload.matches) || !payload.summary) {
      throw new RadarError('Malformed radar API response', response.status);
    }

    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new RadarError('Radar scan timed out.');
    }
    if (error instanceof RadarError) throw error;
    throw new RadarError(error.message || 'Unable to reach radar backend.');
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error) {
  if (error.upstreamStatus === 451) {
    return 'The radar server is running, but Binance rejected its server region with HTTP 451.';
  }
  if (error.upstreamStatus === 429) {
    return 'Binance rate-limited the radar server (HTTP 429).';
  }
  if (error.status) {
    return `Radar backend failed: HTTP ${error.status}${error.message ? ` · ${error.message}` : ''}`;
  }
  return error.message || 'Unable to reach radar backend.';
}

async function updateData() {
  setLoading(true);
  clearEmptyState();
  ELEMENTS.tableBody.innerHTML = '';
  ELEMENTS.totalPairs.textContent = 'Scanning…';
  ELEMENTS.filteredPairs.textContent = 'Matches: --';
  ELEMENTS.updatedTime.textContent = 'Last Updated: --:--';
  setStatus('Server is scanning live Binance Futures data…');

  try {
    const payload = await fetchRadar();
    renderTable(payload.matches);

    const generated = payload.generatedAt ? new Date(payload.generatedAt) : new Date();
    ELEMENTS.updatedTime.textContent = `Last Updated: ${generated.toLocaleTimeString()}`;
    ELEMENTS.totalPairs.textContent = `Scanned: ${payload.summary.totalPairs}`;
    ELEMENTS.filteredPairs.textContent = `Matches: ${payload.summary.matches}`;

    const suffix = payload.summary.symbolErrors
      ? ` · ${payload.summary.symbolErrors} symbol requests failed`
      : '';
    setStatus(
      `Server-side live scan · ${payload.summary.totalPairs} pairs · ${(payload.durationMs / 1000).toFixed(1)}s${suffix}`,
      payload.summary.symbolErrors ? 'warning' : 'success'
    );
  } catch (error) {
    console.error('Radar update failed', error);
    const message = describeError(error);
    ELEMENTS.totalPairs.textContent = 'Pairs: --';
    ELEMENTS.filteredPairs.textContent = 'Matches: --';
    setStatus(message, 'error');
    setEmptyState('Live market data is unavailable.', message);
  } finally {
    setLoading(false);
  }
}

ELEMENTS.refreshBtn.addEventListener('click', updateData);
updateData();
