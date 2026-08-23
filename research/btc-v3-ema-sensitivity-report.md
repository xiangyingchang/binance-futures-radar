# BTC V3.1 EMA 参数敏感性测试

> Research-only。没有修改 main、V3 生产策略或生产环境；参数敏感性不是参数优化。

## 结论

**inconclusive**

结果没有形成足够清晰且同向的 OOS 优势，不能据此更换当前 EMA 参数。

- OOS window: **2024-01-01 至 2026-07-31**。
- OOS winner by ending BTC: **ema10_30**；by BTC CAGR: **ema10_30**。
- OOS ending-BTC spread: **0.101159 BTC**；CAGR spread: **3.31%**。
- 直接比较当前 baseline 与 EMA20/60：15/30 的 OOS ending BTC 高 **0.051860 BTC**、BTC CAGR 高 **1.70%**；但 EMA20/60 的 whipsaw 明显更少。由于 EMA10/30 在 OOS 反而排名第一，严格分类仍为 **inconclusive**，不据此改生产参数。
- 判定规则：Preferred requires the same candidate to lead OOS ending BTC and BTC CAGR with a material margin; if the spread is immaterial, classify no_material_difference; otherwise classify inconclusive. A winner among the unapproved EMA20/50 or EMA10/30 variants cannot be promoted to a preferred label.

## 冻结边界

| 参数 | 处理 |
|---|---|
| EMA fast/slow | 仅测试 15/30、20/60、20/50、10/30 |
| MA200 / slope | 200D / 30D |
| Valuation | trailing drawdown lookback 365D; cheap -20.00% / MA deviation -10.00%; very cheap -35.00% / -20.00% |
| Volatility / margin | RV30; target annual vol 60.00%; margin cap 1.5x |
| Execution costs | fee 5 bps; slippage 5 bps; maintenance stress 10.00% |

EMA15/EMA30 是当前 V3.1 baseline。除 EMA fast/slow 外，所有信号门槛、估值、RV30、margin cap、fee、slippage、Funding 处理和执行时点均保持一致；没有根据 OOS 结果继续调 EMA。

## 回测数据与执行模型

- 数据：Binance Vision 官方 COIN-M 月档；Index daily、BTCUSD_PERP execution daily、BTCUSD_PERP mark 4H、官方 fundingRate。Index partial months: **2023-08**；execution partial months: **2023-08, 2026-06**；mark partial months: **2023-08**。
- 执行：T-1 fully closed Index daily close 产生信号，T 日永续开盘立即调仓；逆向 COIN-M PnL、整数合约、5 bps fee、5 bps adverse slippage。
- Funding：只记官方可取得的真实记录；存在缺口，缺失事件没有补成 0；因此绝对收益带有 partial-Funding 限制。
- 三段指标分别以 1 BTC、空头寸开始；OOS 的指标 warm-up 使用 2024-01-01 之前已关闭的历史 close，但不把 IS 资本或仓位带入 OOS。
- 未来函数：信号只使用当前执行日开盘前已关闭的 Index daily close；当前日 OHLC 仅用于执行、Funding mark 和维护保证金压力测试。
- 同一持仓的 mark-to-market 按价格事件顺序只结算一次；成交只改变仓位并记 fee/slippage，不重复结算同一段价格。

### Full sample

| EMA | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | avg/max exposure | turnover USD | fees BTC | funding PnL BTC | slippage cost BTC | trades | trendScore switches | Bear Lock episodes/days |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/EMA30 | 2.091693 | 13.15% | 49.70% | -34.67% | -54.13% | 0.753 / 1.542 | 2814100 | 0.022677 | 0.010338 | 0.022677 | 955 | 105 | 4 / 575 |
| EMA20/EMA60 | 2.034069 | 12.62% | 49.01% | -35.55% | -53.45% | 0.761 / 1.543 | 2682300 | 0.022568 | 0.005253 | 0.022568 | 1037 | 82 | 4 / 575 |
| EMA20/EMA50 | 1.951475 | 11.84% | 47.98% | -36.79% | -54.37% | 0.760 / 1.542 | 2585900 | 0.021779 | 0.005636 | 0.021779 | 1010 | 86 | 4 / 575 |
| EMA10/EMA30 | 2.201037 | 14.11% | 50.99% | -34.27% | -53.58% | 0.751 / 1.542 | 2926400 | 0.023427 | 0.012073 | 0.023427 | 949 | 110 | 4 / 575 |

### 2020–2023

| EMA | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | avg/max exposure | turnover USD | fees BTC | funding PnL BTC | slippage cost BTC | trades | trendScore switches | Bear Lock episodes/days |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/EMA30 | 1.557214 | 13.95% | 66.10% | -34.67% | -54.13% | 0.744 / 1.542 | 594400 | 0.008886 | -0.001649 | 0.008886 | 409 | 45 | 2 / 322 |
| EMA20/EMA60 | 1.574720 | 14.33% | 66.64% | -34.35% | -53.45% | 0.748 / 1.543 | 637200 | 0.009551 | -0.002022 | 0.009551 | 433 | 38 | 2 / 322 |
| EMA20/EMA50 | 1.544005 | 13.66% | 65.68% | -34.34% | -54.37% | 0.748 / 1.542 | 606300 | 0.009116 | -0.001792 | 0.009116 | 432 | 40 | 2 / 322 |
| EMA10/EMA30 | 1.612993 | 15.14% | 67.83% | -34.27% | -53.58% | 0.742 / 1.542 | 598200 | 0.008967 | -0.001418 | 0.008967 | 407 | 48 | 2 / 322 |

### 2024–2026 OOS

| EMA | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | avg/max exposure | turnover USD | fees BTC | funding PnL BTC | slippage cost BTC | trades | trendScore switches | Bear Lock episodes/days |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA15/EMA30 | 1.342993 | 12.09% | 30.61% | -23.63% | -31.99% | 0.765 / 1.276 | 1436900 | 0.008983 | 0.007789 | 0.008983 | 514 | 60 | 2 / 253 |
| EMA20/EMA60 | 1.291133 | 10.40% | 28.63% | -25.03% | -33.63% | 0.778 / 1.276 | 1308300 | 0.008381 | 0.004711 | 0.008381 | 567 | 44 | 2 / 253 |
| EMA20/EMA50 | 1.263754 | 9.48% | 27.57% | -26.50% | -33.79% | 0.775 / 1.276 | 1291400 | 0.008319 | 0.004907 | 0.008319 | 544 | 46 | 2 / 253 |
| EMA10/EMA30 | 1.364913 | 12.80% | 31.43% | -23.62% | -32.23% | 0.763 / 1.276 | 1452500 | 0.009076 | 0.008462 | 0.009076 | 499 | 62 | 2 / 253 |

## EMA20/60 是否减少 whipsaw

- OOS EMA 状态切换：15/30 **30** 次，20/60 **15** 次，变化 **-15** 次（50.00%）。
- OOS 短状态 whipsaw episode：15/30 **17**，20/60 **7**，变化 **-10**（58.82%）。
- 预先定义的“明显减少”标准是两项都至少减少 20%；本次结果：**达到**。

## 更慢是否错过大趋势

- 诊断定义：未来 30D Index close return 至少 +20%，而当日 EMA fast 不高于 EMA slow；这是事后诊断，不参与交易。
- OOS missed-big-trend days：15/30 **30**，20/60 **16**，变化 **-14**；episodes 变化 **-1**。
- 结论：EMA20/60 **没有显示出更多错过大趋势的迹象**。

## 15/30 的额外收益是否只是更高换手或 exposure

相对 EMA20/60 的 OOS accounting context：

| 项目 | 15/30 - 20/60 |
|---|---:|
| ending BTC | 0.051860 |
| BTC CAGR | 1.70% |
| average exposure | -0.0132 |
| turnover USD | 128600 |
| trade count | -53 |
| fee cost BTC | 0.000602 |
| slippage cost BTC | 0.000602 |
| funding PnL BTC | 0.003078 |

这些是并行记账差异，不能机械相加为 ending-BTC 差异：逆向合约 PnL、整数合约、Funding、成本和仓位会复利耦合。若 15/30 的优势同时伴随更高 average exposure / turnover，只能说收益与更积极执行相伴，不能声称优势来自 EMA 本身的纯信号质量。

## 数据限制与交付

- Funding OOS status: **partial**；available 2676 / expected 2829 events，coverage 94.59%，missing slots 153。
- 官方月档存在的日线 partial gap 会保留可用行并单独列出，不会被静默补齐；execution gaps: 2023-08 trailing_gap 2023-08-28T00:00:00.000Z, 2023-08-29T00:00:00.000Z, 2023-08-30T00:00:00.000Z, 2023-08-31T00:00:00.000Z; 2026-06 internal_gap_172800000ms 2026-06-29T00:00:00.000Z。这些 gaps 不改变执行模型，但会造成对应日期缺测。
- Funding archive gaps: 2026-07；已存在月档中的规律性缺口以 missing slot count 单独统计。
- 研究分支只新增敏感性测试脚本、测试和结果；未修改生产 lib/btc-v3-strategy.js。
- 结果 JSON：research/btc-v3-ema-sensitivity-result.json
- 本报告：research/btc-v3-ema-sensitivity-report.md
