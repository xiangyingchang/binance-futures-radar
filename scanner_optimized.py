#!/usr/bin/env python3
"""
Binance Futures RSI Scanner — Optimized Production Version
============================================================
扫描 Binance USDⓈ-M 永续合约，输出结构化信号文件供 radar_engine.py 消费。

信号源规则（对齐 TRADING_STRATEGY.md v1.2 第二节）：
- rsi_1h > 90
- rsi_4h > 80
- funding_apr > -500%
- rank > 100（缺失时放行，标记 rank_status=missing）

输出格式：
{
  "source": "binance-futures-radar",
  "source_run_id": "<uuid>",
  "generated_at": "<ISO8601>",
  "eligible_signals": [...],
  "rejected_signals": [...]
}
"""

import os
import sys
import json
import uuid
import asyncio
import aiohttp
import time
import argparse
from datetime import datetime, timezone, timedelta
from pathlib import Path
from dotenv import load_dotenv

# Load local .env file
load_dotenv()

# ============================================================
# Configuration — aligned with TRADING_STRATEGY.md
# ============================================================
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

# RSI Thresholds (策略手册第二节)
RSI_1H_THRESHOLD = 90
RSI_4H_THRESHOLD = 80
RSI_PERIOD = 6
K_LINE_LIMIT = 35  # 35 根 K 线

# Funding Rate Filter
FUNDING_APR_MIN = -500  # funding_apr > -500%

# Rank Filter
RANK_MIN_EXCLUSIVE = 100  # rank > 100 (rank_status=missing 时放行)

# Concurrency
CONCURRENCY = 40

# API Endpoints
BINANCE_BASE = "https://fapi.binance.com"
BEIJING_TZ = timezone(timedelta(hours=8))

# Output
WORKSPACE = os.environ.get(
    "OPENCLAW_WORKSPACE",
    str(Path(__file__).resolve().parent.parent)
    if (Path(__file__).resolve().parent.parent / "tasks").is_dir()
    else str(Path(__file__).resolve().parent),
)
SIGNALS_DIR = os.path.join(WORKSPACE, "signals")
RUNTIME_DIR = os.path.join(WORKSPACE, "runtime")
LATEST_SIGNALS_FILE = os.path.join(RUNTIME_DIR, "latest_signals.json")

# Global Cache for Asset Ranks (Base Asset -> Rank)
ASSET_RANK_CACHE = {"data": {}, "last_update": 0}
RANK_CACHE_TTL = 3600  # 1 hour


# ============================================================
# RSI Calculation — Wilder's Smoothing (策略手册第九节)
# ============================================================
def calculate_rsi(closes, period=6):
    """
    Wilder's Smoothing RSI.
    - 边界保护：avg_gain=0 且 avg_loss=0 时返回 50
    """
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

    # Wilder's Smoothing
    for i in range(period + 1, len(closes)):
        diff = closes[i] - closes[i - 1]
        current_gain = diff if diff > 0 else 0
        current_loss = abs(diff) if diff < 0 else 0

        avg_gain = ((avg_gain * (period - 1)) + current_gain) / period
        avg_loss = ((avg_loss * (period - 1)) + current_loss) / period

    # 边界保护
    if avg_gain == 0 and avg_loss == 0:
        return 50

    if avg_loss == 0:
        return 100

    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


# ============================================================
# Async HTTP helpers
# ============================================================
async def fetch_json(session, url, params=None, timeout=15):
    """Async GET request with error handling."""
    try:
        async with session.get(url, params=params, timeout=timeout) as response:
            if response.status == 200:
                return await response.json()
            else:
                print(f"Error fetching {url}: HTTP {response.status}")
                return None
    except asyncio.TimeoutError:
        print(f"Timeout fetching {url}")
        return None
    except Exception as e:
        print(f"Exception fetching {url}: {e}")
        return None


# ============================================================
# Depth Analysis (Top 100 order book)
# ============================================================
async def fetch_depth_ratio(session, symbol):
    """Fetch order book depth and return bid/ask ratio for top 100 levels."""
    try:
        data = await fetch_json(
            session,
            f"{BINANCE_BASE}/fapi/v1/depth",
            params={"symbol": symbol, "limit": 100},
            timeout=10,
        )
        if not data:
            return None

        bids_total = sum(float(b[1]) for b in data.get("bids", []))
        asks_total = sum(float(a[1]) for a in data.get("asks", []))

        if asks_total == 0:
            return None

        return round(bids_total / asks_total, 2)
    except Exception:
        return None


# ============================================================
# Symbol Scanner
# ============================================================
async def check_symbol(
    session, semaphore, symbol, ticker_info, funding_rate, funding_interval, rank, rank_status,
    eligible_results, rejected_results, generated_at, source_run_id,
):
    """Scan a single symbol against all filter criteria."""
    async with semaphore:
        base_info = {
            "pair": symbol,
            "rank": rank,
            "rank_status": rank_status,
            "funding_rate": funding_rate,
            "funding_interval": funding_interval,
            "volume": float(ticker_info.get("quoteVolume", 0)),
            "price": float(ticker_info.get("lastPrice", 0)),
            "change_24h": float(ticker_info.get("priceChangePercent", 0)),
            "generated_at": generated_at,
            "source_run_id": source_run_id,
        }

        reject_reasons = []

        # --- Step 1: Fetch 1h RSI ---
        k1h_data = await fetch_json(
            session,
            f"{BINANCE_BASE}/fapi/v1/klines",
            params={"symbol": symbol, "interval": "1h", "limit": K_LINE_LIMIT},
        )
        if not k1h_data:
            return  # silently skip if API fails

        k1h_closes = [float(c[4]) for c in k1h_data]
        rsi_1h = round(calculate_rsi(k1h_closes, RSI_PERIOD), 2)
        base_info["rsi_1h"] = rsi_1h

        if rsi_1h <= RSI_1H_THRESHOLD:
            return  # early exit: below minimum threshold, don't even record

        # --- Step 2: Fetch 4h RSI (only if 1h passes) ---
        k4h_data = await fetch_json(
            session,
            f"{BINANCE_BASE}/fapi/v1/klines",
            params={"symbol": symbol, "interval": "4h", "limit": K_LINE_LIMIT},
        )
        if not k4h_data:
            return

        k4h_closes = [float(c[4]) for c in k4h_data]
        rsi_4h = round(calculate_rsi(k4h_closes, RSI_PERIOD), 2)
        base_info["rsi_4h"] = rsi_4h

        # --- Step 3: Calculate funding APR ---
        annualized_rate = funding_rate * (24 / funding_interval) * 365 * 100
        funding_apr = round(annualized_rate, 2)
        base_info["funding_apr"] = funding_apr

        # --- Step 4: Fetch depth ---
        depth_100 = await fetch_depth_ratio(session, symbol)
        base_info["depth_100"] = depth_100

        # --- Step 5: Apply filters ---
        if rsi_4h < RSI_4H_THRESHOLD:
            reject_reasons.append(f"rsi_4h={rsi_4h}<{RSI_4H_THRESHOLD}")

        if funding_apr <= FUNDING_APR_MIN:
            reject_reasons.append(f"funding_apr={funding_apr}<={FUNDING_APR_MIN}")

        # Rank filter: rank > 100 required, but missing rank is allowed
        if rank_status == "valid" and rank is not None and rank <= RANK_MIN_EXCLUSIVE:
            reject_reasons.append(f"rank={rank}<={RANK_MIN_EXCLUSIVE}")

        # --- Step 6: Classify ---
        base_info["reject_reasons"] = reject_reasons
        base_info["eligible"] = len(reject_reasons) == 0

        if len(reject_reasons) == 0:
            eligible_results.append(base_info)
        else:
            rejected_results.append(base_info)


# ============================================================
# Main Scan
# ============================================================
async def scan_market():
    """
    Main async scanning logic.
    Returns: (eligible_signals, rejected_signals)
    """
    start_time = datetime.now(BEIJING_TZ)
    print(f"[{start_time.strftime('%Y-%m-%d %H:%M:%S')}] Starting optimized scan...")

    source_run_id = str(uuid.uuid4())
    generated_at = datetime.now(timezone.utc).isoformat()

    async with aiohttp.ClientSession() as session:
        # 1. Fetch metadata in parallel
        now_ts = time.time()
        tasks = [
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/exchangeInfo"),
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/ticker/24hr"),
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/premiumIndex"),
            fetch_json(session, f"{BINANCE_BASE}/fapi/v1/fundingInfo"),
        ]

        # Fetch rank data if cache expired
        fetching_rank = False
        if now_ts - ASSET_RANK_CACHE["last_update"] > RANK_CACHE_TTL:
            fetching_rank = True
            tasks.append(
                fetch_json(
                    session,
                    "https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true",
                )
            )

        metadata = await asyncio.gather(*tasks)

        if fetching_rank:
            ex_info, ticker_list, premium_list, funding_info_list, product_data = metadata
            if product_data and product_data.get("success"):
                mcap_list = []
                for item in product_data.get("data", []):
                    if item.get("q") == "USDT" and item.get("cs") is not None:
                        try:
                            price = float(item.get("c", 0))
                            cs = float(item["cs"])
                            if price > 0 and cs > 0:
                                mcap_list.append({"base": item["b"], "mcap": price * cs})
                        except Exception:
                            continue

                mcap_list.sort(key=lambda x: x["mcap"], reverse=True)
                rank_map = {item["base"]: i + 1 for i, item in enumerate(mcap_list)}
                ASSET_RANK_CACHE["data"] = rank_map
                ASSET_RANK_CACHE["last_update"] = now_ts
                print(f"Updated global asset ranks. Tracked {len(rank_map)} assets.")
            else:
                print("Warning: Failed to fetch product data for market cap ranking.")
        else:
            ex_info, ticker_list, premium_list, funding_info_list = metadata

        if not all([ex_info, ticker_list, premium_list, funding_info_list]):
            print("Error: Failed to fetch initial metadata from Binance.")
            return [], []

        # 2. Build maps
        symbols = [
            s["symbol"]
            for s in ex_info["symbols"]
            if s["quoteAsset"] == "USDT" and s["status"] == "TRADING"
        ]

        ticker_map = {item["symbol"]: item for item in ticker_list}
        funding_map = {
            item["symbol"]: float(item["lastFundingRate"]) for item in premium_list
        }
        funding_info_map = {
            item["symbol"]: item.get("fundingIntervalHours", 8)
            for item in funding_info_list
        }

        # Base asset mapping for rank lookup
        symbol_to_base = {}
        for s in ex_info["symbols"]:
            symbol_to_base[s["symbol"]] = s["baseAsset"]

        print(
            f"Scanning {len(symbols)} trading pairs with concurrency {CONCURRENCY}..."
        )

        # 3. Run concurrent scanners
        semaphore = asyncio.Semaphore(CONCURRENCY)
        eligible_results = []
        rejected_results = []
        scan_tasks = []

        for symbol in symbols:
            t_info = ticker_map.get(symbol, {})
            f_rate = funding_map.get(symbol, 0)
            f_interval = funding_info_map.get(symbol, 8)

            # Resolve rank
            base_asset = symbol_to_base.get(symbol, symbol.replace("USDT", ""))
            rank = ASSET_RANK_CACHE["data"].get(base_asset)
            if rank is None and base_asset.startswith("1000"):
                rank = ASSET_RANK_CACHE["data"].get(base_asset[4:])

            rank_status = "valid" if rank is not None else "missing"

            scan_tasks.append(
                check_symbol(
                    session,
                    semaphore,
                    symbol,
                    t_info,
                    f_rate,
                    f_interval,
                    rank,
                    rank_status,
                    eligible_results,
                    rejected_results,
                    generated_at,
                    source_run_id,
                )
            )

        await asyncio.gather(*scan_tasks)

        # Sort eligible by rsi_1h descending
        eligible_results.sort(key=lambda x: x.get("rsi_1h", 0), reverse=True)
        rejected_results.sort(key=lambda x: x.get("rsi_1h", 0), reverse=True)

        end_time = datetime.now(BEIJING_TZ)
        duration = (end_time - start_time).total_seconds()
        print(
            f"Scan complete in {duration:.1f}s. "
            f"Eligible: {len(eligible_results)}, Rejected: {len(rejected_results)}"
        )

        return eligible_results, rejected_results


# ============================================================
# Output: write structured signal files
# ============================================================
def write_signal_output(eligible_signals, rejected_signals):
    """
    Write two files:
    1. runtime/latest_signals.json — for radar_engine.py consumption
    2. signals/radar_optimized_signals_<timestamp>.json — archive
    """
    now = datetime.now(BEIJING_TZ)
    source_run_id = (
        eligible_signals[0]["source_run_id"]
        if eligible_signals
        else (
            rejected_signals[0]["source_run_id"]
            if rejected_signals
            else str(uuid.uuid4())
        )
    )
    generated_at = (
        eligible_signals[0]["generated_at"]
        if eligible_signals
        else (
            rejected_signals[0]["generated_at"]
            if rejected_signals
            else datetime.now(timezone.utc).isoformat()
        )
    )

    payload = {
        "source": "binance-futures-radar",
        "source_run_id": source_run_id,
        "generated_at": generated_at,
        "scan_completed_at": now.isoformat(),
        "eligible_signals": eligible_signals,
        "rejected_signals": rejected_signals,
        "summary": {
            "total_scanned": len(eligible_signals) + len(rejected_signals),
            "eligible_count": len(eligible_signals),
            "rejected_count": len(rejected_signals),
        },
    }

    # Ensure directories exist
    os.makedirs(RUNTIME_DIR, exist_ok=True)
    os.makedirs(SIGNALS_DIR, exist_ok=True)

    # 1. Write latest_signals.json (consumed by radar_engine.py)
    with open(LATEST_SIGNALS_FILE, "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Written: {LATEST_SIGNALS_FILE}")

    # 2. Write archive copy
    archive_name = f"radar_optimized_signals_{now.strftime('%Y%m%d_%H%M%S')}.json"
    archive_path = os.path.join(SIGNALS_DIR, archive_name)
    with open(archive_path, "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Archived: {archive_path}")

    return payload


# ============================================================
# Telegram notification
# ============================================================
def format_message(eligible, rejected):
    """Format results for Telegram notification."""
    import random

    now = datetime.now(BEIJING_TZ).strftime("%H:%M")

    if not eligible and not rejected:
        return f"🚨 *RSI Radar* · {now}\n\n✅ 暂无高RSI币种"

    emojis = ["🔥", "🚀", "⚡", "🎯", "💎", "🌟", "📈", "📢", "🔔", "✨"]

    lines = [f"🚨 *RSI RADAR* | `{now}`\n"]

    if eligible:
        lines.append(f"*符合条件: {len(eligible)} 个*\n")
        for m in eligible[:15]:
            emoji = random.choice(emojis)
            rsi_str = f"1h:{int(m['rsi_1h'])} 4h:{int(m.get('rsi_4h', 0))}"
            funding_str = f"{m.get('funding_apr', 0):+.1f}%"
            rank = m.get("rank")
            rank_str = f"(#{rank})" if rank else "(rank?)"
            lines.append(
                f"{emoji} `{m['pair']}` {rank_str} | {rsi_str} | 年化:{funding_str}"
            )

    if rejected:
        lines.append(f"\n_已过滤: {len(rejected)} 个 (rsi_1h>90 但未全部达标)_")

    return "\n".join(lines)


async def send_telegram(message):
    """Async send Telegram message."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram not configured. Result:")
        print(message)
        return True

    async with aiohttp.ClientSession() as session:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {
            "chat_id": TELEGRAM_CHAT_ID,
            "text": message,
            "parse_mode": "Markdown",
        }
        try:
            async with session.post(url, json=payload, timeout=10) as response:
                if response.status == 200:
                    return True
                else:
                    print(f"Telegram send failed: HTTP {response.status}")
                    return False
        except Exception as e:
            print(f"Telegram send error: {e}")
            return False


# ============================================================
# Main
# ============================================================
async def main():
    parser = argparse.ArgumentParser(description="Binance Futures RSI Scanner (Optimized)")
    parser.add_argument(
        "--loop",
        action="store_true",
        help="Enable continuous scanning at every top of the hour",
    )
    parser.add_argument(
        "--no-telegram",
        action="store_true",
        help="Skip Telegram notification",
    )
    parser.add_argument(
        "--no-file",
        action="store_true",
        help="Skip writing signal files (print to stdout only)",
    )
    args = parser.parse_args()

    if args.loop:
        print("Loop mode enabled. Scanning at every top of the hour.")
        while True:
            await run_once(args)
            await wait_until_next_hour()
    else:
        await run_once(args)


async def run_once(args):
    """Run a single scan cycle."""
    eligible, rejected = await scan_market()

    # Write output files
    if not args.no_file:
        payload = write_signal_output(eligible, rejected)
    else:
        payload = {
            "eligible_signals": eligible,
            "rejected_signals": rejected,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    # Send Telegram
    if not args.no_telegram:
        message = format_message(eligible, rejected)
        await send_telegram(message)

    return eligible, rejected


async def wait_until_next_hour():
    """Wait until the beginning of the next hour."""
    now = datetime.now(BEIJING_TZ)
    # 下一个整点的 :58 分
    next_run = (now + timedelta(hours=1)).replace(minute=58, second=0, microsecond=0)
    if now.minute < 58:
        next_run = now.replace(minute=58, second=0, microsecond=0)

    wait_seconds = (next_run - now).total_seconds()
    if wait_seconds < 0:
        wait_seconds += 3600

    print(
        f"Waiting {wait_seconds:.0f}s until next run ({next_run.strftime('%H:%M:%S')})..."
    )
    await asyncio.sleep(wait_seconds)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nScan cancelled by user.")
