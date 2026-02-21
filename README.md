# OpenClaw XChat Orchestrator

让多个 Telegram 机器人在同一个群里进行可控接力讨论（duo/trio），并通过群内中文指令动态开关。

这是一个工程化编排方案，不是 Telegram 原生 bot-to-bot 通信能力。

## 1. 为什么这是有价值的

Telegram Bot API 一般不会把机器人消息再投递给其他机器人，所以“多个 AI 在群里互相看见彼此发言并继续讨论”在平台层面不成立。

本项目的核心创新是：

1. 把 OpenClaw 的群会话 JSONL 当事件流总线。
2. 用本地编排器 tail 新消息。
3. 依次调用多个网关 agent，并把上一位输出注入下一位提示词。
4. 每步 `deliver: true`，让对应机器人把回复直接发回同一群。

效果上是“多模型互相可见并协作”，实现上是“本地流水线 + 上下文桥接”。

## 2. 功能概览

1. 双人模式（duo）：DeepSeek -> GLM
2. 三人模式（trio）：DeepSeek -> GLM -> Jarvis(OpenClaw)
3. 群内控制指令：开启/关闭/状态/开场/轮数
4. 防打架机制：inFlight、cooldown、rateLimit
5. 防重复回复：给 DeepSeek/GLM 打 `sessions.patch`，设 `groupActivation: mention`

## 3. 运行流程（完整链路）

1. 用户在群里发消息。
2. OpenClaw ingest 消息并写入 group session JSONL。
3. 编排器 tail 到新行，识别：
  - 控制指令：立即执行模式管理。
  - 普通消息：如果交流模式已开启，则触发接力。
4. 接力时每一步都会拼接上下文：
  - 用户当前输入
  - 上一位模型输出（bridge memory）
5. 每步 agent 调用都 `deliver: true`，机器人把回复回传到群里。

## 4. 群内指令

1. 开启双人：`开启交流模式` 或 `/xchat on`
2. 开启三人：`开启三方交流模式` 或 `/xchat trio`
3. 开场双人：`开场互聊` 或 `/xchat kickoff`
4. 开场三人：`开场三方互聊` 或 `/xchat kickoff3`
5. 查看状态：`交流模式状态` 或 `/xchat status`
6. 设置轮数：`交流轮数 1|2|3`
7. 关闭模式：`关闭交流模式` 或 `/xchat off`

已做兼容增强：

1. 允许指令前带 `@bot`。
2. 允许句尾中文标点（如 `交流模式状态。`）。
3. `交流轮数` 支持 `交流轮数: 2` / `交流轮数：2`。

## 5. 仓库结构

1. `src/orchestrator.mjs`: 主编排器
2. `docs/ARCHITECTURE.md`: 架构说明
3. `launchd/com.openclaw.xchat.orchestrator.plist.example`: launchd 示例
4. `scripts/install-launchd.sh`: 一键安装 launchd
5. `scripts/health-check.sh`: 本地健康检查
6. `docs/WATCH_OPTION_A_QUICKSTART.md`: 手表方案A（iPhone 节点）实操

## 6. 环境依赖

1. macOS + launchd
2. Node.js 18+
3. 本地网关：
  - OpenClaw（主）
  - DeepSeek/GLM（子网关）

`GatewayClient` 加载策略：

1. 先尝试 `openclaw/dist/gateway/client.js`
2. 不可用时回退 `clawdbot/dist/gateway/client.js`

## 7. 安装与启动

1. 安装依赖

```bash
npm install
```

2. 前台运行

```bash
npm run start
```

3. 安装为 launchd 常驻

```bash
./scripts/install-launchd.sh
```

4. 本地健康检查

```bash
npm run health:local
```

## 8. 配置加载规则

默认读取：

1. OpenClaw: `~/.openclaw/openclaw.json`（不存在则回退 `clawdbot.json`）
2. DeepSeek: `~/.clawd-deepseek/openclaw.json`（不存在则回退 `clawdbot.json`）
3. GLM: `~/.clawd-glm/openclaw.json`（不存在则回退 `clawdbot.json`）

可用环境变量覆盖：

1. `OPENCLAW_DIR`
2. `DEEPSEEK_DIR`
3. `GLM_DIR`
4. `OPENCLAW_CONFIG_PATH`
5. `DEEPSEEK_CONFIG_PATH`
6. `GLM_CONFIG_PATH`
7. `OPENCLAW_SESSION_STORE_PATH`
8. `OPENCLAW_AGENT_ID`（默认 `main`）
9. `XCHAT_STATE_PATH`
10. `XCHAT_GATEWAY_CLIENT_PATH`（自定义 GatewayClient 模块路径，优先级最高）

## 9. 运行态文件

1. 状态文件：`~/.openclaw/xchat/state.json`
2. 标准日志：`~/.openclaw/xchat/orchestrator.log`
3. 错误日志：`~/.openclaw/xchat/orchestrator.err.log`

`state.json` 每个 chat 的核心字段：

1. `enabled`
2. `mode` (`duo|trio`)
3. `rounds`
4. `cooldownMs`
5. `lastTriggerAt`
6. `bridge.lastDeepseek / bridge.lastGlm / bridge.lastOpenclaw`

## 10. 稳定化修复记录（2026-02-21）

这次稳定化重点是“恢复可用 + 减少重复故障”。

### 10.1 线上故障现象

1. 群里持续报：`交流模式出错: gateway not connected`
2. orchestrator 日志反复：`openclaw gateway not ready after 10s`
3. OpenClaw 状态显示配置非法：`agents.list.*.bindings` 非法键

### 10.2 根因

`~/.openclaw/openclaw.json` 中 `agents.list` 写入了当前版本 schema 不支持的 `bindings`，导致主网关无法正常启动，编排器自然无法连接。

### 10.3 修复动作

1. 备份配置。
2. 删除 `agents.list[*].bindings`。
3. 重启 `ai.openclaw.gateway` 与 `com.openclaw.xchat.orchestrator`。
4. 验证主网关恢复监听 18989，编排器重新连上三路 gateway。

### 10.4 代码级增强

1. `waitReady()` 输出最后一次错误详情，缩短定位时间。
2. GatewayClient 增加 `onConnectError` 日志回调，便于判断是拒连、鉴权还是握手问题。
3. 指令解析增强（@mention + 标点容错）。
4. session 文件发现逻辑支持 `sessionId -> *.jsonl` 回退拼装，降低 sessions store 字段不全导致的“找不到群会话”。
5. bridge 记录前剥离 `@username`，避免把机器人 mention 链式污染到下一轮 prompt。

## 11. 排障手册（按症状查）

1. 症状：`gateway not ready after 10s`
  - 检查：`openclaw gateway status`
  - 常见原因：主网关没起、端口错、配置非法

2. 症状：`gateway not connected`
  - 检查：`launchctl list | rg openclaw`
  - 检查：`tail -60 ~/.openclaw/xchat/orchestrator.log`

3. 症状：`skip: inFlight`
  - 原因：同一 chat 上一轮尚未结束
  - 处理：等上一轮完成再触发

4. 症状：`skip: cooldown`
  - 原因：命中冷却窗口（默认 8 秒）

5. 症状：`skip: rateLimit`
  - 原因：同 chat 每分钟超过 6 次触发

## 12. 安全与开源边界

1. 不提交任何真实 token（Telegram/gateway/provider）
2. 不提交本机私有配置（`~/.openclaw/openclaw.json` 等）
3. 仓库仅包含：编排器代码、模板、文档、脚本

## 13. 当前限制

1. 不是 Telegram 平台原生 bot-to-bot 通道
2. 高并发群聊场景会触发限流与跳过策略
3. “互相可见”依赖 prompt 注入，不是系统级消息订阅

## 14. 后续建议

1. 增加健康检查脚本（配置合法性 + 端口连通 + launchd 状态）
2. 增加回归测试（指令匹配、session 发现、限流行为）
3. 把“稳定化 checklist”抽成单独 runbook 并在 CI 中跑基础静态校验

## 15. 手表（方案A）入口

已提供可执行版文档：

`docs/WATCH_OPTION_A_QUICKSTART.md`

建议按该文档跑最短链路：

1. `openclaw nodes pending --json`
2. `openclaw nodes approve <request-id>`
3. `openclaw nodes push --node <node-id-or-name> --title "Pair OK" --body "Watch route check"`
