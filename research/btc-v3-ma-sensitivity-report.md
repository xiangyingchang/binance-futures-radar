# BTC V3.1 均线敏感性测试

研究分支：research/v3-ma-sensitivity；研究版本：btc-v3.1-ma-sensitivity-1

## 结论

- 短期均线分类：15_30_preferred
- 长期均线分类：SMA200_preferred
- 这不是参数寻优：短期只比较 EMA15/30、EMA20/60、EMA20/50、EMA10/30；长期只比较 SMA200 与 EMA200，未继续扩大搜索。

分类按事先声明的门槛判断：OOS 至少两个主要结果指标达到 materiality，且不能同时恶化 BTC/USD 两种 max drawdown，并需要至少一个历史窗口方向支持；否则为 inconclusive 或 no_material_difference。

## 数据与冻结边界

- 生成时间：2026-08-23T06:16:32.358Z
- API host：https://www.binance.com；使用官方 /dapi/v1 路径。信号：Binance COIN-M BTCUSD Index Price 完整日线；执行：BTCUSD_PERP continuous perpetual 日线；Funding：BTCUSD_PERP funding history；Funding mark 只取在 funding timestamp 前已闭合的 4H mark candle。
- 数据范围：2020-08-11 至 2026-08-22；index 2203 根、execution 2203 根、mark 13212 根、funding 6607 条。
- 输入数据 SHA-256：c574756da90672f47fd7d6f8082584e2aa23d8df692ce8f9543fda8b0b07b98e
- 执行时序：T-1 已闭合 signal → T 开盘调仓；当前日 OHLC 不进入当天开盘选择；逆向 COIN-M PnL、整数合约、5 bps fee、5 bps adverse slippage、实际 funding、10% 静态维护率 stress 全部冻结。
- EMA200 对照只替换 Trend Score 的 price > 200MA 与 200MA 30D slope；估值层的 365D drawdown、SMA200 deviation、RV30、Bear Lock 规则和所有执行参数保持冻结。
- 基准 parity：PASS；未修改 lib/btc-v3-strategy.js 或生产 V3.1 策略。

## Full Sample

| 组合 | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | turnover BTC | trades | score/regime switches | Bear Lock days | avg exposure |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/30 + SMA200 | 1.9967 | 12.14% | 53.07% | -34.04% | -53.60% | 48.58 | 969 | 109/92 | 595 | 0.747x |
| EMA20/60 + SMA200 | 1.8462 | 10.69% | 51.09% | -35.74% | -53.85% | 46.61 | 1045 | 82/75 | 595 | 0.755x |
| EMA20/50 + SMA200 | 1.8441 | 10.67% | 51.06% | -35.81% | -53.85% | 46.25 | 1034 | 86/75 | 595 | 0.754x |
| EMA10/30 + SMA200 | 2.1011 | 13.09% | 54.36% | -33.76% | -53.23% | 50.20 | 965 | 113/92 | 595 | 0.745x |

长期均线单独比较（短期固定 EMA15/30）：

| 组合 | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | turnover BTC | trades | score/regime switches | Bear Lock days | avg exposure |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/30 + SMA200 | 1.9967 | 12.14% | 53.07% | -34.04% | -53.60% | 48.58 | 969 | 109/92 | 595 | 0.747x |
| EMA15/30 + EMA200 | 2.0338 | 12.48% | 53.53% | -42.21% | -53.23% | 78.82 | 951 | 128/106 | 704 | 0.714x |

ending BTC 是同一笔从 1 BTC 开始的连续账户在窗口末的 BTC NAV；窗口 CAGR 从窗口起点 NAV 到窗口末 NAV 计算。turnover BTC 是实际成交合约名义量按执行开盘价折算的 BTC 总量。

## 2020-2023

| 组合 | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | turnover BTC | trades | score switches | regime switches | Bear Lock days | avg exposure |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/30 + SMA200 | 1.5848 | 14.54% | 66.96% | -34.04% | -53.60% | 17.99 | 405 | 45 | 38 | 322 | 0.744x |
| EMA20/60 + SMA200 | 1.5630 | 14.07% | 66.28% | -33.74% | -53.85% | 18.44 | 423 | 36 | 31 | 322 | 0.749x |
| EMA20/50 + SMA200 | 1.5956 | 14.77% | 67.29% | -33.74% | -53.85% | 17.76 | 431 | 38 | 31 | 322 | 0.749x |
| EMA10/30 + SMA200 | 1.6415 | 15.73% | 68.70% | -33.76% | -53.23% | 18.13 | 411 | 47 | 38 | 322 | 0.743x |

| 组合 | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | turnover BTC | trades | score switches | regime switches | Bear Lock days | avg exposure |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/30 + SMA200 | 1.5848 | 14.54% | 66.96% | -34.04% | -53.60% | 17.99 | 405 | 45 | 38 | 322 | 0.744x |
| EMA15/30 + EMA200 | 1.6669 | 16.26% | 69.46% | -37.29% | -53.23% | 35.76 | 389 | 53 | 42 | 395 | 0.698x |

## 2024-2026 OOS

| 组合 | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | turnover BTC | trades | score switches | regime switches | Bear Lock days | avg exposure |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/30 + SMA200 | 1.9967 | 9.14% | 36.93% | -23.61% | -31.99% | 30.59 | 564 | 64 | 54 | 273 | 0.750x |
| EMA20/60 + SMA200 | 1.8462 | 6.50% | 33.63% | -25.04% | -33.63% | 28.17 | 622 | 46 | 44 | 273 | 0.763x |
| EMA20/50 + SMA200 | 1.8441 | 5.63% | 32.53% | -26.53% | -33.80% | 28.49 | 603 | 48 | 44 | 273 | 0.760x |
| EMA10/30 + SMA200 | 2.1011 | 9.79% | 37.75% | -23.62% | -32.23% | 32.07 | 554 | 66 | 54 | 273 | 0.748x |

| 组合 | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | turnover BTC | trades | score switches | regime switches | Bear Lock days | avg exposure |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/30 + SMA200 | 1.9967 | 9.14% | 36.93% | -23.61% | -31.99% | 30.59 | 564 | 64 | 54 | 273 | 0.750x |
| EMA15/30 + EMA200 | 2.0338 | 7.82% | 35.28% | -24.72% | -34.23% | 43.06 | 562 | 75 | 64 | 309 | 0.734x |

## 收益差异归因

### 短期均线：EMA15/30 vs EMA20/60

OOS BTC CAGR -2.63pp、USD CAGR -3.30pp、USD max DD -1.64pp；主要可观测差异是更少18 次短期交叉、30 日内反向 whipsaw 减少18 次、平均目标敞口 增加 0.012x、实际换手 BTC 名义量 减少 7.9%、Trend 3 日平均敞口 增加 0.005x、Trend 3 天数 增加 71 天。对照组合为 EMA15/30 + SMA200，测试组合为 EMA20/60 + SMA200。

EMA20/50 与 EMA10/30 是预先限定的控制组合，仅用于识别更慢/更快的方向是否稳定，不参与最终分类：

OOS BTC CAGR -3.51pp、USD CAGR -4.40pp、USD max DD -1.81pp；主要可观测差异是更少16 次短期交叉、30 日内反向 whipsaw 减少16 次、平均目标敞口 增加 0.009x、实际换手 BTC 名义量 减少 6.9%、Trend 3 日平均敞口 增加 0.003x、Trend 3 天数 增加 53 天。对照组合为 EMA15/30 + SMA200，测试组合为 EMA20/50 + SMA200。

OOS BTC CAGR +0.66pp、USD CAGR +0.82pp、USD max DD -0.24pp；主要可观测差异是更多2 次短期交叉、30 日内反向 whipsaw 增加2 次、平均目标敞口 减少 0.002x、实际换手 BTC 名义量 增加 4.8%、Trend 3 日平均敞口 减少 0.002x、Trend 3 天数 减少 11 天。对照组合为 EMA15/30 + SMA200，测试组合为 EMA10/30 + SMA200。

### 长期均线：SMA200 vs EMA200

OOS BTC CAGR -1.32pp、USD CAGR -1.65pp、USD max DD -2.25pp；主要可观测差异是更少0 次短期交叉、30 日内反向 whipsaw 减少0 次、平均目标敞口 减少 0.016x、实际换手 BTC 名义量 增加 40.8%、Trend 3 日平均敞口 增加 0.008x、Trend 3 天数 增加 33 天。对照组合为 EMA15/30 + SMA200，测试组合为 EMA15/30 + EMA200。

解释口径：交叉次数和 30 日内反向交叉用于反应速度与 whipsaw；平均敞口用于隔离持仓更多带来的收益差异；实际 turnover/trade count 用于交易成本与执行扰动；Trend 3 日数及其平均敞口用于观察大趋势捕获。以上均为回测后的描述性分析，没有回写信号或参数。

## 限制

- 这仍是研究回测，不是生产策略变更，也不构成实盘授权。
- 历史维护率层级无法逐时重建，沿用 V3.1 的 10% 静态 stress；若出现 liquidation，窗口结果会标记为失败而不会把缺失收益当成 0。
- 2024-2026 OOS 是按固定组合直接评估的留出窗口；不允许根据 OOS 结果继续调整 EMA/MA 参数。

结果 JSON：research/btc-v3-ma-sensitivity-result.json
