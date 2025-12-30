const ELEMENTS = {
    updatedTime: document.getElementById('last-updated'),
    refreshBtn: document.getElementById('refresh-btn'),
    loading: document.getElementById('loading-indicator'),
    tableBody: document.getElementById('table-body'),
    emptyState: document.getElementById('empty-state'),
    totalPairs: document.getElementById('total-pairs'),
    filteredPairs: document.getElementById('filtered-pairs')
};

const CONFIG = {
    minVolume: 0, // Default to All (Previous 10M USDT)
    rsiLimit: 35, // Sufficient for RSI-14
    concurrency: 40, // Match Python's concurrency
    cacheTTL: 60000, // 60 seconds
    rankCacheTTL: 3600000 // 1 hour for rank cache
};

const CACHE = {
    klines: {}, // symbol_interval -> { data: [], timestamp: long }
    rank: { data: {}, timestamp: 0 },
    products: { data: {}, timestamp: 0 }
};

// Wake Lock to prevent screen sleep during scanning (mobile)
let wakeLock = null;

// --- API Functions ---

// Helper to prevent caching
const noCache = () => `?t=${Date.now()}`;

async function fetchExchangeInfo() {
    try {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/exchangeInfo${noCache()}`);
        const data = await response.json();
        // Filter for USDT pairs and trading enabled
        const activeSymbols = data.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING');

        return {
            symbols: activeSymbols.map(s => s.symbol),
            baseMap: activeSymbols.reduce((acc, s) => {
                acc[s.symbol] = s.baseAsset;
                return acc;
            }, {})
        };
    } catch (error) {
        console.error("Error fetching exchange info:", error);
        return { symbols: [], baseMap: {} };
    }
}

async function fetch24hTicker() {
    try {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr${noCache()}`);
        const data = await response.json();
        return data.reduce((acc, item) => {
            acc[item.symbol] = {
                price: parseFloat(item.lastPrice),
                volume: parseFloat(item.quoteVolume),
                priceChangePercent: parseFloat(item.priceChangePercent)
            };
            return acc;
        }, {});
    } catch (error) {
        console.error("Error fetching ticker:", error);
        return {};
    }
}

async function fetchFundingRates() {
    try {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex${noCache()}`);
        const data = await response.json();
        return data.reduce((acc, item) => {
            acc[item.symbol] = parseFloat(item.lastFundingRate);
            return acc;
        }, {});
    } catch (error) {
        console.error("Error fetching funding rates:", error);
        return {};
    }
}

async function fetchFundingIntervals() {
    try {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/fundingInfo${noCache()}`);
        const data = await response.json();
        return data.reduce((acc, item) => {
            acc[item.symbol] = item.fundingIntervalHours;
            return acc;
        }, {});
    } catch (error) {
        console.error("Error fetching funding intervals:", error);
        return {};
    }
}

async function fetchProductData() {
    // Fetches raw product data to calculate GLOBAL market cap rank
    const now = Date.now();
    if (CACHE.products.data && CACHE.products.data.length > 0 && (now - CACHE.products.timestamp < CONFIG.rankCacheTTL)) {
        return CACHE.products.data;
    }

    try {
        const response = await fetch("https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true");
        const json = await response.json();
        if (json.success && json.data) {
            // Return raw data list for processing
            CACHE.products.data = json.data;
            CACHE.products.timestamp = now;
            return json.data;
        }
        return [];
    } catch (error) {
        console.error("Error fetching product data:", error);
        return CACHE.products.data || [];
    }
}

async function fetchKlines(symbol, interval, limit = CONFIG.rsiLimit) {
    const cacheKey = `${symbol}_${interval}`;
    const now = Date.now();

    if (CACHE.klines[cacheKey] && (now - CACHE.klines[cacheKey].timestamp < CONFIG.cacheTTL)) {
        return CACHE.klines[cacheKey].data;
    }

    try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&t=${now}`;
        const response = await fetch(url);
        const data = await response.json();
        const closePrices = data.map(candle => parseFloat(candle[4]));

        CACHE.klines[cacheKey] = {
            data: closePrices,
            timestamp: now
        };

        return closePrices;
    } catch (error) {
        return [];
    }
}

// --- Indicator Functions ---

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 0;

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) {
            gains += diff;
        } else {
            losses += Math.abs(diff);
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Smooth subsequent values (though we likely just use the last standard RSI if we had history)
    // For this simple scanner, standard RSI on the last 14 candles using the simple SMA method 
    // or Wilder's smoothing is often debated. 
    // Standard Wilder's Smoothing:
    // RSI = 100 - 100 / (1 + RS)
    // RS = Average Gain / Average Loss

    // However, to be accurate with just ~20 candles, the initialization effectively IS the RSI.
    // If we wanted Wilder's smoothing properly we need more data. 
    // Let's assume the user wants "Current RSI" effectively.
    // We will use a standard simple implementation for the subset we have.

    // Actually, to get an accurate current RSI, we usually need ~100 candles to stabilize the EMA.
    // But we will use a simpler approximation here due to API limits (200 pairs * 2 intervals * 100 candles = heavy).
    // Let's try to fetch 30 candles and do the best we can.

    // RE-IMPLEMENTATION for stability:
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const currentGain = diff > 0 ? diff : 0;
        const currentLoss = diff < 0 ? Math.abs(diff) : 0;

        avgGain = ((avgGain * (period - 1)) + currentGain) / period;
        avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// --- Logic ---

async function updateData() {
    setLoading(true);
    ELEMENTS.tableBody.innerHTML = ''; // Clear table

    // Request wake lock to prevent screen sleep on mobile
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) {
        // Wake lock request failed - silently continue
    }

    try {
        // 1. Fetch all metadata in PARALLEL
        const [exchangeData, stats, fundingMap, fundingIntervals, productList] = await Promise.all([
            fetchExchangeInfo(),
            fetch24hTicker(),
            fetchFundingRates(),
            fetchFundingIntervals(),
            fetchProductData()
        ]);

        const { symbols, baseMap } = exchangeData;

        ELEMENTS.totalPairs.textContent = `Pairs: ${symbols.length}`;

        // 2. Filter by Volume (Now scans all by default as minVolume is 0)
        const minVol = CONFIG.minVolume;

        const highVolumeSymbols = symbols.filter(s => {
            const vol = stats[s]?.volume || 0;
            return vol >= minVol;
        });

        // Optimization: Smart Scan Order
        // Sort by 24h Price Change % (Desc) so likely candidates (Top Gainers) are scanned first
        highVolumeSymbols.sort((a, b) => {
            const changeA = stats[a]?.priceChangePercent || 0;
            const changeB = stats[b]?.priceChangePercent || 0;
            return changeB - changeA;
        });

        // Update Total Pairs UI to show filtered vs total
        ELEMENTS.totalPairs.textContent = `Scanned: ${highVolumeSymbols.length} / ${symbols.length}`;

        // CALCULATE GLOBAL MARKET CAP RANK
        // 1. Process product list for ALL USDT spot pairs
        const mcapList = [];
        productList.forEach(item => {
            if (item.q === 'USDT' && item.cs) {
                const price = parseFloat(item.c || 0);
                const cs = parseFloat(item.cs);
                if (price > 0 && cs > 0) {
                    mcapList.push({
                        base: item.b,
                        mcap: price * cs
                    });
                }
            }
        });

        // 2. Sort Descending
        mcapList.sort((a, b) => b.mcap - a.mcap);

        // 3. Create Rank Map (Base Asset -> Rank)
        const rankMap = {};
        mcapList.forEach((item, index) => {
            // Only assign best rank if duplicate base assets exist (rare for USDT pairs but safety first)
            if (!rankMap[item.base]) {
                rankMap[item.base] = index + 1;
            }
        });

        // 3. Batch Process Klines for RSI (The heavy part)
        // Optimization: Use concurrent pool pattern for maximum throughput

        const results = [];
        const CONCURRENCY = CONFIG.concurrency;
        const TARGET_SYMBOLS = highVolumeSymbols;

        // Concurrent pool pattern - much faster than batch processing
        let index = 0;
        let completed = 0;
        const total = TARGET_SYMBOLS.length;

        const processSymbol = async (symbol) => {
            // 1. Fetch 1h
            const k1h = await fetchKlines(symbol, '1h', CONFIG.rsiLimit);
            const rsi1h = calculateRSI(k1h, 6);

            // 2. Early Exit
            if (rsi1h < 90) {
                return null;
            }

            // 3. Fetch 4h only if 1h is promising
            const k4h = await fetchKlines(symbol, '4h', CONFIG.rsiLimit);
            const rsi4h = calculateRSI(k4h, 6);

            if (rsi4h < 80) {
                return null;
            }

            // Found a match!
            return {
                symbol,
                // price: stats[symbol]?.price || 0, // Removed per request
                // volume: stats[symbol]?.volume || 0, // Removed vol, keep for sorting logic internally if needed, logic below uses it
                volume: stats[symbol]?.volume || 0, // Kept for sorting only
                funding: fundingMap[symbol] || 0,
                interval: fundingIntervals[symbol] || 8,
                // Look up global rank using base asset
                rank: (() => {
                    const base = baseMap[symbol] || symbol.replace('USDT', '');
                    let r = rankMap[base];
                    // Fallback for 1000PEPE -> PEPE
                    if (!r && base.startsWith('1000')) {
                        r = rankMap[base.substring(4)];
                    }
                    return r || 'N/A';
                })(),
                rsi1h,
                rsi4h
            };
        };

        const worker = async () => {
            while (index < total) {
                const currentIndex = index++;
                const symbol = TARGET_SYMBOLS[currentIndex];

                try {
                    const result = await processSymbol(symbol);
                    if (result) {
                        results.push(result);
                    }
                } catch (err) {
                    // Skip failed symbols
                }

                completed++;
                // Update progress less frequently to reduce DOM updates
                if (completed % 10 === 0 || completed === total) {
                    ELEMENTS.totalPairs.textContent = `Scanning: ${completed}/${total}`;
                }
            }
        };

        // Start concurrent workers
        const workers = Array(Math.min(CONCURRENCY, total)).fill(null).map(() => worker());
        await Promise.all(workers);

        // 6. Sort and Render (Filtering already done in loop effectively)
        const matches = results; // already filtered

        // Sort by Market Cap (Using Volume as proxy as planned) DESC
        matches.sort((a, b) => b.volume - a.volume);

        // 6. Render
        renderTable(matches);

        const now = new Date();
        ELEMENTS.updatedTime.textContent = `Last Updated: ${now.toLocaleTimeString()}`;
        ELEMENTS.filteredPairs.textContent = `Matches: ${matches.length}`;

    } catch (error) {
        console.error("Main loop error:", error);
        alert("Failed to update data. Check console.");
    } finally {
        setLoading(false);

        // Release wake lock
        if (wakeLock !== null) {
            try {
                await wakeLock.release();
                wakeLock = null;
            } catch (err) {
                // Ignore release errors
            }
        }
    }
}

function renderTable(items) {
    if (items.length === 0) {
        ELEMENTS.emptyState.classList.remove('hidden');
        return;
    }

    ELEMENTS.emptyState.classList.add('hidden');

    items.forEach(item => {
        const row = document.createElement('tr');

        // Formatting
        const rankDisplay = item.rank !== 'N/A' ? `#${item.rank}` : '-';

        // Annualized Funding Calculation
        // Formula: rate * (24 / interval) * 365
        const dailyIntervals = 24 / item.interval;
        const annualizedRate = item.funding * dailyIntervals * 365 * 100;
        const fundingDisplay = `<span class="funding-wrapper">${annualizedRate > 0 ? '+' : ''}${annualizedRate.toFixed(2)}% <span class="interval-tag">(${item.interval}h)</span></span>`;

        const rsi1h = item.rsi1h.toFixed(1);
        const rsi4h = item.rsi4h.toFixed(1);

        // Deep link handling
        const webLink = `https://www.binance.com/en/futures/${item.symbol}`;

        row.innerHTML = `
            <td class="symbol-cell" title="Click to copy">${item.symbol}</td>
            <td class="rank-cell">${rankDisplay}</td>
            <td class="${item.funding > 0 ? 'funding-positive' : 'funding-negative'}">${fundingDisplay}</td>
            <td class="${item.rsi1h >= 90 ? 'rsi-extreme' : 'rsi-high'}">${rsi1h}</td>
            <td class="${item.rsi4h >= 80 ? 'rsi-extreme' : 'rsi-high'}">${rsi4h}</td>
            <td><a href="${webLink}" target="_blank" class="action-btn">Trade</a></td>
        `;

        // Click to Copy Logic for Symbol
        const symbolCell = row.querySelector('.symbol-cell');
        symbolCell.style.cursor = 'copy';
        symbolCell.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent row click
            navigator.clipboard.writeText(item.symbol).then(() => {
                const originalText = symbolCell.textContent;
                symbolCell.textContent = 'Copied!';
                setTimeout(() => {
                    symbolCell.textContent = originalText;
                }, 1000);
            });
        });

        ELEMENTS.tableBody.appendChild(row);
    });
}

function setLoading(isLoading) {
    if (isLoading) {
        ELEMENTS.loading.classList.remove('hidden');
        ELEMENTS.refreshBtn.disabled = true;
    } else {
        ELEMENTS.loading.classList.add('hidden');
        ELEMENTS.refreshBtn.disabled = false;
    }
}

// --- Initialization ---

// Event Listeners
ELEMENTS.refreshBtn.addEventListener('click', () => updateData());

// Auto Refresh every 15 minutes - REMOVED per user request
// setInterval(updateData, 15 * 60 * 1000);

// Initial Load
updateData();
