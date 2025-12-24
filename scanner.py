#!/usr/bin/env python3
"""
Binance Futures RSI Scanner (Extreme Speed v3)
Uses asyncio + aiohttp for high-concurrency scanning.
"""

import os
import sys
import asyncio
import aiohttp
from datetime import datetime, timezone, timedelta

# Configuration
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID')

# RSI Thresholds
RSI_1H_THRESHOLD = 90
RSI_4H_THRESHOLD = 80
RSI_PERIOD = 6
CONCURRENCY = 40  # Increased concurrency for extreme speed

# API Endpoints
BINANCE_BASE = "https://fapi.binance.com"
BEIJING_TZ = timezone(timedelta(hours=8))


def calculate_rsi(closes, period=6):
    """Accurate RSI calculation matching the JS implementation"""
    if len(closes) < period + 1:
        return 0
    
    gains = 0
    losses = 0
    
    # Initial SMA
    for i in range(1, period + 1):
        diff = closes[i] - closes[i - 1]
        if diff >= 0:
            gains += diff
        else:
            losses += abs(diff)
    
    avg_gain = gains / period
    avg_loss = losses / period
    
    # Wilder's Smoothing (as implemented in app.js)
    for i in range(period + 1, len(closes)):
        diff = closes[i] - closes[i - 1]
        current_gain = diff if diff > 0 else 0
        current_loss = abs(diff) if diff < 0 else 0
        
        avg_gain = ((avg_gain * (period - 1)) + current_gain) / period
        avg_loss = ((avg_loss * (period - 1)) + current_loss) / period
    
    if avg_loss == 0:
        return 100
    
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


async def fetch_json(session, url, params=None):
    """Async helper for GET requests"""
    try:
        async with session.get(url, params=params, timeout=10) as response:
            if response.status == 200:
                return await response.json()
            else:
                return None
    except Exception:
        return None


async def check_symbol(session, semaphore, symbol, ticker_info, funding_rate, results):
    """Concurrent worker for checking a single symbol"""
    async with semaphore:
        # Fetch 1h klines
        k1h_data = await fetch_json(session, f"{BINANCE_BASE}/fapi/v1/klines", 
                                   params={'symbol': symbol, 'interval': '1h', 'limit': 35})
        if not k1h_data:
            return

        k1h = [float(c[4]) for c in k1h_data]
        rsi_1h = calculate_rsi(k1h, RSI_PERIOD)

        if rsi_1h < RSI_1H_THRESHOLD:
            return

        # Fetch 4h only if 1h passes
        k4h_data = await fetch_json(session, f"{BINANCE_BASE}/fapi/v1/klines", 
                                   params={'symbol': symbol, 'interval': '4h', 'limit': 35})
        if not k4h_data:
            return

        k4h = [float(c[4]) for c in k4h_data]
        rsi_4h = calculate_rsi(k4h, RSI_PERIOD)

        if rsi_4h >= RSI_4H_THRESHOLD:
            results.append({
                'symbol': symbol,
                'price': float(ticker_info.get('lastPrice', 0)),
                'volume': float(ticker_info.get('quoteVolume', 0)),
                'change': float(ticker_info.get('priceChangePercent', 0)),
                'funding': funding_rate,
                'rsi_1h': rsi_1h,
                'rsi_4h': rsi_4h
            })


async def scan_market():
    """Main async scanning logic"""
    start_time = datetime.now(BEIJING_TZ)
    print(f"[{start_time}] Starting extreme speed scan (v3)...")

    async with aiohttp.ClientSession() as session:
        # 1. Fetch metadata in parallel
        tasks = [
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/exchangeInfo"),
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/ticker/24hr"),
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/premiumIndex")
        ]
        
        metadata = await asyncio.gather(*tasks)
        ex_info, ticker_list, premium_list = metadata

        if not all([ex_info, ticker_list, premium_list]):
            print("Error: Failed to fetch initial metadata from Binance.")
            return []

        # 2. Map data
        symbols = [s['symbol'] for s in ex_info['symbols'] 
                  if s['quoteAsset'] == 'USDT' and s['status'] == 'TRADING']
        
        ticker_map = {item['symbol']: item for item in ticker_list}
        funding_map = {item['symbol']: float(item['lastFundingRate']) for item in premium_list}

        # 3. Sort symbols by 24h change (desc)
        symbols.sort(key=lambda s: float(ticker_map.get(s, {}).get('priceChangePercent', 0)), reverse=True)

        print(f"Scanning {len(symbols)} trading pairs with concurrency {CONCURRENCY}...")

        # 4. Running concurrent scanners
        semaphore = asyncio.Semaphore(CONCURRENCY)
        results = []
        scan_tasks = []

        for symbol in symbols:
            t_info = ticker_map.get(symbol, {})
            f_rate = funding_map.get(symbol, 0)
            scan_tasks.append(check_symbol(session, semaphore, symbol, t_info, f_rate, results))

        # Show progress while running
        await asyncio.gather(*scan_tasks)

        end_time = datetime.now(BEIJING_TZ)
        duration = (end_time - start_time).total_seconds()
        print(f"Scan complete in {duration:.1f} seconds. Found {len(results)} matches.")
        return results


def format_message(matches):
    """Format results for Telegram - clean and minimal design"""
    now = datetime.now(BEIJING_TZ).strftime("%m-%d %H:%M")
    
    if not matches:
        return f"📡 *RSI Radar*  ·  {now}\n\n✅ 暂无高RSI币种"
    
    matches.sort(key=lambda x: x['volume'], reverse=True)
    
    lines = [
        f"📡 *RSI Radar*  ·  {now}",
        f"━━━━━━━━━━━━━━━━",
        ""
    ]
    
    for m in matches[:15]:
        # Format funding rate as percentage
        funding_pct = m['funding'] * 100
        funding_str = f"{funding_pct:+.3f}%"
        
        # Symbol copyable, RSI values, funding rate
        lines.append(f"`{m['symbol']}`")
        lines.append(f"  RSI  1h `{int(m['rsi_1h'])}` · 4h `{int(m['rsi_4h'])}`  |  费率 `{funding_str}`")
        lines.append("")
    
    if len(matches) > 15:
        lines.append(f"_+{len(matches) - 15} more_")
    
    lines.append("━━━━━━━━━━━━━━━━")
    lines.append("💡 _点击币种名称可复制_")
    
    return "\n".join(lines)



async def send_telegram(message):
    """Async send Telegram message"""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Warning: Telegram not configured. Printing result to console:")
        print(message)
        return True

    async with aiohttp.ClientSession() as session:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {'chat_id': TELEGRAM_CHAT_ID, 'text': message, 'parse_mode': 'Markdown'}
        async with session.post(url, json=payload) as response:
            return response.status == 200


async def main():
    matches = await scan_market()
    message = format_message(matches)
    success = await send_telegram(message)
    if success:
        print("Telegram notification sent.")
    else:
        print("Failed to send Telegram notification.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nScan cancelled by user.")
