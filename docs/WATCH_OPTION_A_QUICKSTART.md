# Apple Watch 方案A（通过 iPhone 节点）快速上手

本方案不要求单独 watchOS app。路径是：

iPhone 节点配对 -> OpenClaw 通知/能力调用 -> Apple Watch 通过 iPhone 联动接收。

## 1. 先确认服务正常

```bash
openclaw gateway status
openclaw nodes list
openclaw nodes pending
```

正常情况下应该看到：

1. Gateway `Runtime: running`
2. nodes 当前 `Pending: 0 · Paired: 0`（初始状态）

## 2. 发起并完成配对

在 iPhone 侧发起节点配对后，Mac 端执行：

```bash
openclaw nodes pending --json
openclaw nodes approve <request-id>
openclaw nodes list --json
```

说明：

1. `<request-id>` 来自 `nodes pending` 输出
2. 配对成功后，`paired` 数组会出现节点记录

## 3. 识别节点能力

```bash
openclaw nodes status --connected --json
openclaw nodes describe --node <node-id-or-name>
```

建议先看 `describe`，确认该节点支持哪些能力再调用。

## 4. 发送测试消息到 iPhone/Watch 链路

优先使用 APNs 测试推送（iOS 节点）：

```bash
openclaw nodes push --node <node-id-or-name> --title "OpenClaw Test" --body "Hello from XChat"
```

如果你是 mac 节点，才使用：

```bash
openclaw nodes notify --node <node-id-or-name> --title "OpenClaw Test" --body "Hello" 
```

注意：`nodes notify` 当前是 `mac only`。

## 5. 常见问题

1. `No pending pairing requests`
  - iPhone 侧还没发起配对请求，先在手机端操作再回到 Mac 执行 `nodes pending`。

2. `approve` 后看不到 paired
  - 先 `openclaw nodes list --json` 再 `openclaw nodes status --connected --json`，确认是否短暂离线。

3. 推送没到 Watch
  - 先验证 iPhone 是否能收到 `nodes push`
  - 再检查 iPhone 与 Watch 的通知联动设置

4. 命令超时
  - 增加超时参数，例如 `--timeout 25000`

## 6. 推荐最短验证路径（3条命令）

```bash
openclaw nodes pending --json
openclaw nodes approve <request-id>
openclaw nodes push --node <node-id-or-name> --title "Pair OK" --body "Watch route check"
```
