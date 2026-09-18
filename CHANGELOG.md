# Changelog

## 2.1.0 (2026-09-18) — 修复「微信渠道突然不能用」根因 + 四渠道双向自检

- **修复「微信(iLink) 渠道突然收不到消息、面板命令没反应」的根因（真实事故）**：
  旧版长轮询循环里有一句
  `if (!cur.enabled || !cur.wechat?.enabled || !tok) { wechatPolling = false; return; }`
  —— 只要配置快照**瞬时**读空（面板重启、其它插件写 settings、热重载），微信长轮询就**永久退出**，
  而且**不留任何日志**（这正是「突然不能用了、日志里却什么都没有」的原因；实测该状态下面板进程
  与 `ilinkai.weixin.qq.com` 再无任何连接，重启面板才恢复）。现在：
  - 快照读空只跳过本轮并留痕（`markSkip` + 一次性 warn），**绝不自杀**；只有用户显式关闭渠道才停；
  - 新增 **60 秒轮询看门狗**：凡「配置里启用、但轮询/长连接没在跑」的渠道自动重新拉起（自愈）。
- **新增「四渠道双向自检」**（设置 → 多渠道机器人 → 诊断）：
  一张表列出 Telegram / 企业微信 / QQ / 微信 的**接收通道是否在跑、最近一次入站、最近一次出站结果、
  结论与原因**，20 秒自动刷新；`GET /api/channel-bot/status` 增加 `health` 与 `state` 字段
  （含通知目标与「为什么某渠道收不到通知」的原因）。
- **修复企微通知永远发不出**：`notifyTargets` 只认 webhook/应用消息两种配置，当前部署用的是
  **方案二（botId+secret 长连接）** → 企微从来进不了通知列表。现已包含方案二路径。
- **修复 QQ 通知拿错目标导致必失败**：旧版会把数字群号（甚至 appId）当 `group_openid` 推给
  QQ 开放平台 v2，平台必然返回 `400 请求的资源不存在(用户/群已注销)`（实测 13:34/14:05/14:07 三次）。
  现在只在「收到过入站消息且会话 id 是合法 openid（16–64 位非纯数字）」时才推，否则跳过并说明原因。
- **微信 context_token 落盘**：被动回复必须带回 context_token，旧版只存在内存里，面板一重启就丢
  → 之后的主动推送必然 `ret -2`。现在按会话落盘到 `~/.dsh/channel-bot-state.json`，重启后仍可推。
- **入站不再静默丢弃**：所有「非文本/非用户消息/白名单外/配置快照暂不可用」的跳过都计入健康账
  （`inbound.skipped` + `lastSkipReason`），并在健康表里显示。
- **Telegram 轮询改为自调度单飞**：旧版 `setInterval(2s)` + `timeout:30` 长轮询会**自己和自己并发**，
  Telegram 把较早的请求以 `409 Conflict: terminated by other getUpdates request` 掐掉（健康账实测 16 次）。
  现在永远只有一个请求在飞（`polls` 稳步递增、`fails=0`）。
- **QQ 的 `msg_id` 只在被动回复窗口内使用**：`msg_id` 仅对「刚收到的那条消息」有效（约 5 分钟），
  过期/跨消息复用会被平台拒绝（`400 请求参数msg_id无效或越权`）。现在回复入站走 passive（带新鲜 msg_id），
  **通知/测试走主动推送（不带 msg_id）**，并给 msg_id 加了时间戳与新鲜度判断。
- **企微主动推送目标兜底**：长连接（方案二）推送目标 = 显式 target → `touser` → 进程内最近入站会话
  → **持久化的会话绑定**（重启后仍能推，不必等用户再发一条消息）。
- **测试按钮纳入健康账**：面板「测试验证」发的消息现在也计入 `outbound`，自检表不再永远显示 0。
- **微信通知放宽为「有目标用户就试一次」**：实测 iLink 在会话窗口内允许无 `context_token` 的主动推送
  （`{"ok":true}`），`ret -2` 表示「当前没有可用会话窗口」；失败时仍返回可操作提示。
- **单测 41 → 53 项**：新增 `lib/health.js`（健康登记 + 通知目标解析 + msg_id 新鲜度纯函数），覆盖
  openid 校验、企微方案二通知、QQ 数字 id 拒推、微信目标解析、msg_id 过期后必须不带、
  健康结论与原因文案。

## 2.0.0 (2026-09-18) — 适配 dsh 0.1.6-alpha.1（转正式版）

- **适配并实测 dsh 0.1.6-alpha.1**：核心（全局 CLI + profile 内 `@deepseek-ai/*`）全量为
  `0.1.6-alpha.1` 时，面板启动、设置分区渲染（多渠道机器人卡片 29 个开关 / 43 个输入框全量渲染）、
  `settings.section` 分区注册、`sidebar.footer.action` 侧边栏入口、`/api/channel-bot/status`
  以及各渠道连接（企微智能机器人长连接鉴权成功）全部正常，浏览器控制台 **0 报错**。
- **修复「审批卡片可能漏脱敏凭证」（真实缺陷，回归测试已补）**：`argsSummary()` 用**带 `/g`** 的
  `REDACT_PATTERN.test()` 做判定，而全局正则的 `lastIndex` 会在多次调用之间残留 → 同一形态的
  `ghp_…` / `sk-…` / `Bearer …` / JWT 会「时而脱敏、时而原样输出」，漏判即把凭证原样送进
  经第三方 IM 中转的远程审批卡片。现改为无状态判定（`REDACT_TEST`），并把 `gh[pousr]_` 规则
  放宽到覆盖连字符/下划线的写法。新增回归测试：同一凭证连续 12 次调用必须每次都脱敏。
- **兼容性可自查**：`GET /api/channel-bot/status` 增加 `pluginVersion` 与
  `compat { core, testedCore, minCore }`；`/version` 命令回显
  `DeepSeek Harness <核心版本>（多渠道机器人 v2.0.0 · 已验证 0.1.6-alpha.1）`；
  面板「设置 → 多渠道机器人 → 诊断 → 测试状态」同步可见，复制诊断信息里也带上该提示。
- 版本号进入 **稳定版**（去掉 `-rc.N`）。行为与 rc.7 一致，无破坏性变更，可直接替换安装。

## 2.0.0-rc.7 (2026-09-10) — 诊断面板配色改为跟随主题

- **修复 rc.6 诊断面板在浅色主题下「看起来像被禁用」**：rc.6 的文字颜色写死了深色主题的兜底值
  （`var(--dsw-alias-text-primary, #e6e9ef)` 之类），在浅色主题下面板会渲染成浅灰 → 用户容易误以为提示不可用。
  现在标题/正文一律 `inherit`（跟随面板主题），次要说明行用 `opacity: 0.7` 弱化，
  浅色与深色主题下都保持正文级对比度。
- 无功能变更：其余行为与 rc.6 完全一致（域名/反代的 8 秒超时自诊断、重新绑定、复制诊断信息）。
- 提示：本版仍只改善「别人看到什么」。设置不可用的根因在核心 `isLoopback`（见 README「域名 / 反向代理部署」一节），
  换插件版本不能恢复设置读写。

## 2.0.0-rc.6 (2026-09-10) — 域名/反代部署：设置「加载中…」改为超时自诊断

- **修复「用域名/反向代理访问时，“多渠道机器人设置加载中…”永远转圈」的体验问题**。
  **根因在核心，不在本插件**：`@deepseek-ai/dsh-client-connection` 的 `isLoopback` 只看浏览器地址栏
  （是不是 `127.0.0.1`/`localhost`），反代部署时恒为 `false` → 核心把 settings 静默降级为 unavailable
  → `ctx.settingsScope.bind()` 永远拿不到 `status==="ready"` 的快照（同一部署下核心自带的 Models 页会直接报
  `settings are unavailable in this browser`）。插件无法自救，但**不该让用户面对一个永远转圈的页面**。
- 现在 **8 秒超时后渲染诊断面板**：显示当前地址、核心判定（loopback / remote）、根因说明、
  两条修复路径（本机 `127.0.0.1:3080/?token=…` 访问 ／ 给核心 `isLoopback` 打域名放行补丁）、
  「重新绑定」与「复制诊断信息」按钮（后者一键复制可粘贴进 issue 的诊断文本）。
  **机器人后台运行与渠道收发不受影响**，仅面板里的设置读写不可用。
- 实测：域名下（已有核心放行补丁）3668 字符正常 UI、全程零 4xx/5xx，无渠道回归；
  临时摘掉核心放行补丁模拟他人环境，T+4s 仍转圈 → T+12s 正常出现诊断面板。
- README 增补「域名 / 反向代理部署：设置一直『加载中…』？」一节，说明现象、根因与两种解法。

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
