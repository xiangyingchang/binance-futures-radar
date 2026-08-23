# BTC V3 Exposure Curve V2 第二阶段回测

> Research-only. 本报告不修改 main、不修改 V3 生产策略、不部署生产环境。

## 结论

在官方可取得的真实 funding records 上，Exposure Curve 经得住第二阶段的阈值稳健性检验：所有阈值组的 mild/aggressive 变体都在样本外同时超过 baseline；但 funding coverage 不完整，因此这不是全数据、生产级的最终确认。

- Robustness classification: **robust**
- Data qualification: **robust_on_available_funding_partial**；baseline OOS funding coverage = **partial**。
- OOS positive matrix variants: **6/6**
- 判断规则：robust requires every threshold group and both mild/aggressive variants to beat baseline on OOS in both ending BTC and BTC CAGR; one-group success is suspected overfit.
- 参数在 2023-12-31 冻结；2024-01-01 起只做样本外评价，未根据 OOS 结果调参。

## 为什么第一阶段结果不能直接采信

第一阶段把 funding 明确标记为 omitted，并用 Daily OHLC 近似挂单成交路径；更严重的是，挂单成交前后先按分段价格结算、随后又对同一持仓从日开盘结算到日收盘，造成日内 PnL 可能重复 mark-to-market。本版改为单一事件序列：每次 mark 只从上一个 mark 到当前价格一次，成交只改变仓位并结算手续费/滑点，不再次结算同一段价格。

## 数据与执行假设

- 数据：Binance Vision 官方 COIN-M 月档（[公开数据仓库](https://github.com/binance/binance-public-data)、[数据入口](https://data.binance.vision/)）。
- Signal：BTCUSD Index 的 fully closed daily candles，T-1 close 决定 T 日第一根执行 bar 的仓位；本次 index partial months: **2023-08**。
- Execution：BTCUSD_PERP Kline，优先 1H；本次 execution interval used = **1h**。Fallback months: **none**；partial months: **2023-08, 2026-06**。
- Funding mark：BTCUSD_PERP mark price，优先 1H；本次 mark interval used = **1h**。Fallback months: **none**；partial months: **2023-08**。mark 缺口只在 funding event 上回退到最近可用的 execution OHLC 点，并在结果里计数。
- Funding：使用官方 fundingRate 月档的真实 last_funding_rate；官方档案从 2022-07 才开始。2020-08 至 2022-06 不补 0，结果标记 partial。样本外 funding coverage: **partial**, 94.59% events coverage。
- Maker fee: 2 bps；taker fee: 5 bps；maker/taker slippage: 5/5 bps。费率是保守研究假设，不代表某个账户的 VIP 实际费率。
- COIN-M contract size: 100 USD；initial capital: 1 BTC；margin cap: 1.5x。
- Intraday path: OHLC path: open -> low -> high -> close on bullish bars; open -> high -> low -> close on bearish bars。1H 数据不足时才按月回退 4H，并在 JSON/report 中保留月份。

## 主场景指标：样本内 2020–2023

| scenario | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | avg/max exposure | turnover USD | fees BTC (maker/taker) | funding PnL BTC | slippage BTC | trades | fill rate | missed rallies |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline_immediate | 1.557142 | 13.95% | 66.11% | -35.47% | -56.73% | 0.744 / 1.544 | 594400 | 0.008886 (0.000000 / 0.008886) | -0.001661 | 0.008886 | 409 | n/a | 0 |
| ladder_80_20 | 1.557991 | 13.97% | 66.14% | -35.38% | -56.68% | 0.743 / 1.544 | 577000 | 0.008595 (0.000010 / 0.008585) | -0.001467 | 0.008610 | 432 | 5.61% | 80 |
| ladder_60_40 | 1.558919 | 13.99% | 66.17% | -35.28% | -56.59% | 0.742 / 1.542 | 560800 | 0.008302 (0.000028 / 0.008274) | -0.001133 | 0.008343 | 443 | 7.02% | 114 |
| curve_mild | 1.762802 | 18.20% | 72.30% | -34.83% | -55.30% | 0.748 / 1.543 | 1502000 | 0.018778 (0.002583 / 0.016195) | -0.000917 | 0.022652 | 734 | 5.56% | 1211 |
| curve_aggressive | 1.916382 | 21.14% | 76.60% | -34.75% | -54.79% | 0.752 / 1.545 | 2563400 | 0.030392 (0.005682 / 0.024710) | 0.000115 | 0.038915 | 746 | 5.56% | 1211 |

## 主场景指标：样本外 2024–2026

| scenario | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | avg/max exposure | turnover USD | fees BTC (maker/taker) | funding PnL BTC | slippage BTC | trades | fill rate | missed rallies |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline_immediate | 1.343329 | 12.10% | 30.62% | -23.92% | -34.44% | 0.765 / 1.279 | 1437600 | 0.008988 (0.000000 / 0.008988) | 0.008132 | 0.008988 | 522 | n/a | 0 |
| ladder_80_20 | 1.338074 | 11.93% | 30.42% | -23.92% | -34.38% | 0.763 / 1.277 | 1400400 | 0.008734 (0.000006 / 0.008727) | 0.008383 | 0.008744 | 546 | 4.13% | 149 |
| ladder_60_40 | 1.329607 | 11.66% | 30.10% | -23.92% | -34.33% | 0.762 / 1.279 | 1358300 | 0.008431 (0.000024 / 0.008407) | 0.008722 | 0.008468 | 569 | 6.49% | 185 |
| curve_mild | 1.399910 | 13.91% | 32.72% | -23.92% | -33.82% | 0.766 / 1.397 | 1989900 | 0.011612 (0.000776 / 0.010836) | 0.008455 | 0.012775 | 614 | 2.62% | 939 |
| curve_aggressive | 1.452256 | 15.54% | 34.62% | -23.91% | -33.81% | 0.768 / 1.487 | 2641400 | 0.014788 (0.001660 / 0.013128) | 0.008633 | 0.017278 | 616 | 2.62% | 939 |

## 主场景指标：全可执行窗口

| scenario | ending BTC | BTC CAGR | USD CAGR | BTC max DD | USD max DD | avg/max exposure | turnover USD | fees BTC (maker/taker) | funding PnL BTC | slippage BTC | trades | fill rate | missed rallies |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline_immediate | 2.091799 | 13.15% | 49.71% | -35.47% | -56.73% | 0.753 / 1.544 | 2814800 | 0.022682 (0.000000 / 0.022682) | 0.010854 | 0.022682 | 961 | n/a | 0 |
| ladder_80_20 | 2.088503 | 13.12% | 49.67% | -35.38% | -56.68% | 0.752 / 1.544 | 2745300 | 0.022023 (0.000022 / 0.022001) | 0.011366 | 0.022056 | 1009 | 5.31% | 247 |
| ladder_60_40 | 2.080542 | 13.05% | 49.58% | -35.28% | -56.59% | 0.751 / 1.542 | 2669200 | 0.021309 (0.000061 / 0.021249) | 0.012155 | 0.021400 | 1041 | 6.32% | 309 |
| curve_mild | 2.467511 | 16.32% | 53.91% | -34.83% | -55.30% | 0.756 / 1.543 | 4987900 | 0.039001 (0.003950 / 0.035051) | 0.013818 | 0.044925 | 1383 | 4.29% | 2150 |
| curve_aggressive | 2.782841 | 18.69% | 57.04% | -34.75% | -54.79% | 0.759 / 1.545 | 7606300 | 0.058494 (0.008861 / 0.049633) | 0.016480 | 0.071785 | 1406 | 4.29% | 2150 |

## 参数稳健性矩阵：OOS 冻结参数

| thresholds | strength | IS ending BTC delta | OOS ending BTC delta | OOS BTC CAGR delta | beats baseline |
|---|---|---:|---:|---:|---|
| [-3%, -6%, -10%] | mild | 0.131801 | 0.065087 | 2.07% | yes |
| [-3%, -6%, -10%] | aggressive | 0.300990 | 0.133124 | 4.18% | yes |
| [-5%, -10%, -15%] | mild | 0.205660 | 0.056581 | 1.80% | yes |
| [-5%, -10%, -15%] | aggressive | 0.359240 | 0.108927 | 3.43% | yes |
| [-7%, -12%, -20%] | mild | 0.136289 | 0.031934 | 1.02% | yes |
| [-7%, -12%, -20%] | aggressive | 0.311380 | 0.075201 | 2.39% | yes |

## 相对 baseline 的增量收益来自哪里（OOS）

| scenario | ending BTC delta | avg exposure delta | better buy price proxy BTC | intraday mean-reversion proxy BTC | funding PnL delta BTC | fee-cost benefit BTC | slippage-cost benefit BTC |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline_immediate | 0.000000 | 0.0000 | 0.000000 | 0.000000 | 0.000000 | 0.000000 | 0.000000 |
| ladder_80_20 | -0.005255 | -0.0012 | 0.001065 | 0.000453 | 0.000251 | 0.000255 | 0.000245 |
| ladder_60_40 | -0.013722 | -0.0030 | 0.004981 | 0.001480 | 0.000591 | 0.000557 | 0.000521 |
| curve_mild | 0.056581 | 0.0016 | 0.229415 | 0.044730 | 0.000323 | -0.002623 | -0.003787 |
| curve_aggressive | 0.108927 | 0.0032 | 0.490294 | 0.086767 | 0.000501 | -0.005799 | -0.008289 |

解释：

- higher average exposure 只报告 exposure 差异，不虚构一个可加总的美元贡献。
- better buy price proxy 把 maker fill 与同一日开盘价比较。
- intraday mean-reversion proxy 把 maker fill 与该日收盘价比较。
- funding/fee/slippage 是实际记账项相对 baseline 的差异。
- 这些组件不要求加总等于 ending BTC delta；逆向合约、动态 sizing、funding 和成本会复利耦合。

## 研究边界

- IS funding 在官方档案覆盖开始前不完整，因此 IS 的 funding PnL 不能解释为 2020–2023 全覆盖的真实 funding 结果。
- OOS 2024–2026 的 funding 需要以本次 JSON 中的 coverage 状态为准；缺失事件不会被静默当作 0。
- 这是研究回测，不是成交可执行性证明；1H OHLC 仍不能解决同一根 bar 内真实 tick 顺序，所以路径规则被固定并公开。
- 旧的 research/btc-v3-exposure-curve-result.json 保留为第一阶段历史结果；本文件只对应 V2 修正版。
