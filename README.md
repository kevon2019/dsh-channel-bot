# dsh-channel-bot

多渠道机器人插件（本地 file: 插件，非市场包）。把 DSH 面板接到 IM：
既能用命令查面板状态、收主动通知，也能**直接在 IM 里和 agent 对话**、**远程审批高风险操作**。

渠道：Telegram（getUpdates 长轮询）、微信（腾讯 iLink 官方机器人，扫码登录 + getupdates 长轮询）、
钉钉 / 飞书 / 企业微信（方案一：机器人 webhook 出站 / 应用消息；钉钉飞书还支持入站回调）、
QQ（**方案一** OneBot HTTP 双向；**方案二** QQ 开放平台 v2 官方机器人：AppID+AppSecret 换取 access_token，被动回复自动带 msg_id）、
企业微信（**方案二** 智能机器人长连接，@wecom/aibot-node-sdk 直接收发，无需公网回调）。

设置入口：**设置 → 左侧导航底部「📣 多渠道机器人」**（需 ≥1440px 宽视口，窄窗口会折叠导航）。

## 配置界面（v2.0.0-rc.2+）
- **每个渠道 / 方案一 / 方案二** 各带「💾 保存」「🧪 测试验证」按钮（QQ/企微 方案一二各自一组），
  「保存」读取该分区所有字段一次写回并生效；「测试」向该渠道真实发送一条消息验证凭据连通，可选填目标 ID。
- **折叠展开**：每个分区（总开关 / 各渠道 / 命令 / 远程对话 / 远程审批 / 通知事件）都可点击标题或
  「▲收起 / ▼展开」折叠；「总开关」右侧「▲全部收起 / ▼全部展开」一键折叠展开所有分区。
- 微信提供「微信扫码登录」按钮，扫码后 botToken 自动写入。
- **获取凭据指引**（v2.0.0-rc.3+）：QQ 方案二、企微方案二各带「🙋 获取凭据指引」，一键展开"去哪复制凭据"的分步说明 + 打开对应管理后台链接（q.qq.com / work.weixin.qq.com）。配置值仍须从管理后台复制后手动填入（QQ/企微为静态应用凭据，无扫码获取通道）。
- UI 基于原生 settings section（`slots.inject("settings.section")`），与面板 Models/视觉路由设置页一致。

---

## 功能分层

### 1. 命令（IM → 面板）
| 命令 | 说明 |
|---|---|
| `/help` | 命令清单（按开关与功能启用状态动态生成） |
| `/balance` | DeepSeek 账户余额 |
| `/spending` | 全部会话花销：今日 / 本周 / 本月 / 今年（按 V4 官方峰谷价估算） |
| `/status` | Harness 版本、运行时长、已启用渠道、插件数、远程对话/审批开关、待审批列表 |
| `/plugins` | 已安装插件清单 |
| `/version` | Harness 版本 |
| `/new` | 为当前聊天新建（重置）绑定会话 |
| `/end` | 解绑当前聊天的会话（面板里历史仍在） |
| `/sessions` | 所有已绑定的聊天 → 会话映射 |
| `/approve <id> yes\|no` | 远程批准 / 拒绝一次工具调用 |

### 2. 主动通知（面板 → IM）
- `send_notification` 工具：agent 可自己推消息。
- 服务 `channelBotNotifier`：其他插件 `ctx.inject(["channelBotNotifier"])` 后调 `notify()`。
- REST：`POST /api/channel-bot/notify` `{"text":"...","channel":"telegram"}`（channel 可省=全部）。
- 事件通知：任务完成 / 出错 / 中止 / 阻塞 / Token 上限 / 等待审批 / 余额不足，
  分级开关 + 关键词包含/排除（支持 `/正则/`）+ **静默时段**（如 `22:00-08:00`，时段内不推送但任务照常跑）。

### 3. 远程对话（IM ⇄ agent）— 默认关闭
开启后，**不带命令前缀的普通消息**就是给 agent 的任务：

```
聊天 (platform + chatId)  ──确定性哈希──▶  DSH session id
```

- 会话 id 由 `sha256(platform:chatId)` 生成，**重启不变**；映射另存
  `~/.dsh/channel-bot-sessions.json`（tmp+rename 原子写、防抖）。
- 取 agent 顺序：`agents.get()` → `agents.resume()` → `agents.create()`，
  与面板输入框走同一套官方服务；agent 预设通过 `setup` 回调挂载（不挂载=会话没有官方工具）。
- agent 正在跑时新消息走 `steer()`（打断/纠偏），空闲时走 `followup()`。
- 回复原路发回**该聊天**（不是广播）；Markdown 降级为纯文本，超长按段落切分。
- 流式：你在「活跃窗口」（默认 10 分钟）内发过消息时，多步任务的中间结果也会推送；
  人不在就只推最终结果。

### 4. 远程审批（高风险工具调用）— 默认关闭
两个官方缝：

1. `tools/pre-execute` **风险闸**：按规则评级，≥阈值（默认 medium）才返回 `{kind:'ask'}`。
   日常操作（`npm install`、`git pull`、`rm -rf node_modules`）判 low，永不打扰——
   防的是「审批疲劳 → 用户干脆关掉审批」。
2. `approval/request` **应答器**：推审批卡片到 IM，等 `/approve <id> yes|no`。
   关闭时 `next()` 交回面板弹窗，面板行为不变。

- 超时语义：`timeoutSec`（默认 300s）无人应答 → 推「任务已阻塞」提醒并继续等；
  再过 `pendingMaxSec`（默认 3600s）→ **判定拒绝**。任何异常出口都是拒绝（fail closed）。
- 卡片里的参数摘要**脱敏**：token / secret / key / password 等键名，以及
  `sk-…` / `ghp_…` / `Bearer …` / JWT 形状的值一律替换为 `***`——卡片要经过第三方 IM 服务器。
- 审计：`~/.dsh/channel-bot-approvals.log`，一行一条 JSON（谁、什么工具、参数摘要、结果、耗时）。

内置风险规则（`lib/approvals.js`，顺序敏感，先匹配先生效）：

| 级别 | 例子 |
|---|---|
| high | `rm -rf /`、`rm -rf ~`、`rm -rf *`、`rm -rf /etc/*`、`mkfs`、`dd if=`、`curl … \| sh`、`chmod -R 777`、`sudo shutdown`、`DROP TABLE`、`systemctl stop` |
| medium | `rm -rf <具体路径>`、`git push --force`、`git reset --hard`、`git clean -f`、`sudo`、`kill -9`、`docker rm/prune` |
| low | `npm/pnpm/yarn/bun install`、`pip install`、`git pull/commit/...`、`rm -rf node_modules` |

自定义规则（设置里的多行文本框）：

```
high  terraform\s+destroy          # 默认作用于 shell 类工具
high  * secrets/prod               # * = 所有工具
medium tool:memory .               # tool:<名字> = 指定工具
```

> ⚠️ 规则只匹配**参数 JSON**，且命令类规则只作用于 shell 类工具
> （`bash`/`terminal`/`execute_bash`/…）。否则 `memory` 工具保存一条**引用了**
> `rm -rf` 的笔记就会被判 high——危险字符串是数据，不是指令（实机踩过）。

---

## 安全须知

- **远程对话 = 把面板输入框开放给能给机器人发消息的人**。开启前务必配好各渠道的
  「允许的 Chat ID / 用户 ID」白名单；留空表示不限制。
- 钉钉/飞书入站回调支持加签校验（`secret`），不填则跳过校验（运维自己权衡）。
- 企业微信入站需要 AES 解密，当前**只支持出站**。
- 审批默认拒绝：推送失败、超时、会话中止全部按拒绝/不可用处理。

---

## 文件结构

```
lib/index.js       host 半边：设置 schema、命令、各渠道收发、通知、投影订阅、路由
lib/render.js      Markdown→纯文本、长文切分、参数脱敏、静默时段
lib/sessions.js    聊天⇄会话映射（确定性 id、原子持久化、去重、活跃判定、allowlist）
lib/dispatch.js    派活：ensureAgent（get→resume→create）+ userMessage + steer/followup
lib/approvals.js   风险评级 + 审批桥（pre-execute 闸 + approval/request 应答器）
lib/client.js      浏览器半边：设置面板 UI + 侧边栏「📣 多渠道机器人」入口
scripts/unit.test.mjs  单测（无网络、无 DSH 运行时）
```

测试：

```bash
cd ~/.dsh/profiles/web/dsh-channel-bot && node --test scripts/unit.test.mjs
```

---

## 关键实现坑（都踩过）

1. **`{{model}}` 无值**：`agents.create`/`resume` 不传 `agentOptions` → 回合组装失败
   `prompt variable "{{model}}" has no value ... (section "deployment:persona")`。
   新建取 `agentDefaultModel.currentSelection()`（**不是** `get()`）；
   恢复优先读该会话自己最后一条 `request/header` 的 config。
2. **`agentPreset: ""`**：空字符串不是合法预设 id，`presets.resolve("")` 抛
   `preset "" not found`；要传 `undefined` 让服务给默认值。
3. **多步回合会重复回复**：一个 turn 每个 step 都发一条 `assistant/message`，
   把它们拼起来会得到「收到收到收到」。最终答复取**最后一条**（`lastMsg`），
   流式只推「已经不是最新的那条」（`prevMsg`），另加一层「与上次发送内容相同则跳过」的去重。
4. **`permissionRules/decision` 让 resume 失败**：`dsh-session` 的 `append()` 丢掉了
   `ignorable: true` 选项，事件写盘没带标记，之后 resume 整个日志被拒绝
   （`unknown to this harness and not marked ignorable`）。修在
   `/root/.dsh/patches/dsh-client-patches.sh` 的 `patch_session_ignorable_append`。
5. **子 slot 必须 `ctx.slots.inject`**：`sidebar.footer.action` 是 ui-sidebar 声明的子 slot，
   裸 `register` 会与声明竞态，直接打崩整个 client boot。
