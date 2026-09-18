/**
 * dsh-channel-bot — 渠道健康登记 / 持久化状态 / 通知目标解析（v2.1.0）
 *
 * 抽成独立模块的原因：这些是「纯逻辑 + 一点点落盘」，可以被单测直接 import
 * （host 主文件 lib/index.js 依赖 cordis / dsh-tools，无法在单测里独立加载）。
 *
 * 为什么要有健康账：渠道的轮询与长连接是**静默进程** —— 正常时不产生任何日志，
 * 而出问题时如果代码里是「静默跳过 / 静默 return」，从外面看就是「渠道突然不能用了」
 * 且日志里什么都没有。这里把「接收通道是否在跑 / 最近入站 / 最近出站」记下来，
 * 通过 /api/channel-bot/status 的 health 字段暴露给面板。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 状态文件路径：调用时解析，可用 CHANNEL_BOT_STATE_FILE 覆盖（单测用临时文件，
 *  否则跑一次单测就会把线上 ~/.dsh/channel-bot-state.json 覆盖掉 —— 真踩过）。 */
export function stateFilePath() {
  return process.env.CHANNEL_BOT_STATE_FILE || join(homedir(), ".dsh", "channel-bot-state.json");
}

/* ---------------- 健康登记 ---------------- */
export const chanHealth = {};
export function hrec(ch) {
  if (!chanHealth[ch]) {
    chanHealth[ch] = {
      poller: { running: false, polls: 0, lastPollAt: null, lastError: null, lastErrorAt: null, fails: 0 },
      inbound: { count: 0, lastAt: null, lastFrom: null, lastText: null, skipped: 0, lastSkipReason: null },
      outbound: { count: 0, ok: 0, fail: 0, lastAt: null, lastOk: null, lastError: null },
    };
  }
  return chanHealth[ch];
}
export function markPoll(ch, okFlag, error) {
  const r = hrec(ch);
  r.poller.lastPollAt = new Date().toISOString();
  if (okFlag) { r.poller.polls += 1; r.poller.fails = 0; r.poller.lastError = null; }
  else {
    r.poller.fails = (r.poller.fails || 0) + 1;
    r.poller.lastError = error ? String(error).slice(0, 200) : "unknown";
    r.poller.lastErrorAt = new Date().toISOString();
  }
}
export function markInbound(ch, from, text) {
  const r = hrec(ch);
  r.inbound.count += 1;
  r.inbound.lastAt = new Date().toISOString();
  r.inbound.lastFrom = from ? String(from) : null;
  r.inbound.lastText = text ? String(text).slice(0, 80) : null;
}
export function markSkip(ch, reason) {
  const r = hrec(ch);
  r.inbound.skipped += 1;
  r.inbound.lastSkipReason = String(reason).slice(0, 160);
}
export function markOutbound(ch, okFlag, error) {
  const r = hrec(ch);
  r.outbound.count += 1;
  r.outbound.lastAt = new Date().toISOString();
  r.outbound.lastOk = okFlag === true;
  if (okFlag) { r.outbound.ok += 1; r.outbound.lastError = null; }
  else { r.outbound.fail += 1; r.outbound.lastError = error ? String(error).slice(0, 200) : "unknown"; }
}

/* ---------------- 跨重启持久化 ---------------- */
export const persistedState = { wechatContexts: {}, qqInbound: null, qqMsgIds: {}, qqMsgIdAt: {} };
export function loadPersistedState() {
  try {
    const d = JSON.parse(readFileSync(stateFilePath(), "utf8"));
    if (d && typeof d === "object") {
      if (d.wechatContexts && typeof d.wechatContexts === "object") persistedState.wechatContexts = d.wechatContexts;
      if (d.qqInbound && typeof d.qqInbound === "object") persistedState.qqInbound = d.qqInbound;
      if (d.qqMsgIds && typeof d.qqMsgIds === "object") persistedState.qqMsgIds = d.qqMsgIds;
      if (d.qqMsgIdAt && typeof d.qqMsgIdAt === "object") persistedState.qqMsgIdAt = d.qqMsgIdAt;
    }
  } catch { /* 首次运行没有该文件 */ }
}
let saveTimer = null;
export function savePersistedState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeFileSync(stateFilePath(), JSON.stringify(persistedState, null, 2)); } catch { /* 落盘失败不影响收发 */ }
  }, 800);
}

/** [v2.2.0] 六个渠道的清单（供 /status、面板自检表、脚本统一遍历） */
export const CHANNELS = ["telegram", "dingtalk", "feishu", "wecom", "qq", "wechat"];
export const CHANNEL_LABELS = {
  telegram: "Telegram", dingtalk: "钉钉", feishu: "飞书",
  wecom: "企业微信", qq: "QQ", wechat: "微信(iLink)",
};
/** 该渠道是否参与「双向自检」（分渠道设定：每个渠道一个 selfCheck 开关，默认开） */
export function selfCheckEnabled(cfg, ch) {
  const c = cfg?.[ch];
  if (!c) return false;
  return c.selfCheck !== false;
}

/* ---------------- 纯函数：目标解析 ---------------- */
/** QQ openid 形如 B237F05151A11D57DAB2743EAC38D040；纯数字是「群号/QQ号」，
 *  QQ 开放平台 v2 不接受，发过去必然 400「请求的资源不存在(用户/群已注销)」。 */
export function isQqOpenidLike(id) {
  const s = String(id || "").trim();
  if (s.length < 16) return false;
  if (/^\d+$/.test(s)) return false;
  return /^[A-Za-z0-9_-]{16,64}$/.test(s);
}

/** QQ 的 msg_id 只在一小段时间窗口内可用于「被动回复」；过期后仍带着它推送，
 *  平台会直接拒绝：`400 请求参数msg_id无效或越权`（实测）。这里给一个新鲜度判断。 */
export const QQ_MSG_ID_MAX_AGE_MS = 4 * 60 * 1000;
export function freshQqMsgId(state, id, nowMs, maxAgeMs) {
  const st = state || persistedState;
  const mid = st?.qqMsgIds?.[String(id)] || "";
  const at = st?.qqMsgIdAt?.[String(id)] || 0;
  if (!mid) return "";
  const max = Number.isFinite(maxAgeMs) ? maxAgeMs : QQ_MSG_ID_MAX_AGE_MS;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!at || now - at > max) return "";
  return mid;
}
export function rememberQqMsgId(id, msgId, nowMs) {
  const key = String(id);
  persistedState.qqMsgIds = persistedState.qqMsgIds || {};
  persistedState.qqMsgIdAt = persistedState.qqMsgIdAt || {};
  persistedState.qqMsgIds[key] = msgId;
  persistedState.qqMsgIdAt[key] = Number.isFinite(nowMs) ? nowMs : Date.now();
  savePersistedState();
}

/** 通知目标解析：从配置 + 持久化状态算出「每个渠道能往哪推」。 */
export function planNotifyTargets(cfg, state) {
  const st = state || persistedState;
  const targets = [];
  if (cfg?.telegram?.enabled && cfg.telegram.notify) {
    const chatId = cfg.telegram.notifyChatId || cfg.telegram.allowedChatIds?.[0];
    if (chatId) targets.push({ channel: "telegram", chatId: String(chatId) });
  }
  const dt = cfg?.dingtalk || {};
  if (dt.enabled && dt.notify) {
    /* 方案二（企业内部应用机器人）：AppKey+AppSecret+robotCode+目标；方案一：群机器人 Webhook */
    if (dt.scheme === "1" ? !!dt.outWebhook : (dt.appKey && dt.appSecret && dt.robotCode && dt.testTargetId)) {
      targets.push({ channel: "dingtalk", target: { id: String(dt.testTargetId || ""), type: dt.testTargetType || "user" } });
    }
  }
  const fs = cfg?.feishu || {};
  if (fs.enabled && fs.notify) {
    if (fs.scheme === "1" ? !!fs.outWebhook : (fs.appId && fs.appSecret && fs.testTargetId)) {
      targets.push({ channel: "feishu", target: { id: String(fs.testTargetId || ""), type: fs.testTargetType || "open_id" } });
    }
  }
  const wecomAppMsg = !!(cfg?.wecom?.corpid && cfg.wecom.corpsecret && cfg.wecom.agentid && cfg.wecom.touser);
  const wecomWsBot = !!(cfg?.wecom?.botId && cfg.wecom?.secret);
  if (cfg?.wecom?.enabled && cfg.wecom.notify && (cfg.wecom.outWebhook || wecomAppMsg || wecomWsBot)) {
    targets.push({ channel: "wecom" });
  }
  if (cfg?.qq?.enabled && cfg.qq.notify) {
    const openid = st.qqInbound && st.qqInbound.id ? String(st.qqInbound.id) : "";
    if (isQqOpenidLike(openid)) {
      targets.push({ channel: "qq", target: { type: st.qqInbound.type === "group" ? "group" : "private", id: openid } });
    } else if (cfg.qq.onebotUrl) {
      const gid = cfg.qq.groupId || (st.qqInbound && st.qqInbound.id) || "";
      if (gid) targets.push({ channel: "qq", target: { type: "group", id: String(gid) } });
    }
  }
  if (cfg?.wechat?.enabled && cfg.wechat.notify) {
    const uid = cfg.wechat.notifyUserId || cfg.wechat.allowedUserIds?.[0];
    /* [v2.1.0 实测修正] 之前要求「必须有 context_token 才推」，但实测 iLink 在会话窗口内
     * 允许无 token 的主动推送（`{"ok":true}`）；而 ret -2 是「没有可用会话窗口」。
     * 所以这里只要求「有目标用户」，有 token 就带上（更稳），没有也让推送尝试一次 ——
     * 失败时 sendWechat 会抛出带修复指引的错误（先在该会话发一条消息）。 */
    if (uid) {
      const tok = st.wechatContexts ? (st.wechatContexts[String(uid)]?.token || "") : "";
      targets.push({ channel: "wechat", chatId: String(uid), contextToken: tok });
    }
  }
  return targets;
}

/** 为什么某个渠道没进通知列表（给用户看得懂的理由）。 */
export function notifySkipReasons(cfg, state) {
  const st = state || persistedState;
  const has = (ch) => planNotifyTargets(cfg, st).some((t) => t.channel === ch);
  const out = [];
  if (cfg?.qq?.enabled && cfg.qq.notify && !has("qq")) {
    out.push("qq: 尚无可用会话 openid（先在 QQ 给机器人发一条消息，或改用 OneBot 方案并填群号）");
  }
  const dt2 = cfg?.dingtalk || {};
  if (dt2.enabled && dt2.notify && !has("dingtalk")) {
    out.push(dt2.scheme === "1" ? "dingtalk: 未配置方案一 Webhook 地址" : "dingtalk: 方案二需 AppKey+AppSecret+robotCode，并填通知目标（userId 或 openConversationId）");
  }
  const fs2 = cfg?.feishu || {};
  if (fs2.enabled && fs2.notify && !has("feishu")) {
    out.push(fs2.scheme === "1" ? "feishu: 未配置方案一 Webhook 地址" : "feishu: 方案二需 App ID+App Secret，并填通知目标（open_id / chat_id）");
  }
  if (cfg?.wechat?.enabled && cfg.wechat.notify && !has("wechat")) {
    out.push("wechat: 未配置通知目标用户（填「通知用户ID」，或在微信里先给机器人发一条消息以自动带上）");
  }
  return out;
}

/** [v2.2.0] 六渠道健康表：把「分渠道自检开关」与健康结论合成一份，供 /status 与面板表格用。
 *  infoMap: { <channel>: { tokenSet, pollerRunning } }；未给出的渠道按未启用处理。 */
export function channelHealthView(cfg, infoMap) {
  const out = {};
  for (const ch of CHANNELS) {
    const info = infoMap[ch] || {};
    const enabled = !!(cfg?.enabled && cfg?.[ch]?.enabled);
    const view = healthyView(ch, cfg, { enabled, tokenSet: !!info.tokenSet, pollerRunning: info.pollerRunning !== false });
    view.selfCheck = selfCheckEnabled(cfg, ch);
    view.label = CHANNEL_LABELS[ch];
    view.scheme = cfg?.[ch]?.scheme ?? null;
    /* 接收通道类型：轮询/长连接（telegram/wecom/qq/wechat） vs 平台回调（dingtalk/feishu 走 Webhook） */
    view.receiverKind = (ch === "telegram" || ch === "wechat") ? "poller" : (ch === "wecom" ? "socket" : "webhook");
    out[ch] = view;
  }
  return out;
}

/** 单渠道健康结论：ok=false 时 problems 里是给人看的原因，而不是让人去翻日志。
 *  notes 是「不影响判定、但值得知道」的提示（例如本次运行还没收到过入站消息 ——
 *  空闲不等于坏，用户发一条消息就能验证接收链路）。 */
export function healthyView(ch, cfg, info) {
  const r = hrec(ch);
  const problems = [];
  const notes = [];
  if (!info.enabled) problems.push("渠道未启用");
  if (info.enabled && !info.tokenSet) problems.push("凭据未配置完整");
  if (info.enabled && info.tokenSet && !info.pollerRunning) problems.push("接收通道未在运行（轮询/长连接未启动）");
  /* 偶发失败（例如 Telegram 长轮询超时后的瞬时 409）不该一票否决：连续 ≥3 次才算问题，
   * 单次失败降级为 notes，避免自检表长期挂着一条早已恢复的旧错。 */
  if (info.enabled && (r.poller.fails || 0) >= 3 && r.poller.lastError) problems.push("最近轮询连续失败 " + r.poller.fails + " 次：" + r.poller.lastError);
  else if (info.enabled && (r.poller.fails || 0) > 0 && r.poller.lastError) notes.push("偶发轮询失败（已恢复）：" + String(r.poller.lastError).slice(0, 60));
  if (r.outbound.lastOk === false && r.outbound.lastError) problems.push("最近出站失败：" + r.outbound.lastError);
  if (info.enabled && info.tokenSet && info.pollerRunning && r.inbound.count === 0) {
    notes.push("接收链路待验证：本次运行还没收到过入站消息");
  }
  return {
    enabled: info.enabled,
    credentials: info.tokenSet,
    receiver: info.pollerRunning,
    poller: { ...r.poller },
    inbound: { ...r.inbound },
    outbound: { ...r.outbound },
    ok: problems.length === 0,
    problems,
    notes,
  };
}
