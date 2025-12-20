const ELEMENTS = {
    updatedTime: document.getElementById('last-updated'),
    refreshBtn: document.getElementById('refresh-btn'),
    loading: document.getElementById('loading-indicator'),
    tableBody: document.getElementById('table-body'),
    emptyState: document.getElementById('empty-state'),
    totalPairs: document.getElementById('total-pairs'),
    filteredPairs: document.getElementById('filtered-pairs')
};

const CACHE = {
    pairs: [],
    klines: {} // symbol -> { 1h: [], 4h: [] }
};

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

async function fetchKlines(symbol, interval, limit = 20) {
    try {
        // limit is hardcoded in call, but let's append cache buster
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&t=${Date.now()}`;
        const response = await fetch(url);
        const data = await response.json();
        // [time, open, high, low, close, volume, ...]
        return data.map(candle => parseFloat(candle[4])); // We only need close prices
    } catch (error) {
        // console.error(`Error fetching klines for ${symbol}:`, error);
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

    try {
        // 1. Get all pairs
        const symbols = await fetchExchangeInfo();
        ELEMENTS.totalPairs.textContent = `Pairs: ${symbols.length}`;

        // 2. Get 24h stats (Price, Volume)
        const stats = await fetch24hTicker();

        // 3. Get Funding Rates
        const fundingCalls = fetchFundingRates(); // Started parallel
        const fundingMap = await fundingCalls;

        // 4. Batch Process Klines for RSI (The heavy part)
        // We will do this in chunks to avoid browsing freezing or rate limits issues if strictly enforced client side

        // Actually, for a pure client side app, fetching 200 pairs * 2 requests is ~400 requests.
        // Binance limit is 1200 request weight per minute usually.
        // Klines weight is 1. Ticker is 1. 
        // 400 requests is safe-ish if not repeated instantly.

        const results = [];
        const BATCH_SIZE = 10;

        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
            const batch = symbols.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async symbol => {
                // Fetch 1h and 4h
                const [k1h, k4h] = await Promise.all([
                    fetchKlines(symbol, '1h', 499),
                    fetchKlines(symbol, '4h', 499)
                ]);

                const rsi1h = calculateRSI(k1h, 6);
                const rsi4h = calculateRSI(k4h, 6);

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
            results.push(...batchResults);

            // Artificial delay to respect rate limits if needed, 
            // but browsers limit concurrent connections anyway.
            // await new Promise(r => setTimeout(r, 100)); 

            // Progressive updating? maybe later.
            // Update status text
            ELEMENTS.totalPairs.textContent = `Scanning: ${Math.min(i + BATCH_SIZE, symbols.length)}/${symbols.length}`;
        }

        // 5. Filter and Sort
        // Condition: 1h RSI >= 90 AND 4h RSI >= 80 (Reverted to original strict criteria)
        const matches = results.filter(item => item.rsi1h >= 90 && item.rsi4h >= 80);

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

        // Deep link
        // Web: https://www.binance.com/en/futures/BTCUSDT
        const link = `https://www.binance.com/en/futures/${item.symbol}`;

        row.innerHTML = `
            <td class="symbol-cell">${item.symbol}</td>
            <td class="price-cell">$${price}</td>
            <td class="volume-cell">${volume}</td>
            <td class="${item.funding > 0 ? 'funding-positive' : 'funding-negative'}">${funding}</td>
            <td class="${item.rsi1h >= 90 ? 'rsi-extreme' : 'rsi-high'}">${rsi1h}</td>
            <td class="${item.rsi4h >= 80 ? 'rsi-extreme' : 'rsi-high'}">${rsi4h}</td>
            <td><a href="${link}" target="_blank" class="action-btn">Trade</a></td>
        `;

        // Whole row click
        row.style.cursor = 'pointer';
        row.addEventListener('click', (e) => {
            if (e.target.tagName !== 'A') {
                window.open(link, '_blank');
            }
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

ELEMENTS.refreshBtn.addEventListener('click', updateData);

// Auto Refresh every 15 minutes - REMOVED per user request
// setInterval(updateData, 15 * 60 * 1000);

// Initial Load
updateData();
