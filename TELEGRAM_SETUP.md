# Telegram 通知设置指南

## 1. 创建 Telegram Bot

1. 打开 Telegram，搜索 **@BotFather**
2. 发送 `/newbot` 命令
3. 输入机器人名称，例如：`My RSI Scanner`
4. 输入机器人用户名，例如：`my_rsi_scanner_bot`（必须以 `_bot` 结尾）
5. BotFather 会返回一个 **API Token**，格式类似：
   ```
   123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   ```
6. **保存这个 Token！**

## 2. 获取你的 Chat ID

1. 搜索并打开你刚创建的机器人
2. 点击 **Start** 或发送任意消息
3. 访问这个链接（替换 `YOUR_BOT_TOKEN`）：
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```
4. 找到 `"chat":{"id":` 后面的数字，这就是你的 **Chat ID**

## 3. 配置 GitHub Secrets

1. 打开你的 GitHub 仓库：https://github.com/xiangyingchang/binance-futures-radar
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**，添加两个 Secret：

| Name | Value |
|------|-------|
| `TELEGRAM_BOT_TOKEN` | 你的 Bot Token（步骤1获取） |
| `TELEGRAM_CHAT_ID` | 你的 Chat ID（步骤2获取） |

## 4. 测试运行

1. 进入仓库的 **Actions** 页面
2. 点击左侧的 **RSI Scanner**
3. 点击右侧的 **Run workflow** → **Run workflow**
4. 等待运行完成，检查 Telegram 是否收到消息

## 5. 运行频率

默认配置是**每小时**运行一次。如果你想修改频率，编辑 `.github/workflows/scan.yml` 中的 cron 表达式：

```yaml
# 示例：
# 每小时: '0 * * * *'
# 每2小时: '0 */2 * * *'  
# 每天早上8点(UTC): '0 0 * * *'
# 每天北京时间早上8点: '0 0 * * *' (UTC 0点 = 北京时间8点)
```

## 常见问题

**Q: 收不到消息？**
- 确保你给 Bot 发送过消息（点击 Start）
- 检查 Token 和 Chat ID 是否正确
- 查看 GitHub Actions 的运行日志

**Q: 如何停止通知？**
- 进入 GitHub Actions，禁用 RSI Scanner workflow

**Q: 费用？**
- 完全免费！GitHub Actions 对公开仓库免费，Telegram Bot API 也是免费的
