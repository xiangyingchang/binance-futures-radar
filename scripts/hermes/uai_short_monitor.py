#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UAIUSDT 15-minute short-monitor scanner.

This module has two consumers:
- ``--detail``: fetch a fresh Binance Futures snapshot and print a readable report.
- ``--state``: fetch the same core data and print a deterministic state signature for
  Hermes Cron's change detector.  It deliberately omits timestamps and raw prices.

The scanner never places orders and never reads account credentials.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Iterable

SYMBOL = "UAIUSDT"
BINANCE_BASE = "https://www.binance.com"
MARKET_URL = "https://binance-futures-radar.vercel.app/api/market"
FRESHNESS_MAX_SECONDS = 180
REQUEST_TIMEOUT_SECONDS = 15
RSI_PERIOD = 6
OI_24H_STRONG_PCT = 20.0
OI_7D_STRONG_PCT = 30.0

HEADERS = {
    "Accept": "application/json",
    "User-Agent": "uai-short-monitor/1.0",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}


def finite(value: Any, fallback: float | None = None) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def pct_change(current: Any, previous: Any) -> float | None:
    current_n = finite(current)
    previous_n = finite(previous)
    if current_n is None or previous_n in (None, 0):
        return None
    return ((current_n / previous_n) - 1.0) * 100.0


def calculate_rsi_series(closes: Iterable[Any], period: int = RSI_PERIOD) -> list[float | None]:
    values = [finite(value) for value in closes]
    result: list[float | None] = [None] * len(values)
    if len(values) < period + 1 or any(value is None for value in values):
        return result

    gains = 0.0
    losses = 0.0
    for index in range(1, period + 1):
        difference = values[index] - values[index - 1]  # type: ignore[operator]
        gains += max(difference, 0.0)
        losses += max(-difference, 0.0)

    average_gain = gains / period
    average_loss = losses / period

    def to_rsi(gain: float, loss: float) -> float:
        if gain == 0.0 and loss == 0.0:
            return 50.0
        if loss == 0.0:
            return 100.0
        return 100.0 - (100.0 / (1.0 + (gain / loss)))

    result[period] = to_rsi(average_gain, average_loss)
    for index in range(period + 1, len(values)):
        difference = values[index] - values[index - 1]  # type: ignore[operator]
        gain = max(difference, 0.0)
        loss = max(-difference, 0.0)
        average_gain = ((average_gain * (period - 1)) + gain) / period
        average_loss = ((average_loss * (period - 1)) + loss) / period
        result[index] = to_rsi(average_gain, average_loss)
    return result


def current_rsi(closes: Iterable[Any], period: int = RSI_PERIOD) -> float | None:
    series = calculate_rsi_series(closes, period)
    return series[-1] if series and series[-1] is not None else None


def percentile_rank(values: Iterable[Any], current: Any) -> float | None:
    current_n = finite(current)
    clean = [finite(value) for value in values]
    clean = [value for value in clean if value is not None]
    if current_n is None or len(clean) < 10:
        return None
    return sum(value <= current_n for value in clean) / len(clean) * 100.0


def parse_klines(rows: Any) -> list[dict[str, float | int]]:
    if not isinstance(rows, list):
        return []
    parsed: list[dict[str, float | int]] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 8:
            continue
        close = finite(row[4])
        if close is None:
            continue
        parsed.append(
            {
                "openTime": int(row[0]),
                "open": finite(row[1]) or 0.0,
                "high": finite(row[2]) or 0.0,
                "low": finite(row[3]) or 0.0,
                "close": close,
                "closeTime": int(row[6]),
                "quoteVolume": finite(row[7]) or 0.0,
            }
        )
    return parsed


def closed_candles(candles: list[dict[str, float | int]], now_ms: int | None = None) -> list[dict[str, float | int]]:
    current_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    return [candle for candle in candles if int(candle["closeTime"]) < current_ms]


def _candle_float(candle: dict[str, float | int], key: str) -> float:
    return float(candle[key])


def true_range(current: dict[str, float | int], previous_close: float | None) -> float:
    high = _candle_float(current, "high")
    low = _candle_float(current, "low")
    previous = finite(previous_close)
    if previous is None:
        return high - low
    return max(high - low, abs(high - previous), abs(low - previous))


def atr(candles: list[dict[str, float | int]], period: int = 14) -> float | None:
    if len(candles) < period + 1:
        return None
    ranges = [
        true_range(candles[index], _candle_float(candles[index - 1], "close"))
        for index in range(1, len(candles))
    ]
    value = sum(ranges[:period]) / period
    for current_range in ranges[period:]:
        value = ((value * (period - 1)) + current_range) / period
    return value


def detect_bearish_divergence(
    candles: list[dict[str, float | int]], rsi_values: list[float | None]
) -> bool:
    if len(candles) < 6 or len(rsi_values) < len(candles):
        return False
    start = len(candles) - 6

    def peak(offset: int, length: int) -> tuple[float, float] | None:
        candidates: list[tuple[float, float]] = []
        for index in range(offset, offset + length):
            rsi_value = rsi_values[index]
            if rsi_value is not None:
                candidates.append((_candle_float(candles[index], "high"), rsi_value))
        return max(candidates, key=lambda item: item[0]) if candidates else None

    previous_peak = peak(start, 3)
    recent_peak = peak(start + 3, 3)
    if previous_peak is None or recent_peak is None:
        return False
    return recent_peak[0] > previous_peak[0] * 1.002 and recent_peak[1] < previous_peak[1] - 2.0


def analyze_reversal(
    one_hour_candles: list[dict[str, float | int]],
    four_hour_candles: list[dict[str, float | int]],
) -> dict[str, Any]:
    one_rsi = calculate_rsi_series([candle["close"] for candle in one_hour_candles])
    four_rsi = calculate_rsi_series([candle["close"] for candle in four_hour_candles])
    last_one = one_hour_candles[-1] if one_hour_candles else None
    last_four = four_hour_candles[-1] if four_hour_candles else None
    previous_four = four_hour_candles[-2] if len(four_hour_candles) >= 2 else None

    current_one_rsi = one_rsi[-1] if one_rsi else None
    current_four_rsi = four_rsi[-1] if four_rsi else None
    previous_four_rsi = four_rsi[-2] if len(four_rsi) >= 2 else None
    prior_one_rsi = [value for value in one_rsi[-13:-1] if value is not None]
    recent_four_rsi = [value for value in four_rsi[-7:] if value is not None]

    structure_break_1h = False
    if last_one is not None and len(one_hour_candles) >= 4:
        prior_lows = [_candle_float(candle, "low") for candle in one_hour_candles[-4:-1]]
        structure_break_1h = _candle_float(last_one, "close") < min(prior_lows)

    structure_break_4h = False
    if last_four is not None and previous_four is not None:
        structure_break_4h = _candle_float(last_four, "close") < _candle_float(previous_four, "low")

    peak_rsi_4h = max(recent_four_rsi) if recent_four_rsi else None
    rsi_1h_cross_below_80 = (
        current_one_rsi is not None
        and current_one_rsi < 80.0
        and any(value > 90.0 for value in prior_one_rsi)
    )
    rsi_4h_declining = (
        current_four_rsi is not None
        and previous_four_rsi is not None
        and current_four_rsi < previous_four_rsi
    )
    bearish_divergence = detect_bearish_divergence(four_hour_candles, four_rsi)

    result: dict[str, Any] = {
        "rsi1h": current_one_rsi,
        "rsi4h": current_four_rsi,
        "peakRsi4h": peak_rsi_4h,
        "had4hOver85": peak_rsi_4h is not None and peak_rsi_4h > 85.0,
        "rsi4hDeclining": rsi_4h_declining,
        "bearishDivergence": bearish_divergence,
        "structureBreak4h": structure_break_4h,
        "rsi1hCrossBelow80": rsi_1h_cross_below_80,
        "structureBreak1h": structure_break_1h,
    }
    result["reversalCount"] = sum(
        bool(result[key])
        for key in ("bearishDivergence", "structureBreak4h", "rsi1hCrossBelow80", "structureBreak1h")
    )
    result["atr4h"] = atr(four_hour_candles)
    recent_highs = [_candle_float(candle, "high") for candle in four_hour_candles[-6:]]
    result["recentHigh"] = max(recent_highs) if recent_highs else None
    reference_price = _candle_float(last_four, "close") if last_four else None
    if result["recentHigh"] is not None and result["atr4h"] is not None:
        result["invalidationPrice"] = result["recentHigh"] + (0.5 * result["atr4h"])
    else:
        result["invalidationPrice"] = result["recentHigh"]
    result["invalidationDistancePct"] = pct_change(result["invalidationPrice"], reference_price)
    return result


def compute_oi_changes(rows: Any) -> dict[str, Any]:
    data = rows if isinstance(rows, list) else []
    clean = [
        row
        for row in data
        if isinstance(row, dict)
        and finite(row.get("sumOpenInterest")) is not None
        and int(row.get("timestamp", 0)) > 0
    ]
    clean.sort(key=lambda row: int(row["timestamp"]))
    if len(clean) < 2:
        return {"oiCurrent": None, "oiCurrentValue": None, "oi24hPct": None, "oi7dPct": None, "oiSamples": len(clean)}

    current = finite(clean[-1]["sumOpenInterest"])
    current_timestamp = int(clean[-1]["timestamp"])
    if current is None or current <= 0:
        return {"oiCurrent": None, "oiCurrentValue": None, "oi24hPct": None, "oi7dPct": None, "oiSamples": len(clean)}

    def nearest_before(hours: int) -> dict[str, Any] | None:
        target = current_timestamp - (hours * 60 * 60 * 1000)
        candidates = [row for row in clean if int(row["timestamp"]) <= target]
        return candidates[-1] if candidates else None

    prior_24 = nearest_before(24)
    prior_7d = nearest_before(24 * 7)
    return {
        "oiCurrent": current,
        "oiCurrentValue": finite(clean[-1].get("sumOpenInterestValue")),
        "oiCurrentTimestamp": current_timestamp,
        "oi24hPct": pct_change(current, prior_24.get("sumOpenInterest") if prior_24 else None),
        "oi7dPct": pct_change(current, prior_7d.get("sumOpenInterest") if prior_7d else None),
        "oi24hTimestamp": int(prior_24["timestamp"]) if prior_24 else None,
        "oi7dTimestamp": int(prior_7d["timestamp"]) if prior_7d else None,
        "oiSamples": len(clean),
    }


def funding_band(percentile: float | None) -> str:
    if percentile is None:
        return "UNKNOWN"
    if percentile >= 90.0:
        return "P90_PLUS"
    if percentile >= 75.0:
        return "P75_P90"
    if percentile >= 60.0:
        return "P60_P75"
    return "BELOW_P60"


def squeeze_risk(metrics: dict[str, Any]) -> bool:
    return (
        (finite(metrics.get("oi24hPct")) or -math.inf) >= OI_24H_STRONG_PCT
        or (finite(metrics.get("oi7dPct")) or -math.inf) >= OI_7D_STRONG_PCT
    )


def determine_status(metrics: dict[str, Any]) -> str:
    if metrics.get("dataErrors"):
        return "DATA_ERROR"
    reversal = metrics.get("reversal") or {}
    critical_values = (
        metrics.get("lastPrice"),
        metrics.get("fundingPercentile"),
        metrics.get("oi24hPct"),
        metrics.get("oi7dPct"),
        reversal.get("recentHigh"),
        reversal.get("invalidationPrice"),
    )
    if any(finite(value) is None for value in critical_values):
        return "DATA_ERROR"
    price = finite(metrics.get("lastPrice"))
    recent_high = finite(reversal.get("recentHigh"))
    invalidation = finite(reversal.get("invalidationPrice"))
    if price is not None and (
        (recent_high is not None and price >= recent_high)
        or (invalidation is not None and price >= invalidation)
    ):
        return "INVALIDATED"

    funding_percentile = finite(metrics.get("fundingPercentile"))
    has_reversal = bool(
        reversal.get("rsi1hCrossBelow80")
        or reversal.get("rsi4hDeclining")
        or reversal.get("bearishDivergence")
    )
    if (
        funding_percentile is not None
        and funding_percentile >= 90.0
        and bool(reversal.get("structureBreak4h"))
        and has_reversal
    ):
        return "SHORT_CONFIRMED"
    if funding_percentile is not None and funding_percentile >= 90.0:
        return "WATCH_EXTREME"
    if has_reversal or bool(reversal.get("structureBreak1h")):
        return "WATCH_COOLING"
    return "NO_SETUP"


def _risk_band(level: Any, reference_price: Any) -> str:
    level_n = finite(level)
    reference_n = finite(reference_price)
    if level_n is None or reference_n in (None, 0):
        return "NA"
    relative_pct = (level_n / reference_n - 1.0) * 100.0
    # The state monitor is for meaningful changes, not every tick.  Two-point
    # percentage buckets keep ordinary price noise from waking the agent.
    bucket = int(round(relative_pct / 2.0) * 2)
    return f"{bucket:+d}pct"


def next_trigger_levels(metrics: dict[str, Any]) -> dict[str, float | None]:
    one = metrics.get("oneHourClosed") or []
    four = metrics.get("fourHourClosed") or []
    one_level = None
    four_level = None
    if len(one) >= 3:
        one_level = min(_candle_float(candle, "low") for candle in one[-3:])
    if four:
        four_level = _candle_float(four[-1], "low")
    return {"trigger1h": one_level, "trigger4h": four_level}


def state_signature(metrics: dict[str, Any]) -> str:
    status = determine_status(metrics)
    if metrics.get("dataErrors"):
        return "UAI_STATE|state=DATA_ERROR|funding=UNKNOWN|break1h=0|break4h=0|rsi1hCross=0|rsi4hDecl=0|bearDiv=0|squeeze=0|trigger1h=NA|trigger4h=NA|invalidation=NA|data=ERROR"
    reversal = metrics.get("reversal") or {}
    triggers = next_trigger_levels(metrics)
    return "|".join(
        [
            "UAI_STATE",
            f"state={status}",
            f"funding={funding_band(finite(metrics.get('fundingPercentile')))}",
            f"break1h={int(bool(reversal.get('structureBreak1h')))}",
            f"break4h={int(bool(reversal.get('structureBreak4h')))}",
            f"rsi1hCross={int(bool(reversal.get('rsi1hCrossBelow80')))}",
            f"rsi4hDecl={int(bool(reversal.get('rsi4hDeclining')))}",
            f"bearDiv={int(bool(reversal.get('bearishDivergence')))}",
            f"squeeze={int(squeeze_risk(metrics))}",
            f"trigger1h={_risk_band(triggers['trigger1h'], metrics.get('lastPrice'))}",
            f"trigger4h={_risk_band(triggers['trigger4h'], metrics.get('lastPrice'))}",
            f"invalidation={_risk_band((reversal or {}).get('invalidationPrice'), metrics.get('lastPrice'))}",
            f"data={'ERROR' if metrics.get('dataErrors') else 'OK'}",
        ]
    )


def _url(path: str, params: dict[str, Any] | None = None) -> str:
    target = BINANCE_BASE + path
    if params:
        target += "?" + urllib.parse.urlencode(params)
    return target


def _response_age_seconds(date_header: str | None, now: float | None = None) -> float | None:
    if not date_header:
        return None
    try:
        parsed = parsedate_to_datetime(date_header)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        current = datetime.now(timezone.utc).timestamp() if now is None else now
        return current - parsed.astimezone(timezone.utc).timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def _openers() -> list[urllib.request.OpenerDirector]:
    # The direct opener avoids accidentally routing Binance through a stale proxy;
    # the default opener remains a bounded fallback for cron environments that
    # require Clash or another configured transport.
    return [
        urllib.request.build_opener(urllib.request.ProxyHandler({})),
        urllib.request.build_opener(),
    ]


def fetch_json(url: str, timeout: int = REQUEST_TIMEOUT_SECONDS) -> tuple[Any, dict[str, Any]]:
    failures: list[str] = []
    for opener in _openers():
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with opener.open(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
                return payload, {
                    "url": url,
                    "http": int(response.status),
                    "date": response.headers.get("Date"),
                    "ageSec": _response_age_seconds(response.headers.get("Date")),
                }
        except urllib.error.HTTPError as error:
            # Binance explicitly asks clients not to retry these responses;
            # do not switch transports and extend a 418/429 ban.
            if error.code in (418, 429):
                raise RuntimeError(f"HTTP {error.code}; retry suppressed") from error
            failures.append(f"HTTP {error.code}")
        except Exception as error:  # noqa: BLE001 - transport boundary
            failures.append(str(error))
    raise RuntimeError("; ".join(failures) or "request failed")


def fetch_funding_history(now_ms: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    start_ms = now_ms - (90 * 24 * 60 * 60 * 1000)
    cursor = start_ms
    rows: list[dict[str, Any]] = []
    metadata: list[dict[str, Any]] = []
    for _ in range(4):
        url = _url(
            "/fapi/v1/fundingRate",
            {"symbol": SYMBOL, "startTime": cursor, "endTime": now_ms, "limit": 1000},
        )
        payload, meta = fetch_json(url)
        metadata.append(meta)
        if not isinstance(payload, list) or not payload:
            break
        rows.extend(row for row in payload if isinstance(row, dict))
        if len(payload) < 1000:
            break
        last_time = int(payload[-1].get("fundingTime", 0))
        if last_time <= cursor:
            break
        cursor = last_time + 1
    return rows, metadata


def _validate_kline_fresh(rows: Any, interval_ms: int, now_ms: int) -> str | None:
    if not isinstance(rows, list) or len(rows) < RSI_PERIOD + 1:
        return "insufficient candles"
    try:
        latest_open = int(rows[-1][0])
    except (IndexError, TypeError, ValueError):
        return "invalid latest candle"
    if now_ms - latest_open > interval_ms * 2:
        return f"latest candle is too old ({(now_ms - latest_open) / 1000:.1f}s)"
    return None


def _freshness_error(meta: dict[str, Any]) -> str | None:
    if not isinstance(meta.get("date"), str) or not meta.get("date"):
        return "missing HTTP Date"
    age = finite(meta.get("ageSec"))
    if age is None:
        return "unparseable HTTP Date"
    if age is not None and age > FRESHNESS_MAX_SECONDS:
        return f"response age {age:.1f}s > {FRESHNESS_MAX_SECONDS}s"
    return None


def _iso_age_seconds(value: Any, now: float | None = None) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        current = datetime.now(timezone.utc).timestamp() if now is None else now
        return current - parsed.astimezone(timezone.utc).timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def scan_live(include_market: bool = False) -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    endpoints = {
        "ticker": _url("/fapi/v1/ticker/24hr", {"symbol": SYMBOL}),
        "premium": _url("/fapi/v1/premiumIndex", {"symbol": SYMBOL}),
        "k1h": _url("/fapi/v1/klines", {"symbol": SYMBOL, "interval": "1h", "limit": 200}),
        "k4h": _url("/fapi/v1/klines", {"symbol": SYMBOL, "interval": "4h", "limit": 100}),
        "k1d": _url("/fapi/v1/klines", {"symbol": SYMBOL, "interval": "1d", "limit": 60}),
        "oihist": _url("/futures/data/openInterestHist", {"symbol": SYMBOL, "period": "1h", "limit": 169}),
        "oi": _url("/fapi/v1/openInterest", {"symbol": SYMBOL}),
        "fundingInfo": _url("/fapi/v1/fundingInfo"),
    }
    if include_market:
        endpoints["market"] = MARKET_URL + "?_uai_ts=" + str(time.time_ns())

    payloads: dict[str, Any] = {}
    metadata: dict[str, Any] = {}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=len(endpoints) + 1) as pool:
        futures: dict[Any, str] = {pool.submit(fetch_json, url): name for name, url in endpoints.items()}
        futures[pool.submit(fetch_funding_history, now_ms)] = "fundingHistory"
        for future in as_completed(futures):
            name = futures[future]
            try:
                result = future.result()
                if name == "fundingHistory":
                    payloads[name], metadata[name] = result
                else:
                    payloads[name], metadata[name] = result
            except Exception as error:  # noqa: BLE001 - surface as DATA_ERROR
                errors.append(f"{name}: {error}")

    for name, meta in metadata.items():
        if isinstance(meta, list):
            for index, item in enumerate(meta):
                freshness_error = _freshness_error(item)
                if freshness_error:
                    errors.append(f"{name}[{index}]: {freshness_error}")
        else:
            freshness_error = _freshness_error(meta)
            if freshness_error:
                errors.append(f"{name}: {freshness_error}")

    if include_market:
        market_payload = payloads.get("market")
        if not isinstance(market_payload, dict):
            errors.append("market: payload unavailable")
        else:
            market_age = _iso_age_seconds(market_payload.get("generatedAt"))
            if market_age is None:
                errors.append("market: missing or invalid generatedAt")
            elif market_age > FRESHNESS_MAX_SECONDS:
                errors.append(f"market: generatedAt age {market_age:.1f}s > {FRESHNESS_MAX_SECONDS}s")
            market_values = (
                ((market_payload.get("btc") or {}).get("change24hPct")),
                ((market_payload.get("eth") or {}).get("change24hPct")),
                ((market_payload.get("breadth") or {}).get("median24hPct")),
                ((market_payload.get("breadth") or {}).get("positivePct")),
                ((market_payload.get("breadth") or {}).get("n")),
            )
            if any(finite(value) is None for value in market_values):
                errors.append("market: required breadth fields unavailable")

    ticker_payload = payloads.get("ticker")
    premium_payload = payloads.get("premium")
    funding_info_payload = payloads.get("fundingInfo")
    funding_history_payload = payloads.get("fundingHistory")
    ticker: dict[str, Any] = ticker_payload if isinstance(ticker_payload, dict) else {}
    premium: dict[str, Any] = premium_payload if isinstance(premium_payload, dict) else {}
    funding_info_rows: list[dict[str, Any]] = [
        row for row in (funding_info_payload if isinstance(funding_info_payload, list) else [])
        if isinstance(row, dict)
    ]
    symbol_funding_info = next(
        (row for row in funding_info_rows if row.get("symbol") == SYMBOL),
        None,
    )
    if symbol_funding_info is None:
        errors.append("fundingInfo: UAIUSDT interval not found")

    raw_1h = payloads.get("k1h", [])
    raw_4h = payloads.get("k4h", [])
    raw_1d = payloads.get("k1d", [])
    freshness_specs = [(raw_1h, 60 * 60 * 1000, "1h"), (raw_4h, 4 * 60 * 60 * 1000, "4h"), (raw_1d, 24 * 60 * 60 * 1000, "1d")]
    for rows, interval_ms, label in freshness_specs:
        problem = _validate_kline_fresh(rows, interval_ms, now_ms)
        if problem:
            errors.append(f"{label}_klines: {problem}")

    one_all = parse_klines(raw_1h)
    four_all = parse_klines(raw_4h)
    daily_all = parse_klines(raw_1d)
    one_closed = closed_candles(one_all, now_ms)
    four_closed = closed_candles(four_all, now_ms)
    daily_closed = closed_candles(daily_all, now_ms)
    if len(one_closed) < RSI_PERIOD + 1 or len(four_closed) < RSI_PERIOD + 1 or len(daily_closed) < RSI_PERIOD + 1:
        errors.append("klines: insufficient closed candles")

    funding_history: list[dict[str, Any]] = [
        row for row in (funding_history_payload if isinstance(funding_history_payload, list) else [])
        if isinstance(row, dict)
    ]
    funding_rates = [finite(row.get("fundingRate")) for row in funding_history]
    funding_rates = [rate for rate in funding_rates if rate is not None]
    current_funding = finite(premium.get("lastFundingRate"))
    funding_percentile = percentile_rank(funding_rates, current_funding)
    if current_funding is None or funding_percentile is None:
        errors.append("funding: current rate or 90-day percentile unavailable")

    oi_metrics = compute_oi_changes(payloads.get("oihist"))
    if oi_metrics.get("oi24hPct") is None or oi_metrics.get("oi7dPct") is None:
        errors.append("openInterestHist: missing 24h/7d reference")
    oi_payload = payloads.get("oi")
    current_oi_endpoint = finite(oi_payload.get("openInterest")) if isinstance(oi_payload, dict) else None
    if current_oi_endpoint is None:
        errors.append("openInterest: current value unavailable")

    reversal = analyze_reversal(one_closed, four_closed)
    daily_live_closes = [candle["close"] for candle in daily_all]
    return_7d = pct_change(daily_live_closes[-1], daily_live_closes[-8]) if len(daily_live_closes) >= 8 else None
    funding_interval = int(symbol_funding_info.get("fundingIntervalHours", 0)) if symbol_funding_info else 0
    if funding_interval <= 0:
        errors.append("fundingInfo: invalid funding interval")
    required_values = {
        "ticker.lastPrice": ticker.get("lastPrice"),
        "ticker.priceChangePercent": ticker.get("priceChangePercent"),
        "ticker.highPrice": ticker.get("highPrice"),
        "ticker.lowPrice": ticker.get("lowPrice"),
        "ticker.quoteVolume": ticker.get("quoteVolume"),
        "premium.markPrice": premium.get("markPrice"),
        "premium.indexPrice": premium.get("indexPrice"),
        "daily.return7d": return_7d,
        "reversal.recentHigh": reversal.get("recentHigh"),
        "reversal.invalidationPrice": reversal.get("invalidationPrice"),
    }
    for label, value in required_values.items():
        if finite(value) is None:
            errors.append(f"{label}: missing")

    source_dates = sorted(
        str(meta.get("date"))
        for meta in metadata.values()
        if isinstance(meta, dict) and isinstance(meta.get("date"), str)
    )
    metrics: dict[str, Any] = {
        "symbol": SYMBOL,
        "snapshotTime": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sourceDates": source_dates,
        "dataErrors": sorted(set(errors)),
        "lastPrice": finite(ticker.get("lastPrice")),
        "markPrice": finite(premium.get("markPrice")),
        "indexPrice": finite(premium.get("indexPrice")),
        "change24hPct": finite(ticker.get("priceChangePercent")),
        "high24h": finite(ticker.get("highPrice")),
        "low24h": finite(ticker.get("lowPrice")),
        "quoteVolume24h": finite(ticker.get("quoteVolume")),
        "fundingRate": current_funding,
        "fundingIntervalHours": funding_interval,
        "fundingAprPct": (
            current_funding * (24.0 / funding_interval) * 365.0 * 100.0
            if current_funding is not None and funding_interval > 0
            else None
        ),
        "fundingPercentile": funding_percentile,
        "fundingSamples": len(funding_rates),
        "dailyRsiLive": current_rsi([candle["close"] for candle in daily_all]),
        "dailyRsiClosed": current_rsi([candle["close"] for candle in daily_closed]),
        "return7dPct": return_7d,
        "rsi1hLive": current_rsi([candle["close"] for candle in one_all]),
        "rsi4hLive": current_rsi([candle["close"] for candle in four_all]),
        "reversal": reversal,
        "oneHourClosed": one_closed,
        "fourHourClosed": four_closed,
        "dailyClosed": daily_closed,
        **oi_metrics,
        "currentOiEndpoint": current_oi_endpoint,
        "market": payloads.get("market") if isinstance(payloads.get("market"), dict) else None,
    }
    metrics["squeezeRisk"] = squeeze_risk(metrics)
    metrics["state"] = determine_status(metrics)
    return metrics


def _fmt(value: Any, decimals: int = 2) -> str:
    number = finite(value)
    return "--" if number is None else f"{number:.{decimals}f}"


def _fmt_pct(value: Any, decimals: int = 2) -> str:
    number = finite(value)
    return "--" if number is None else f"{number:+.{decimals}f}%"


def format_detail(metrics: dict[str, Any]) -> str:
    reversal = metrics.get("reversal") or {}
    triggers = next_trigger_levels(metrics)
    errors = metrics.get("dataErrors") or []
    state = metrics.get("state") or determine_status(metrics)
    lines = [
        f"[UAIUSDT MONITOR] snapshotUTC={metrics.get('snapshotTime')} source=Binance-Futures",
        f"STATUS|{state}|autoTrade=false|squeezeRisk={bool(metrics.get('squeezeRisk', squeeze_risk(metrics)))}",
        f"PRICE|last={_fmt(metrics.get('lastPrice'), 7)}|mark={_fmt(metrics.get('markPrice'), 7)}|index={_fmt(metrics.get('indexPrice'), 7)}|24h={_fmt_pct(metrics.get('change24hPct'))}|7d={_fmt_pct(metrics.get('return7dPct'))}|high24h={_fmt(metrics.get('high24h'), 7)}|low24h={_fmt(metrics.get('low24h'), 7)}|quoteVol={_fmt(metrics.get('quoteVolume24h'), 0)}",
        f"FUNDING|rate={_fmt_pct((finite(metrics.get('fundingRate')) or 0) * 100, 6)}|interval={metrics.get('fundingIntervalHours')}h|apr={_fmt_pct(metrics.get('fundingAprPct'), 2)}|percentile={_fmt(metrics.get('fundingPercentile'), 2)}|samples={metrics.get('fundingSamples')}",
        f"OI|currentContracts={_fmt(metrics.get('oiCurrent'), 0)}|currentValueUSD={_fmt(metrics.get('oiCurrentValue'), 2)}|24h={_fmt_pct(metrics.get('oi24hPct'))}|7d={_fmt_pct(metrics.get('oi7dPct'))}|samples={metrics.get('oiSamples')}",
        f"RSI|1hLive={_fmt(metrics.get('rsi1hLive'))}|1hClosed={_fmt(reversal.get('rsi1h'))}|4hLive={_fmt(metrics.get('rsi4hLive'))}|4hClosed={_fmt(reversal.get('rsi4h'))}|4hPeak7={_fmt(reversal.get('peakRsi4h'))}|1dLive={_fmt(metrics.get('dailyRsiLive'))}|1dClosed={_fmt(metrics.get('dailyRsiClosed'))}",
        f"STRUCTURE|1hBreak={bool(reversal.get('structureBreak1h'))}|4hBreak={bool(reversal.get('structureBreak4h'))}|1hCrossBelow80={bool(reversal.get('rsi1hCrossBelow80'))}|4hDeclining={bool(reversal.get('rsi4hDeclining'))}|bearDiv={bool(reversal.get('bearishDivergence'))}|reversalCount={reversal.get('reversalCount')}",
        f"LEVELS|next1hCloseTrigger={_fmt(triggers.get('trigger1h'), 7)}|next4hCloseTrigger={_fmt(triggers.get('trigger4h'), 7)}|recentHigh={_fmt(reversal.get('recentHigh'), 7)}|invalidation={_fmt(reversal.get('invalidationPrice'), 7)}|invalidationDistance={_fmt_pct(reversal.get('invalidationDistancePct'))}",
        f"DATA|errors={'NONE' if not errors else '; '.join(errors)}|action={'NONE' if not errors else '不调仓、不新增仓位、不执行交易'}|sourceDates={','.join(metrics.get('sourceDates') or [])}",
    ]
    market = metrics.get("market") or {}
    if market:
        btc = market.get("btc") or {}
        eth = market.get("eth") or {}
        breadth = market.get("breadth") or {}
        lines.append(
            f"MARKET|generatedAt={market.get('generatedAt')}|BTC24h={_fmt_pct(btc.get('change24hPct'))}|ETH24h={_fmt_pct(eth.get('change24hPct'))}|altMedian24h={_fmt_pct(breadth.get('median24hPct'))}|altPositive={_fmt_pct(breadth.get('positivePct'), 1)}|n={breadth.get('n')}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--detail", action="store_true", help="print a readable fresh snapshot")
    mode.add_argument("--state", action="store_true", help="print deterministic Cron state signature")
    args = parser.parse_args(argv)
    detail = bool(args.detail or not args.state)
    try:
        metrics = scan_live(include_market=True)
        if detail:
            print(format_detail(metrics))
        else:
            print(state_signature(metrics))
        return 0
    except Exception as error:  # noqa: BLE001 - top-level safety fallback
        if detail:
            print(
                "\n".join(
                    [
                        f"[UAIUSDT MONITOR] snapshotUTC={datetime.now(timezone.utc).isoformat(timespec='seconds')} source=Binance-Futures",
                        f"STATUS|DATA_ERROR|autoTrade=false|squeezeRisk=false",
                        f"DATA|errors=top-level: {error}|action=不调仓、不新增仓位、不执行交易",
                    ]
                )
            )
        else:
            print("UAI_STATE|state=DATA_ERROR|funding=UNKNOWN|break1h=0|break4h=0|rsi1hCross=0|rsi4hDecl=0|bearDiv=0|squeeze=0|trigger1h=NA|trigger4h=NA|invalidation=NA|data=ERROR")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
