# dsh-channel-bot

deepseek-harness (dsh) 面板的**多渠道机器人**插件：把面板命令、任务完成/告警通知、远程对话和远程审批接到多种即时通讯渠道。

- 渠道：Telegram / 钉钉 / 飞书 / 企业微信 / QQ 开放平台 v2 / 微信（个人号 · 官方 iLink）
- 命令：`/help` `/balance` `/status` `/plugins` `/version`
- 通知渠道：agent 完成任务、出错、需要关注时主动推送（每渠道独立开关）
- 远程对话：在 IM 里直接发普通消息即作为任务提交给 agent，回复原路返回
- 远程审批：高风险工具调用先推审批卡片，IM 里 `/approve <id> yes|no` 放行/拒绝

## 安装（DSH 一键命令）

在 dsh 面板所在的机器上，进入任意 dsh profile 后执行：

```bash
dsh plugin --profile web add github:kevon2019/dsh-channel-bot
```

> 如需锁定版本：`dsh plugin --profile web add github:kevon2019/dsh-channel-bot#v1.0.4`
> （GitHub 依赖用 `#` 指定 tag/分支，**不是** npm 的 `@版本`）。安装后重启面板：`systemctl restart deepseek-harness.service`
> 企业微信接入依赖 `@wecom/aibot-node-sdk`（v1.0.4 起已在插件依赖内，安装自动带上）。

## 配置

打开 dsh 面板 → **设置 → 多渠道机器人**，按渠道填写：

| 渠道 | 需要的信息 | 获取方式 |
|---|---|---|
| Telegram | Bot Token、允许的 Chat ID | @BotFather 创建机器人；`notifyChatId` 填你的用户 ID |
| 钉钉 | 群机器人 Webhook、加签密钥 | 钉钉群机器人设置 |
| 飞书 | 群机器人 Webhook、加签密钥 | 飞书群机器人设置 |
| 企业微信（方案一）| 机器人 Webhook 或 4 项应用参数（corpid/corpsecret/agentid/touser）| 企微管理后台 |
| 企业微信（方案二 · 真收发）| botId + secret | 企微「智能机器人」API 模式 · 长连接（本插件用 `@wecom/aibot-node-sdk` 直连收发）|
| QQ（开放平台 v2）| appId + appSecret | QQ 开放平台管理端 → 开发基础设置 |
| 微信（个人号）| 官方 iLink botToken | 面板内扫码登录（自动写入）|

### 企业微信方案二（真收发）

`wecom.botId/secret` 配置后，插件用 `@wecom/aibot-node-sdk` 的 `WSClient` 长连接企微智能机器人：

- **收**：`message.text` 事件 → 会话 ID 从 `frame.body.from.userid` 取
- **发**：`replyStream` 回复命令；远程对话回复经投影链路；主动推送 `wsClient.sendMessage(chatId, {msgtype:'markdown', markdown:{content}})`
- 注意：同一个企微 bot 只能一个客户端连接（channel-bot 与 OpenClaw 二选一占用）。

### QQ 开放平台 v2

`qq.appId/appSecret`（QQ 开放平台管理端获取），走官方 **webhook（公网 HTTPS 回调）+ OpenAPI**（WebSocket 事件推送官方已下线）：

- **回调地址**：`https://your-domain.example.com/api/channel-bot/webhook/qq`（仅 80/443/8080/8443）。管理端配置该地址时会做 `op:13` 验证，插件返回 `{plain_token, signature}`（签名算法 **Ed25519**：seed=repeat(appSecret,32)，签名体=event_ts+plain_token）。
- **订阅事件**：单聊 `C2C_MESSAGE_CREATE` + 群聊@ `GROUP_AT_MESSAGE_CREATE`（webhook 灰度需在管理端开通/联系反馈助手）。
- **发送**：鉴权头 **`Authorization: QQBot {access_token}`**（不是 `Bot {appId}.{token}`，后者报 11243）；`POST /v2/users/{openid}/messages`（单聊）/ `/v2/groups/{group_openid}/messages`（群@）；**被动回复必须带 `msg_id`**（等价微信 context_token）。
- **IP 白名单**：正式环境须把服务器公网 IP 加进管理端 IP 白名单；调试可用沙箱 `sandbox.api.sgroup.qq.com`（无 IP 白名单限制）。
- 面板所在 nginx 需豁免该回调路径认证（`auth_request off`，见 README 末尾「注意事项」）。

### 微信（个人号 · 官方 iLink）

`wechat.botToken` 为腾讯官方 iLink Bot Token，面板「微信」配置块内**扫码登录**自动写入（流程：`POST /api/channel-bot/wechat/login` 生成二维码 → 扫码 → `login/status` 确认即写回 token）。

- 会话 ID 用入站消息的 `msg.from_user_id`（`xxx@im.wechat`），`notifyUserId`/`allowedUserIds` 填你的微信会话 ID。
- **回复必须带 `context_token`**（每条入站消息携带，回复时原样带回，否则不投递）。
- `sendmessage` 需带：`from_user_id:""` + `client_id: <uuid>` + 头 `iLink-App-Id: bot`、`iLink-App-ClientVersion: 131584`，且 `context_token` 仅在有时才加（别传空串）。
- **双向前提**：bot 身份（扫码微信号）与发消息方必须是**两个不同微信账号**——同一个号扫码做 bot 又自己发消息属于「自聊」，微信平台不投递。建议用常用号做 bot、另一个号做测试发送方。

## 注意事项

- **远程对话回复走 sessionProjections**：turn/end 事件带 `lastEndSeq`，订阅端用严格 `lastEndSeq === seq` 门控防回放，勿放宽成 `seq < lastEndSeq`（会重复推送上一轮回复）。
- **公网回调需 nginx 豁免认证**：dsh 面板 nginx 若整 server 有 `auth_request /__auth_check`，须加 `location /api/channel-bot/webhook { auth_request off; proxy_pass http://backend; }`，否则外部回调（QQ/钉钉/飞书）被 401 拦截。
- **重复消息去重**：插件对同一平台+chatId 的相同文本做 `lastSentToChat` 去重，避免流式重复。
- **别在 profile 里手动 `pnpm add/up`**：可能破坏 `node_modules/@changfenhuang/dsh-genui` 软链（dsh 面板软链到 `@omdsh-dev/dsh-genui`）导致 UI 起不来；装/改插件走 `dsh plugin`。若动过 pnpm，检查该软链仍在。
- **PROFILE 层补丁**：插件对面板的 cordis 补丁写在 PROFILE 的 `cordis.patch.yml`，勿改 node_modules 里的（重启还原）。
- **私密信息**：token/密钥只填面板设置（settings.yaml），勿写进源码/命令。面板设置页打不开/转圈 = 缓存陈旧，硬刷新即可。

底部每个配置块均有 **💾 保存** 与 **🧪 测试验证** 按钮；点标题旁 **▲ 收起 / ▼ 展开** 折叠对应区块；**总开关**的「**▲ 全部收起 / ▼ 全部展开**」一键折叠/展开所有渠道与功能区。

## 开发与源码

- 结构：`lib/index.js`（host 半，服务端）+ `lib/client.js`（client 半，浏览器端）+ `cordis.patch.yml`（bundle 挂载）
- 版本：`1.0.4`
- 许可：MIT
