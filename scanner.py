#!/usr/bin/env python3
"""
Binance Futures RSI Scanner (Extreme Speed v3)
Uses asyncio + aiohttp for high-concurrency scanning.
"""

import os
import sys
import asyncio
import aiohttp
import time
import argparse
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv

# Load local .env file
load_dotenv()

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

# Global Cache for Asset Ranks (Base Asset -> Rank)
ASSET_RANK_CACHE = {
    'data': {}, # base_asset -> rank (int)
    'last_update': 0
}
RANK_CACHE_TTL = 3600  # 1 hour


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


async def fetch_json(session, url, params=None, timeout=10):
    """Async helper for GET requests"""
    try:
        async with session.get(url, params=params, timeout=timeout) as response:
            if response.status == 200:
                return await response.json()
            else:
                print(f"Error fetching {url}: {response.status}")
                return None
    except Exception as e:
        print(f"Exception fetching {url}: {e}")
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
                'funding_interval': ticker_info.get('funding_interval', 8),
                'rank': ticker_info.get('rank', 'N/A'),
                'rsi_1h': rsi_1h,
                'rsi_4h': rsi_4h
            })


async def scan_market():
    """Main async scanning logic"""
    start_time = datetime.now(BEIJING_TZ)
    print(f"[{start_time}] Starting extreme speed scan (v3)...")

    async with aiohttp.ClientSession() as session:
        # 1. Fetch metadata in parallel
        now_ts = time.time()
        tasks = [
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/exchangeInfo"),
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/ticker/24hr"),
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/premiumIndex"),
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/fundingInfo")
        ]
        
        # Only fetch rank if cache expired
        fetching_rank = False
        if now_ts - ASSET_RANK_CACHE['last_update'] > RANK_CACHE_TTL:
            fetching_rank = True
            # Fetch product data which contains circulating supply ('cs')
            tasks.append(fetch_json(session, "https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true"))
        
        metadata = await asyncio.gather(*tasks)
        
        if fetching_rank:
            # If rank was fetched, it's the last item in metadata
            # If rank was fetched, it's the last item in metadata
            ex_info, ticker_list, premium_list, funding_info_list, product_data = metadata
            
            if product_data and product_data.get('success'):
                # GLOBAL RANK CALCULATION
                # 1. Extract all USDT pairs with Circulating Supply
                # 2. Calculate Market Cap = Price * CS
                # 3. Sort by Mcap to get Global Rank
                
                mcap_list = []
                # products are typically Spot pairs or mixed. We want Spot USDT pairs for best price comparison.
                for item in product_data.get('data', []):
                    # Filter for USDT quote and valid CS
                    if item.get('q') == 'USDT' and item.get('cs') is not None:
                        try:
                            price = float(item.get('c', 0))
                            cs = float(item['cs'])
                            if price > 0 and cs > 0:
                                mcap = price * cs
                                mcap_list.append({
                                    'base': item['b'], # Base Asset (e.g. BTC)
                                    'mcap': mcap
                                })
                        except:
                            continue
                            
                # Sort by Market Cap Desc
                mcap_list.sort(key=lambda x: x['mcap'], reverse=True)
                
                # Build Rank Map (Base Asset -> Rank)
                rank_map = {item['base']: i+1 for i, item in enumerate(mcap_list)}
                
                ASSET_RANK_CACHE['data'] = rank_map
                ASSET_RANK_CACHE['last_update'] = now_ts
                print(f"Updated global asset ranks. Tracked {len(rank_map)} assets.")
            else:
                print("Warning: Failed to fetch Product data for market cap.")
        else:
            # If rank was not fetched, metadata has 4 items
            ex_info, ticker_list, premium_list, funding_info_list = metadata

        if not all([ex_info, ticker_list, premium_list, funding_info_list]):
            print("Error: Failed to fetch initial metadata from Binance.")
            return []

        # 2. Map data
        symbols = [s['symbol'] for s in ex_info['symbols'] 
                  if s['quoteAsset'] == 'USDT' and s['status'] == 'TRADING']
        
        ticker_map = {item['symbol']: item for item in ticker_list}
        funding_map = {item['symbol']: float(item['lastFundingRate']) for item in premium_list}
        # Map funding interval and ranking
        funding_info_map = {item['symbol']: item.get('fundingIntervalHours', 8) for item in funding_info_list}
        
        # Helper to get base asset from symbol (e.g. BTCUSDT -> BTC)
        # We can use ex_info for accurate baseAsset
        symbol_to_base = {}
        for s in ex_info['symbols']:
            symbol_to_base[s['symbol']] = s['baseAsset']

        for symbol in ticker_map:
            ticker_map[symbol]['funding_interval'] = funding_info_map.get(symbol, 8)
            
            # Resolve Global Rank via Base Asset
            base_asset = symbol_to_base.get(symbol, symbol.replace('USDT', ''))
            
            # Handle 1000PEPE -> PEPE case if needed, but let's try direct map first.
            # Usually users want the rank of the underlying project.
            # If base is '1000PEPE', we might check 'PEPE' in rank cache if '1000PEPE' not found.
            
            rank = ASSET_RANK_CACHE['data'].get(base_asset)
            
            # Fallback: Try stripping '1000'
            if rank is None and base_asset.startswith('1000'):
                rank = ASSET_RANK_CACHE['data'].get(base_asset[4:])
                
            ticker_map[symbol]['rank'] = rank if rank else 'N/A'

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
    """Format results for Telegram - Clean Single Line with Random Emojis"""
    import random
    now = datetime.now(BEIJING_TZ).strftime("%H:%M")
    
    if not matches:
        return f"🚨 *RSI Radar* · {now}\n\n✅ 暂无高RSI币种"
    
    # Sort by Volume (Quote Volume)
    matches.sort(key=lambda x: x['volume'], reverse=True)
    
    emojis = ["🔥", "🚀", "⚡", "🎯", "💎", "🌟", "📈", "📢", "🔔", "✨"]
    
    lines = [f"🚨 *RSI RADAR* | `{now}`\n"]
    
    for m in matches[:15]:
        # Calculate TRUE Annualized Funding Rate (APR)
        interval = m.get('funding_interval', 8)
        annualized_rate = m['funding'] * (24 / interval) * 365 * 100
        
        # Formatting
        rsi_str = f"1h:{int(m['rsi_1h'])} 4h:{int(m['rsi_4h'])}"
        funding_str = f"{annualized_rate:+.2f}%"
        emoji = random.choice(emojis)
        rank_str = f"(#{m['rank']})" if m['rank'] != 'N/A' else ""
        
        # Single line format: EMOJI `SYMBOL` (#Rank) | 1h:XX 4h:XX | 年化: +/-XX.XX% (Xh)
        lines.append(f"{emoji} `{m['symbol']}` {rank_str} | {rsi_str} | 年化:{funding_str} ({interval}h)")
    
    if len(matches) > 15:
        lines.append(f"\n_+{len(matches) - 15} more coins detected..._")
    
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


async def wait_until_next_hour():
    """Wait until the beginning of the next hour"""
    now = datetime.now(BEIJING_TZ)
    next_hour = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    wait_seconds = (next_hour - now).total_seconds()
    
    # Add a small buffer to ensure we are definitely in the next hour
    wait_seconds += 2 
    
    print(f"Waiting {wait_seconds:.1f} seconds until next hour ({next_hour.strftime('%H:%M:%S')})...")
    await asyncio.sleep(wait_seconds)


async def main():
    parser = argparse.ArgumentParser(description='Binance Futures RSI Scanner')
    parser.add_argument('--loop', action='store_true', help='Enable continuous scanning at every top of the hour')
    args = parser.parse_args()

    if args.loop:
        print("Loop mode enabled. Bot will scan at every top of the hour.")
        while True:
            matches = await scan_market()
            message = format_message(matches)
            success = await send_telegram(message)
            if success:
                print(f"[{datetime.now(BEIJING_TZ)}] Notification sent successfully.")
            else:
                print(f"[{datetime.now(BEIJING_TZ)}] Failed to send notification.")
            
            await wait_until_next_hour()
    else:
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
