#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BTC Smart DCA V3 每周定投提醒（Hermes cron no-agent 专用）
- 数据源：ahr999.aix4u.com 开源日度数据集（与 Ledger 估值页首选源一致）
- 现价：Kraken 实时 ticker（与 Ledger getBtcSpotPrice 首选源一致），CoinGecko 兜底
- 敞口层：V3 每日复盘 API（canonical 目标敞口与合约操作）+ 生产信号趋势分明细 + AHR999 深水区 override
- 输出本周操作金额与弹药池流向；stdout 非空即投递飞书，空则静默
"""

import json
import time
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

AHR999_URL = "https://ahr999.aix4u.com/datasets/ahr999.json"
KRAKEN_TICKER_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD"
COINGECKO_URL = ("https://api.coingecko.com/api/v3/simple/price"
                 "?ids=bitcoin&vs_currencies=usd&include_24hr_change=true")
V3_DAILY_URL = "https://binance-futures-radar.vercel.app/api/btc-v3-daily-analysis"
V3_SIGNAL_URL = "https://binance-futures-radar.vercel.app/api/btc-v3"

PROXY_URL = "http://127.0.0.1:7897"
# Cron 环境可能继承 HTTPS_PROXY/ALL_PROXY；direct 需要空映射绕过
TRANSPORTS = (("Clash proxy", PROXY_URL, 2), ("direct", None, 1))
ATTEMPT_TIMEOUT = 10
RETRY_DELAYS = (0.5, 1.5)
MAX_AGE_DAYS = 3  # 对齐 Ledger MAX_AHR999_DATA_AGE_DAYS

BASE_WEEKLY_USDT = 700
BANDS = (
    (0.45, "低估加速", "<0.45", 2.00, 1400),
    (0.80, "偏低加量", "0.45–0.80", 1.75, 1225),
    (1.20, "正常定投", "0.80–1.20", 1.00, 700),
    (2.00, "偏高减速", "1.20–2.00", 0.60, 420),
    (3.00, "高温保守", "2.00–3.00", 0.30, 210),
    (float("inf"), "极端高温", "≥3.00", 0.20, 140),
)

# 三层体系参数（V4 修订：Bear Lock 二元 + override 1.5x + 确认门 + kill switch）
OVERRIDE_ENTRY = 0.40   # AHR999 < 0.40 进入深水区 override
OVERRIDE_EXIT = 0.45    # AHR999 >= 0.45 交还非深水区模式
OVERRIDE_LEV = 1.5      # V4：深水区杠杆上限（E2 压力测试定档，原 V3 为 2.0x）
CONFIRM_GATE_DD = -0.20 # V4 确认门：365D 回撤 <= -20% 才允许 override
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")

UA = {
    "User-Agent": "btc-dca-reminder/1.0",
    "Accept": "application/json",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}


def fetch(url, timeout, proxy_url):
    proxy_handler = urllib.request.ProxyHandler(
        {} if proxy_url is None else {"http": proxy_url, "https": proxy_url}
    )
    opener = urllib.request.build_opener(proxy_handler)
    req = urllib.request.Request(url, headers=UA)
    with opener.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get(url, timeout):
    failures = []
    for label, proxy_url, attempts in TRANSPORTS:
        for attempt in range(attempts):
            try:
                return fetch(url, min(timeout, ATTEMPT_TIMEOUT), proxy_url)
            except Exception as exc:  # noqa: BLE001
                failures.append(f"{label} attempt {attempt + 1}: {exc}")
                if attempt + 1 < attempts:
                    time.sleep(RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)])
    raise RuntimeError("; ".join(failures) or "fetch failed")


def latest_ahr999():
    rows = get(AHR999_URL, 30)
    if not isinstance(rows, list):
        raise RuntimeError("dataset is not a list")
    valid = [r for r in rows
             if isinstance(r, dict)
             and isinstance(r.get("date"), str)
             and isinstance(r.get("ahr999"), (int, float))]
    if not valid:
        raise RuntimeError("no valid ahr999 rows")
    return valid[-1]


def spot_price():
    """Kraken 首选，CoinGecko 兜底；都失败返回 (None, None)。"""
    try:
        payload = get(KRAKEN_TICKER_URL, 20)
        result = payload.get("result") or {}
        pair = next((v for k, v in result.items()
                     if k != "last" and isinstance(v, dict)), None)
        price = float(pair["c"][0]) if pair and pair.get("c") else None
        if price and price > 0:
            return price, "Kraken"
    except Exception:  # noqa: BLE001
        pass
    try:
        payload = get(COINGECKO_URL, 20)
        price = float(payload["bitcoin"]["usd"])
        if price > 0:
            return price, "CoinGecko"
    except Exception:  # noqa: BLE001
        pass
    return None, None


def v3_daily():
    """V3 每日复盘 canonical 快照（每日 10:10 复盘任务写入，Vercel API 代理）。

    提供目标敞口与合约操作指导；status 非 ok 或关键字段缺失返回 None（降级，不猜）。
    """
    payload = get(V3_DAILY_URL, 20)
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        return None
    target = payload.get("targetExposure")
    guidance = payload.get("marketGuidance")
    candle = str(payload.get("candleDate") or "").strip()
    if (isinstance(target, bool) or not isinstance(target, (int, float))
            or not isinstance(guidance, str) or not guidance.strip() or not candle):
        return None
    return {
        "target": float(target),
        "guidance": guidance.strip(),
        "candle": candle,
        "label": str(payload.get("label") or "").strip(),
    }


def v3_signal():
    """生产 /api/btc-v3 信号快照，用于趋势分明细与复盘新鲜度交叉核对。"""
    payload = get(V3_SIGNAL_URL, 20)
    sig = payload.get("signal") if isinstance(payload, dict) else None
    if not isinstance(sig, dict) or sig.get("ready") is not True:
        return None
    score = sig.get("trendScore")
    target = sig.get("finalTarget")
    ma200 = sig.get("ma200")
    slope = sig.get("ma200Slope30")
    dd = sig.get("drawdown365")
    numeric_fields = [v for v in (score, target, ma200, slope) if v is not None]
    if any(isinstance(v, bool) or not isinstance(v, (int, float))
           for v in numeric_fields):
        return None
    candle = ""
    latest = payload.get("latestClosedCandle")
    if isinstance(latest, dict):
        candle = str(latest.get("openTimeIso") or "")[:10]
    return {
        "score": int(score),
        "bear_lock": bool(sig.get("bearLock")),
        "ma200": float(ma200),
        "slope": float(slope),
        "target": float(target),
        "candle": candle,
        "drawdown365": (float(dd) if isinstance(dd, (int, float))
                        and not isinstance(dd, bool) else None),
    }


def band_for(value):
    for max_exclusive, tier, rng, mult, weekly in BANDS:
        if value < max_exclusive:
            return tier, rng, mult, weekly
    return BANDS[-1][1], BANDS[-1][2], BANDS[-1][3], BANDS[-1][4]


def fmt_usd(v):
    return f"${v:,.0f}"


def fmt_usdt(v):
    return f"{v:,.0f} USDT"


def is_sunday_calibration_day():
    """V4 合约周日校准日；周五周报只执行第一层现货 DCA。"""
    return datetime.now(SHANGHAI_TZ).weekday() == 6


def main():
    record = latest_ahr999()
    ahr = float(record["ahr999"])
    tier, rng, mult, weekly = band_for(ahr)

    data_date = record["date"]
    data_ts = datetime.strptime(data_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    age_days = (datetime.now(timezone.utc) - data_ts).days
    stale = age_days > MAX_AGE_DAYS

    price, spot_src = spot_price()
    ma200 = record.get("ma200")
    close = record.get("close")
    sunday_calibration = is_sunday_calibration_day()

    exposure_lines = []
    try:
        v3 = v3_daily()
    except Exception:
        v3 = None
    try:
        sig = v3_signal()
    except Exception:
        sig = None
    if v3 is not None:
        # V4 确认门：dd365 <= -20% 才允许 override；数据缺失视为未满足，不猜。
        # bearLock 不是确认门的等价条件，不能替代回撤确认。
        dd365 = sig.get("drawdown365") if sig is not None else None
        gate_ok = dd365 is not None and dd365 <= CONFIRM_GATE_DD
        override_active = ahr < OVERRIDE_ENTRY and gate_ok
        exposure_lines.append("")
        if ahr < OVERRIDE_ENTRY and dd365 is None:
            exposure_lines.append("敞口层: 深水区，但确认门数据缺失（V4）")
            exposure_lines.append(f"├─ AHR999 {ahr:.4f} < {OVERRIDE_ENTRY}，但 365D 回撤数据缺失")
            exposure_lines.append("├─ 确认门无法判定，本周不调仓，维持第二层 Bear Lock 判断")
            exposure_lines.append(f"└─ V4 目标 {OVERRIDE_LEV:.2f}x 不生效，等待数据恢复后周日校准")
        elif override_active:
            exposure_lines.append("敞口层: 深水区 override 接管（V4）")
            dd_txt = f"{dd365 * 100:+.1f}%" if dd365 is not None else "缺失"
            exposure_lines.append(f"├─ 确认门: 已满足（365D 回撤 {dd_txt} <= -20%）")
            exposure_lines.append(f"├─ AHR999 {ahr:.4f} < {OVERRIDE_ENTRY}，override 接管")
            exposure_lines.append(f"├─ V4 目标 {OVERRIDE_LEV:.2f}x（原 V3 为 2.00x，降档）")
            exposure_lines.append(f"├─ V3 趋势目标 {v3['target']:.2f}x（override 期间暂停，仅参考）")
            if sunday_calibration:
                exposure_lines.append(f"└─ 合约操作: 人工将总敞口调至 {OVERRIDE_LEV:.2f}x（张数按每日复盘权益快照换算）")
            else:
                exposure_lines.append("└─ V4 合约操作: HOLD（周日校准；本次仅执行现货定投）")
        else:
            if ahr < OVERRIDE_ENTRY and not gate_ok:
                dd_txt = f"{dd365 * 100:+.1f}%" if dd365 is not None else "缺失"
                exposure_lines.append(f"敞口层: 深水区但确认门未满足（365D 回撤 {dd_txt} > -20%），override 不生效")
            else:
                exposure_lines.append("敞口层: 非深水区")
            if sig is not None:
                lock_txt = "，Bear Lock" if sig["bear_lock"] else ""
                v4_target = 0.0 if sig["bear_lock"] else 1.0
                exposure_lines.append(f"├─ 目标 {v4_target:.2f}x（V4 Bear Lock 二元开关{lock_txt}）")
                exposure_lines.append(f"├─ MA200 {fmt_usd(sig['ma200'])}，30日斜率 {sig['slope']*100:+.1f}%")
                if sig["candle"] and sig["candle"] != v3["candle"]:
                    exposure_lines.append(f"├─ ⚠️ V3 复盘（{v3['candle']}）与最新信号（{sig['candle']}）不同日，操作指导可能滞后")
            if v3["label"]:
                exposure_lines.append(f"├─ V3 复盘（{v3['candle']}）: {v3['label']}")
            if ahr < OVERRIDE_EXIT:
                exposure_lines.append(f"├─ AHR999 {ahr:.4f} 处于 0.40–0.45 滞后带（override 持仓中则维持 {OVERRIDE_LEV:.2f}x）")
            else:
                exposure_lines.append(f"├─ AHR999 {ahr:.4f} >= {OVERRIDE_EXIT}，非深水区模式")
            exposure_lines.append(f"├─ V3 趋势层目标 {v3['target']:.2f}x（仅参考，V4 不执行趋势阶梯）")
            if sig is not None:
                v4_target = 0.0 if sig["bear_lock"] else 1.0
                if sunday_calibration:
                    exposure_lines.append(f"└─ V4 合约操作: {'开等量空头对冲' if sig['bear_lock'] else '平掉合约仓位，纯现货 1.0x'}")
                else:
                    exposure_lines.append("└─ V4 合约操作: HOLD（周日校准；本次仅执行现货定投）")
    elif sig is not None:
        exposure_lines.append("")
        exposure_lines.append(f"敞口层: V3 复盘不可用，信号目标 {sig['target']:.2f}x（仅参考）")
        exposure_lines.append("└─ 合约操作: 本周不调仓，等待每日复盘恢复")
    else:
        exposure_lines.append("")
        exposure_lines.append("敞口层: V3 数据不可用，本周仅执行定投，敞口维持现状")

    lines = []
    lines.append("⚡ BTC 定投提醒（BTC Smart DCA V3）")
    lines.append("执行时间: 每周五 23:00（北京时间）")
    lines.append("")
    lines.append(f"AHR999: {ahr:.4f}（{tier}档 {rng}）")
    if price is not None:
        lines.append(f"BTC 现价: {fmt_usd(price)}（{spot_src} 实时）")
    elif close:
        lines.append(f"BTC 现价: {fmt_usd(float(close))}（{data_date} 收盘，实时价获取失败）")
    if ma200:
        lines.append(f"200日均线: {fmt_usd(float(ma200))}（{data_date}）")
    lines.append("")
    lines.append(f"本周操作: 投入 {fmt_usdt(weekly)}")
    flow = weekly - BASE_WEEKLY_USDT
    if flow > 0:
        lines.append(f"├─ 基础预算: {fmt_usdt(BASE_WEEKLY_USDT)}")
        lines.append(f"└─ 弹药池: 取出 {fmt_usdt(flow)} 补充")
    elif flow < 0:
        lines.append(f"├─ 基础预算: 投入 {fmt_usdt(weekly)}")
        lines.append(f"└─ 弹药池: 存入 {fmt_usdt(-flow)}")
    else:
        lines.append(f"└─ 基础预算: {fmt_usdt(BASE_WEEKLY_USDT)}（无弹药池流动）")
    lines.extend(exposure_lines)
    lines.append("")
    if stale:
        lines.append(f"⚠️ AHR999 数据已 {age_days} 天未更新（截至 {data_date}），档位可能滞后，建议核对后执行")
    else:
        lines.append(f"数据截至 {data_date}（{age_days} 天前收盘）")
    lines.append("策略: V4 修订版（2026-08-31 研究定稿）")
    lines.append("├─ 第一层: AHR999 六档定投，永不停投")
    lines.append("├─ 第二层: Bear Lock 二元开关（0.0x 对冲 / 1.0x 现货，原趋势阶梯已删除）")
    lines.append("└─ 第三层: 深水区 override 1.5x + 确认门 + 182 天 kill switch")

    print("\n".join(lines))


if __name__ == "__main__":
    main()
