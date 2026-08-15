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
    apiStatus: document.getElementById('api-status')
};

const CONFIG = {
    apiBase: 'https://fapi.binance.com',
    requestTimeoutMs: 12000,
    rsiPeriod: 6,
    klineLimit: 35,
    rsi1hThreshold: 90,
    rsi4hThreshold: 80,
    fundingAprMin: -500,
    rankMinExclusive: 100,
    change24hMax: 35,
    concurrency: 12,
    depthLimit: 100,
    rankCacheTTL: 60 * 60 * 1000
};

const CACHE = {
    productList: null,
    productListAt: 0
};

class ApiError extends Error {
    constructor(message, { status = null, code = null, endpoint = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.endpoint = endpoint;
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

async function fetchJson(url, { params = {}, timeoutMs = CONFIG.requestTimeoutMs } = {}) {
    const target = new URL(url);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
            target.searchParams.set(key, String(value));
        }
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(target.toString(), {
            method: 'GET',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: controller.signal
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (_) {
            // Keep payload null; the HTTP status remains the useful signal.
        }

        if (!response.ok) {
            const apiMessage = payload?.msg || payload?.message || `HTTP ${response.status}`;
            throw new ApiError(apiMessage, {
                status: response.status,
                code: payload?.code ?? null,
                endpoint: target.pathname
            });
        }

        return payload;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new ApiError(`Request timed out after ${timeoutMs / 1000}s`, {
                endpoint: target.pathname
            });
        }
        if (error instanceof ApiError) throw error;
        throw new ApiError(error.message || 'Network request failed', {
            endpoint: target.pathname
        });
    } finally {
        clearTimeout(timer);
    }
}

function futuresGet(path, params = {}) {
    return fetchJson(`${CONFIG.apiBase}${path}`, { params });
}

async function fetchExchangeInfo() {
    const data = await futuresGet('/fapi/v1/exchangeInfo');
    if (!Array.isArray(data?.symbols)) {
        throw new ApiError('Malformed exchangeInfo response', { endpoint: '/fapi/v1/exchangeInfo' });
    }

    const activeSymbols = data.symbols.filter((symbol) =>
        symbol.quoteAsset === 'USDT' &&
        symbol.status === 'TRADING' &&
        symbol.underlyingType === 'COIN'
    );

    return {
        symbols: activeSymbols.map((symbol) => symbol.symbol),
        baseMap: activeSymbols.reduce((acc, symbol) => {
            acc[symbol.symbol] = symbol.baseAsset;
            return acc;
        }, {})
    };
}

async function fetch24hTicker() {
    const data = await futuresGet('/fapi/v1/ticker/24hr');
    if (!Array.isArray(data)) {
        throw new ApiError('Malformed 24h ticker response', { endpoint: '/fapi/v1/ticker/24hr' });
    }

    return data.reduce((acc, item) => {
        acc[item.symbol] = {
            volume: Number(item.quoteVolume || 0),
            priceChangePercent: Number(item.priceChangePercent || 0)
        };
        return acc;
    }, {});
}

async function fetchFundingRates() {
    const data = await futuresGet('/fapi/v1/premiumIndex');
    if (!Array.isArray(data)) {
        throw new ApiError('Malformed premiumIndex response', { endpoint: '/fapi/v1/premiumIndex' });
    }

    return data.reduce((acc, item) => {
        acc[item.symbol] = Number(item.lastFundingRate || 0);
        return acc;
    }, {});
}

async function fetchFundingIntervals() {
    try {
        const data = await futuresGet('/fapi/v1/fundingInfo');
        if (!Array.isArray(data)) return {};
        return data.reduce((acc, item) => {
            acc[item.symbol] = Number(item.fundingIntervalHours || 8);
            return acc;
        }, {});
    } catch (error) {
        console.warn('Funding interval API unavailable; defaulting to 8h.', error);
        return {};
    }
}

async function fetchProductData() {
    const now = Date.now();
    if (CACHE.productList && now - CACHE.productListAt < CONFIG.rankCacheTTL) {
        return CACHE.productList;
    }

    try {
        const json = await fetchJson(
            'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products',
            { params: { includeEtf: 'true' } }
        );
        const list = Array.isArray(json?.data) ? json.data : [];
        CACHE.productList = list;
        CACHE.productListAt = now;
        return list;
    } catch (error) {
        console.warn('Market-cap rank source unavailable; rank filter will be skipped when unknown.', error);
        return CACHE.productList || [];
    }
}

async function fetchKlines(symbol, interval) {
    const data = await futuresGet('/fapi/v1/klines', {
        symbol,
        interval,
        limit: CONFIG.klineLimit
    });

    if (!Array.isArray(data)) return [];
    return data.map((candle) => Number(candle[4])).filter(Number.isFinite);
}

async function fetchDepth(symbol) {
    try {
        const data = await futuresGet('/fapi/v1/depth', {
            symbol,
            limit: CONFIG.depthLimit
        });
        if (!Array.isArray(data?.bids) || !Array.isArray(data?.asks)) return null;
        return data;
    } catch (error) {
        console.warn(`Depth unavailable for ${symbol}`, error);
        return null;
    }
}

function calculateRSI(closes, period = CONFIG.rsiPeriod) {
    if (!Array.isArray(closes) || closes.length < period + 1) return 0;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i += 1) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i += 1) {
        const diff = closes[i] - closes[i - 1];
        const currentGain = diff > 0 ? diff : 0;
        const currentLoss = diff < 0 ? Math.abs(diff) : 0;
        avgGain = ((avgGain * (period - 1)) + currentGain) / period;
        avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
    }

    if (avgGain === 0 && avgLoss === 0) return 50;
    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function buildRankMap(productList) {
    const marketCaps = [];

    productList.forEach((item) => {
        if (item.q !== 'USDT' || item.cs == null) return;
        const price = Number(item.c || 0);
        const circulatingSupply = Number(item.cs || 0);
        if (price > 0 && circulatingSupply > 0) {
            marketCaps.push({ base: item.b, marketCap: price * circulatingSupply });
        }
    });

    marketCaps.sort((a, b) => b.marketCap - a.marketCap);

    return marketCaps.reduce((acc, item, index) => {
        if (!acc[item.base]) acc[item.base] = index + 1;
        return acc;
    }, {});
}

function resolveRank(symbol, baseMap, rankMap) {
    const base = baseMap[symbol] || symbol.replace(/USDT$/, '');
    let rank = rankMap[base];
    if (!rank && base.startsWith('1000')) rank = rankMap[base.slice(4)];
    return rank || null;
}

function fundingApr(rate, intervalHours) {
    const interval = intervalHours > 0 ? intervalHours : 8;
    return rate * (24 / interval) * 365 * 100;
}

function analyzeDepth(depthData) {
    if (!depthData) {
        return { depthRatio: null, bidPower: null, askPower: null };
    }

    const bidPower = depthData.bids.reduce(
        (sum, [price, qty]) => sum + Number(price) * Number(qty),
        0
    );
    const askPower = depthData.asks.reduce(
        (sum, [price, qty]) => sum + Number(price) * Number(qty),
        0
    );

    return {
        depthRatio: askPower > 0 ? bidPower / askPower : null,
        bidPower,
        askPower
    };
}

async function processSymbol(symbol, context) {
    const { stats, fundingMap, fundingIntervals, baseMap, rankMap } = context;

    const k1h = await fetchKlines(symbol, '1h');
    const rsi1h = calculateRSI(k1h);
    if (rsi1h <= CONFIG.rsi1hThreshold) return null;

    const k4h = await fetchKlines(symbol, '4h');
    const rsi4h = calculateRSI(k4h);
    if (rsi4h < CONFIG.rsi4hThreshold) return null;

    const interval = fundingIntervals[symbol] || 8;
    const funding = fundingMap[symbol] || 0;
    const annualizedFunding = fundingApr(funding, interval);
    if (annualizedFunding <= CONFIG.fundingAprMin) return null;

    const change24h = stats[symbol]?.priceChangePercent || 0;
    if (change24h >= CONFIG.change24hMax) return null;

    const rank = resolveRank(symbol, baseMap, rankMap);
    if (rank !== null && rank <= CONFIG.rankMinExclusive) return null;

    const depth = analyzeDepth(await fetchDepth(symbol));

    return {
        symbol,
        rank,
        funding,
        fundingApr: annualizedFunding,
        interval,
        rsi1h,
        rsi4h,
        change24h,
        volume: stats[symbol]?.volume || 0,
        ...depth
    };
}

async function scanWithPool(symbols, context) {
    const results = [];
    let cursor = 0;
    let completed = 0;

    const worker = async () => {
        while (true) {
            const current = cursor;
            cursor += 1;
            if (current >= symbols.length) return;

            const symbol = symbols[current];
            try {
                const result = await processSymbol(symbol, context);
                if (result) results.push(result);
            } catch (error) {
                console.warn(`Skipping ${symbol} after API error`, error);
            } finally {
                completed += 1;
                if (completed % 10 === 0 || completed === symbols.length) {
                    ELEMENTS.totalPairs.textContent = `Scanning: ${completed}/${symbols.length}`;
                }
            }
        }
    };

    const workerCount = Math.min(CONFIG.concurrency, symbols.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
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

    if (items.length === 0) {
        setEmptyState(
            'No pairs match the strategy right now.',
            'Live Binance Futures data loaded successfully; no symbol currently passes every filter.'
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
            <td class="depth-cell ${depthAdvice.className}" title="Top ${CONFIG.depthLimit} levels">${depthDisplay}<div class="depth-advice">${depthAdvice.text}</div></td>
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
                // Clipboard can be unavailable in some embedded browsers; no need to break the table.
            }
        });

        ELEMENTS.tableBody.appendChild(row);
    });
}

function describeApiError(error) {
    if (error?.status === 451) {
        return 'Binance Futures API returned HTTP 451. Your current network/region cannot access the data source.';
    }
    if (error?.status === 429) {
        return 'Binance Futures API rate limit reached (HTTP 429). Try again later.';
    }
    if (error?.status) {
        return `Binance Futures API failed: HTTP ${error.status}${error.message ? ` · ${error.message}` : ''}`;
    }
    return `Cannot reach Binance Futures API${error?.message ? ` · ${error.message}` : ''}`;
}

function setLoading(isLoading) {
    ELEMENTS.refreshBtn.disabled = isLoading;
    ELEMENTS.loading.classList.toggle('hidden', !isLoading);
}

async function updateData() {
    setLoading(true);
    clearEmptyState();
    ELEMENTS.tableBody.innerHTML = '';
    ELEMENTS.totalPairs.textContent = 'Connecting…';
    ELEMENTS.filteredPairs.textContent = 'Matches: --';
    ELEMENTS.updatedTime.textContent = 'Last Updated: --:--';
    setStatus('Connecting to live Binance Futures API…');

    try {
        // Critical requests must all succeed. Optional metadata is allowed to degrade gracefully.
        const [exchangeData, stats, fundingMap, fundingIntervals, productList] = await Promise.all([
            fetchExchangeInfo(),
            fetch24hTicker(),
            fetchFundingRates(),
            fetchFundingIntervals(),
            fetchProductData()
        ]);

        const rankMap = buildRankMap(productList);
        const symbols = exchangeData.symbols;

        if (symbols.length === 0) {
            throw new ApiError('exchangeInfo returned zero active USDT perpetual symbols');
        }

        // Likely high-RSI candidates first so useful results finish earlier.
        symbols.sort((a, b) =>
            (stats[b]?.priceChangePercent || 0) - (stats[a]?.priceChangePercent || 0)
        );

        setStatus(`Live data connected · scanning ${symbols.length} Binance USDⓈ-M pairs`);
        ELEMENTS.totalPairs.textContent = `Scanning: 0/${symbols.length}`;

        const matches = await scanWithPool(symbols, {
            stats,
            fundingMap,
            fundingIntervals,
            baseMap: exchangeData.baseMap,
            rankMap
        });

        matches.sort((a, b) => b.rsi1h - a.rsi1h || b.volume - a.volume);
        renderTable(matches);

        const now = new Date();
        ELEMENTS.updatedTime.textContent = `Last Updated: ${now.toLocaleTimeString()}`;
        ELEMENTS.totalPairs.textContent = `Scanned: ${symbols.length}`;
        ELEMENTS.filteredPairs.textContent = `Matches: ${matches.length}`;
        setStatus(`Live Binance Futures API · ${symbols.length} pairs scanned`, 'success');
    } catch (error) {
        console.error('Radar update failed', error);
        const message = describeApiError(error);
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
