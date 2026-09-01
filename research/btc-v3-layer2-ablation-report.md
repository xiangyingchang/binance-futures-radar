# BTC V3 第二层趋势层消融研究（E1）

> Research-only。不修改 main、不修改 V3 生产策略、不部署生产环境。

## 结论

**接受判据通过：第二层可以简化为 Bear Lock 二元开关。**

预注册判据（跑前冻结）：若 `bearlock_only` 在 OOS 的 ending BTC 不低于 `full_trend` 的 99%，且 OOS BTC 最大回撤不比 `full_trend` 深超过 1pp，则接受简化。

实际结果：`bearlock_only` OOS ending BTC **2.203 vs 2.103**（不是"不劣于"，是直接更好，+4.8%），OOS 最大回撤 **−23.63% vs −23.63%**（打平）。判据通过，且方向一致。

## 关键数字

| 场景 | ending BTC | IS 收益 | OOS 收益 | OOS BTC MDD | 全程 BTC MDD | 空头天数 | 调仓次数 |
|---|---:|---:|---:|---:|---:|---:|---:|
| full_trend（现行 V3.1） | 2.103 | +56.6% | +32.9% | −23.6% | −34.6% | 1009 | 939 |
| bearlock_only | 2.203 | +62.3% | +35.8% | −23.6% | −32.5% | 576 | 66 |
| ladder_only（无 Bear Lock） | 1.374 | +18.7% | +14.5% | −16.8% | −17.7% | 1009 | 1294 |
| constant_1x | 1.000 | 0 | 0 | 0 | 0 | 0 | 0 |

叠加第三层 override 后排序不变，且优势放大：

| 场景 | ending BTC | OOS 收益 | OOS BTC MDD |
|---|---:|---:|---:|
| bearlock_only + ramp | **5.817** | +67.5% | −17.0% |
| full_trend + ramp | 5.493 | +64.0% | −22.8% |
| bearlock_only + 1.5x | 4.836 | +63.6% | **−13.7%** |
| full_trend + 1.5x | 4.568 | +60.2% | −22.9% |

## 解读

1. **趋势阶梯（0.5/0.75/1.0/1.25 档）是负贡献的复杂度**。`ladder_only` 单独只有 +37% 的 `bearlock_only` 收益的零头；`full_trend` 相对 `bearlock_only` 全程少积累 0.10 BTC，且多付 14 倍的调仓次数（939 vs 66）——阶梯档位在 whipsaw 区间反复进出，摩擦成本吃掉了择时收益。
2. **Bear Lock 承载了第二层的全部价值**。它同时改善收益（+62% vs 阶梯的 +19%）和回撤路径（叠加 override 后 OOS 回撤 −13.7%~−17.0%，显著好于 full_trend 的 −22.9%）。
3. **调仓次数 66 vs 939**：二元开关把第二层从"每周微调"变成"熊市保险丝"，执行复杂度和出错面大幅下降。

## 建议的第二层新形态

```text
Bear Lock（Close < MA200 且 MA200 30日斜率 < 0）→ 目标敞口 0.0x（等量空头对冲）
否则 → 1.0x（纯现货，无 overlay）
```

删除趋势分阶梯、估值上调、波动率门——这些部件在本口径下未证明其存在价值。

## 口径与边界

- 数据：Binance Vision 官方 COIN-M 月档，2020-08-11 ~ 2026-07-31；funding 覆盖 partial（94.6%），缺口不补零。
- 执行：T-1 已收盘 Index 日线信号 → T 日开盘调仓；fee 5bps、slippage 5bps、维持保证金压力 10%。
- 所有参数继承冻结的 btc-v3.1-coinm 配置，未在 OOS 上调参；判据在运行前写死于脚本头部注释。
- 局限：IS/OOS 只有一次分割；仅 6 年真实合约史；`bearlock_only` 的优势有一部分来自"少交易"，在费率更低的账户下差距会缩小。

## 产物

- 脚本：`scripts/btc-v3-layer2-ablation.js`
- 结果：`research/btc-v3-layer2-ablation-result.json`（16 场景全量指标）
