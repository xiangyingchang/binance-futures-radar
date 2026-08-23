# Design — Binance Futures Radar

这是两个生产页面共用的展示层设计系统。它只约束颜色、排版、布局、交互反馈和响应式行为，不改变数据获取、指标计算、筛选条件、仓位计算或下单边界。

## Genre

Atmospheric 的技术型 app 变体：暗色、克制、数据先于装饰。

## Macrostructure family

- App pages: **Workbench**
  - 单页双视图：`index.html` 作为唯一入口，通过底部 Tab 切换两个 view。
  - 主雷达：Scan ledger，先读扫描状态，再读规则和候选表。
  - BTC V3：Decision brief，先读目标敞口和每日策略分析，再读指标、Gate 和纪律。
- Content pages: 不适用。

## Theme

`Midnight Instrument`：以冷蓝为唯一主信号，语义色只用于明确表达风险状态。

- `--color-paper`   `oklch(13% 0.016 252)`
- `--color-paper-2` `oklch(16.5% 0.018 252)`
- `--color-paper-3` `oklch(20% 0.019 252)`
- `--color-ink`     `oklch(95% 0.008 252)`
- `--color-ink-2`   `oklch(82% 0.012 252)`
- `--color-muted`   `oklch(70% 0.012 252)`
- `--color-subdued` `oklch(60% 0.012 252)`
- `--color-rule`    `oklch(31% 0.018 252)`
- `--color-accent`  `oklch(74% 0.145 252)`
- `--color-accent-soft` `oklch(20% 0.05 252)`
- semantic soft surfaces use 20–22% lightness to keep status text readable on mobile.
- `--color-focus`   `oklch(88% 0.12 252)`

## Typography

- Display: Space Grotesk 600–700, roman。
- Body: IBM Plex Sans 400–500。
- Mono: JetBrains Mono，用于状态、时间、数据标签和代码。
- 数字使用 `tabular-nums`，中文正文使用舒适行高。

## Spacing

4-point named scale，定义在 `tokens.css`。页面样式只引用 `var(--space-*)`，不在规则中散落颜色和字体值。

## Motion

- 页面保持静态编排；只使用按钮按压、刷新 loading 和必要的 opacity/transform 反馈。
- Easings：`--ease-out`、`--ease-in`、`--ease-in-out`。
- `prefers-reduced-motion: reduce` 下取消空间移动，保留不超过 150ms 的功能反馈。

## Microinteractions

- 刷新按钮：禁用 + spinner + 保持文字可读。
- 表格行：桌面 hover 只改变背景；键盘 focus 使用可见 ring。
- 交易对复制：沿用脚本现有的“已复制”反馈，不增加 toast。
- 输入框：固定 1px 边框，focus 只增加 outline，不发生布局位移。

## Chrome

- 顶部：N9 edge-aligned utility header，左侧产品/版本身份，右侧刷新动作。
- 视图切换：移动优先的底部双 Tab rail，`做空雷达` / `BTC V3`；V3 视图按需加载，避免两套页面样式串线。
- V3 操作区：实时 Mark Price、精确刷新时间和完整日线信号基准置于操作指导顶部；异常时锁定为不可操作状态。
- 页尾：Ft2 inline-rule single line，信息单行收束，不添加虚构的 sitemap、徽标或指标。

## Per-page allowances

- App 页面不得使用装饰性图片、虚构指标、渐变文字、玻璃拟态或自动交易 CTA。
- 保留现有中文文案、实时状态、错误状态和策略免责声明。
- 允许主雷达与 BTC V3 在同一系统内采用不同的信息节奏，但必须共享 token、字体、状态语义和交互尺寸。
- V3 只保留带日期和更新时间的「每日策略分析」作为自然语言解释；实时目标、指标、今日操作指导和 Gate 结果继续独立显示。

## What pages MUST share

- 冷蓝主信号、暗色 cool-grey surfaces、Space Grotesk + IBM Plex Sans + JetBrains Mono。
- 1px 规则线、8–16px 紧凑圆角、44px 交互命中区。
- 语义色的含义：绿色 = 正常/积累，黄色 = 警告/待核查，红色 = 防守/风险。

## Exports

详见根目录 `tokens.css`。本次不生成 Tailwind、DTCG 或 shadcn 变体，因为仓库是无框架静态 HTML。
