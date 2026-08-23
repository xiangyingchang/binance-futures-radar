# BTC V3 Exposure Curve V4 第四阶段机制研究

> Research-only. 本报告不修改 main、不修改 V3 生产策略、不部署生产环境。

## 最终判断

最终分类：**weak_mechanism**。

Some fixed pre-crash splits show explanatory power in a subset of years or scenarios, but no common cross-year mechanism is established.

2026 失效的主要事前证据：

- 2026 crash 前 Trend Score 更低，长期/中期趋势组合更偏空。
- 2026 crash 前 Bear Lock 覆盖率更高，且基线目标 exposure 更低，Curve 成交主要发生在空头覆盖/减仓路径。
- 2026 crash 前 baseline target exposure 更低，说明失效发生在已有下行 regime，而非高 exposure 下的普通回撤。
- 2026 crash 前 MA200 30D slope 更弱。
- 2026 crash 前 RV30 反而更低，不能把失效归因于单纯的波动率上升。
- 2026 crash 前 7D return 更差，支持 continuation 而非单纯 panic reversal 的解释。
- 2026 crash 前相对 90D high 的回撤更深。

## 研究边界

- 仅复用第三阶段已经冻结的 curve_mild / curve_aggressive 结果和 cluster LOO marginal ending BTC；没有重新调 threshold、bonus、费用或撮合路径。
- 特征只使用 crash cluster 开始日前最后一个 fully closed BTCUSD Index daily close，以及该时间之前已覆盖的 Funding。
- 2024 只用于形成固定 hypothesis；2025、2026 不重新选规则或阈值。
- 42 个 OOS crash cluster 中，mild 覆盖 42 个 cluster、记录 74 次 maker fill；aggressive 覆盖 42 个 cluster、记录 73 次 maker fill。无填充 cluster 不被伪装成盈利或亏损。

## 数据路径和完整性

- 继续使用第三阶段 1H 优先 execution / mark 数据；本次 execution interval = **1h**，fallback months = **none**。
- Crash cluster 定义沿用第三阶段：BTCUSD_PERP execution daily 或 BTCUSD Index daily close-to-close / low-to-open 达到 -5%，最多允许一个非 crash 日间隔。
- Funding 只读官方已覆盖事件，状态 **partial**，覆盖率 **94.59%**（2676/2829）；缺口没有当作 0。

- 内部月度归档缺口：2024-01, 2024-02, 2024-03, 2024-04, 2024-05, 2024-06, 2024-07, 2024-08, 2024-09, 2024-10, 2024-11, 2024-12, 2025-01, 2025-02, 2025-03, 2025-04, 2025-05, 2025-06, 2025-07, 2025-08, 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06；这些月份每月缺少月末 08:00 / 16:00 两个 slot。
- OOS 整月缺口：2026-07；这些月份没有可用 Funding 事件，不能按 0 计入。
- 缺口原因：2026-07: HTTP 404 for the official COIN-M monthly fundingRate archive in this run; No official daily fundingRate archive was found for this symbol/path; COIN-M REST fundingRate endpoint returned HTTP 451 from this environment

## 盈亏 crash 特征对比

下面的 mean / median 是 cluster-level pre-crash feature；marginal ending BTC 的盈利/亏损标签来自第三阶段完整动态 LOO，不是简单扣最终 PnL。

### curve_mild

填充 cluster：42；maker fill：74；盈利：32；亏损：10。

| feature | profitable n / mean / median | losing n / mean / median | missing filled |
|---|---:|---:|---:|
| V3 Trend Score | 32 / 1.9375 / 2.0000 | 10 / 2.0000 / 2.5000 | 0 |
| Bear Lock | 32 / 0.1563 / 0.0000 | 10 / 0.2000 / 0.0000 | 0 |
| Baseline target exposure | 32 / 0.8585 / 1.0000 | 10 / 0.7806 / 0.8762 | 0 |
| Price vs MA200 | 32 / 0.1621 / 0.1443 | 10 / 0.2205 / 0.2463 | 0 |
| MA200 30D slope | 32 / 0.0504 / 0.0626 | 10 / 0.0557 / 0.0527 | 0 |
| EMA15 vs EMA30 | 32 / 0.0040 / -0.0026 | 10 / 0.0127 / 0.0041 | 0 |
| 365D drawdown | 32 / -0.1454 / -0.1138 | 10 / -0.1474 / -0.1079 | 0 |
| MA200 deviation | 32 / 0.1621 / 0.1443 | 10 / 0.2205 / 0.2463 | 0 |
| RV30 | 32 / 0.4633 / 0.4569 | 10 / 0.5315 / 0.5243 | 0 |
| Volatility cap | 32 / 1.3689 / 1.3132 | 10 / 1.2136 / 1.1594 | 0 |
| Crash前 7D return | 32 / 0.0058 / 0.0004 | 10 / 0.0095 / 0.0227 | 0 |
| Crash前 30D return | 32 / 0.0293 / -0.0015 | 10 / 0.0546 / -0.0254 | 0 |
| Crash前 7D realized vol | 32 / 0.4120 / 0.3619 | 10 / 0.5029 / 0.4724 | 0 |
| 连续 3 日下跌 | 32 / 0.1250 / 0.0000 | 10 / 0.1000 / 0.0000 | 0 |
| 连续 5 日下跌 | 32 / 0.0625 / 0.0000 | 10 / 0.0000 / 0.0000 | 0 |
| 连续 7 日下跌 | 32 / 0.0000 / 0.0000 | 10 / 0.0000 / 0.0000 | 0 |
| 距离 30D high 回撤 | 32 / -0.0796 / -0.0635 | 10 / -0.0799 / -0.0772 | 0 |
| 距离 90D high 回撤 | 32 / -0.1143 / -0.1109 | 10 / -0.1043 / -0.0958 | 0 |
| Funding last rate | 32 / 0.0001 / 0.0001 | 10 / 0.0001 / 0.0001 | 0 |
| Funding 7D mean | 32 / 0.0001 / 0.0001 | 10 / 0.0001 / 0.0001 | 0 |
| Funding 7D median | 32 / 0.0001 / 0.0001 | 10 / 0.0001 / 0.0001 | 0 |
| Funding positive share 7D | 32 / 0.8891 / 0.9048 | 10 / 0.8987 / 0.9762 | 0 |

## curve_mild 固定规则 walk-forward

| rule | 2024 preferred group | 2024 mean gap | 2025 | 2026 | held both |
|---|---|---:|---|---|---|
| Bear Lock on | none | n/a | not_testable | not_testable | no |
| Trend Score <= 1 | none | -0.0011 | not_testable | not_testable | no |
| MA200 slope < 0 | none | n/a | not_testable | not_testable | no |
| Baseline exposure >= 1.0 | condition | 0.0002 | direction_held | insufficient_sample | no |
| RV30 >= V3 target annual vol | other | -0.0002 | insufficient_sample | insufficient_sample | no |
| Price below MA200 | other | -0.0018 | direction_held | insufficient_sample | no |
| EMA15 below EMA30 | other | -0.0012 | direction_held | insufficient_sample | no |
| Crash前 7D return < 0 | other | -0.0004 | direction_held | insufficient_sample | no |
| Crash前 30D return < 0 | condition | 0.0007 | direction_failed | direction_failed | no |
| Crash前连续 3 日下跌 | none | n/a | not_testable | not_testable | no |
| Crash前连续 5 日下跌 | none | n/a | not_testable | not_testable | no |
| Crash前连续 7 日下跌 | none | n/a | not_testable | not_testable | no |
| 365D drawdown <= V3 cheap threshold | none | -0.0011 | not_testable | not_testable | no |

### curve_aggressive

填充 cluster：42；maker fill：73；盈利：31；亏损：11。

| feature | profitable n / mean / median | losing n / mean / median | missing filled |
|---|---:|---:|---:|
| V3 Trend Score | 31 / 1.9355 / 2.0000 | 11 / 2.0000 / 2.0000 | 0 |
| Bear Lock | 31 / 0.1613 / 0.0000 | 11 / 0.1818 / 0.0000 | 0 |
| Baseline target exposure | 31 / 0.8539 / 1.0000 | 11 / 0.8005 / 0.8853 | 0 |
| Price vs MA200 | 31 / 0.1596 / 0.1431 | 11 / 0.2223 / 0.2400 | 0 |
| MA200 30D slope | 31 / 0.0496 / 0.0616 | 11 / 0.0574 / 0.0599 | 0 |
| EMA15 vs EMA30 | 31 / 0.0042 / -0.0023 | 11 / 0.0113 / 0.0018 | 0 |
| 365D drawdown | 31 / -0.1463 / -0.1120 | 11 / -0.1446 / -0.1157 | 0 |
| MA200 deviation | 31 / 0.1596 / 0.1431 | 11 / 0.2223 / 0.2400 | 0 |
| RV30 | 31 / 0.4614 / 0.4534 | 11 / 0.5306 / 0.5211 | 0 |
| Volatility cap | 31 / 1.3760 / 1.3232 | 11 / 1.2080 / 1.1514 | 0 |
| Crash前 7D return | 31 / 0.0061 / 0.0012 | 11 / 0.0083 / -0.0033 | 0 |
| Crash前 30D return | 31 / 0.0320 / 0.0018 | 11 / 0.0445 / -0.0556 | 0 |
| Crash前 7D realized vol | 31 / 0.4143 / 0.3620 | 11 / 0.4882 / 0.3918 | 0 |
| 连续 3 日下跌 | 31 / 0.1290 / 0.0000 | 11 / 0.0909 / 0.0000 | 0 |
| 连续 5 日下跌 | 31 / 0.0645 / 0.0000 | 11 / 0.0000 / 0.0000 | 0 |
| 连续 7 日下跌 | 31 / 0.0000 / 0.0000 | 11 / 0.0000 / 0.0000 | 0 |
| 距离 30D high 回撤 | 31 / -0.0784 / -0.0563 | 11 / -0.0831 / -0.0792 | 0 |
| 距离 90D high 回撤 | 31 / -0.1143 / -0.1099 | 11 / -0.1053 / -0.1157 | 0 |
| Funding last rate | 31 / 0.0001 / 0.0001 | 11 / 0.0001 / 0.0001 | 0 |
| Funding 7D mean | 31 / 0.0001 / 0.0001 | 11 / 0.0001 / 0.0001 | 0 |
| Funding 7D median | 31 / 0.0001 / 0.0001 | 11 / 0.0001 / 0.0001 | 0 |
| Funding positive share 7D | 31 / 0.8855 / 0.9048 | 11 / 0.9080 / 1.0000 | 0 |

## curve_aggressive 固定规则 walk-forward

| rule | 2024 preferred group | 2024 mean gap | 2025 | 2026 | held both |
|---|---|---:|---|---|---|
| Bear Lock on | none | n/a | not_testable | not_testable | no |
| Trend Score <= 1 | none | -0.0022 | not_testable | not_testable | no |
| MA200 slope < 0 | none | n/a | not_testable | not_testable | no |
| Baseline exposure >= 1.0 | condition | 0.0001 | direction_held | insufficient_sample | no |
| RV30 >= V3 target annual vol | other | -0.0001 | insufficient_sample | insufficient_sample | no |
| Price below MA200 | other | -0.0037 | direction_held | insufficient_sample | no |
| EMA15 below EMA30 | other | -0.0030 | direction_held | insufficient_sample | no |
| Crash前 7D return < 0 | other | -0.0026 | direction_failed | insufficient_sample | no |
| Crash前 30D return < 0 | condition | 0.0017 | direction_held | direction_failed | no |
| Crash前连续 3 日下跌 | none | n/a | not_testable | not_testable | no |
| Crash前连续 5 日下跌 | none | n/a | not_testable | not_testable | no |
| Crash前连续 7 日下跌 | none | n/a | not_testable | not_testable | no |
| 365D drawdown <= V3 cheap threshold | none | -0.0022 | not_testable | not_testable | no |


## 2024 / 2025 / 2026 regime 对比

### curve_mild

| year | all clusters | filled | profitable | losing | Trend Score | Bear Lock rate | baseline exposure | price vs MA200 | MA200 slope | RV30 | pre 7D return | pre 30D return | 7D down rate | 30D high DD | 90D high DD |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2024 | 21 | 21 | 16 | 5 | 2.62 | 0.0% | 1.037 | 35.8% | 8.5% | 53.4% | 3.0% | 14.6% | 0.0% | -4.7% | -5.9% |
| 2025 | 14 | 14 | 11 | 3 | 1.86 | 0.0% | 0.964 | 8.4% | 4.8% | 43.3% | 0.1% | -5.6% | 0.0% | -8.9% | -13.8% |
| 2026 | 7 | 7 | 5 | 2 | 0.14 | 100.0% | 0.000 | -18.6% | -4.2% | 40.9% | -5.2% | -11.4% | 0.0% | -15.7% | -22.0% |

### curve_aggressive

| year | all clusters | filled | profitable | losing | Trend Score | Bear Lock rate | baseline exposure | price vs MA200 | MA200 slope | RV30 | pre 7D return | pre 30D return | 7D down rate | 30D high DD | 90D high DD |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2024 | 21 | 21 | 15 | 6 | 2.62 | 0.0% | 1.037 | 35.8% | 8.5% | 53.4% | 3.0% | 14.6% | 0.0% | -4.7% | -5.9% |
| 2025 | 14 | 14 | 11 | 3 | 1.86 | 0.0% | 0.964 | 8.4% | 4.8% | 43.3% | 0.1% | -5.6% | 0.0% | -8.9% | -13.8% |
| 2026 | 7 | 7 | 5 | 2 | 0.14 | 100.0% | 0.000 | -18.6% | -4.2% | 40.9% | -5.2% | -11.4% | 0.0% | -15.7% | -22.0% |


## 固定候选规则与 walk-forward

候选规则和阈值在运行前固定：Bear Lock on；Trend Score <= 1；MA200 slope < 0；baseline exposure >= 1.0；RV30 >= 0.60（V3 target annual vol）；以及价格/EMA/先行收益/连续下跌/365D drawdown 的符号或 V3 cheap threshold。2024 中每条规则只选择 condition / other 中 mean incremental BTC 较高者作为 hypothesis；该组在 2025 和 2026 原样验证。

- curve_mild stable rules: none
- curve_aggressive stable rules: none

## 结论解释

部分特征对某一年或某个 curve 有解释力，但跨年份不稳定，不能据此设计执行过滤器。

建议：**继续历史研究与独立 Forward Test 并行；不得直接转入 V3.2 执行规则**。

## 输出

- 每个 cluster / scenario 的完整特征、Outcome 和 Funding coverage：research/btc-v3-exposure-curve-v4-clusters.csv
- 结构化结果和全部分布：research/btc-v3-exposure-curve-v4-result.json
