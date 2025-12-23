#!/usr/bin/env python3
"""
Binance Futures RSI Scanner with Telegram Notification
Scans for high RSI coins and sends alerts via Telegram
"""

import os
import sys
import requests
from datetime import datetime

# Configuration
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID')

# RSI Thresholds
RSI_1H_THRESHOLD = 90
RSI_4H_THRESHOLD = 80
RSI_PERIOD = 6

# API Endpoints
BINANCE_BASE = "https://fapi.binance.com"


def calculate_rsi(closes, period=14):
    """Calculate RSI from close prices"""
    if len(closes) < period + 1:
        return 0
    
    gains = 0
    losses = 0
    
    for i in range(1, period + 1):
        diff = closes[i] - closes[i - 1]
        if diff >= 0:
            gains += diff
        else:
            losses += abs(diff)
    
    avg_gain = gains / period
    avg_loss = losses / period
    
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


def fetch_symbols():
    """Fetch all USDT trading pairs"""
    try:
        response = requests.get(f"{BINANCE_BASE}/fapi/v1/exchangeInfo")
        data = response.json()
        return [s['symbol'] for s in data['symbols'] 
                if s['quoteAsset'] == 'USDT' and s['status'] == 'TRADING']
    except Exception as e:
        print(f"Error fetching symbols: {e}")
        return []


def fetch_ticker():
    """Fetch 24h ticker data"""
    try:
        response = requests.get(f"{BINANCE_BASE}/fapi/v1/ticker/24hr")
        data = response.json()
        return {item['symbol']: {
            'price': float(item['lastPrice']),
            'volume': float(item['quoteVolume']),
            'change': float(item['priceChangePercent'])
        } for item in data}
    except Exception as e:
        print(f"Error fetching ticker: {e}")
        return {}


def fetch_funding_rates():
    """Fetch funding rates"""
    try:
        response = requests.get(f"{BINANCE_BASE}/fapi/v1/premiumIndex")
        data = response.json()
        return {item['symbol']: float(item['lastFundingRate']) for item in data}
    except Exception as e:
        print(f"Error fetching funding rates: {e}")
        return {}


def fetch_klines(symbol, interval, limit=35):
    """Fetch kline data"""
    try:
        response = requests.get(
            f"{BINANCE_BASE}/fapi/v1/klines",
            params={'symbol': symbol, 'interval': interval, 'limit': limit}
        )
        data = response.json()
        return [float(candle[4]) for candle in data]  # Close prices
    except Exception as e:
        return []


def send_telegram_message(message):
    """Send message via Telegram Bot"""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram credentials not configured")
        print(message)
        return False
    
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {
            'chat_id': TELEGRAM_CHAT_ID,
            'text': message,
            'parse_mode': 'Markdown'
        }
        response = requests.post(url, json=payload)
        return response.status_code == 200
    except Exception as e:
        print(f"Error sending Telegram message: {e}")
        return False


def scan_market():
    """Main scanning logic"""
    print(f"[{datetime.now()}] Starting market scan...")
    
    # Fetch data
    symbols = fetch_symbols()
    ticker = fetch_ticker()
    funding = fetch_funding_rates()
    
    print(f"Found {len(symbols)} trading pairs")
    
    # Sort by 24h change (top gainers first)
    symbols.sort(key=lambda s: ticker.get(s, {}).get('change', 0), reverse=True)
    
    matches = []
    scanned = 0
    
    for symbol in symbols:
        scanned += 1
        if scanned % 50 == 0:
            print(f"Scanned {scanned}/{len(symbols)}...")
        
        # Fetch 1h klines
        k1h = fetch_klines(symbol, '1h')
        rsi_1h = calculate_rsi(k1h, RSI_PERIOD)
        
        # Early exit if 1h RSI not high enough
        if rsi_1h < RSI_1H_THRESHOLD:
            continue
        
        # Fetch 4h klines only if 1h is promising
        k4h = fetch_klines(symbol, '4h')
        rsi_4h = calculate_rsi(k4h, RSI_PERIOD)
        
        if rsi_4h >= RSI_4H_THRESHOLD:
            info = ticker.get(symbol, {})
            matches.append({
                'symbol': symbol,
                'price': info.get('price', 0),
                'volume': info.get('volume', 0),
                'change': info.get('change', 0),
                'funding': funding.get(symbol, 0),
                'rsi_1h': rsi_1h,
                'rsi_4h': rsi_4h
            })
    
    print(f"Scan complete. Found {len(matches)} matches.")
    return matches


def format_message(matches):
    """Format scan results as Telegram message"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    
    if not matches:
        return f"🔍 *Binance Futures Radar*\n📅 {now}\n\n✅ 没有发现符合条件的币种\n(1h RSI ≥ 90 且 4h RSI ≥ 80)"
    
    # Sort by volume
    matches.sort(key=lambda x: x['volume'], reverse=True)
    
    lines = [
        f"🚨 *Binance Futures Radar*",
        f"📅 {now}",
        f"📊 发现 {len(matches)} 个高 RSI 币种",
        "",
        "```"
    ]
    
    for m in matches[:10]:  # Limit to top 10
        funding_pct = m['funding'] * 100
        lines.append(
            f"{m['symbol']:12} | 1h:{m['rsi_1h']:.0f} 4h:{m['rsi_4h']:.0f} | {m['change']:+.1f}%"
        )
    
    lines.append("```")
    
    if len(matches) > 10:
        lines.append(f"\n_... 及另外 {len(matches) - 10} 个币种_")
    
    lines.append("\n💡 _高 RSI 可能意味着超买，注意做空机会_")
    
    return "\n".join(lines)


def main():
    """Main entry point"""
    # Check credentials
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Warning: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set")
        print("Running in test mode (output to console only)")
    
    # Scan market
    matches = scan_market()
    
    # Format and send message
    message = format_message(matches)
    success = send_telegram_message(message)
    
    if success:
        print("Telegram message sent successfully!")
    else:
        print("Failed to send Telegram message or running in test mode")
    
    return 0 if success or not TELEGRAM_BOT_TOKEN else 1


if __name__ == "__main__":
    sys.exit(main())
