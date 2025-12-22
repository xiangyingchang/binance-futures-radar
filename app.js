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
    batchSize: 20, // Batch size for processing
    concurrency: 12, // Number of simultaneous requests
    batchDelay: 50, // Small delay between task starts
    cacheTTL: 60000 // 60 seconds
};



const CACHE = {
    klines: {} // symbol_interval -> { data: [], timestamp: long }
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
        return data.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol);
    } catch (error) {
        console.error("Error fetching exchange info:", error);
        return [];
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
        // 1. Get all pairs
        const symbols = await fetchExchangeInfo();
        ELEMENTS.totalPairs.textContent = `Pairs: ${symbols.length}`;

        // 2. Get 24h stats (Price, Volume)
        const stats = await fetch24hTicker();

        // 3. Filter by Volume (Now scans all by default as minVolume is 0)
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

        // 4. Get Funding Rates (Only for relevant pairs to save bandwidth? actually public endpoint returns all)
        // We can keep fetching all for simplicity or optimize if needed.
        const fundingCalls = fetchFundingRates();
        const fundingMap = await fundingCalls;

        // 5. Batch Process Klines for RSI (The heavy part)
        // Optimization: Fetch 1h first, if not high, skip 4h.

        const results = [];
        const BATCH_SIZE = CONFIG.batchSize;
        const TARGET_SYMBOLS = highVolumeSymbols; // processed list

        for (let i = 0; i < TARGET_SYMBOLS.length; i += BATCH_SIZE) {
            const batch = TARGET_SYMBOLS.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async symbol => {
                // Optimization: Lazy fetch

                // 1. Fetch 1h
                const k1h = await fetchKlines(symbol, '1h', CONFIG.rsiLimit);
                const rsi1h = calculateRSI(k1h, 6); // using same period as before, keeping logic

                // 2. Early Exit
                if (rsi1h < 90) {
                    return null; // Skip this pair
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
                    price: stats[symbol]?.price || 0,
                    volume: stats[symbol]?.volume || 0, // USDT Volume
                    funding: fundingMap[symbol] || 0,
                    rsi1h,
                    rsi4h
                };
            });

            const batchResults = await Promise.all(promises);
            // Filter out nulls
            const validResults = batchResults.filter(r => r !== null);
            results.push(...validResults);

            // Artificial delay to respect rate limits
            await new Promise(r => setTimeout(r, CONFIG.batchDelay));

            // Update status text
            ELEMENTS.totalPairs.textContent = `Scanning: ${Math.min(i + BATCH_SIZE, TARGET_SYMBOLS.length)}/${TARGET_SYMBOLS.length}`;
        }

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
        const price = item.price < 1 ? item.price.toFixed(6) : item.price.toFixed(2);
        const volume = (item.volume / 1000000).toFixed(2) + 'M';
        const funding = (item.funding * 100).toFixed(4) + '%';
        const rsi1h = item.rsi1h.toFixed(1);
        const rsi4h = item.rsi4h.toFixed(1);

        // Deep link handling
        const webLink = `https://www.binance.com/en/futures/${item.symbol}`;

        // Helper to detect mobile
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        row.innerHTML = `
            <td class="symbol-cell">${item.symbol}</td>
            <td class="price-cell">$${price}</td>
            <td class="volume-cell">${volume}</td>
            <td class="${item.funding > 0 ? 'funding-positive' : 'funding-negative'}">${funding}</td>
            <td class="${item.rsi1h >= 90 ? 'rsi-extreme' : 'rsi-high'}">${rsi1h}</td>
            <td class="${item.rsi4h >= 80 ? 'rsi-extreme' : 'rsi-high'}">${rsi4h}</td>
            <td><a href="#" class="action-btn" data-symbol="${item.symbol}">Trade</a></td>
        `;

        // Row and Button Click Logic
        const handleTrade = (e) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent bubbling if clicking button directly

            if (isMobile) {
                // Try Deep Link first (Common schemes)
                // Note: Scheme support varies by OS and App version. 
                // We use a fallback mechanism.
                const deepLink = `binance://futures/${item.symbol}`; // Try specific pair
                // const deepLink = `binance://app/futures`; // General futures

                // Attempt to open App
                window.location.href = deepLink;

                // Fallback to Web Universal Link (which might also trigger app) after 500ms
                setTimeout(() => {
                    window.location.href = webLink;
                }, 500);
            } else {
                window.open(webLink, '_blank');
            }
        };

        row.style.cursor = 'pointer';
        row.addEventListener('click', (e) => {
            // If clicking the button (which is an A tag now), handle specifically
            if (e.target.classList.contains('action-btn')) {
                handleTrade(e);
            } else {
                // Clicking the row acts same as button for better UX
                handleTrade(e);
            }
        });

        // Bind click to the button specifically to be safe
        const btn = row.querySelector('.action-btn');
        btn.addEventListener('click', handleTrade);

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
