# Changelog

## 2.0.0-rc.5 (2026-09-10) — 四渠道双向实测 + QQ 主动推送去重修复

- **修复 QQ 开放平台 v2 主动推送必失败**：`/v2/users|groups/<id>/messages` 的 payload 缺 `msg_seq`，
  平台按「消息被去重，请检查请求msgseq」(code 40054005) 拒绝——**同一 `msg_id` 下的第二次发送必命中**
  （先被动回复、再主动推一条即 400）。现在每条消息带进程内递增的唯一 `msg_seq`（取值 1..65000），
  并在发送日志里打印 `seq=` 便于排查。
- **四渠道双向实测通过（dsh 0.1.5-rc.1）**：
  - 入站：Telegram / 微信 iLink / 企微智能机器人长连接 / QQ 开放平台 v2 —— 各发一条普通消息，
    四条均成功创建真实 agent 会话（`[inbound] dispatch` → sessionId），并按渠道回发回复；
  - 出站（面板 → 渠道主动推送）：Telegram、微信（自动带入站 `context_token` 做被动回复）、
    企微（长连接 + ack）、QQ（v2，修复后）全部发出成功。

## 2.0.0-rc.4 (2026-09-10) — 0.1.5-rc.1 实测 + 方案二双向可用

- **微信渠道补齐「方案二 · OpenClaw / ClawBot 模式」**：此前只有 schema 字段（botId/secret）而面板无入口，现在与企微/QQ 一致，提供输入区 + 凭据指引 + 「保存 / 校验方案二」按钮 → 三个渠道的方案二均可**双向读写**（面板写入落盘、重载回显）。
- **修复 `writeChannel` 合并基线**：原先以「渲染期 props」为合并基准，同一区块连续提交两个字段时第二次提交会把刚写的字段覆盖回去（实测 secret 落盘、botId 被清空，企微/QQ/微信方案二均受影响）。改为读取**写时刻的实时快照**。
- **`/api/channel-bot/test` 明确区分方案**：微信 `scheme=2` 走记录型校验（不再误落到方案一发送）；`scheme=1`（iLink）优先使用最近入站消息的 `context_token` 做**被动回复**，无 token 时给出可操作提示（此前只报 `ret -2`）。
- 测试接口响应新增 `message` 字段，面板「测试验证」按钮优先展示服务端说明文案。
- **目标核心：`@deepseek-ai/dsh >= 0.1.5-rc.1` 实测通过**（自制插件已迁移到 `ctx.settings.installSection`）。

## 2.0.0-alpha.1 (2026-09-02) — DSH alpha.3 适配

- **settings API 迁移**：`@deepseek-ai/dsh-settings` 在 alpha.3 移除了 `installSettingsSection` / `settingsNamespace`，本插件改为通过 `ctx.inject(["settings"])` 拿到 settings 服务，调用 `settingsCtx.settings.installSection(ctx, NS, schema, base, { setSource, onChange })`。
- **目标核心**：`@deepseek-ai/dsh >= 0.1.2-alpha.1`。**不再兼容 `< 0.1.2-alpha.1` 旧核心**（因 alpha.3 删除了 installSettingsSection）。
- **其余核心 API**（`defineTool` / `ctx.tools.register` / `sessionQuery` / `settings.update` / client `settings.section` slot）在 alpha.3 均保留，无需改动。
- 说明：本版本为 alpha.3 适配候选版，运行时时序细节将随 alpha.3 核心稳定后精调。

## 1.0.9 — 2026-08-29

- 多渠道路由（QQ/企微/钉钉/飞书/Telegram/微信 iLink）、面板命令、事件通知、远程对话、远程审批。
