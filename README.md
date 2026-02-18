# ClawDBot XChat Orchestrator

让多个 Telegram 机器人在同一个群里以“接力”的方式互相对话（互相可见上下文），并且通过一个群内指令开启/关闭。

这不是 Telegram Bot API 原生的“bot-to-bot message”能力。
真实做法是：

- 由一个本机编排器监听群消息（读取 OpenClaw 会话 JSONL）
- 然后按固定顺序调用不同网关（DeepSeek / GLM / Jarvis）的 `agent` 接口
- 将上一位的输出注入下一位 prompt，从而模拟“互相能看到并回应”

## 功能

- 双方互聊：DeepSeek <-> GLM
- 三方互聊：DeepSeek -> GLM -> Jarvis（OpenClaw 主机器人）
- 支持在群里不需要 @mention 也能触发（需在 BotFather 关闭隐私模式，并且在配置中禁用 requireMention）
- 支持轮数控制（默认 2 轮，最大 3 轮）

## 指令（在群里发）

- 开启双人交流：`开启交流模式`
- 开启三方交流：`开启三方交流模式` 或 `/xchat trio`
- 开场双人互聊：`开场互聊`
- 开场三方互聊：`开场三方互聊`
- 设置轮数：`交流轮数 1` / `交流轮数 2` / `交流轮数 3`
- 查看状态：`交流模式状态`
- 关闭：`关闭交流模式`

## 依赖

- macOS + launchd（本仓库提供示例 plist）
- Node.js 18+
- ClawDBot 网关（`clawdbot gateway`）

本仓库代码通过 `clawdbot/dist/gateway/client.js` 直接调用本地网关。

## 安装

1) 安装依赖

```bash
npm install
```

2) 运行（前台）

```bash
npm run start
```

3) 运行（launchd 常驻）

参考 `launchd/com.openclaw.xchat.orchestrator.plist.example`，把路径改成你机器上的实际路径。

建议用 `scripts/install-launchd.sh` 自动生成并安装（见下）。

## 配置

脚本默认读取本机目录：

- OpenClaw: `~/.openclaw/openclaw.json`
- DeepSeek: `~/.clawd-deepseek/clawdbot.json`
- GLM: `~/.clawd-glm/clawdbot.json`

也可以通过环境变量覆盖：

- `OPENCLAW_DIR`
- `DEEPSEEK_DIR`
- `GLM_DIR`
- `OPENCLAW_CONFIG_PATH`
- `DEEPSEEK_CONFIG_PATH`
- `GLM_CONFIG_PATH`
- `OPENCLAW_SESSION_STORE_PATH`
- `OPENCLAW_AGENT_ID`（默认 `main`）
- `XCHAT_STATE_PATH`

## 安全注意事项

- 不要把任何 `.openclaw/openclaw.json`、`clawdbot.json`、Telegram token、gateway token 提交到 GitHub。
- 本仓库只提交 orchestrator 代码和示例 plist。实际 token 必须留在本机。

## 为什么 bot “互相看不到”

Telegram 的机器人通常无法收到其他机器人发出的普通消息，这是 Telegram 的限制。
本项目绕开这个限制的方式是“编排器注入上下文”。

