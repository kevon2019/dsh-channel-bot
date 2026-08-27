# dsh-channel-bot

deepseek-harness (dsh) 面板的**多渠道机器人**插件：把面板命令、任务完成/告警通知、远程对话和远程审批接到多种即时通讯渠道。

- 渠道：Telegram / 钉钉 / 飞书 / 企业微信 / QQ(OneBot) / 微信(官方 iLink Bot API)
- 命令：`/help` `/balance` `/status` `/plugins` `/version`
- 通知渠道：agent 完成任务、出错、需要关注时主动推送（每渠道独立开关）
- 远程对话：在 IM 里直接发普通消息即作为任务提交给 agent，回复原路返回
- 远程审批：高风险工具调用先推审批卡片，IM 里 `/approve <id> yes|no` 放行/拒绝

## 安装（DSH 一键命令）

在 dsh 面板所在的机器上，进入任意 dsh profile 后执行：

```bash
dsh plugin --profile web add github:kevon2019/dsh-channel-bot
```

> 如需锁定版本：`dsh plugin --profile web add github:kevon2019/dsh-channel-bot@1.0.1`
> 安装后重启面板服务即可生效：`systemctl restart deepseek-harness.service`

## 配置

打开 dsh 面板 → **设置 → 多渠道机器人**，按渠道填写：

| 渠道 | 需要的信息 | 获取方式 |
|---|---|---|
| Telegram | Bot Token、允许的 Chat ID | @BotFather 创建机器人 |
| 钉钉 | 群机器人 Webhook、加签密钥 | 钉钉群机器人设置 |
| 飞书 | 群机器人 Webhook、加签密钥 | 飞书群机器人设置 |
| 企业微信（方案一）| 机器人 Webhook，或 4 项应用消息参数（corpid/corpsecret/agentid/touser）| 企微管理后台 |
| 企业微信（方案二 · OpenClaw 长链接）| Bot ID + Secret | 企微「智能机器人」API 模式·长连接 |
| QQ | OneBot HTTP 地址、Access Token、群号 | 你的 OneBot 端点 |
| 微信（个人号）| 官方 iLink Bot Token | 面板内扫码登录 |

> 企业微信方案二（OpenClaw 长链接）仅作配置记录/展示：实际企微对话由 OpenClaw 生态承接，本插件不直接收发企微智能机器人消息。

底部每个配置块均有 **💾 保存** 与 **🧪 测试验证** 按钮；点标题旁的 **▲ 收起 / ▼ 展开** 可折叠对应区块。

## 开发与源码

- 结构：`lib/index.js`（host 半，服务端）+ `lib/client.js`（client 半，浏览器端）+ `cordis.patch.yml`（bundle 挂载）
- 版本：`1.0.1`
- 许可：MIT
