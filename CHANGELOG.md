# Changelog

## 2.3.0 (2026-09-19) — 按渠道「修复」+「一键修复全部渠道故障和报错」

- **诊断表新增修复能力**（设置 → 多渠道机器人 → 诊断）：
  - 每行在「自检」旁新增 **「修复」** 按钮（`data-repair`），顶部新增 **「一键修复全部」**
    （`data-repair-all`，按钮上直接显示「N 个有故障 / 共 M 个已启用」，有故障时高亮）；
  - 修复结果就地显示在对应渠道行（悬浮可见完整明细），一键修复额外给一行汇总
    `✅ 修复并通过 N 个；⚠ 仍需人工 M 个；⏭ 跳过 K 个；共执行 J 项动作`。
- **修复做什么（按渠道）**：
  1. 重启接收通道 —— Telegram 轮询 / 微信 iLink 长轮询 / 企业微信长连接；钉钉、飞书、QQ 为平台回调，
     如实返回「无常驻接收进程可重启」的说明；
  2. 清除该渠道的访问令牌缓存（钉钉 `accessToken` / 飞书 `tenant_access_token` / QQ `access_token`）；
  3. 清空健康账历史错误（连续失败计数、最近入站/出站错误）；
  4. 真打一次平台接口校验凭据（Telegram `getMe`、钉钉/飞书/QQ 换 token、企微长连接状态、微信 token 配置）；
  5. 复核并返回「做了什么 / 仍需人工 / 修复后结论」。
- **修的是根因，不是话术**：
  - **强制重启不再打出 409**：Telegram 轮询新增 `AbortController`，重启前主动中止在飞的 `getUpdates`；
    被取代的旧请求不再计入错误账（`if (!alive)` 分支）。微信长轮询新增「代（generation）」计数 +
    同样中止在飞请求 —— 既解决「循环卡死但 `wechatPolling` 恒为 true、修复无从下手」，也避免两个长轮询并发。
    实测：修复 telegram 后 `poller.fails=0、lastError=null`（旧实现会立刻记一次 `HTTP 409`）。
  - **凭据缺失如实回显**：钉钉/飞书缺 AppKey/AppSecret 时返回可操作提示，结论保持 ⚠，不假装修好。
- **服务端 API（仅新增）**：`POST /api/channel-bot/repair {channel}` / `{channel:"all"|"*"|省略}`；
  返回 `{ok, scope, summary{total,repaired,healthy,failed,skipped,actions}, results[...], health, channelsMeta}`；
  `GET` 返回 405、未知渠道返回 400。`/status` 的 health 计算抽成 `channelRuntimeInfo()` 与服务端修复共用同一口径。
- **实测证据（2026-09-19，dsh 0.1.6-alpha.1 / 面板 3080 + 真实 Chromium 点击）**：
  - `POST /repair {channel:"telegram"}` → `probe: Telegram 凭据有效（@hermes_2026_kevonbot）`，
    3 项动作，`after.poller.fails=0`、`lastError=null`（**修复前实测过一次 `HTTP 409`，加 AbortController 后消失**）；
  - `POST /repair {channel:"all"}` → `summary: {total:6, repaired:6, healthy:4, failed:2, actions:12}`：
    telegram / 企业微信 / QQ / 微信 修复并复核通过；钉钉、飞书如实报「需要 AppKey+AppSecret+robotCode」、
    「需要 App ID + App Secret」（已核对 `settings.yaml`：两者确实未配置方案二凭据）；
  - CDP 真实鼠标点击：6 行「修复」按钮 + 「一键修复全部」全部可点，telegram 行就地显示
    `✅ 修复完成（复核通过）：✔ Telegram 凭据有效（@hermes_2026_kevonbot）`，汇总行显示
    `✅ 修复并通过 4 个；⚠ 仍需人工 2 个；共执行 12 项动作`，控制台 0 报错；
  - 单测：`node --test scripts/unit.test.mjs scripts/client.test.mjs` = 66 项全绿
    （新增 `scripts/client.test.mjs` 8 项：修复结果文案的成功/部分/跳过/无返回四态 + 一键汇总）。
- 兼容性不变：dsh `0.1.6-alpha.1` 实测。

## 2.2.0 (2026-09-18) — 全渠道双向自检 + 钉钉/飞书「方案二」

- **双向自检扩展到全部 6 个渠道**：Telegram / **钉钉** / **飞书** / 企业微信 / QQ / 微信，
  每个渠道一行，显示「接收通道类型 + 状态」（轮询中 / 长连接 / 回调就绪 / 未启用）、
  最近一次入站（时间·来源·内容）、最近一次出站（成功次数或错误原文）、结论与原因，
  并在渠道名后标出当前是**方案一还是方案二**。
- **分渠道设定**：每个渠道一个「参与自检」开关（默认开）——点一下即可把某渠道移出/纳入自检表
  （设置持久化到 `selfCheck` 字段）；顶部有「**全部自检（N 个已启用渠道）**」，
  每行还有独立的「**自检**」按钮，单个渠道诊断后就地显示结果（✅ 已发送 / ❌ 原因），不用翻日志。
- **钉钉支持「方案二」：企业内部应用机器人**（`scheme: "2"`，默认）：
  `AppKey + AppSecret + robotCode` 换 accessToken（带缓存），单聊走
  `/v1.0/robot/oToMessages/batchSend`、群聊走 `/v1.0/robot/groupMessages/send`；
  入站回调支持 `appSecret` 签名校验（`timestamp`/`sign` 头）+ 解析 `conversationId/msgId/senderStaffId`。
  方案一（群机器人 Webhook + 加签）仍在 `scheme: "1"` 下保留。
- **飞书支持「方案二」：自建应用**（`scheme: "2"`，默认）：
  `App ID + App Secret` 换 `tenant_access_token`，走 `/open-apis/im/v1/messages`
  （receive_id_type 支持 open_id / chat_id / email / user_id / union_id）；
  事件订阅支持 **Verification Token 校验**与 **Encrypt Key AES-256-CBC 解密**（`encrypt` 字段）。
  方案一（群机器人 Webhook + 加签）仍在 `scheme: "1"` 下保留。
- **新增插件自写配置接口** `POST /api/channel-bot/config`：把 patch 合并进 `channel-bot`
  设置命名空间（如 `{"patch":{"dingtalk":{"scheme":"2"},"feishu":{"scheme":"2"}}}`），
  用于方案切换/批量设置自检开关，免手改 settings.yaml。
- 通知与自检覆盖新渠道：`planNotifyTargets` 现在也支持钉钉/飞书方案二（凭据+目标齐全才进列表，
  否则在「未进通知列表的原因」里说明缺什么）。
- 单测 54 → 57 项（六渠道清单/分渠道开关/健康视图字段/钉钉飞书方案二通知目标）。

## 2.1.1 (2026-09-18) — 双向自检表可读性修复

- **「接收链路待验证」显式化**：入站还没收到过消息时，结论列不再只写「✅ 正常」，而是
  「✅ 正常（接收链路待验证：本次运行还没收到过入站消息）」——避免把「还没验证」误读成「双向都通了」。
- 表格可读性：表头改为左对齐（与数据列对齐）、说明文字不再被图例截断成病句、
  底部「通知目标」用中文渠道名（Telegram / 企业微信 / QQ / 微信(iLink)）。
- 无功能变更（判定逻辑与 2.1.0 一致）。

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
