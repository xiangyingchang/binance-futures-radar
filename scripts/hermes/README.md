# Hermes Agent 自动化任务配置（BTC 策略）

这个目录存放 Hermes agent 定时任务的**版本化副本**，用于追踪策略通知的逻辑变更、提供回滚依据。**真正的运行时配置不在本仓库**，修改时必须以本仓库为参考、以本机实时配置为准，两个方向都要小心。

## 文件清单

| 文件 | 用处 | 实际运行位置 |
|---|---|---|
| `btc-dca-reminder.py` | BTC Smart DCA V4 周报（每周五 23:00，北京时间）：AHR999 六档定投金额 + V4 敞口层判断（Bear Lock 二元、override 确认门三分支）+ 弹药池流向，stdout 非空即推送飞书 | `~/.hermes/scripts/btc-dca-reminder.py` |
| `jobs-btc-v4-daily-review.json` | BTC V4 日报任务（每天 10:10）的 prompt 参考快照：日频监控 + 调仓日门（仅状态变化日/周日给 BUY/SELL）+ notepad 跨日状态机 + daily JSON 写入与远端回读规则 | `~/.hermes/cron/jobs.json`（job id `5293f85c811c`） |

## 同步方向（重要）

**本仓库是版本化参考，不是部署源。** 修改任务逻辑时的正确流程：

1. 先备份实时配置：`cp ~/.hermes/cron/jobs.json ~/.hermes/cron/jobs.json.bak-<日期>`
2. 修改实时配置（脚本直接改文件；prompt 用 `hermes cron edit <job-id> --prompt <新prompt>`）
3. 实测验证（`hermes cron run <job-id>`，检查输出 + `~/.hermes/cron/output/<job-id>/` 最新 md）
4. 验证通过后，把改后的文件**复制回**本目录（jobs.json 只导出脱敏快照：prompt + 调度配置，剔除运行时状态和 chat id）
5. 提交时在下面的"更新记录"加一行

绝不要把本目录文件直接覆盖到 `~/.hermes/`——运行时字段（state、next_run_at、failure_streak 等）不在快照里，直接覆盖会破坏任务状态。

## 回滚方法

- **脚本**：`cp scripts/hermes/btc-dca-reminder.py ~/.hermes/scripts/btc-dca-reminder.py`（先备份当前版本）
- **Prompt**：从快照 JSON 取 `prompt` 字段，`hermes cron edit 5293f85c811c --prompt '<prompt>'`（先备份 jobs.json）
- **完整回滚**：用修改前的 `jobs.json.bak-*` 整文件恢复（这是唯一包含全部运行时状态的备份）

## V4 口径要点（2026-09-01 定稿）

- 周报每周五 23:00 执行现货 DCA；日报每天运行 ≠ 每天调仓：override 进出场仍仅周日决策；Bear Lock、25% 熔断、182 天 kill switch 每日检查、状态变化立即调仓；其余天 HOLD
- 跨日状态存 notepad：`hermes cron notepad 5293f85c811c get/set state`；状态不可用时降级为不调仓，不编造
- 周报 override 确认门三分支：数据缺失 → 不调仓；确认门未满足（365D 回撤 > −20%）→ override 不生效回落第二层；满足 → 1.5x

## 更新记录

| 日期 | 文件 | 变更 | 验证 |
|---|---|---|---|
| 2026-09-06 | `btc-dca-reminder.py` | 周报改为每周五 23:00；周五通知明确 V4 合约仍按周日校准，本次仅执行现货定投 | ✅ live Cron 字段校验 + 周五通知分支测试 |
| 2026-09-03 | `jobs-btc-v4-daily-review.json` | r4 表达层：固定五段人话通知，首屏先给敞口/动作/原因；主文只保留 Close、MA200、30D slope、AHR999、365D Drawdown；明确下一动作、理论目标与今日实际调仓的区别 | ✅ live Cron 与参考 prompt 逐字节一致；策略规则未改 |
| 2026-09-01 | `jobs-btc-v4-daily-review.json` | 首次入库：V4 日频 prompt（9081→9801 字符），加调仓日门 + notepad 状态机；实测 run 输出 HOLD + state 写入成功，daily JSON 推送远端一致（commit c5c6f75） | ✅ hermes cron run 实测 + notepad state 回读 |
| 2026-09-01 | `btc-dca-reminder.py` | 首次入库：V4 周报脚本，修复 override 确认门两处 bug（删 `or bear_lock` 等价条件、确认门未满足时不再无条件输出 1.5x） | ✅ 三分支逻辑测试 5/5 + 实跑非 override 分支 |
