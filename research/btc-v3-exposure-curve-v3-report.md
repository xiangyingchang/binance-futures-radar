# BTC V3 Exposure Curve V3 第三阶段验证

> Research-only. 本报告不修改 main、不修改 V3 生产策略、不部署生产环境。

## 最终判断

最终分类：**robust_crash_alpha**。

本阶段不调参，只把第二阶段冻结的 curve_mild / curve_aggressive 放进 crash-cluster 归因、真正的 leave-one-crash-out 重跑和年度切片。分类规则版本：**v3-fixed-rules-1**。

## Funding 覆盖

- OOS 请求窗口：**2024-01-01 至 2026-07-31**。
- 官方可用事件：**2676/2829**，覆盖率 **94.59%**，状态 **partial**；按 8 小时理论槽位仍缺 **153** 个事件。
- 来源：[Binance Public Data README](https://github.com/binance/binance-public-data)；[Binance Vision](https://data.binance.vision/)。
- 缺失 OOS 整月档案：**2026-07**；存在月档但仍有槽位缺口的月份：**2024-01, 2024-02, 2024-03, 2024-04, 2024-05, 2024-06, 2024-07, 2024-08, 2024-09, 2024-10, 2024-11, 2024-12, 2025-01, 2025-02, 2025-03, 2025-04, 2025-05, 2025-06, 2025-07, 2025-08, 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06**。
- 缺失事件没有补 0；缺失整月的官方月档返回 404，未发现对应 daily funding archive；COIN-M REST endpoint 在本环境返回 451。
- Observed archive pattern: each available OOS monthly CSV contains 8-hour funding rows through 00:00 on the last calendar day, but the expected last-day 08:00 and 16:00 slots are absent. No alternate source was available to fill these events.

## 数据和路径

- 延续 V2 的 **1H 优先** execution / mark 数据与 OHLC path；本次 execution interval = **1h**，partial months = **2023-08, 2026-06**。
- 1H 不完整时尝试 4H；本次 fallback months = **none**。未把 Daily OHLC 作为撮合源。
- Signal 仍是 T-1 fully closed BTCUSD Index daily close；crash cluster 以 BTCUSD_PERP execution daily path 为主、Index daily path 为补充；Funding mark 缺口仍只在 Funding event 上使用最近可用 execution OHLC 点。
- 单一事件序列 MTM 通过 V2 回归测试；没有额外的日开盘到收盘重复结算。

## OOS 主结果

| scenario | ending BTC | delta vs baseline | BTC CAGR | CAGR delta | BTC max DD | USD max DD | avg / max exposure |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline_immediate | 1.343329 | 0.000000 | 12.10% | 0.00% | -23.92% | -34.44% | 0.765 / 1.279 |
| curve_mild | 1.399910 | 0.056581 | 13.91% | 1.80% | -23.92% | -33.82% | 0.766 / 1.397 |
| curve_aggressive | 1.452256 | 0.108927 | 15.54% | 3.43% | -23.91% | -33.81% | 0.768 / 1.487 |

## 收益集中度

| scenario | maker fills | crash clusters | profitable | losing | cluster win rate | mean incremental BTC | median incremental BTC | top 1 share | top 3 share | top 5 share | top 10 share |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| curve_mild | 74 | 42 | 32 | 10 | 76.19% | 0.001450 | 0.000710 | 23.06% | 55.81% | 69.90% | 95.43% |
| curve_aggressive | 73 | 42 | 31 | 11 | 73.81% | 0.002863 | 0.001837 | 23.54% | 52.14% | 67.09% | 93.36% |

这里的 cluster 增量是“完整曲线重跑 ending BTC - 去掉该 cluster 后动态重跑 ending BTC”，不是从最终 PnL 里简单扣一笔；各 cluster 的 marginal contribution 因 compounding 不保证可加总。

## Leave-One-Crash-Out：动态重跑

| scenario | run | ending BTC | delta vs baseline | BTC CAGR | BTC max DD | USD max DD | avg / max exposure |
|---|---|---:|---:|---:|---:|---:|---:|
| curve_mild | full | 1.399910 | 0.056581 | 13.91% | -23.92% | -33.82% | 0.766 / 1.397 |
| curve_mild | top1 | 1.386861 | 0.043532 | 13.49% | -23.92% | -33.82% | 0.766 / 1.396 |
| curve_mild | top3 | 1.368333 | 0.025004 | 12.91% | -23.92% | -33.90% | 0.766 / 1.342 |
| curve_mild | top5 | 1.360362 | 0.017033 | 12.65% | -23.91% | -34.21% | 0.766 / 1.342 |
| curve_mild | top10 | 1.345913 | 0.002584 | 12.19% | -23.93% | -34.40% | 0.766 / 1.342 |
| curve_aggressive | full | 1.452256 | 0.108927 | 15.54% | -23.91% | -33.81% | 0.768 / 1.487 |
| curve_aggressive | top1 | 1.426614 | 0.083285 | 14.74% | -23.91% | -33.81% | 0.768 / 1.487 |
| curve_aggressive | top3 | 1.395466 | 0.052137 | 13.77% | -23.91% | -33.81% | 0.767 / 1.487 |
| curve_aggressive | top5 | 1.379171 | 0.035842 | 13.25% | -23.91% | -33.89% | 0.767 / 1.488 |
| curve_aggressive | top10 | 1.350564 | 0.007235 | 12.34% | -23.91% | -34.35% | 0.766 / 1.488 |

## 年度稳定性

| year | scenario | ending BTC | ending BTC delta | BTC CAGR | CAGR delta | BTC max DD | USD max DD |
|---|---|---:|---:|---:|---:|---:|---:|
| 2024 | baseline_immediate | 0.943051 | 0.000000 | -5.68% | 0.00% | -16.96% | -32.13% |
| 2024 | curve_mild | 0.967882 | 0.024831 | -3.20% | 2.48% | -15.88% | -32.31% |
| 2024 | curve_aggressive | 0.997999 | 0.054948 | -0.20% | 5.48% | -15.17% | -32.82% |
| 2025 | baseline_immediate | 1.010413 | 0.000000 | 1.04% | 0.00% | -8.38% | -33.88% |
| 2025 | curve_mild | 1.030355 | 0.019942 | 3.04% | 1.99% | -6.73% | -33.52% |
| 2025 | curve_aggressive | 1.041904 | 0.031491 | 4.19% | 3.15% | -6.76% | -33.80% |
| 2026 | baseline_immediate | 1.408621 | 0.000000 | 80.38% | 0.00% | -23.92% | -0.18% |
| 2026 | curve_mild | 1.402242 | -0.006380 | 78.97% | -1.40% | -23.92% | -0.86% |
| 2026 | curve_aggressive | 1.395446 | -0.013176 | 77.48% | -2.89% | -23.91% | -1.80% |

## 最差 5 个 crash cluster

| scenario | rank | cluster | start | end | fills | marginal ending BTC |
|---|---:|---|---|---|---:|---:|
| curve_mild | 42 | crash-2026-02-03 | 2026-02-03 | 2026-02-05 | 4 | -0.008511 |
| curve_mild | 41 | crash-2024-03-19 | 2024-03-19 | 2024-03-19 | 1 | -0.003016 |
| curve_mild | 40 | crash-2026-06-02 | 2026-06-02 | 2026-06-02 | 1 | -0.001330 |
| curve_mild | 39 | crash-2024-04-02 | 2024-04-02 | 2024-04-02 | 1 | -0.000858 |
| curve_mild | 38 | crash-2025-11-14 | 2025-11-14 | 2025-11-14 | 1 | -0.000428 |
| curve_aggressive | 42 | crash-2026-02-03 | 2026-02-03 | 2026-02-05 | 4 | -0.021128 |
| curve_aggressive | 41 | crash-2024-03-19 | 2024-03-19 | 2024-03-19 | 1 | -0.005936 |
| curve_aggressive | 40 | crash-2026-06-02 | 2026-06-02 | 2026-06-02 | 1 | -0.002617 |
| curve_aggressive | 39 | crash-2024-04-02 | 2024-04-02 | 2024-04-02 | 1 | -0.001800 |
| curve_aggressive | 38 | crash-2024-08-27 | 2024-08-27 | 2024-08-27 | 1 | -0.000728 |

## Fill-level 归因

完整的 curve_mild / curve_aggressive 实际 maker fill 明细见 [events CSV](./btc-v3-exposure-curve-v3-events.csv)。每行包含：V3 baseline target、threshold、limit/effective price、contracts、成交后 exposure、当日 close、1D/3D/7D return、lot BTC PnL、Funding、fee、slippage，以及同一 crash cluster 的连续多档标记。只覆盖空头而未新开 lot 的 maker fill 也会记录；其已实现持仓 PnL 由本次成交关闭的原始 lot segment 归因，成交本身的 fee/slippage 单独记录。

relativeBaselineIncrementalPnlBtc 是同一 fill 数量、同一日开盘 immediate taker entry 的局部 counterfactual（价格、fee、slippage）；它不是完整策略的 Shapley 分摊。完整策略的相对 baseline 结论以 cluster LOO 重跑为准。

## Funding / 成本敏感性

- baseline_immediate: with Funding delta = **0.000000 BTC**；without Funding delta = **0.000000 BTC**；Funding 对该场景 ending BTC 的直接影响 = **0.009012 BTC**。
- curve_mild: with Funding delta = **0.056581 BTC**；without Funding delta = **0.056312 BTC**；Funding 对该场景 ending BTC 的直接影响 = **0.009280 BTC**。
- curve_aggressive: with Funding delta = **0.108927 BTC**；without Funding delta = **0.109226 BTC**；Funding 对该场景 ending BTC 的直接影响 = **0.008713 BTC**。

## 最终分类依据

- curve_mild: **robust_crash_alpha**；positive years = 2/3；top-3 removal remaining delta = 0.025004；top-5 removal remaining delta = 0.017033；top-5 share = 69.90%。
- curve_aggressive: **robust_crash_alpha**；positive years = 2/3；top-3 removal remaining delta = 0.052137；top-5 removal remaining delta = 0.035842；top-5 share = 67.09%。

进入 V3.2 执行规则设计：**不可以**。The result is crash-concentrated rather than broad; keep it research-only.

- robust_broad：两个 curve 变体至少 2/3 年为正，去掉 Top 5 后仍为正，且 Top 5 贡献占总增量少于 50%。
- robust_crash_alpha：整体有效，去掉 Top 3 后仍有优势，但不满足 broad 条件，说明收益明显依赖少数 crash。
- fragile：去掉 Top 3 后优势消失，或 available-Funding 优势在不计 Funding 时消失。
- invalid：未来函数、路径/数据错位或重复 MTM 等验证失败。

## 边界

- Funding 仍是 partial，不能把本次分类说成“完整历史 Funding 已证明”。
- 1H OHLC 不能观察单根 bar 内真实 tick 顺序；固定 path model 只是可审计近似。
- 没有根据 cluster 结果修改阈值、bonus、费用或生产策略。
