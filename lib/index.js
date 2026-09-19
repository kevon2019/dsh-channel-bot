/**
 * dsh-channel-bot — multi-channel bot host half.
 *
 * Channels: Telegram (getUpdates polling), DingTalk / Feishu / WeCom (outbound
 * robot webhooks; DingTalk/Feishu also accept inbound webhook callbacks),
 * QQ via OneBot HTTP (inbound event report + outbound send).
 *
 * The bot answers commands that call panel features:
 *   /help /balance /status /plugins /version
 *
 * Configuration lives in the `channel-bot` settings namespace (visible in the
 * panel Settings UI via the settings.plugin.item card) and is persisted by
 * the settings service like any other namespace.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
// [hermes-ops 0.1.5-rc.1] dsh-settings 0.1.2+ 移除了 installSettingsSection/settingsNamespace；
// 0.1.5 恢复为服务级 installSection(ctx, ns, schema, entry, hooks)。见下方 apply() 内注册。
import z from "schemastery";
import AiBot from "@wecom/aibot-node-sdk";
import { createHmac, createHash, createDecipheriv, createPrivateKey, randomUUID, sign, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { markdownToText, splitLongText, inQuietHours } from "./render.js";
import { ChatSessionMap } from "./sessions.js";
import { dispatchTask } from "./dispatch.js";
import { ApprovalBridge } from "./approvals.js";
import {
  planNotifyTargets, notifySkipReasons, healthyView, isQqOpenidLike,
  hrec, markPoll, markInbound, markSkip, markOutbound,
  persistedState, loadPersistedState, savePersistedState,
  freshQqMsgId, rememberQqMsgId,
  CHANNELS, CHANNEL_LABELS, selfCheckEnabled, channelHealthView,
} from "./health.js";

const NS = "channel-bot";
const API_PREFIX = "/api/channel-bot";
const POLL_INTERVAL_MS = 2000;
const PROFILE_DIR = join(homedir(), ".dsh", "profiles", process.env.DSH_PROFILE ?? "web");
const BALANCE_URL = "https://api.deepseek.com/user/balance";
/* [2026-09-18 v2.0.0] 兼容性声明：随包声明本版本验证过的核心版本，并在 /status、/version
 * 与面板诊断里如实回显，避免「装了插件却不知道支不支持当前核心」。
 * 已在 dsh 0.1.6-alpha.1 全量实测（面板启动 / 设置分区 / 渠道连接 / 队列与命令 API）。 */
const COMPAT = Object.freeze({ testedCore: "0.1.6-alpha.1", minCore: "0.1.2-alpha.1" });
function pluginVersion() {
  try { return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? ""); }
  catch { return ""; }
}
const VERSION = pluginVersion();

/* Tencent official personal-WeChat Bot API (iLink / ClawBot) — see
   https://github.com/hao-ji-xing/cc-weixin/blob/main/weixin-bot-api.md */
const ILINK_BASE = "https://ilinkai.weixin.qq.com";
function ilinkHeaders(token) {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (2 << 8) | 0),
    "X-WECHAT-UIN": Buffer.from(String((Math.random() * 0xffffffff) >>> 0)).toString("base64"),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}




/* ------------------------------------------------------------------ */
/* Settings schema                                                     */
/* ------------------------------------------------------------------ */
const channelSchema = z.object({
  enabled: z.boolean().default(false),
  outWebhook: z.string().default(""),
  secret: z.string().default(""),
  notify: z.boolean().default(false),
});
const schema = z.object({
  enabled: z.boolean().default(true),
  prefix: z.string().default("/"),
  telegram: z.object({
    enabled: z.boolean().default(false),
    botToken: z.string().default(""),
    allowedChatIds: z.array(z.string()).default([]),
    notify: z.boolean().default(false),
    notifyChatId: z.string().default(""),
    selfCheck: z.boolean().default(true),     // [v2.2.0] 是否参与「双向自检」表（分渠道设定）
  }),
  /* 钉钉：[v2.2.0] 方案一 = 群机器人 Webhook + 加签；方案二 = 企业内部应用机器人（AppKey/AppSecret/robotCode）
   * 由插件按 scheme 选择逻辑；scheme 默认 "2"（应用机器人）——群机器人 Webhook 只在 scheme="1" 时使用。 */
  dingtalk: z.object({
    enabled: z.boolean().default(false),
    notify: z.boolean().default(false),
    scheme: z.string().default("2"),          // "1"=群机器人 Webhook（方案一） / "2"=企业内部应用机器人（方案二）
    outWebhook: z.string().default(""),       // 方案一
    secret: z.string().default(""),           // 方案一 加签密钥
    appKey: z.string().default(""),           // 方案二 AppKey
    appSecret: z.string().default(""),        // 方案二 AppSecret
    robotCode: z.string().default(""),        // 方案二 机器人编码（钉钉开放平台机器人设置里）
    callbackToken: z.string().default(""),    // 方案二 回调签名 token（可选，用于校验入站回调）
    callbackAesKey: z.string().default(""),   // 方案二 回调加密 aes_key（可选，填了则解密 encrypt 字段）
    testTargetId: z.string().default(""),     // 测试/通知目标：userId（单聊）或 openConversationId（群聊）
    testTargetType: z.string().default("user"), // user=单聊 / group=群聊
    selfCheck: z.boolean().default(true),
  }),
  /* 飞书：[v2.2.0] 方案一 = 群机器人 Webhook + 加签；方案二 = 自建应用（App ID/App Secret，im/v1/messages） */
  feishu: z.object({
    enabled: z.boolean().default(false),
    notify: z.boolean().default(false),
    scheme: z.string().default("2"),          // "1"=群机器人 Webhook / "2"=自建应用
    outWebhook: z.string().default(""),       // 方案一
    secret: z.string().default(""),           // 方案一 加签密钥
    appId: z.string().default(""),            // 方案二 App ID（cli_xxx）
    appSecret: z.string().default(""),        // 方案二 App Secret
    verificationToken: z.string().default(""),// 方案二 事件订阅 Verification Token（可选）
    encryptKey: z.string().default(""),       // 方案二 事件订阅 Encrypt Key（可选，填了则解密 encrypt 字段）
    testTargetId: z.string().default(""),     // 测试/通知目标：open_id / chat_id / email / user_id
    testTargetType: z.string().default("open_id"),
    selfCheck: z.boolean().default(true),
  }),
  wecom: z.object({
    enabled: z.boolean().default(false),
    outWebhook: z.string().default(""),
    corpid: z.string().default(""),
    corpsecret: z.string().default(""),
    agentid: z.string().default(""),
    touser: z.string().default(""),
    botId: z.string().default(""),   // 方案二 · OpenClaw 长链接（仅记录，不直接收发）
    secret: z.string().default(""),  // 方案二 · OpenClaw 长链接（仅记录，不直接收发）
    notify: z.boolean().default(false),
    testTargetId: z.string().default(""),  // 测试目标 ID（持久化，自动带出）
    selfCheck: z.boolean().default(true),
  }),
  qq: z.object({
    enabled: z.boolean().default(false),
    onebotUrl: z.string().default(""),
    accessToken: z.string().default(""),
    groupId: z.string().default(""),
    botId: z.string().default(""),   // 方案二 · OpenClaw 机器人模式（仅记录）
    secret: z.string().default(""),  // 方案二 · OpenClaw 机器人模式（仅记录）
    appId: z.string().default(""),   // 方案二 · QQ开放平台 v2 (AppSecret→getAppAccessToken)
    appSecret: z.string().default(""),
    notify: z.boolean().default(false),
    testTargetId: z.string().default(""),              // 测试目标 ID（openid 或 group_openid）
    testTargetType: z.string().default("private"),     // 测试目标类型（group/private，send 时校验）
    selfCheck: z.boolean().default(true),
  }),
  wechat: z.object({
    enabled: z.boolean().default(false),
    botToken: z.string().default(""),
    allowedUserIds: z.array(z.string()).default([]),
    botId: z.string().default(""),   // 方案二 · OpenClaw 机器人模式（仅记录）
    secret: z.string().default(""),  // 方案二 · OpenClaw 机器人模式（仅记录）
    notify: z.boolean().default(false),
    notifyUserId: z.string().default(""),
    testTargetId: z.string().default(""),  // 测试目标 ID（对方 @im.wechat 用户）
    selfCheck: z.boolean().default(true),
  }),
  commands: z.object({
    help: z.boolean().default(true),
    balance: z.boolean().default(true),
    spending: z.boolean().default(true),
    status: z.boolean().default(true),
    plugins: z.boolean().default(true),
    version: z.boolean().default(true),
  }),
  /* Remote conversation: an inbound non-command message becomes a real agent
   * turn in the DSH session bound to that chat. Off by default — it grants
   * whoever can message the bot the same power as the panel composer. */
  chat: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default(""),
    model: z.string().default(""),
    agentPreset: z.string().default(""),
    workspace: z.string().default(""),
    maxSessions: z.number().default(20),
    autoCreate: z.boolean().default(true),
    /* Stream partial replies while the human is present (activity within
     * presenceWindowMin); otherwise only the final result card is pushed. */
    stream: z.boolean().default(true),
    presenceWindowMin: z.number().default(10),
    flushIntervalMs: z.number().default(1200),
  }),
  /* Remote approval: risky tool calls in bot-bound sessions ask through IM. */
  approvals: z.object({
    enabled: z.boolean().default(false),
    minRisk: z.string().default("medium"),
    timeoutSec: z.number().default(300),
    pendingMaxSec: z.number().default(3600),
    riskRules: z.string().default(""),
  }),
  notifyEvents: z.object({
    completed: z.boolean().default(true),
    error: z.boolean().default(true),
    aborted: z.boolean().default(false),
    blocked: z.boolean().default(false),
    maxTokens: z.boolean().default(false),
    approval: z.boolean().default(true),
    lowBalance: z.boolean().default(false),
    lowBalanceThreshold: z.number().default(5),
    keywordInclude: z.string().default(""),
    keywordExclude: z.string().default(""),
    /* "22:00-08:00" style ranges (comma/newline separated): suppress pushes,
     * never suppress the task itself. */
    quietHours: z.string().default(""),
  }),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error("body too large")); request.destroy(); return; }
      chunks.push(c);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw === "" ? {} : JSON.parse(raw)); }
      catch { reject(new Error("invalid JSON body")); }
    });
    request.on("error", reject);
  });
}
function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}
function hmacBase64(secret, message) {
  return createHmac("sha256", secret).update(message).digest("base64");
}
function safeEqual(a, b) {
  try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  catch { return false; }
}
/** Trusted-host extension: allow requests whose Host is in DSH_TRUSTED_HOSTS (loopback socket still required by nginx layout). */
function isTrustedHost(request) {
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  const hostname = host.split(":")[0];
  const env = process.env.DSH_TRUSTED_HOSTS ?? "";
  return env.split(",").map((s) => s.trim().toLowerCase()).includes(hostname.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Command handlers — "call panel features"                            */
/* ------------------------------------------------------------------ */
function pluginList() {
  try {
    const pkg = JSON.parse(readFileSync(join(PROFILE_DIR, "package.json"), "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    return deps;
  } catch { return []; }
}
function harnessVersion() {
  /* /version 应读真正的 harness 核心版本，而非某个插件的传递依赖。
     之前读 PROFILE/node_modules/@deepseek-ai/dsh —— 恰被 dsh-browser 硬编码 pin 到 rc.1，
     导致 /version 显示 rc.1，而实际核心(global dsh + base/web-app/app-boot)是 rc.2。
     按核心包优先读取，缺失时回退。 */
  const cores = ["@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  for (const c of cores) {
    try {
      const v = JSON.parse(readFileSync(join(PROFILE_DIR, "node_modules", c, "package.json"), "utf8")).version;
      if (v) return v;
    } catch { /* try next */ }
  }
  try {
    return JSON.parse(readFileSync(join(PROFILE_DIR, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8")).version ?? "unknown";
  } catch { return "unknown"; }
}
async function fetchBalanceInfo() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const res = await fetch(BALANCE_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const data = await res.json();
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  if (infos.length === 0) return null;
  const first = infos[0];
  return {
    currency: first.currency,
    total: Number(first.total_balance) || 0,
    granted: Number(first.granted_balance) || 0,
    toppedUp: Number(first.topped_up_balance) || 0,
  };
}
async function deepseekBalance() {
  const info = await fetchBalanceInfo();
  if (info === null) return "未配置 DEEPSEEK_API_KEY 或余额接口不可用";
  return `${info.currency}: 总额 ${info.total}（赠送 ${info.granted} / 充值 ${info.toppedUp}）`;
}

/* ------------------------------------------------------------------ */
/* Session spending — DeepSeek V4 峰谷计价                              */
/* Pricing mirrored from @rainronin/dsh-balance-monitor (official V4    */
/* peak/off-peak rates, effective 2026-08-17 Beijing time).             */
/* ------------------------------------------------------------------ */
const DEEPSEEK_V4_PRICES = {
  flash: {
    peak: { cacheRead: 0.1, cacheMiss: 3.0, output: 9.0 },
    offpeak: { cacheRead: 0.05, cacheMiss: 1.5, output: 4.5 },
  },
  pro: {
    peak: { cacheRead: 0.3, cacheMiss: 9.0, output: 27.0 },
    offpeak: { cacheRead: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
};
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
function beijingDayStart(epoch) {
  const shifted = epoch + BEIJING_OFFSET_MS;
  return shifted - (shifted % DAY_MS) - BEIJING_OFFSET_MS;
}
function beijingWeekStart(epoch) {
  const dayStart = beijingDayStart(epoch);
  const dow = new Date(dayStart + BEIJING_OFFSET_MS).getUTCDay(); // 0=周日
  return dayStart - ((dow + 6) % 7) * DAY_MS; // 周一为一周起点
}
function beijingMonthStart(epoch) {
  const d = new Date(epoch + BEIJING_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - BEIJING_OFFSET_MS;
}
function beijingYearStart(epoch) {
  const d = new Date(epoch + BEIJING_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), 0, 1) - BEIJING_OFFSET_MS;
}
/** 北京时间的峰谷阶段：09:00-12:00 与 14:00-18:00 为高峰。 */
function pricingPhase(epoch) {
  const msIntoDay = epoch - beijingDayStart(epoch);
  return (msIntoDay >= 9 * HOUR_MS && msIntoDay < 12 * HOUR_MS) || (msIntoDay >= 14 * HOUR_MS && msIntoDay < 18 * HOUR_MS) ? "peak" : "offpeak";
}
function modelTierOf(model) {
  const id = String(model ?? "").toLowerCase();
  return id.includes("pro") ? "pro" : "flash";
}
/** 按官方 V4 峰谷价计算一个会话事件日志的累计费用（元）与 token 用量。
 * cacheMiss 按 input+cacheWrite 计；镜像 balance-monitor 的 computeSessionCost。 */
function computeSessionCost(events) {
  let costYuan = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let model;
  for (const event of events ?? []) {
    if (event?.type === "request/context") model = event.data?.model;
    else if (event?.type === "request/header" && model === undefined) model = event.data?.header?.config?.model;
    else if (event?.type === "assistant/message" && event.data?.usage) {
      const usage = event.data.usage;
      const price = DEEPSEEK_V4_PRICES[modelTierOf(model)][pricingPhase(typeof event.time === "number" ? event.time : Date.now())];
      const cacheMiss = (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      const cacheRead = usage.cacheReadTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      costYuan += (cacheMiss * price.cacheMiss + cacheRead * price.cacheRead + output * price.output) / 1_000_000;
      inputTokens += usage.inputTokens ?? 0;
      cacheReadTokens += cacheRead;
      cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      outputTokens += output;
    }
  }
  return { costYuan, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, model };
}
/** 元金额格式化：小金额保留更多小数位，去尾零。 */
function formatYuan(value) {
  const n = Number(value) || 0;
  if (n === 0) return "0";
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return String(Math.round(n * 1000) / 1000);
  return String(Math.round(n * 10000) / 10000);
}
/** Locate the raw event log of a persisted session: ~/.dsh/sessions/<group>/<id>/session.jsonl.zstd */
function findSessionLog(sessionId) {
  const root = join(homedir(), ".dsh", "sessions");
  try {
    for (const group of readdirSync(root)) {
      const p = join(root, group, sessionId, "session.jsonl.zstd");
      if (existsSync(p)) return p;
    }
  } catch { /* sessions root missing */ }
  return null;
}
/** Full event log of one session: live in-memory events first (they carry
 * token usage), then the raw zstd JSONL (persisted events also carry usage).
 * The sessionQuery service's listEvents strips event.data, so it cannot be
 * used for cost computation. */
async function readSessionEvents(ctx, sessionId) {
  try {
    const live = ctx.sessions?.get(sessionId);
    if (live !== void 0 && Array.isArray(live.events)) return live.events;
  } catch { /* live read best-effort */ }
  const p = findSessionLog(sessionId);
  if (p === null) return [];
  try {
    const raw = execFileSync("zstdcat", [p], { timeout: 15000, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    const events = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Plan + tool approval bridge for dsh-lark-bot compat.
 *
 * Provides two HTTP-facing contracts used by the dsh-lark-bot host plugins:
 *
 *  1. plan approval (`/api/channel-bot/plan-approval`):
 *     POST { token, sessionId, plan } → { ok, decision, feedback? }
 *     for `lark_request_plan_approval`.
 *
 *  2. tool approval (`/api/channel-bot/tool-approval`):
 *     - policy check: POST { policyCheckOnly: true } → { ok, policy: "allow" }
 *     - one-shot tool approval: POST { token, sessionId, toolName, ... }
 *       → { ok, outcome: "allowed-once" | "rejected" | ... }
 *     for `dsh-lark-bot/approval`.
 *
 * The inbound IM commands are:
 *   /planapprove <id> yes|no
 *   /toolapprove <id> yes|no
 */
class PlanToolApprovalBridge {
  constructor({ notify, token, timeoutMs = 10 * 60 * 1000 }) {
    this.notify = notify;
    this.token = token || "";
    this.timeoutMs = timeoutMs;
    this.planRecords = new Map();
    this.toolRecords = new Map();
    this.recent = new Map();
  }

  #validateToken(body) {
    const token = typeof body?.token === "string" ? body.token : "";
    return this.token !== "" && token === this.token;
  }

  #push(text) {
    if (typeof this.notify !== "function") return Promise.resolve(null);
    return Promise.resolve(this.notify(text)).catch(() => null);
  }

  #settle(map, id, result) {
    const record = map.get(String(id));
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    map.delete(String(id));
    this.recent.set(String(id), { result, at: Date.now() });
    if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value);
    if (typeof record.resolve === "function") record.resolve(result);
  }

  async handlePlan(body) {
    if (!this.#validateToken(body)) return { ok: false, error: "bad or missing token" };
    const plan = typeof body?.plan === "string" ? body.plan : "";
    if (!plan.trim()) return { ok: false, error: "plan is required" };
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    const text = [
      `📋 计划审批 #${id}`,
      sessionId ? `会话: ${sessionId}` : "",
      "",
      plan,
      "",
      `回复「/planapprove ${id} yes」批准；「/planapprove ${id} no」拒绝。`,
    ].filter(Boolean).join("\n");
    const record = { id, sessionId, plan, resolve: null, timer: null };
    const promise = new Promise((resolve) => { record.resolve = resolve; });
    record.timer = setTimeout(() => {
      this.#settle(this.planRecords, id, { ok: false, error: "timeout" });
    }, this.timeoutMs);
    this.planRecords.set(id, record);

    const push = await this.#push(text);
    const noChannel = push === null ||
      (push && push.ok === true && Array.isArray(push.sent) && push.sent.length === 0);
    if (noChannel) {
      this.#settle(this.planRecords, id, { ok: false, error: "no reachable IM channel" });
    }
    return promise;
  }

  respondPlan(id, answer, responder) {
    const record = this.planRecords.get(String(id));
    if (!record) return this.recent.has(String(id)) ? "ignored" : "not-found";
    if (answer !== "yes" && answer !== "no") return "ignored";
    const decision = answer === "yes" ? "approved" : "revise";
    this.#settle(this.planRecords, id, {
      ok: true,
      decision,
      feedback: `${responder}: ${decision}`,
    });
    return decision === "approved" ? "accepted" : "rejected";
  }

  async handleTool(body) {
    if (body?.policyCheckOnly === true) {
      // dsh-lark-bot/plan asks the bridge for the current scope policy before
      // every tool. Auto-allow here; the real per-tool approval is handled by
      // the tool-approval branch below.
      return { ok: true, policy: "allow" };
    }
    if (!this.#validateToken(body)) return { ok: false, error: "bad or missing token" };
    const toolName = typeof body?.toolName === "string" ? body.toolName : "";
    if (!toolName) return { ok: false, error: "toolName is required" };
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const reason = typeof body?.reason === "string" ? body.reason : "";
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    const text = [
      `🔐 工具审批 #${id}`,
      `工具: ${toolName}`,
      sessionId ? `会话: ${sessionId}` : "",
      reason ? `原因: ${reason}` : "",
      "",
      `回复「/toolapprove ${id} yes」批准；「/toolapprove ${id} no」拒绝。`,
    ].filter(Boolean).join("\n");
    const record = { id, toolName, sessionId, resolve: null, timer: null };
    const promise = new Promise((resolve) => { record.resolve = resolve; });
    record.timer = setTimeout(() => {
      this.#settle(this.toolRecords, id, { ok: false, error: "timeout" });
    }, this.timeoutMs);
    this.toolRecords.set(id, record);

    const push = await this.#push(text);
    const noChannel = push === null ||
      (push && push.ok === true && Array.isArray(push.sent) && push.sent.length === 0);
    if (noChannel) {
      this.#settle(this.toolRecords, id, { ok: false, error: "no reachable IM channel" });
    }
    return promise;
  }

  respondTool(id, answer, responder) {
    const record = this.toolRecords.get(String(id));
    if (!record) return this.recent.has(String(id)) ? "ignored" : "not-found";
    if (answer !== "yes" && answer !== "no") return "ignored";
    const outcome = answer === "yes" ? "allowed-once" : "rejected";
    this.#settle(this.toolRecords, id, {
      ok: true,
      outcome,
      denial: answer === "no" ? {
        layer: "tool-approval",
        reason: `the user rejected the one-shot approval for tool ${record.toolName}`,
        toChange: "choose a safer alternative or ask the user before requesting approval again",
      } : undefined,
    });
    return outcome === "allowed-once" ? "accepted" : "rejected";
  }

  pendingList() {
    const plans = [...this.planRecords.values()].map((r) => ({
      kind: "plan", id: r.id, tool: "plan", state: "waiting",
    }));
    const tools = [...this.toolRecords.values()].map((r) => ({
      kind: "tool", id: r.id, tool: r.toolName, state: "waiting",
    }));
    return [...plans, ...tools];
  }

  dispose() {
    for (const id of [...this.planRecords.keys()]) {
      this.#settle(this.planRecords, id, { ok: false, error: "disposed" });
    }
    for (const id of [...this.toolRecords.keys()]) {
      this.#settle(this.toolRecords, id, { ok: false, error: "disposed" });
    }
  }
}


async function handleCommand(cfg, text, services = {}) {
  const prefix = cfg.prefix || "/";
  if (typeof text !== "string" || !text.trim().startsWith(prefix)) return null;
  const tokens = text.trim().slice(prefix.length).split(/\s+/);
  const cmd = (tokens[0] || "").toLowerCase();
  const args = tokens.slice(1);
  const cmds = cfg.commands ?? {};
  if (cmd === "help" && cmds.help !== false) {
    const lines = ["可用命令："];
    if (cmds.balance !== false) lines.push(`  ${prefix}balance — 查询 DeepSeek 余额`);
    if (cmds.spending !== false) lines.push(`  ${prefix}spending — 会话花销（今日/本周/本月/今年）`);
    if (cmds.status !== false) lines.push(`  ${prefix}status — 面板服务状态`);
    if (cmds.plugins !== false) lines.push(`  ${prefix}plugins — 已安装插件清单`);
    if (cmds.version !== false) lines.push(`  ${prefix}version — Harness 版本`);
    if (cfg.chat?.enabled) {
      lines.push(
        `  ${prefix}new — 新建/重置本聊天绑定的会话`,
        `  ${prefix}end — 解绑本聊天的会话`,
        `  ${prefix}sessions — 已绑定的聊天与会话`,
        "",
        "直接发普通消息即可与 agent 对话（无需命令前缀）。",
      );
    }
    if (cfg.approvals?.enabled) lines.push(`  ${prefix}approve <id> yes|no — 远程批准/拒绝工具调用`);
    lines.push(`  ${prefix}planapprove <id> yes|no — 远程批准/拒绝计划审批`);
    lines.push(`  ${prefix}toolapprove <id> yes|no — 远程批准/拒绝工具审批`);

    lines.push(`  ${prefix}help — 本帮助`);
    return lines.join("\n");
  }
  if (cmd === "balance" && cmds.balance !== false) return await deepseekBalance();
  if (cmd === "spending" && cmds.spending !== false && typeof services.spending === "function") return await services.spending();
  if (cmd === "approve" && typeof services.approve === "function") {
    if (args.length < 2) return `用法：${prefix}approve <id> yes|no`;
    return services.approve(args[0], args[1].toLowerCase());
  }
    if (cmd === "planapprove" && typeof services.planApprove === "function") {
      if (args.length < 2) return `用法：${prefix}planapprove <id> yes|no`;
      return services.planApprove(args[0], args[1].toLowerCase());
    }
    if (cmd === "toolapprove" && typeof services.toolApprove === "function") {
      if (args.length < 2) return `用法：${prefix}toolapprove <id> yes|no`;
      return services.toolApprove(args[0], args[1].toLowerCase());
    }

  if (cmd === "new" && typeof services.newSession === "function") return await services.newSession();
  if (cmd === "end" && typeof services.endSession === "function") return await services.endSession();
  if (cmd === "sessions" && typeof services.listSessions === "function") return services.listSessions();
  if (cmd === "status" && cmds.status !== false) {
    const channels = [];
    if (cfg.telegram?.enabled) channels.push("Telegram");
    if (cfg.dingtalk?.enabled) channels.push("钉钉");
    if (cfg.feishu?.enabled) channels.push("飞书");
    if (cfg.wecom?.enabled) channels.push("企业微信");
    if (cfg.qq?.enabled) channels.push("QQ");
    if (cfg.wechat?.enabled) channels.push("微信");
    const lines = [
      `Harness ${harnessVersion()}`,
      `进程运行 ${Math.floor(process.uptime() / 60)} 分钟`,
      `已启用渠道: ${channels.length ? channels.join("、") : "无"}`,
      `插件总数: ${pluginList().length}`,
      `远程对话: ${cfg.chat?.enabled ? "开" : "关"} · 远程审批: ${cfg.approvals?.enabled ? `开（≥${cfg.approvals.minRisk || "medium"}）` : "关"}`,
    ];
    if (typeof services.sessionCount === "function") lines.push(`已绑定会话: ${services.sessionCount()}`);
    if (typeof services.pendingApprovals === "function") {
      const pending = services.pendingApprovals();
      if (pending.length > 0) {
        lines.push(`待审批 ${pending.length} 条:`);
        for (const p of pending.slice(0, 5)) lines.push(`  #${p.id} ${p.tool} (${p.risk}, ${p.ageSec}s)`);
      }
    }
    return lines.join("\n");
  }
  if (cmd === "plugins" && cmds.plugins !== false) {
    const list = pluginList();
    if (list.length === 0) return "无法读取插件清单";
    return `已安装 ${list.length} 个插件:\n${list.slice(0, 25).join("\n")}${list.length > 25 ? `\n…共 ${list.length} 个` : ""}`;
  }
  if (cmd === "version" && cmds.version !== false) return `DeepSeek Harness ${harnessVersion()}（多渠道机器人 v${VERSION} · 已验证 ${COMPAT.testedCore}）`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Outbound senders                                                    */
/* ------------------------------------------------------------------ */
async function sendTelegram(cfg, chatId, text) {
  const token = cfg.telegram?.botToken;
  if (!token) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: String(chatId), text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`telegram send HTTP ${res.status}`);
}
/* ================================================================== */
/* [v2.2.0] 方案二：钉钉企业内部应用机器人 / 飞书自建应用               */
/*   与企微/QQ 的方案二同一套思路：应用级凭据换 access_token，再调       */
/*   开放平台的发消息接口；错误一律带平台返回的 code/message，不静默。   */
/* ================================================================== */
let dingTokenCache = { token: "", exp: 0 };
async function getDingAccessToken(appKey, appSecret) {
  if (dingTokenCache.token && Date.now() < dingTokenCache.exp) return dingTokenCache.token;
  const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ appKey, appSecret }), signal: AbortSignal.timeout(10000),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.accessToken) throw new Error(`钉钉 accessToken 获取失败: ${d.code ?? res.status} ${d.message ?? ""}`);
  dingTokenCache = { token: d.accessToken, exp: Date.now() + ((Number(d.expireIn) || 7200) * 1000) - 60000 };
  return dingTokenCache.token;
}
/* 方案二发消息：单聊 /v1.0/robot/oToMessages/batchSend，群聊 /v1.0/robot/groupMessages/send */
async function sendDingTalkScheme2(dt, text, target) {
  const { appKey, appSecret, robotCode } = dt || {};
  if (!appKey || !appSecret) throw new Error("未配置方案二（钉钉 AppKey + AppSecret）");
  if (!robotCode) throw new Error("未配置方案二（钉钉 robotCode 机器人编码）");
  const id = String(target?.id || "").trim();
  if (!id) throw new Error("钉钉方案二缺少目标：填「目标ID」（单聊 userId 或群 openConversationId）");
  const token = await getDingAccessToken(appKey, appSecret);
  const isGroup = target?.type === "group";
  const url = isGroup
    ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
    : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
  const payload = isGroup
    ? { robotCode, openConversationId: id, msgKey: "sampleText", msgParam: JSON.stringify({ content: text }) }
    : { robotCode, userIds: [id], msgKey: "sampleText", msgParam: JSON.stringify({ content: text }) };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body && body.code && body.code !== "0")) {
    throw new Error(`钉钉方案二发送失败: HTTP ${res.status} ${body.code ?? ""} ${body.message ?? ""}`.trim());
  }
  return body;
}
let feishuTokenCache = { token: "", exp: 0 };
async function getFeishuTenantToken(appId, appSecret) {
  if (feishuTokenCache.token && Date.now() < feishuTokenCache.exp) return feishuTokenCache.token;
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(10000),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.tenant_access_token) throw new Error(`飞书 tenant_access_token 获取失败: ${d.code ?? res.status} ${d.msg ?? ""}`);
  feishuTokenCache = { token: d.tenant_access_token, exp: Date.now() + ((Number(d.expire) || 7200) * 1000) - 60000 };
  return feishuTokenCache.token;
}
/* 方案二发消息：POST /open-apis/im/v1/messages?receive_id_type=... */
async function sendFeishuScheme2(fs, text, target) {
  const { appId, appSecret } = fs || {};
  if (!appId || !appSecret) throw new Error("未配置方案二（飞书 App ID + App Secret）");
  const id = String(target?.id || "").trim();
  if (!id) throw new Error("飞书方案二缺少目标：填「目标ID」（open_id / chat_id / email / user_id）");
  const type = ["open_id", "chat_id", "email", "user_id", "union_id"].includes(target?.type) ? target.type : "open_id";
  const token = await getFeishuTenantToken(appId, appSecret);
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(type)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: id, msg_type: "text", content: JSON.stringify({ text }) }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body && typeof body.code === "number" && body.code !== 0)) {
    throw new Error(`飞书方案二发送失败: HTTP ${res.status} ${body.code ?? ""} ${body.msg ?? ""}`.trim());
  }
  return body;
}
/* 飞书事件订阅 encrypt 字段解密（AES-256-CBC；官方算法：key=sha256(encryptKey)，iv=密文前 16 字节） */
function feishuDecrypt(encryptKey, encrypted) {
  try {
    const key = createHash("sha256").update(String(encryptKey), "utf8").digest();
    const buf = Buffer.from(String(encrypted), "base64");
    const iv = buf.subarray(0, 16);
    const data = buf.subarray(16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(false);
    let out = Buffer.concat([decipher.update(data), decipher.final()]);
    const pad = out[out.length - 1];
    if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
    return JSON.parse(out.toString("utf8"));
  } catch (e) { return null; }
}
async function sendDingTalk(cfg, text, target) {
  const dt = cfg?.dingtalk || {};
  /* [v2.2.0] scheme="2"（默认）= 企业内部应用机器人；只有 scheme="1" 才走群机器人 Webhook */
  if (dt.scheme !== "1" && (dt.appKey || dt.appSecret || dt.robotCode)) {
    return sendDingTalkScheme2(dt, text, target || { id: dt.testTargetId, type: dt.testTargetType });
  }
  const url = dt.outWebhook;
  if (!url) throw new Error(dt.scheme === "1" ? "未配置钉钉方案一（群机器人 Webhook 地址）" : "未配置钉钉（方案二需 AppKey+AppSecret+robotCode；方案一需 Webhook）");
  if (cfg.dingtalk?.secret) {
    const ts = Date.now();
    const sign = encodeURIComponent(hmacBase64(cfg.dingtalk.secret, `${ts}\n${cfg.dingtalk.secret}`));
    url += `${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${sign}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`dingtalk send HTTP ${res.status}`);
}
async function sendFeishu(cfg, text, target) {
  const fs = cfg?.feishu || {};
  /* [v2.2.0] scheme="2"（默认）= 自建应用；只有 scheme="1" 才走群机器人 Webhook */
  if (fs.scheme !== "1" && (fs.appId || fs.appSecret)) {
    return sendFeishuScheme2(fs, text, target || { id: fs.testTargetId, type: fs.testTargetType || "open_id" });
  }
  const url = fs.outWebhook;
  if (!url) throw new Error(fs.scheme === "1" ? "未配置飞书方案一（群机器人 Webhook 地址）" : "未配置飞书（方案二需 App ID+App Secret；方案一需 Webhook）");
  const headers = { "content-type": "application/json" };
  if (cfg.feishu?.secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-lark-request-timestamp"] = ts;
    headers["x-lark-signature"] = hmacBase64(cfg.feishu.secret, `${ts}\n${cfg.feishu.secret}`);
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ msg_type: "text", content: { text } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`feishu send HTTP ${res.status}`);
}
let wecomWs = null;      // 企微智能机器人 WebSocket 客户端（方案二）
let wecomChatId = "";    // 最近收到企微消息的会话 userid，用于主动推送
let wecomBindingResolver = () => "";   // [v2.1.0] apply() 注入：读持久化的企微会话绑定，重启后仍能主动推送
function resolveWecomTarget(cfgOrWx, explicit) {
  const t = String(explicit || "").trim();
  if (t) return t;
  const wx = (cfgOrWx && cfgOrWx.wecom) ? cfgOrWx.wecom : (cfgOrWx || {});
  if (wx.touser) return String(wx.touser);
  if (wecomChatId) return wecomChatId;
  try { const f = wecomBindingResolver(); if (f) return String(f); } catch { /* ignore */ }
  return "";
}
async function sendWecom(cfg, text, opts) {
  const wx = cfg.wecom || {};
  const forceS1 = !!(opts && opts.scheme === "1");
  const forceS2 = !!(opts && opts.scheme === "2");
  const touserOv = (opts && opts.touser) || "";
  // 方案二：企微智能机器人（botId+secret，Bot WebSocket）——可主动推送
  if (!forceS1 && wx.botId && wx.secret && wecomWs) {
    const chatId = resolveWecomTarget(wx, touserOv);
    if (!chatId) { console.log("[wecom] sendWecom 无目标会话(chatId 空)"); return; }
    console.log("[wecom] sendWecom 主动推送 chatId=", chatId);
    try { await wecomWs.sendMessage(chatId, { msgtype: "markdown", markdown: { content: text } }); console.log("[wecom] sendMessage 已发"); return; }
    catch (e) { console.warn("[wecom] sendMessage 失败:", e?.message || String(e)); return; }
  }
  // 企业微信应用消息（发到指定成员个人）：corpid + corpsecret + agentid + touser
  const cb = cfg.wecom || {};
  if (cb.corpid && cb.corpsecret && cb.agentid && (touserOv || cb.touser)) {
    const tk = await (await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(wx.corpid)}&corpsecret=${encodeURIComponent(wx.corpsecret)}`)).json();
    if (!tk.access_token) throw new Error(`wecom gettoken failed: ${tk.errcode} ${tk.errmsg}`);
    const body = { touser: touserOv || wx.touser, agentid: Number(wx.agentid), msgtype: "text", text: { content: text }, safe: 0 };
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tk.access_token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.errcode !== 0) throw new Error(`wecom send err ${j.errcode} ${j.errmsg}`);
    return;
  }
  const url = cfg.wecom?.outWebhook;
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { content: text } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`wecom send HTTP ${res.status}`);
}
// QQ 开放平台 v2 回调地址验证签名：Ed25519，seed=repeat(appSecret,32)，签名体 = event_ts + plain_token
function qqCallbackSignature(appSecret, plainToken, eventTs) {
  const bs = Buffer.from(String(appSecret), "utf8");
  const seed = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) seed[i] = bs[i % bs.length];
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const msg = Buffer.from(`${String(eventTs)}${String(plainToken)}`, "utf8");
  return sign(null, msg, key).toString("hex");
}
const qqMsgIdMap = new Map(); // openid/group_openid → 最近收到的 msg_id（被动回复必带，等价微信 context_token）
/* [hermes-ops 2026-09-10] QQ 开放平台 v2 按 `msg_seq` 去重：不传或复用同值时报
 * 「消息被去重，请检查请求msgseq」(code 40054005)——实测「同一 msg_id 下的第二次发送」
 * 必命中（被动回复后再主动推一条就 400）。改为每条消息带进程内递增的 msg_seq，
 * 取值收敛在 1..65000（uint16 安全区），基准取启动时的秒级时间戳避免重启撞值。 */
let qqMsgSeqCounter = Math.floor(Date.now() / 1000) % 60000;
function nextQqMsgSeq() {
  qqMsgSeqCounter += 1;
  if (qqMsgSeqCounter > 65000) qqMsgSeqCounter = 1;
  return qqMsgSeqCounter;
}
let qqTokCache = { token: "", exp: 0 };
async function getQqToken(q) {
  if (qqTokCache.token && Date.now() < qqTokCache.exp) return qqTokCache.token;
  const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: q.appId, clientSecret: q.appSecret }),
    signal: AbortSignal.timeout(10000),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.access_token) throw new Error(`qq getAppAccessToken fail: ${d.code ?? ""} ${d.message ?? ""}`);
  qqTokCache = { token: d.access_token, exp: Date.now() + ((Number(d.expires_in) || 7200) * 1000) - 60000 };
  return qqTokCache.token;
}
async function sendQqV2(q, target, text, opts) {
  const token = await getQqToken(q);
  const isGroup = target?.type === "group";
  const id = String(target?.id ?? "");
  if (!id) return;
  const url = isGroup
    ? `https://api.sgroup.qq.com/v2/groups/${encodeURIComponent(id)}/messages`
    : `https://api.sgroup.qq.com/v2/users/${encodeURIComponent(id)}/messages`;
  const payload = { content: text, msg_type: 0 };
  /* [v2.1.0] msg_id 的使用规则（实测踩出来的）：
   *  · 只有「被动回复刚收到的那条消息」才该带 msg_id，且只在新窗口内有效（约 5 分钟）；
   *  · 通知/主动推送带旧 msg_id 会被平台拒绝：`400 请求参数msg_id无效或越权`(40034024)；
   *  · 因此由调用方声明 passive —— dispatchReply（回复入站）传 true，notify/test 走主动推送（false）。 */
  const wantPassive = opts?.passive === true;
  const fromMem = wantPassive ? (qqMsgIdMap.get(id) || "") : "";
  const mid = fromMem || (wantPassive ? (freshQqMsgId(persistedState, id) || "") : "");
  if (!wantPassive) qqMsgIdMap.delete(id);
  const seq = nextQqMsgSeq();
  payload.msg_seq = seq;   // [hermes-ops] 必带唯一序号，否则平台按「消息被去重」拒绝
  console.log("[qq] v2 send type=", target?.type, "id=", id, "mid=", mid ? "YES" : "NO", "seq=", seq, "map=", qqMsgIdMap.size);
  if (mid) payload.msg_id = mid;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`qq v2 send HTTP ${res.status}: ${t.slice(0, 140)}`); }
}
async function sendQq(cfg, target, text, opts) {
  const q = cfg?.qq || {};
  if (q.appId && q.appSecret) return sendQqV2(q, target, text, opts);
  const base = q.onebotUrl;
  if (!base) return;
  const headers = { "content-type": "application/json" };
  if (q.accessToken) headers.authorization = `Bearer ${q.accessToken}`;
  const payload = target.type === "group"
    ? { group_id: Number(target.id), message: text }
    : { user_id: Number(target.id), message: text };
  const res = await fetch(`${base.replace(/\/$/, "")}/${target.type === "group" ? "send_group_msg" : "send_private_msg"}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`qq send HTTP ${res.status}`);
}
const wechatCtxMap = new Map(); // chatId → iLink context_token（本次进程内缓存；同时落盘到 channel-bot-state.json）
async function sendWechat(cfg, target, text) {
  const token = cfg.wechat?.botToken;
  if (!token) { markOutbound("wechat", false, "未配置 botToken"); return; }
  /* [v2.1.0] context_token 优先用入站消息带来的那份；没有就用落盘的缓存
   * （旧版只存在内存里，面板一重启就丢 → 通知必然 ret -2）。 */
  const cached = persistedState.wechatContexts[String(target.chatId)]?.token || "";
  const ctxTok = target.contextToken || cached || "";
  const res = await fetch(`${ILINK_BASE}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: ilinkHeaders(token),
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: target.chatId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        ...(ctxTok ? { context_token: ctxTok } : {}),
        item_list: [{ type: 1, text_item: { text } }],
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`wechat send HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data && typeof data.ret === "number" && data.ret !== 0) {
    const msg = `wechat send ret ${data.ret}${data.err_msg ? `: ${data.err_msg}` : ""}`;
    if (!ctxTok) {
      throw new Error(msg + " —— 微信单聊不支持主动推送：请先在该微信会话里给机器人发一条消息"
        + "（插件会用那条消息的 context_token 做被动回复；本机已缓存 " + Object.keys(persistedState.wechatContexts).length + " 个会话），或改用方案二（仅记录）。");
    }
    throw new Error(msg);
  }
}
/* 出站健康登记集中在 answer()/notifyTarget() 两处（覆盖 reply 与 push 两条路径）。 */
async function dispatchReply(cfg, context, text) {
  switch (context.channel) {
    case "telegram": await sendTelegram(cfg, context.chatId, text); break;
    case "dingtalk": await sendDingTalk(cfg, text); break;
    case "feishu": await sendFeishu(cfg, text); break;
    case "wecom": await sendWecom(cfg, text); break;
    case "qq": await sendQq(cfg, context.target, text, { passive: true }); break;
    case "wechat": await sendWechat(cfg, context, text); break;
  }
}
async function answer(cfg, context, text) {
  try { await dispatchReply(cfg, context, text); markOutbound(context.channel, true); }
  catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    markOutbound(context.channel, false, msg);
    console.error("[channel-bot] reply failed:", msg);
  }
}

/* ------------------------------------------------------------------ */
/* Notification channel — outbound push to the user                    */
/* ------------------------------------------------------------------ */
/** Resolve which channels are allowed to receive notifications, with their
 * delivery targets. Webhook channels (dingtalk/feishu/wecom) push to the
 * group behind their configured webhook; telegram/wechat need an explicit
 * target id (own notify* field, falling back to the first allowed id);
 * qq pushes to the configured group. */
function notifyTargets(cfg) {
  /* [v2.1.0] 目标解析改为纯函数 planNotifyTargets(cfg, persistedState)：
   * - 企微补上「方案二（botId+secret 长连接）」这条路径（旧版只认 webhook/应用消息，
   *   导致当前部署下企微永远收不到通知）；
   * - QQ 方案二只在「收到过入站消息、且会话 id 是合法 openid」时才推
   *   （旧版会把数字群号/appId 当目标，必然 400「请求的资源不存在」）；
   * - 微信只在有 context_token（内存或落盘缓存）时才推，否则跳过并留痕。 */
  const targets = planNotifyTargets(cfg, persistedState);
  for (const reason of notifySkipReasons(cfg, persistedState)) {
    console.log("[channel-bot] 通知目标跳过 →", reason);
  }
  return targets;
}
async function notifyTarget(cfg, target, text) {
  try {
    switch (target.channel) {
      case "telegram": await sendTelegram(cfg, target.chatId, text); break;
      case "dingtalk": await sendDingTalk(cfg, text, target.target); break;
      case "feishu": await sendFeishu(cfg, text, target.target); break;
      case "wecom": await sendWecom(cfg, text); break;
      case "qq": await sendQq(cfg, target.target, text); break;
      case "wechat": await sendWechat(cfg, { channel: "wechat", chatId: target.chatId, contextToken: target.contextToken }, text); break;
      default: throw new Error(`unknown notification channel "${target.channel}"`);
    }
    markOutbound(target.channel, true);
  } catch (error) {
    markOutbound(target.channel, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
/** Push text to every configured notification channel (or a single one when
 * `only` is set). Best-effort per channel: failures are collected, never
 * thrown, so one dead channel cannot block the others. */
async function notifyChannels(cfg, text, only) {
  let targets = notifyTargets(cfg);
  if (only) targets = targets.filter((t) => t.channel === only);
  const sent = [];
  const failed = [];
  for (const target of targets) {
    try {
      await notifyTarget(cfg, target, text);
      sent.push(target.channel);
    } catch (error) {
      failed.push({ channel: target.channel, error: error instanceof Error ? error.message : String(error) });
      console.warn("[channel-bot] notify failed:", target.channel, error instanceof Error ? error.message : String(error));
    }
  }
  return { sent, failed };
}

/** Send a single test message to one channel, directly with its own
 * credentials — independent of the notify switch and of `notifyTargets`.
 * This is what the per-channel "测试验证" button calls. Throws on any
 * missing/credential/connectivity failure so the client can surface it. */
async function testChannel(cfg, channel, scheme, target, targetType) {
  const text = "✅ DSH 渠道测试：能收到说明「" + channel + "」配置可用。";
  try {
    const r = await testChannelInner(cfg, channel, scheme, target, targetType, text);
    markOutbound(channel, true);
    return r;
  } catch (e) {
    markOutbound(channel, false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
async function testChannelInner(cfg, channel, scheme, target, targetType, text) {
  switch (channel) {
    case "telegram": {
      const t = cfg?.telegram || {};
      const chatId = t.notifyChatId || t.allowedChatIds?.[0];
      if (!chatId) throw new Error("未配置 Telegram 接收 ID（通知 Chat ID 或允许的 Chat ID）");
      await sendTelegram(cfg, String(chatId), text);
      break;
    }
    case "dingtalk": {
      const dt = cfg?.dingtalk || {};
      const ty = (targetType === "group" ? "group" : "user");
      const t = (target || "").trim() || dt.testTargetId || "";
      if (dt.scheme === "1" || (scheme === "1")) {
        if (!dt.outWebhook) throw new Error("未配置钉钉方案一（群机器人 Webhook 地址）");
        await sendDingTalk({ ...cfg, dingtalk: { ...dt, scheme: "1" } }, text);
        break;
      }
      /* 方案二：企业内部应用机器人 */
      if (!dt.appKey || !dt.appSecret) throw new Error("未配置方案二（钉钉 AppKey + AppSecret）");
      if (!dt.robotCode) throw new Error("未配置方案二（钉钉 robotCode 机器人编码）");
      if (!t) throw new Error("钉钉方案二缺少目标：填「目标ID」= 单聊 userId 或群 openConversationId");
      await sendDingTalkScheme2(dt, text, { id: t, type: ty });
      console.log("[channel-bot] 钉钉方案二测试已发 target=", t, "type=", ty);
      break;
    }
    case "feishu": {
      const fs = cfg?.feishu || {};
      const t = (target || "").trim() || fs.testTargetId || "";
      const ty = (targetType || fs.testTargetType || "open_id").trim();
      if (fs.scheme === "1" || (scheme === "1")) {
        if (!fs.outWebhook) throw new Error("未配置飞书方案一（群机器人 Webhook 地址）");
        await sendFeishu({ ...cfg, feishu: { ...fs, scheme: "1" } }, text);
        break;
      }
      if (!fs.appId || !fs.appSecret) throw new Error("未配置方案二（飞书 App ID + App Secret）");
      if (!t) throw new Error("飞书方案二缺少目标：填「目标ID」（open_id / chat_id / email / user_id）");
      await sendFeishuScheme2(fs, text, { id: t, type: ty });
      console.log("[channel-bot] 飞书方案二测试已发 target=", t, "type=", ty);
      break;
    }
    case "wecom": {
      const wx = cfg?.wecom || {};
      const appMsg = wx.corpid && wx.corpsecret && wx.agentid && wx.touser;
      const t = (target || "").trim();
      if (scheme === "2") {
        /* 方案二：智能机器人长连接（botId+secret），目标 = 指定 target || touser || 最近会话 */
        if (!wx.botId || !wx.secret) throw new Error("未配置方案二（企微智能机器人 Bot ID+Secret）");
        /* [v2.2.0] 配置变更会让长连接重连；自检时给它最多 ~8 秒窗口，而不是立刻报「未连接」 */
        for (let i = 0; i < 16 && !wecomWs; i++) await new Promise((r) => setTimeout(r, 500));
        if (!wecomWs) throw new Error("企业微信长连接尚未就绪（正在初始化/重连，请稍后点「自检」重试）");
        const tgt = resolveWecomTarget(wx, t);
        if (!tgt) throw new Error("企业微信长连接已认证，但尚无目标会话；请填一个「目标ID」或先在企微向机器人发一条消息");
        await wecomWs.sendMessage(String(tgt), { msgtype: "markdown", markdown: { content: text } });
        console.log("[channel-bot] wecom 长连接测试已发 target=", tgt);
        break;
      }
      if (scheme === "1") {
        /* 方案一：应用消息 / Webhook */
        if (!appMsg && !wx.outWebhook) throw new Error("未配置方案一（需填 4 项应用消息参数或 Webhook 地址）");
        await sendWecom(cfg, text, { scheme: "1", touser: t });
        break;
      }
      /* 未指定：优先方案一，否则方案二 */
      if (appMsg || wx.outWebhook) { await sendWecom(cfg, text, { touser: t }); break; }
      if (wx.botId && wx.secret) {
        if (!wecomWs) throw new Error("企业微信长连接客户端未连接，请稍后重试");
        const tgt = resolveWecomTarget(wx, t);
        if (!tgt) throw new Error("企业微信长连接已认证，但尚无目标会话；请填一个「目标ID」或先在企微向机器人发一条消息");
        await wecomWs.sendMessage(String(tgt), { msgtype: "markdown", markdown: { content: text } });
        break;
      }
      throw new Error("未配置企业微信（需填应用消息参数、Webhook、或方案二 Bot ID+Secret）");
    }
    case "qq": {
      const q = cfg?.qq || {};
      const t = (target || "").trim();
      const ty = targetType === "group" ? "group" : "private";
      if (scheme === "2" || (!scheme && q.appId && q.appSecret)) {
        /* 方案二：QQ 开放平台 v2（appId+appSecret），目标 = 指定 target(openid/group_openid) || 最近收到消息的会话 */
        if (!q.appId || !q.appSecret) throw new Error("未配置方案二（QQ 开放平台 AppID+AppSecret）");
        const tk = await (await fetch("https://bots.qq.com/app/getAppAccessToken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: q.appId, clientSecret: q.appSecret }) })).json();
        if (!tk.access_token) throw new Error("QQ 开放平台 v2 access_token 获取失败: " + (tk.code ?? "") + " " + (tk.message ?? ""));
        const id = t || persistedState.qqInbound?.id || qqMsgIdMap.keys().next().value;
        if (!id) throw new Error("QQ 开放平台 v2 凭据验证通过，但尚无目标会话；请填一个「目标ID」(对方openid/group_openid) 或先在 QQ 给机器人发一条消息");
        await sendQq(cfg, { type: ty, id: String(id) }, text);
        break;
      }
      if (scheme === "1") {
        /* 方案一：OneBot HTTP */
        if (!q.onebotUrl) throw new Error("未配置方案一（QQ OneBot 地址）");
        const id = t || q.groupId;
        if (!id) throw new Error("未配置方案一（QQ 群号，测试发到群；或填一个目标ID）");
        await sendQq(cfg, { type: ty, id: String(id) }, text);
        break;
      }
      /* 未配置 v2 且未指定：走 OneBot */
      if (!q.onebotUrl) throw new Error("未配置 QQ OneBot 地址");
      if (!q.groupId) throw new Error("未配置 QQ 群号（测试发到群）");
      await sendQq(cfg, { type: "group", id: String(q.groupId) }, text);
      break;
    }
    case "wechat": {
      const w = cfg?.wechat || {};
      const t = (target || "").trim();
      if (scheme === "2") {
        /* 方案二：OpenClaw / ClawBot 模式 —— 仅配置记录（本插件不直接收发）。
         * 明确走校验分支，避免误落到方案一发送造成「点了方案二却在测 iLink」的误导。 */
        if (!w.botId || !w.secret) throw new Error("未配置方案二（需填 OpenClaw Bot ID + Secret；此方案仅作配置记录，不直接收发）");
        console.log("[channel-bot] wechat 方案二配置校验通过（记录型，未实际发送）");
        return "方案二配置已记录（Bot ID + Secret 完整）——该方案仅作配置记录/展示，实际收发由 OpenClaw 侧承担，本插件不发送消息。";
      }
      const uid = t || w.notifyUserId || w.allowedUserIds?.[0];
      if (!uid) throw new Error("未配置微信接收用户 ID（通知用户 ID、允许的用户 ID、或填一个目标ID）");
      /* 微信单聊不支持机器人「主动推送」：必须带上最近一条入站消息的 context_token 做被动回复。
       * 有缓存就用（这才是「测试验证」真正可用的路径），没有则给出可操作的解释。 */
      const ctxTok = wechatCtxMap.get(String(uid)) || "";
      try {
        await sendWechat(cfg, { channel: "wechat", chatId: String(uid), contextToken: ctxTok }, text);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!ctxTok && /ret\s*-?\d+/.test(msg)) {
          throw new Error(msg + " —— 微信单聊不支持主动推送：请先在微信给机器人发一条消息（插件会用该消息的 context_token 被动回复；本机缓存 " + wechatCtxMap.size + " 个会话），或改用方案二（仅记录）。");
        }
        throw error;
      }
      break;
    }
    default:
      throw new Error(`未知渠道: ${channel}`);
  }
  return { ok: true, sent: channel };
}

/* Low-balance alert: throttled to one API hit per 30 min, best-effort. */
let lastBalanceCheckMs = 0;
async function checkLowBalance(notifier, getConfig) {
  const cfg = getConfig();
  if (!cfg?.enabled || !cfg?.notifyEvents?.lowBalance) return;
  const threshold = typeof cfg.notifyEvents.lowBalanceThreshold === "number" && Number.isFinite(cfg.notifyEvents.lowBalanceThreshold)
    ? cfg.notifyEvents.lowBalanceThreshold
    : 5;
  const now = Date.now();
  if (now - lastBalanceCheckMs < 30 * 60 * 1000) return;
  lastBalanceCheckMs = now;
  try {
    const info = await fetchBalanceInfo();
    if (info !== null && info.total < threshold) {
      await notifier.notify(`⚠️ DeepSeek 余额不足: ¥${formatYuan(info.total)}（阈值 ¥${formatYuan(threshold)}），请及时充值`);
    }
  } catch (error) {
    console.warn("[channel-bot] low-balance check failed:", error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ */
/* Event-driven notifications (mirrors dsh-notification's taxonomy)    */
/* ------------------------------------------------------------------ */
/* Turn-end reasons observed on session `turn/end` events (see
 * dsh-agent-loop turn-end folding): completed / error / aborted /
 * blocked / max-tokens. `approval/asked` fires when the agent waits for
 * a user approval decision. Folding mirrors dsh-notification's
 * notificationProjection (turn/start → assistant/message → tool/call →
 * turn/end), but host-side: we push through the channels instead of
 * showing a browser Notification. */
const TURN_REASON_LABELS = {
  completed: "✅ 任务完成",
  error: "❌ 任务出错",
  aborted: "⏹ 任务中止",
  blocked: "⛔ 任务阻塞",
  "max-tokens": "🔺 达 Token 上限",
};
function sessionTitle(session) {
  if (session !== null && typeof session === "object" && typeof session.title === "string" && session.title !== "") return session.title;
  if (session !== null && typeof session === "object" && typeof session.id === "string") return session.id;
  return "DSH 会话";
}
function reasonLabel(reason) {
  return TURN_REASON_LABELS[reason] ?? `📋 任务结束 (${reason ?? "unknown"})`;
}
/** Whether a turn-end reason is enabled in the notifyEvents config. */
function turnReasonEnabled(cfg, reason) {
  const ev = cfg?.notifyEvents;
  if (!ev) return false;
  switch (reason) {
    case "completed": return ev.completed !== false;
    case "error": return ev.error !== false;
    case "aborted": return ev.aborted === true;
    case "blocked": return ev.blocked === true;
    case "max-tokens": return ev.maxTokens === true;
    default: return false;
  }
}
function splitKeywords(raw) {
  return String(raw ?? "").split(/\n|,/).map((s) => s.trim()).filter((s) => s !== "");
}
function matchKeyword(kw, hay) {
  if (kw.length > 2 && kw.startsWith("/") && kw.endsWith("/")) {
    try { return new RegExp(kw.slice(1, -1)).test(hay); } catch { /* literal fallback */ }
  }
  return hay.includes(kw);
}
/** dsh-notification-style include/exclude keyword rules against
 * title + reply body + tool names. Include: at least one must hit;
 * exclude: any hit suppresses. */
function matchesKeywordRules(cfg, title, body, tools) {
  const ev = cfg?.notifyEvents;
  if (!ev) return true;
  const hay = `${title}\n${body}\n${tools.join("\n")}`;
  const exclude = splitKeywords(ev.keywordExclude);
  if (exclude.length > 0 && exclude.some((k) => matchKeyword(k, hay))) return false;
  const include = splitKeywords(ev.keywordInclude);
  if (include.length > 0 && !include.some((k) => matchKeyword(k, hay))) return false;
  return true;
}
function buildTurnText(title, reason, body, tools) {
  const lines = [`${reasonLabel(reason)}${title && title !== "DSH 会话" ? ` — ${title}` : ""}`];
  if (body !== "") lines.push(body.length > 400 ? body.slice(0, 399) + "…" : body);
  if (tools.length > 0) lines.push(`工具: ${tools.slice(0, 8).join(", ")}${tools.length > 8 ? "…" : ""}`);
  return lines.join("\n");
}
function buildApprovalText(title, toolName, reason) {
  const lines = [`⏳ 等待审批${title && title !== "DSH 会话" ? ` — ${title}` : ""}`];
  if (toolName) lines.push(`工具: ${toolName}`);
  if (reason) lines.push(`原因: ${reason}`);
  lines.push("请到面板批准或拒绝。");
  return lines.join("\n");
}
/** Fold one session event into the projection state (mirrors dsh-notification's
 * notificationProjection apply, plus approval/asked+decided for pending state).
 * Returns a NEW state only when something relevant changed (drives onChanged). */
function foldProjectionEvent(state, event) {
  switch (event?.type) {
    case "turn/start":
      return { ...state, openTurn: { turn: event.data?.turn, text: "", lastMsg: "", prevMsg: "", msgSeq: 0, tools: [] } };
    case "assistant/message": {
      const open = state.openTurn;
      if (open === null || open.turn !== event.data?.turn) return state;
      let msg = "";
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") msg += block.text;
      }
      if (msg === "") return state;
      /* `text` accumulates a short capped digest of the whole turn (used for the
       * notification card and keyword rules). `lastMsg` is the newest assistant
       * message, `prevMsg` the one before it, `msgSeq` how many arrived.
       *
       * A multi-step turn emits ONE assistant/message per step, so concatenating
       * them repeats content — verified live: three steps each answering "收到"
       * produced "收到收到收到". A chat reply therefore uses lastMsg (the final
       * answer at turn/end), and progress streaming pushes prevMsg — a message is
       * only known to be intermediate once a newer one exists. */
      let text = open.text + msg;
      if (text.length > 400) text = text.slice(0, 399) + "…";
      const cap = (s) => (s.length > 3000 ? s.slice(0, 2999) + "…" : s);
      return {
        ...state,
        openTurn: {
          ...open,
          text,
          prevMsg: open.lastMsg ?? "",
          lastMsg: cap(msg),
          msgSeq: (open.msgSeq ?? 0) + 1,
        },
      };
    }
    case "tool/call": {
      const open = state.openTurn;
      if (open === null || open.turn !== event.data?.turn) return state;
      const name = event.data?.name;
      if (typeof name !== "string" || open.tools.includes(name)) return state;
      return { ...state, openTurn: { ...open, tools: [...open.tools, name] } };
    }
    case "turn/end": {
      const open = state.openTurn;
      if (open === null || open.turn !== event.data?.turn) return state;
      return {
        ...state,
        openTurn: null,
        lastEndSeq: typeof event.seq === "number" ? event.seq : -1,
        last: {
          turn: event.data.turn,
          reason: event.data?.reason?.kind ?? "",
          /* Keep the failure text: a remote chat has no panel to look at, so
           * "出错了，请到面板查看" is useless on its own. */
          error: typeof event.data?.reason?.error?.message === "string" ? event.data.reason.error.message.slice(0, 600) : "",
          body: open.text.trim(),
          /* The final assistant message alone — a chat reply must not repeat
           * every step's output (see the assistant/message case). */
          answer: (open.lastMsg ?? "").trim(),
          tools: open.tools,
        },
      };
    }
    case "approval/asked":
      return {
        ...state,
        pendingApprovalSeq: typeof event.seq === "number" ? event.seq : -1,
        pendingApproval: {
          id: typeof event.data?.id === "string" ? event.data.id : "",
          toolName: typeof event.data?.toolName === "string" ? event.data.toolName : "",
          reason: typeof event.data?.reason === "string" ? event.data.reason : "",
        },
      };
    case "approval/decided":
      return state.pendingApproval === null ? state : { ...state, pendingApproval: null, pendingApprovalSeq: null };
    default:
      return state;
  }
}
const EMPTY_TURN_VIEW = Object.freeze({ turn: 0, reason: "", error: "", body: "", answer: "", tools: Object.freeze([]) });
/** Subscribes to session turn-end and approval events through the
 * sessionProjections change feed (the registry is a core service whose own
 * subscription receives every committed session event; its drive() invokes
 * onChanged listeners DIRECTLY, so this works regardless of fiber/isolate
 * event propagation — raw ctx.on("session/event") from a plugin fiber does
 * NOT reliably receive session events). Returns the disposer. */
function subscribeSessionEvents(ctx, notifier, getConfig, onTurnNotified, chatBridge = null) {
  const disposed = new Set();
  const notifiedTurns = new Set();
  const notifiedApprovals = new Set();
  /* Streaming state per bound session: the last assistant-message index we
   * already pushed. Keyed by sessionId. */
  const streams = new Map();
  const streamState = (id) => {
    let s = streams.get(id);
    if (!s) { s = { pushed: 0 }; streams.set(id, s); }
    return s;
  };
  const clearStream = (id) => { streams.delete(id); };
  ctx.sessionProjections.register({
    key: "channel-bot",
    stateSchema: { parse: (value) => value },
    init: () => ({ openTurn: null, last: null, pendingApproval: null }),
    apply: (state, event) => foldProjectionEvent(state, event),
    wire: {
      viewSchema: { parse: (value) => value },
      view: (state) => ({
        last: state.last ?? EMPTY_TURN_VIEW,
        lastEndSeq: state.lastEndSeq ?? null,
        pendingApproval: state.pendingApproval ?? null,
        pendingApprovalSeq: state.pendingApprovalSeq ?? null,
        /* Open-turn state drives streaming replies to a bound chat: we push the
         * newest assistant message (identified by msgSeq), not a growing text
         * buffer, because the buffer is capped at 400 chars. */
        openTurn: state.openTurn === null ? null : { turn: state.openTurn.turn, prevMsg: state.openTurn.prevMsg ?? "", msgSeq: state.openTurn.msgSeq ?? 0 },
      }),
    },
    stateVersion: 1,
  });
  const dispose = ctx.sessionProjections.onChanged((session, key, value, seq) => {
    try {
      if (key !== "channel-bot" || value === null || typeof value !== "object") return;
      const cfg = getConfig();
      if (!cfg?.enabled || !cfg?.notifyEvents) return;
      const id = session?.id;
      if (typeof id !== "string") return;
      /* A session bound to a chat gets its reply in THAT chat (a remote
       * conversation, not a broadcast); unbound sessions keep the original
       * behaviour of pushing to every notification channel. */
      const binding = chatBridge !== null ? chatBridge.bindingFor(id) : null;
      const quiet = inQuietHours(cfg.notifyEvents.quietHours);
      const last = value.last;
      if (last !== null && typeof last === "object" && typeof last.reason === "string" && last.reason !== "" && typeof last.turn === "number") {
        /* seq gate: only notify when the CURRENT driven event IS the turn/end
         * that produced this value — the lazy cell build otherwise replays the
         * last completed turn from history and would spuriously re-notify it
         * after every restart. */
        if (value.lastEndSeq !== seq) return;
        const turnKey = `${id}:${last.turn}`;
        if (notifiedTurns.has(turnKey)) return;
        notifiedTurns.add(turnKey);
        const title = sessionTitle(session);
        const body = typeof last.body === "string" ? last.body : "";
        const tools = Array.isArray(last.tools) ? last.tools.filter((t) => typeof t === "string") : [];
        if (binding !== null) {
          /* Remote conversation: deliver the answer itself, not a status card.
           * Quiet hours still apply — the turn ran, only the push is held. */
          clearStream(id);
          const answer = typeof last.answer === "string" && last.answer !== "" ? last.answer : body;
          const failure = typeof last.error === "string" ? last.error : "";
          if (!quiet) void chatBridge.replyTurn(binding, last.reason, answer, tools, failure);
          return;
        }
        if (quiet) return;
        if (!turnReasonEnabled(cfg, last.reason)) return;
        if (!matchesKeywordRules(cfg, title, body, tools)) return;
        void notifier.notify(buildTurnText(title, last.reason, body, tools));
        if (typeof onTurnNotified === "function") void onTurnNotified();
        return;
      }
      /* Streaming: push each intermediate assistant message while the human is
       * present, so a long multi-step task reports progress instead of going
       * silent. The FINAL message is delivered by the turn/end branch above. */
      const open = value.openTurn;
      if (binding !== null && open !== null && typeof open === "object") {
        if (!quiet) chatBridge.streamPartial(binding, open, streamState(id));
        return;
      }
      const pending = value.pendingApproval;
      if (pending !== null && typeof pending === "object" && typeof pending.id === "string" && pending.id !== "") {
        if (value.pendingApprovalSeq !== seq) return;
        if (cfg.notifyEvents.approval !== true) return;
        /* The remote-approval bridge pushes its own actionable card; a second
         * "waiting for approval" notice would be noise. */
        if (cfg.approvals?.enabled === true) return;
        const approvalKey = `${id}:approval:${pending.id}`;
        if (notifiedApprovals.has(approvalKey)) return;
        notifiedApprovals.add(approvalKey);
        if (quiet) return;
        const title = sessionTitle(session);
        const toolName = typeof pending.toolName === "string" ? pending.toolName : "";
        const reason = typeof pending.reason === "string" ? pending.reason : "";
        if (!matchesKeywordRules(cfg, title, "", [toolName])) return;
        void notifier.notify(buildApprovalText(title, toolName, reason));
      }
    } catch (error) {
      console.warn("[channel-bot] session event handling failed:", error instanceof Error ? error.message : String(error));
    }
  });
  return () => {
    if (disposed.has(dispose)) return;
    disposed.add(dispose);
    for (const id of [...streams.keys()]) clearStream(id);
    try { dispose(); } catch { /* already disposed */ }
  };
}

/* ------------------------------------------------------------------ */
/* Inbound webhook handlers                                            */
/* ------------------------------------------------------------------ */
function verifyDingTalk(request, cfg) {
  const dt = cfg?.dingtalk || {};
  /* [v2.2.0] 方案二（企业内部应用机器人回调）：签名 = base64(hmac_sha256(appSecret, timestamp + "\n" + appSecret))，
   * 放在请求头 timestamp / sign；也兼容 callbackToken 直接比对。 */
  if (dt.scheme !== "1" && (dt.appSecret || dt.callbackToken)) {
    const ts = request.headers["timestamp"] ?? request.headers["x-dingtalk-timestamp"];
    const sig = request.headers["sign"] ?? request.headers["x-dingtalk-signature"];
    if (dt.callbackToken) {
      const tok = request.headers["x-dingtalk-token"] ?? request.headers["token"];
      if (tok && String(tok) !== String(dt.callbackToken)) return false;
    }
    if (!ts || !sig) return true;   // 平台首次校验或未带签名的回调：放行（无密钥时不阻断）
    const want = hmacBase64(dt.appSecret || dt.callbackToken, `${ts}\n${dt.appSecret || dt.callbackToken}`);
    return safeEqual(decodeURIComponent(String(sig)), want);
  }
  const secret = cfg.dingtalk?.secret;
  if (!secret) return true; // no secret configured: skip verification (operator choice)
  const url = new URL(request.url, "http://local");
  const ts = url.searchParams.get("timestamp");
  const sign = url.searchParams.get("sign");
  if (!ts || !sign) return false;
  return safeEqual(decodeURIComponent(sign), hmacBase64(secret, `${ts}\n${secret}`));
}
function verifyFeishu(request, cfg) {
  /* 方案一（群机器人 Webhook）HMAC 校验；方案二（自建应用事件订阅）在 handler 里按
   * Verification Token / Encrypt Key 校验（需要请求体，见下方 webhook 路由）。 */
  const fs = cfg?.feishu || {};
  if (fs.scheme !== "1" && (fs.verificationToken || fs.encryptKey)) return true; // 交给 handler
  const secret = cfg.feishu?.secret;
  if (!secret) return true;
  const ts = request.headers["x-lark-request-timestamp"];
  const sign = request.headers["x-lark-signature"];
  if (!ts || !sign) return false;
  return safeEqual(sign, hmacBase64(secret, `${ts}\n${secret}`));
}
function parseDingTalk(body, cfg) {
  const dt = cfg?.dingtalk || {};
  /* [v2.2.0] 方案二（企业内部应用机器人）回调 body：
   *   {conversationId, msgId, senderId, senderNick, robotCode, text:{content}}
   * 兼容方案一的群机器人回调 {senderNick, text:{content}}。 */
  let content = body?.text?.content;
  if (typeof content !== "string") return null;
  const from = body?.senderStaffId ?? body?.senderId ?? body?.sender?.nick ?? body?.senderNick ?? "钉钉用户";
  const target = body?.conversationId
    ? { type: "group", id: String(body.conversationId) }
    : { type: "user", id: String(from) };
  return { text: content, from, msgId: body?.msgId ? String(body.msgId) : "", target };
}
function parseFeishu(body, cfg) {
  /* [v2.2.0] Encrypt Key 场景：body = {encrypt: "..."}，先解密再按事件 v2 解析 */
  const fs = cfg?.feishu || {};
  if (body && typeof body.encrypt === "string" && fs.encryptKey) {
    const plain = feishuDecrypt(fs.encryptKey, body.encrypt);
    if (!plain) return null;
    body = plain;
  }
  // Event subscription v2 envelope
  const event = body?.event ?? body;
  const raw = event?.message?.content;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.text !== "string") return null;
    return { text: parsed.text, from: event?.sender?.sender_id?.open_id ?? "飞书用户" };
  } catch { return null; }
}
function parseQq(body) {
  /* QQ 开放平台 v2 事件（webhook）：单聊 / 群聊 @ */
  if (body?.op === 0 && typeof body?.t === "string") {
    if (body.t === "C2C_MESSAGE_CREATE") {
      const m = body.d || {};
      const text = String(m.content ?? "");
      if (!text) return null;
      const openid = m.author?.user_openid || m.author?.id || "";
      return { text, from: openid, msgId: String(m.id ?? ""), target: { type: "private", id: openid } };
    }
    if (body.t === "GROUP_AT_MESSAGE_CREATE") {
      const m = body.d || {};
      const text = String(m.content ?? "").replace(/<@!?[\s\S]*?>/g, "").trim();
      if (!text) return null;
      const gid = m.group_openid || "";
      const openid = m.author?.member_openid || m.author?.id || "";
      return { text, from: openid, msgId: String(m.id ?? ""), target: { type: "group", id: gid } };
    }
    return null;
  }
  /* OneBot 事件上报 */
  if (body?.post_type !== "message") return null;
  const text = body.raw_message ?? body.message;
  if (typeof text !== "string") return null;
  return {
    text,
    from: String(body.user_id ?? ""),
    target: body.message_type === "group"
      ? { type: "group", id: String(body.group_id ?? "") }
      : { type: "private", id: String(body.user_id ?? "") },
  };
}
const PARSERS = {
  dingtalk: parseDingTalk,
  feishu: parseFeishu,
  qq: parseQq,
};
const VERIFIERS = {
  dingtalk: verifyDingTalk,
  feishu: verifyFeishu,
};

/* ------------------------------------------------------------------ */
/* Cordis plugin                                                       */
/* ------------------------------------------------------------------ */
const name = "channel-bot";
/* `agents` is required for remote conversation (create/resume/followup a real
 * DSH session from an IM message) — the same service api-proxy uses for the
 * browser composer path. */
const inject = ["webServer", "tools", "sessionProjections", "sessions", "agents"];
function apply(ctx, base) {
  let current = () => base;
  let pollTimer = null;
  let pollStop = null;   // [v2.1.0] 自调度轮询循环的停止钩子
  let telegramAbort = null;  // [v2.3.0] 当前 telegram 轮询的 AbortController（修复时掐掉在飞的旧请求）
  let wechatAbort = null;    // [v2.3.0] 同上，微信 iLink 长轮询
  let unloading = false;     // [v2.3.0] 插件卸载中：主动中止的请求不算「渠道失败」，日志保持干净
  let pollOffset = 0;
  /* iLink login state + programmatic settings updater (set by inject below) */
  let wechatLogin = null;
  let settingsUpdate = null;
  ctx.inject(["settings"], (sctx) => {
    settingsUpdate = (patch) => sctx.settings.update(NS, patch);
    return () => { settingsUpdate = null; };
  });

  /* Notification service + agent tool: outbound push through configured channels.
   * Other plugins can inject "channelBotNotifier" and call notify()/notifyAll();
   * the agent itself can call the send_notification tool. */
  const notifier = {
    async notify(text, options = {}) {
      const cfg = current();
      if (!cfg.enabled) return { ok: false, sent: [], failed: [], reason: "bot disabled" };
      const clean = typeof text === "string" ? text.trim() : "";
      if (!clean) return { ok: false, sent: [], failed: [], reason: "empty text" };
      const only = typeof options?.channel === "string" && options.channel ? options.channel : undefined;
      const { sent, failed } = await notifyChannels(cfg, clean, only);
      return { ok: true, sent, failed };
    },
    async notifyAll(text) { return this.notify(text); },
  };
  ctx.provide("channelBotNotifier", notifier);
  ctx.tools.register(defineTool({
    name: "send_notification",
    description: "Send a notification message to the user through the configured notification channels (Telegram / 钉钉 / 飞书 / 企业微信 / QQ / 微信). Use it when a task finishes, the user needs to take action, an error needs attention, or anything should be pushed outside the panel. Returns the channels that received the message and any that failed.",
    parameters: {
      text: { type: "string", description: "The notification message content." },
      channel: { type: "string", description: "Optional: one of telegram, dingtalk, feishu, wecom, qq, wechat. Omit to send to every configured notification channel." },
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args) {
      if (typeof args.text !== "string" || !args.text.trim()) throw new Error("send_notification requires a non-empty text");
      return await notifier.notify(args.text, { channel: args.channel });
    },
  }));
  /* ---------------------------------------------------------------- */
  /* Remote conversation bridge (chat ⇄ agent) + remote approval       */
  /* ---------------------------------------------------------------- */
  /* Chat↔session bindings live next to the profile so they survive a
   * restart; the ids themselves are derived from platform+chatId so even a
   * lost mapping file lands the same chat on the same session. */
  const chatMap = new ChatSessionMap(join(homedir(), ".dsh", "channel-bot-sessions.json"));
  void chatMap.load();
  /* [v2.1.0] 企微主动推送的持久化兜底：取最近活跃的 wecom 会话绑定（重启后依然可推） */
  wecomBindingResolver = () => {
    try {
      const bound = chatMap.list().filter((b) => b.platform === "wecom");
      if (!bound.length) return "";
      bound.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
      return String(bound[0].chatId || "");
    } catch { return ""; }
  };

  const approvals = new ApprovalBridge({
    ctx,
    getConfig: () => current(),
    notify: (text) => notifier.notify(text),
    logFile: join(homedir(), ".dsh", "channel-bot-approvals.log"),
  });
  const disposeApprovals = approvals.mount();
    const planApprovals = new PlanToolApprovalBridge({
      notify: (text) => notifier.notify(text),
      token: process.env.DSH_LARK_NOTIFY_TOKEN || "",
    });


  /* Last text pushed to each chat, so a multi-step turn that repeats itself
   * does not spam the same line: verified live — a 3-step turn answering "好的"
   * emitted three identical assistant messages (2 streamed + 1 final). */
  const lastSentToChat = new Map();

  /** Send one text to a specific bound chat (not a broadcast). */
  const sendToChat = async (binding, text) => {
    const cfg = current();
    const key = `${binding.platform}:${binding.chatId}`;
    const normalized = typeof text === "string" ? text.trim() : "";
    if (normalized === "" || lastSentToChat.get(key) === normalized) return;
    lastSentToChat.set(key, normalized);
    if (lastSentToChat.size > 200) lastSentToChat.delete(lastSentToChat.keys().next().value);
    const chunks = splitLongText(markdownToText(text));
    for (const chunk of chunks) {
      try {
        if (binding.platform === "telegram") await sendTelegram(cfg, binding.chatId, chunk);
        else if (binding.platform === "wechat") { console.log("[channel-bot] 微信 replyTurn 回发 chatId=", binding.chatId, "ctx=", wechatCtxMap.has(binding.chatId)); await sendWechat(cfg, { channel: "wechat", chatId: binding.chatId, contextToken: wechatCtxMap.get(binding.chatId) ?? "" }, chunk); }
        else if (binding.platform === "qq") await sendQq(cfg, { type: binding.chatType === "group" ? "group" : "private", id: binding.chatId }, chunk);
        else if (binding.platform === "dingtalk") await sendDingTalk(cfg, chunk);
        else if (binding.platform === "feishu") await sendFeishu(cfg, chunk);
        else if (binding.platform === "wecom") { console.log("[channel-bot] 企微 replyTurn 回发 chatId=", binding.chatId); await sendWecom(cfg, chunk); }
      } catch (error) {
        console.warn("[channel-bot] chat reply failed:", binding.platform, error instanceof Error ? error.message : String(error));
        return;
      }
    }
  };

  /* The bridge the projection subscriber calls: it decides whether a session's
   * output goes to one chat (remote conversation) or to every notification
   * channel (plain notification), and handles the streaming reservoir. */
  const chatBridge = {
    bindingFor: (sessionId) => (current().chat?.enabled === true ? chatMap.bySessionId(sessionId) : null),
    /** Final answer of a turn, delivered as the reply itself. */
    replyTurn: async (binding, reason, body, tools, failure) => {
      const clean = typeof body === "string" ? body.trim() : "";
      console.log("[bridge] replyTurn platform=", binding?.platform, "chatId=", binding?.chatId, "reason=", reason, "body=", clean.slice(0, 80));
      if (reason === "error") {
        /* Report the real failure: a chat user cannot open the panel. */
        const detail = clean || (typeof failure === "string" ? failure.trim() : "");
        await sendToChat(binding, `❌ 出错了${detail ? `：${detail}` : "，请到面板查看详情。"}`);
        return;
      }
      if (clean === "") {
        await sendToChat(binding, `${reasonLabel(reason)}${tools.length > 0 ? `（工具: ${tools.slice(0, 6).join(", ")}）` : ""}`);
        return;
      }
      await sendToChat(binding, clean);
    },
    /** Per-message progress push while the user is actively chatting. */
    streamPartial: (binding, open, state) => {
      const cfg = current();
      const chat = cfg.chat ?? {};
      if (chat.stream !== true) return;
      const windowMs = (Number.isFinite(chat.presenceWindowMin) && chat.presenceWindowMin > 0 ? chat.presenceWindowMin : 10) * 60_000;
      if (!chatMap.isOnline(binding.platform, binding.chatId, windowMs)) return;
      const seq = Number(open.msgSeq) || 0;
      /* Push message N-1 (prevMsg) only once message N exists: the newest
       * message may still be the turn's final answer, which turn/end delivers.
       * This makes intermediate steps visible without duplicating the reply. */
      if (seq < 2 || seq - 1 <= state.pushed) return;
      state.pushed = seq - 1;
      const text = typeof open.prevMsg === "string" ? open.prevMsg.trim() : "";
      if (text === "") return;
      void sendToChat(binding, text);
    },
  };

  /* Event-driven notifications: session turn-end states + approval requests,
   * gated by the notifyEvents settings (dsh-notification taxonomy). Sessions
   * bound to a chat get their answer routed back to that chat instead. */
  const disposeSessionEvents = subscribeSessionEvents(
    ctx,
    notifier,
    () => current(),
    () => void checkLowBalance(notifier, () => current()),
    chatBridge,
  );

  /* Per-chat command services: /new, /end, /sessions, /approve. */
const chatServices = (platform, chatId, chatType) => ({
    approve: (id, answer) => {
      if (current().approvals?.enabled !== true) return "远程审批未启用。";
      const result = approvals.respond(id, answer, `${platform}:${chatId}`);
      return {
        accepted: `✅ 已批准 #${id}，任务继续。`,
        rejected: `❌ 已拒绝 #${id}。`,
        ignored: `ℹ️ 审批 #${id} 已被响应。`,
        "not-found": `ℹ️ 审批 #${id} 不存在或已结束。`,
      }[result] ?? `ℹ️ ${result}`;
    },
    planApprove: (id, answer) => {
      const result = planApprovals.respondPlan(id, answer, `${platform}:${chatId}`);
      return {
        accepted: `✅ 已批准计划 #${id}，Agent 可继续执行。`,
        rejected: `❌ 已拒绝计划 #${id}。`,
        ignored: `ℹ️ 计划审批 #${id} 已被响应。`,
        "not-found": `ℹ️ 计划审批 #${id} 不存在或已结束。`,
      }[result] ?? `ℹ️ ${result}`;
    },
    toolApprove: (id, answer) => {
      const result = planApprovals.respondTool(id, answer, `${platform}:${chatId}`);
      return {
        accepted: `✅ 已批准工具 #${id}，继续执行。`,
        rejected: `❌ 已拒绝工具 #${id}。`,
        ignored: `ℹ️ 工具审批 #${id} 已被响应。`,
        "not-found": `ℹ️ 工具审批 #${id} 不存在或已结束。`,
      }[result] ?? `ℹ️ ${result}`;
    },
    newSession: async () => {
      if (current().chat?.enabled !== true) return "远程对话未启用。";
      chatMap.remove(platform, chatId);
      const binding = chatMap.create(platform, chatId, { chatType: chatType ?? "private" });
      return `🆕 已绑定新会话：${binding.sessionId}\n直接发消息开始对话。`;
    },
    endSession: async () => {
      const removed = chatMap.remove(platform, chatId);
      return removed === null ? "本聊天当前没有绑定会话。" : `👋 已解绑会话 ${removed.sessionId}（面板里仍可查看历史）。`;
    },
    listSessions: () => {
      const list = chatMap.list();
      if (list.length === 0) return "暂无绑定的会话。";
      return [`已绑定 ${list.length} 个聊天：`, ...list.slice(0, 15).map((b) => `  ${b.platform}:${b.chatId} → ${b.sessionId}`)].join("\n");
    },
    sessionCount: () => chatMap.size,
    pendingApprovals: () => approvals.pendingList(),
  });

  /**
   * Handle one inbound message: a command answers directly, anything else is
   * dispatched to the bound agent when remote conversation is on.
   * @returns {Promise<string|null>} reply text, or null when nothing to say
   */
  const handleInbound = async ({ platform, chatId, chatType, text, msgId }) => {
    const cfg = current();
    if (!chatMap.dedupe(platform, msgId)) return null;
    const services = { spending: spendingReport, ...chatServices(platform, chatId, chatType) };
    const reply = await handleCommand(cfg, text, services);
    if (reply !== null) return reply;
    if (cfg.chat?.enabled !== true) return null;
    // Not a command: this is a task for the agent.
    chatMap.touch(platform, chatId);
    /* New request → forget the previous turn's last line, so an identical answer
     * to a repeated question is not swallowed by the duplicate guard. */
    lastSentToChat.delete(`${platform}:${chatId}`);
    const result = await dispatchTask({ ctx, map: chatMap, cfg, platform, chatId, text, chatType });
    if (!result.ok) return result.message;
    console.log("[inbound] dispatch platform=", platform, "chatId=", chatId, "result=", JSON.stringify(result));
    return null; // the answer arrives through the projection subscriber
  };

  /* /spending report: day/week/month/year totals over ALL sessions (live +
   * persisted, via sessionQuery), priced with the official V4 peak/off-peak
   * rates. Uses ctx.get("sessionQuery") so a missing query service degrades
   * gracefully instead of failing the plugin boot. */
  const spendingReport = async () => {
    try {
      const query = ctx.get("sessionQuery");
      if (query === void 0 || typeof query.listSessions !== "function") return "会话查询服务不可用";
      const records = await query.listSessions();
      const now = Date.now();
      const dayStart = beijingDayStart(now);
      const weekStart = beijingWeekStart(now);
      const monthStart = beijingMonthStart(now);
      const yearStart = beijingYearStart(now);
      let day = 0, week = 0, month = 0, year = 0, counted = 0;
      for (const record of records ?? []) {
        const id = record?.header?.id;
        if (typeof id !== "string") continue;
        let events = [];
        try {
          events = await readSessionEvents(ctx, id);
        } catch (error) {
          console.warn("[channel-bot] spending: cannot read events of", id.slice(0, 24), "-", error instanceof Error ? error.message : String(error));
        }
        const { costYuan } = computeSessionCost(events);
        const t = events.length > 0 && typeof events[events.length - 1].time === "number"
          ? events[events.length - 1].time
          : typeof record?.header?.createdAt === "number" ? record.header.createdAt : now;
        counted += 1;
        if (t >= dayStart) day += costYuan;
        if (t >= weekStart) week += costYuan;
        if (t >= monthStart) month += costYuan;
        if (t >= yearStart) year += costYuan;
      }
      const lines = [`会话花销（统计 ${counted} 个会话，V4 官方峰谷价估算）:`, `  今日: ¥${formatYuan(day)}`, `  本周: ¥${formatYuan(week)}`, `  本月: ¥${formatYuan(month)}`, `  今年: ¥${formatYuan(year)}`];
      try {
        const info = await fetchBalanceInfo();
        if (info !== null) lines.push(`余额: ¥${formatYuan(info.total)}（${info.currency}）`);
      } catch { /* balance is optional in the report */ }
      return lines.join("\n");
    } catch (error) {
      return "花销统计失败: " + (error instanceof Error ? error.message : String(error));
    }
  };

  const startPolling = (cfg) => {
    if (pollTimer) { clearTimeout(pollTimer); clearInterval(pollTimer); pollTimer = null; }
    if (pollStop) { pollStop(); pollStop = null; }
    const token = cfg?.telegram?.botToken;
    if (!cfg?.enabled || !cfg?.telegram?.enabled || !token) return;
    /* [v2.1.0] 改成「自调度循环」而不是 setInterval(2s) + timeout:30 的长轮询并发：
     * 旧写法每 2 秒就发一次 getUpdates，而服务端会把连接 hold 住 30 秒 →
     * 同一 token 上多个 getUpdates 并发，Telegram 会把较早的请求以
     * `409 Conflict: terminated by other getUpdates request` 掐掉（健康账里实测 16 次），
     * 属于典型的轮询反模式。现在永远只有一个请求在飞。 */
    let alive = true;
    /* [v2.3.0] 「修复」会重启轮询：只把 alive 置 false 并不能终止**已经在飞**的那次 getUpdates
     * （服务端会 hold 住 30 秒），于是新旧两个长轮询同时在同一个 token 上 → 平台立刻返回
     * `409 Conflict`，健康账里刚清完的错误又冒出来。这里用 AbortController 主动掐掉旧请求：
     * 旧请求以 abort 结束，且因为是「被取代」而不是「失败」，不再计入错误账。 */
    let ac = null;
    try {
      if (typeof AbortController === "function") { ac = new AbortController(); telegramAbort = ac; }
    } catch { ac = null; }
    const reqSignal = () => {
      const t = AbortSignal.timeout(35000);
      if (!ac) return t;
      try { return typeof AbortSignal.any === "function" ? AbortSignal.any([ac.signal, t]) : t; } catch { return t; }
    };
    pollStop = () => {
      alive = false;
      if (ac) { try { ac.abort(); } catch { /* 已结束 */ } }
    };
    const tick = async () => {
      if (!alive) { hrec("telegram").poller.running = false; return; }
      hrec("telegram").poller.running = true;
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset: pollOffset, timeout: 30 }),
          signal: reqSignal(),
        });
        if (!res.ok) {
          markPoll("telegram", false, `HTTP ${res.status}`);
        } else {
          const data = await res.json();
          markPoll("telegram", true);
          for (const update of data.result ?? []) {
            pollOffset = Math.max(pollOffset, (update.update_id ?? 0) + 1);
            const msg = update.message;
            if (!msg?.text) { markSkip("telegram", "更新中不含文本消息"); continue; }
            const allow = cfg.telegram.allowedChatIds ?? [];
            if (allow.length > 0 && !allow.includes(String(msg.chat.id))) { markSkip("telegram", "chat 不在 allowedChatIds：" + String(msg.chat.id)); continue; }
            markInbound("telegram", msg.chat.id, msg.text);
            const reply = await handleInbound({
              platform: "telegram",
              chatId: String(msg.chat.id),
              chatType: msg.chat.type === "private" ? "private" : "group",
              text: msg.text,
              msgId: msg.message_id,
            });
            if (reply !== null) await answer(current(), { channel: "telegram", chatId: msg.chat.id }, reply);
          }
        }
      } catch (error) {
        if (!alive || unloading) {
          /* 被「修复/看门狗」重启或插件卸载取代：请求是我们主动中止的，不算渠道失败 */
          console.log("[channel-bot] telegram 旧轮询请求已中止（被更新的轮询取代）");
        } else {
          const m = error instanceof Error ? error.message : String(error);
          markPoll("telegram", false, m);
          console.warn("[channel-bot] telegram poll failed:", m);
        }
      }
      if (alive) pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(tick, 0);
  };
  /* [v2.1.0] 轮询/长连接看门狗：每 60s 检查一次「配置里启用但循环没在跑」的渠道并拉起。
   * 微信长轮询历史上会被瞬时快照打断后永久停摆（已修），这层兜底保证即使再有类似路径，
   * 最多 60s 自愈，而不是等到重启面板。 */
  const pollerWatchdog = () => {
    const cfg = current();
    if (!cfg?.enabled) return;
    const tgl = hrec("telegram");
    const tglStale = !tgl.poller.lastPollAt || (Date.now() - Date.parse(tgl.poller.lastPollAt) > 120000);
    if (cfg.telegram?.enabled && cfg.telegram?.botToken && (!tgl.poller.running || tglStale)) {
      console.warn("[channel-bot] 看门狗：telegram 轮询未运行/超时未轮询，重新拉起");
      startPolling(cfg);
    }
    if (cfg.wechat?.enabled && cfg.wechat?.botToken && wechatPolling === false) {
      console.warn("[channel-bot] 看门狗：wechat 长轮询未运行，重新拉起");
      startWechatPolling(cfg);
    }
    if (cfg.wecom?.enabled && cfg.wecom?.botId && cfg.wecom?.secret && wecomWs === null) {
      console.warn("[channel-bot] 看门狗：wecom 长连接未建立，重新拉起");
      startWecomBot(cfg);
    }
  };
  const watchdogTimer = setInterval(pollerWatchdog, 60 * 1000);

  /* 方案二：企微智能机器人（botId+secret，WebSocket 长连接）——开始/停止 Bot 客户端。
   * 收文本消息 → 调用面板命令工厂 handleCommand → 流式回复；同时记录会话 userid 供主动推送。 */
  const startWecomBot = (cfg) => {
    if (wecomWs) { try { wecomWs.disconnect(); } catch {} wecomWs = null; }
    const wx = (cfg || {}).wecom || {};
    if (wx.enabled && wx.botId && wx.secret) {
      try {
        wecomWs = new AiBot.WSClient({ botId: wx.botId, secret: wx.secret });
        wecomWs.on("authenticated", () => { console.log("[channel-bot] wecom Bot authenticated"); hrec("wecom").poller.running = true; markPoll("wecom", true); });
        wecomWs.on("message.text", (frame) => {
          try {
            const content = frame?.body?.text?.content;
            console.log("[wecom] message.text 触发 content=", JSON.stringify(content), "| chat.enabled=", (current().chat || {}).enabled, "| bodyKeys=", Object.keys(frame?.body || {}));
            if (typeof content !== "string") { console.log("[wecom] content 非字符串, 忽略"); markSkip("wecom", "content 非字符串"); return; }
            const chatId = frame?.body?.from?.userid || frame?.body?.sender?.userid || frame?.body?.receiver?.userid || frame?.body?.userid || "";
            if (chatId) wecomChatId = chatId;
            markInbound("wecom", chatId, content);
            const msgId = frame?.header?.msg_seq ?? frame?.body?.seq ?? Date.now();
            (async () => {
              let out = null;
              try {
                const reply = await handleInbound({ platform: "wecom", chatId, chatType: "private", text: content, msgId });
                console.log("[wecom] handleInbound reply=", reply);
                if (reply !== null && reply !== undefined) out = String(reply);
              } catch (e) { console.warn("[wecom] handleInbound 异常:", e?.message || String(e)); out = "❌ " + (e?.message || String(e)); }
              if (out) {
                console.log("[wecom] 回发:", String(out).slice(0, 60));
                try { await wecomWs.replyStream(frame, String(Date.now()), out, true); markOutbound("wecom", true); }
                catch (e2) { markOutbound("wecom", false, e2?.message || String(e2)); console.warn("[wecom] replyStream 失败:", e2?.message || String(e2)); }
              }
            })();
          } catch (e) { console.warn("[wecom] 外层异常:", e?.message || String(e)); }
        });
        wecomWs.connect();
      } catch (e) { console.warn("[channel-bot] wecom Bot start failed:", e?.message || String(e)); }
    }
  };
  const applyConfig = (cfg) => { startPolling(cfg); startWechatPolling(cfg); startWecomBot(cfg); };

  /* iLink (WeChat) long-polling: like Telegram getUpdates, cursor-based.
   * [v2.1.0 修根因] 旧版在这里 `if (!cur.enabled || !cur.wechat?.enabled || !tok) { wechatPolling = false; return; }`
   * —— 只要配置快照瞬时读空（面板重启、别的插件写 settings、热重载），长轮询就**永久退出**且不留任何日志，
   * 表现就是「微信突然收不到消息、面板命令没反应」，重启面板才恢复。现在改成：
   *   · 快照读空 → 只跳过这一轮 + 计数告警，绝不自杀；
   *   · 只有显式停用（用户关闭开关）才结束循环；
   *   · 外层有 60s 看门狗兜底重启（见 apply 里的 pollerWatchdog）。 */
  let wechatPolling = false;
  let wechatTimer = null;
  let wechatBuf = "";
  let wechatGapLogged = false;
  /* [v2.3.0] 长轮询「代」计数：面板点「修复」要**强制重启**一个可能已经卡住的循环。
   * 旧写法只能「没在跑才拉起」——循环卡死时 wechatPolling 恒为 true，修复就无从下手；
   * 而简单地把 flag 置 false 再置 true 会让旧循环的 in-flight 请求结束后又把自己排上，
   * 变成两个长轮询同时打同一个 token（正是 409 / ret 冲突类问题的来源）。
   * 现在每次启动都 gen+1，旧循环在每一轮开头与排下一轮之前都校验代数，被取代就自杀。 */
  let wechatGen = 0;
  const WECHAT_IDLE_MS = 1500;
  const startWechatPolling = (cfg, forceRestart) => {
    const token = cfg?.wechat?.botToken;
    if (!cfg?.enabled || !cfg?.wechat?.enabled || !token) return;
    if (wechatPolling && !forceRestart) return; // loop self-reloads config via current()
    if (wechatTimer) { clearTimeout(wechatTimer); wechatTimer = null; }
    /* [v2.3.0] 同 telegram：强制重启时必须先掐掉在飞的那次 getupdates（服务端 hold 45 秒），
     * 否则同一个 token 上两个长轮询并发，既可能丢消息也会把游标弄乱。 */
    if (wechatAbort) { try { wechatAbort.abort(); } catch { /* 已结束 */ } }
    wechatAbort = null;
    wechatPolling = true;
    const gen = ++wechatGen;
    const ac = (typeof AbortController === "function") ? new AbortController() : null;
    wechatAbort = ac;
    const reqSignal = () => {
      const t = AbortSignal.timeout(45000);
      if (!ac) return t;
      try { return typeof AbortSignal.any === "function" ? AbortSignal.any([ac.signal, t]) : t; } catch { return t; }
    };
    wechatBuf = "";
    wechatGapLogged = false;
    console.log("[channel-bot] wechat long-poll started" + (forceRestart ? "（修复：强制重启，旧循环将自行退出）" : ""));
    const loop = async () => {
      if (gen !== wechatGen || unloading) { console.log("[channel-bot] wechat 旧轮询循环退出（已被更新的循环取代/插件卸载）"); return; }
      if (!wechatPolling) { hrec("wechat").poller.running = false; return; }
      hrec("wechat").poller.running = true;
      try {
        const cur = current();
        const tok = cur.wechat?.botToken;
        if (!cur.enabled || !cur.wechat?.enabled || !tok) {
          /* 显式关闭开关才停；否则视为瞬时快照问题，继续轮询等它回来 */
          if (cur.wechat?.enabled === false || cur.enabled === false) {
            console.log("[channel-bot] wechat long-poll stopped（配置中已停用微信渠道）");
            wechatPolling = false;
            hrec("wechat").poller.running = false;
            return;
          }
          if (!wechatGapLogged) {
            console.warn("[channel-bot] wechat 配置快照暂不可用（enabled/token 读空），保持轮询等待恢复");
            wechatGapLogged = true;
          }
          markSkip("wechat", "配置快照暂不可用（保持轮询）");
          if (wechatPolling && gen === wechatGen) wechatTimer = setTimeout(loop, WECHAT_IDLE_MS);
          return;
        }
        wechatGapLogged = false;
        const res = await fetch(`${ILINK_BASE}/ilink/bot/getupdates`, {
          method: "POST",
          headers: ilinkHeaders(tok),
          body: JSON.stringify({ get_updates_buf: wechatBuf, base_info: { channel_version: "1.0.2" } }),
          signal: reqSignal(),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data && typeof data.ret === "number" && data.ret !== 0) {
            markPoll("wechat", false, `getupdates ret ${data.ret}${data.err_msg ? `: ${data.err_msg}` : ""}`);
          } else {
            markPoll("wechat", true);
          }
          if (data && Array.isArray(data.msgs)) {
            wechatBuf = data.get_updates_buf ?? wechatBuf;
            for (const msg of data.msgs) {
              if (!msg || msg.message_type !== 1) {
                markSkip("wechat", "非用户消息（message_type=" + (msg && msg.message_type) + "）");
                continue;
              }
              const text = msg.item_list?.[0]?.text_item?.text;
              if (typeof text !== "string") {
                markSkip("wechat", "非文本消息（item_list[0].type=" + (msg.item_list?.[0]?.type) + "）");
                continue;
              }
              const allow = cur.wechat?.allowedUserIds ?? [];
              if (allow.length > 0 && !allow.includes(String(msg.from_user_id))) {
                markSkip("wechat", "发送者不在 allowedUserIds 白名单：" + String(msg.from_user_id));
                continue;
              }
              if (typeof msg.context_token === "string" && msg.context_token !== "") {
                const cid = String(msg.from_user_id);
                wechatCtxMap.set(cid, msg.context_token);
                persistedState.wechatContexts[cid] = { token: msg.context_token, at: new Date().toISOString() };
                savePersistedState();
              }
              markInbound("wechat", msg.from_user_id, text);
              console.log("[wechat] msg from=", String(msg.from_user_id), "text=", JSON.stringify(text));
              const reply = await handleInbound({
                platform: "wechat",
                chatId: String(msg.from_user_id),
                chatType: "private",
                text,
                msgId: msg.msg_id ?? msg.message_id,
              });
              if (reply !== null) {
                await answer(cur, { channel: "wechat", chatId: msg.from_user_id, contextToken: msg.context_token }, reply);
              }
            }
          }
        } else {
          markPoll("wechat", false, `HTTP ${res.status}`);
          console.warn("[channel-bot] wechat getupdates HTTP", res.status);
        }
      } catch (error) {
        if (gen !== wechatGen || unloading) {
          /* 被「修复」强制重启或插件卸载取代：旧请求是主动中止的，不计入错误账 */
          console.log("[channel-bot] wechat 旧长轮询请求已中止（被更新的循环取代）");
        } else {
          const m = error instanceof Error ? error.message : String(error);
          markPoll("wechat", false, m);
          console.warn("[channel-bot] wechat poll failed:", m);
        }
      }
      if (wechatPolling && gen === wechatGen) wechatTimer = setTimeout(loop, WECHAT_IDLE_MS);
    };
    loop();
  };

  /* ================= [v2.3.0] 渠道自愈：按渠道修复 / 一键修复全部 =================
   * 为什么要有「修复」而不只是「自检」：自检查出的是「凭据没配 / 接收通道没在跑 / 连续失败 N 次 /
   * 最近出站失败」，但用户拿到结论后只能自己重启面板。这里把**能自动做掉的事**变成一次点击：
   *   1) 按渠道重启接收通道（telegram 轮询 / wechat 长轮询 / wecom 长连接）；
   *   2) 清除该渠道的访问令牌缓存（钉钉/飞书/QQ 的 token 失效是「出站失败」最常见的原因）；
   *   3) 清掉健康账里的历史错误（连续失败计数 / 最近错误）；
   *   4) 真打一次平台接口校验凭据（Telegram getMe、钉钉 accessToken、飞书 tenant_access_token、QQ token）；
   *   5) 复核并返回「做了什么 / 还需要人工做什么 / 修复后结论」。
   * 「渠道没启用 / 凭据没填」这类只能人来做的，如实进 manual —— 不假装修好了。 */

  /** 每个渠道当前的运行信息（/status 与修复复核共用同一份口径，避免两处漂移）。 */
  const channelRuntimeInfo = (cfg) => ({
    telegram: { tokenSet: !!cfg?.telegram?.botToken, pollerRunning: pollTimer !== null },
    dingtalk: { tokenSet: !!(cfg?.dingtalk?.scheme === "1" ? cfg?.dingtalk?.outWebhook : (cfg?.dingtalk?.appKey && cfg?.dingtalk?.appSecret && cfg?.dingtalk?.robotCode)), pollerRunning: true },
    feishu: { tokenSet: !!(cfg?.feishu?.scheme === "1" ? cfg?.feishu?.outWebhook : (cfg?.feishu?.appId && cfg?.feishu?.appSecret)), pollerRunning: true },
    wecom: { tokenSet: !!(cfg?.wecom?.botId && cfg?.wecom?.secret), pollerRunning: wecomWs !== null },
    qq: { tokenSet: !!(cfg?.qq?.appId && cfg?.qq?.appSecret), pollerRunning: true },
    wechat: { tokenSet: !!cfg?.wechat?.botToken, pollerRunning: wechatPolling },
  });

  /** 凭据缺什么（人话说明），齐了返回 null。 */
  const credentialHint = (ch, cfg) => {
    if (channelRuntimeInfo(cfg)[ch]?.tokenSet === true) return null;
    if (ch === "telegram") return "Telegram：需要 Bot Token（@BotFather 申请）";
    if (ch === "dingtalk") return cfg?.dingtalk?.scheme === "1" ? "钉钉方案一：需要群机器人 Webhook 地址" : "钉钉方案二：需要 AppKey + AppSecret + robotCode";
    if (ch === "feishu") return cfg?.feishu?.scheme === "1" ? "飞书方案一：需要群机器人 Webhook 地址" : "飞书方案二：需要 App ID + App Secret";
    if (ch === "wecom") return "企业微信：需要智能机器人 botId + secret（或改用群 Webhook / 应用消息）";
    if (ch === "qq") return "QQ：需要开放平台 AppID + AppSecret（或用 OneBot 地址）";
    if (ch === "wechat") return "微信：需要 iLink botToken（本页「扫码登录」获取）";
    return "凭据未配置完整";
  };

  /** 真打一次平台接口校验凭据（拿不到就只判配置）。不通过时抛错，错误文案即给用户看的原因。 */
  const probeChannelCredential = async (cfg, ch) => {
    if (ch === "telegram") {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegram.botToken}/getMe`, { signal: AbortSignal.timeout(8000) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.ok !== true) throw new Error(`getMe 失败：HTTP ${res.status} ${d.description || ""}`.trim());
      return "Telegram 凭据有效（@" + (d.result?.username || d.result?.first_name || "bot") + "）";
    }
    if (ch === "dingtalk") {
      const dt = cfg.dingtalk || {};
      if (dt.scheme === "1") { if (!dt.outWebhook) throw new Error("未配置方案一群机器人 Webhook 地址"); return "钉钉方案一 Webhook 已配置"; }
      await getDingAccessToken(dt.appKey, dt.appSecret);
      return "钉钉方案二凭据有效（accessToken 已刷新）";
    }
    if (ch === "feishu") {
      const fs2 = cfg.feishu || {};
      if (fs2.scheme === "1") { if (!fs2.outWebhook) throw new Error("未配置方案一群机器人 Webhook 地址"); return "飞书方案一 Webhook 已配置"; }
      await getFeishuTenantToken(fs2.appId, fs2.appSecret);
      return "飞书方案二凭据有效（tenant_access_token 已刷新）";
    }
    if (ch === "qq") {
      const q = cfg.qq || {};
      if (q.appId && q.appSecret) { await getQqToken(q); return "QQ 开放平台凭据有效（accessToken 已刷新）"; }
      if (q.onebotUrl) return "QQ OneBot 地址已配置（不主动探测连通性）";
      throw new Error("QQ 既未配置 AppID/AppSecret，也未配置 OneBot 地址");
    }
    if (ch === "wecom") {
      const wx = cfg.wecom || {};
      if (wx.botId && wx.secret) return wecomWs !== null ? "企业微信长连接在线" : "企业微信凭据已配置（长连接重连中）";
      if (wx.outWebhook) return "企业微信群 Webhook 已配置";
      if (wx.corpid && wx.corpsecret && wx.agentid) return "企业微信应用消息凭据已配置";
      throw new Error("企业微信未配置可用凭据");
    }
    if (ch === "wechat") {
      if (!cfg.wechat?.botToken) throw new Error("微信 botToken 未配置");
      return "微信 botToken 已配置（长轮询重启后开始收消息）";
    }
    return null;
  };

  /** 按渠道重启接收通道；回调型渠道（钉钉/飞书/QQ）本机没有常驻接收进程，返回 null。 */
  const restartChannelReceiver = (cfg, ch) => {
    if (ch === "telegram") { startPolling(cfg); return "已重启 Telegram getUpdates 轮询"; }
    if (ch === "wechat") { startWechatPolling(cfg, true); return "已重启微信 iLink 长轮询（旧循环自动退出）"; }
    if (ch === "wecom") { startWecomBot(cfg); return "已重连企业微信智能机器人长连接"; }
    return null;
  };

  /** 清掉某渠道的访问令牌缓存（token 过期/被顶掉是「最近出站失败」的常见根因）。 */
  const clearChannelTokenCache = (ch) => {
    const cleared = [];
    if (ch === "dingtalk" && dingTokenCache.token) { dingTokenCache = { token: "", exp: 0 }; cleared.push("钉钉"); }
    if (ch === "feishu" && feishuTokenCache.token) { feishuTokenCache = { token: "", exp: 0 }; cleared.push("飞书"); }
    if (ch === "qq" && qqTokCache.token) { qqTokCache = { token: "", exp: 0 }; cleared.push("QQ"); }
    return cleared.join("、");
  };

  /** 清掉健康账里的错误痕迹（保留入站/出站计数这些「历史事实」，只清错误）。返回是否清过东西。 */
  const clearChannelErrors = (ch) => {
    const r = hrec(ch);
    const had = (r.poller.fails || 0) > 0 || !!r.poller.lastError || !!r.outbound.lastError || r.outbound.lastOk === false || !!r.inbound.lastSkipReason;
    r.poller.fails = 0;
    r.poller.lastError = null;
    r.poller.lastErrorAt = null;
    r.inbound.lastSkipReason = null;
    r.outbound.lastError = null;
    if (r.outbound.lastOk === false) r.outbound.lastOk = null;
    return had;
  };

  /** 单渠道修复：永不抛，所有失败都变成给用户看的 manual 提示。 */
  const repairChannel = async (cfg, ch) => {
    const label = CHANNEL_LABELS[ch] || ch;
    const actions = [];
    const manual = [];
    const notes = [];
    const info = channelRuntimeInfo(cfg)[ch] || {};
    const enabled = !!(cfg?.enabled && cfg?.[ch]?.enabled);
    const before = healthyView(ch, cfg, { enabled, tokenSet: !!info.tokenSet, pollerRunning: info.pollerRunning !== false });
    if (!enabled) {
      manual.push(!cfg?.enabled
        ? "插件总开关未开：设置 → 多渠道机器人 → 打开顶部「启用」"
        : ("渠道未启用：在「" + label + "」分组里打开开关后再点修复"));
      return { channel: ch, label, enabled: false, skipped: true, ok: false, probe: null, actions, manual, notes, before, after: before };
    }
    /* 1) 凭据校验（失败不阻断后面的修复动作） */
    let probe = { ok: false, message: "" };
    const hint = credentialHint(ch, cfg);
    if (hint) {
      probe = { ok: false, message: hint };
      manual.push(hint);
    } else {
      try {
        probe = { ok: true, message: await probeChannelCredential(cfg, ch) };
        actions.push("✔ " + probe.message);
      } catch (error) {
        probe = { ok: false, message: error instanceof Error ? error.message : String(error) };
        manual.push("凭据校验未通过：" + probe.message);
      }
    }
    /* 2) 重启接收通道 */
    let restarted = null;
    try {
      restarted = restartChannelReceiver(cfg, ch);
      if (restarted) actions.push("✔ " + restarted);
      else notes.push("回调型渠道：入站由平台推送到 /api/channel-bot/webhook/" + ch + "，本机没有常驻接收进程可重启");
    } catch (error) {
      manual.push("重启接收通道失败：" + (error instanceof Error ? error.message : String(error)));
    }
    /* 3) 清令牌缓存 */
    const cleared = clearChannelTokenCache(ch);
    if (cleared) actions.push("✔ 已清除 " + cleared + " 访问令牌缓存（下次发送重新获取）");
    /* 4) 清历史错误账 */
    if (clearChannelErrors(ch)) actions.push("✔ 已清除历史错误计数与最近错误");
    /* 5) 复核：重启后给轮询/长连接一点建立时间，再按同一口径重新判定 */
    if (restarted) await new Promise((resolve) => setTimeout(resolve, 400));
    const nowCfg = current();
    const info2 = channelRuntimeInfo(nowCfg)[ch] || {};
    const after = healthyView(ch, nowCfg, { enabled: true, tokenSet: !!info2.tokenSet, pollerRunning: info2.pollerRunning !== false });
    const ok = after.ok && (!hint) && probe.ok;
    if (!after.ok) manual.push("修复后仍有问题：" + ((after.problems || []).join("；") || "未知"));
    if (ok) actions.push("✔ 修复后自检通过（健康账已清零）");
    return { channel: ch, label, enabled: true, skipped: false, ok, probe, actions, manual, notes, before, after };
  };

  ctx.effect(() => {
    const routes = [
      {
        kind: "exact",
        path: `${API_PREFIX}/plan-approval`,
        handler: async (request, response) => {
          try {
            const body = await readBody(request);
            const result = await planApprovals.handlePlan(body);
            sendJson(response, 200, result);
          } catch (error) {
            console.error("[channel-bot] plan-approval failed:", error instanceof Error ? error.message : String(error));
            sendJson(response, 500, { ok: false, error: "internal error" });
          }
        },
      },
      {
        kind: "exact",
        path: `${API_PREFIX}/tool-approval`,
        handler: async (request, response) => {
          try {
            const body = await readBody(request);
            const result = await planApprovals.handleTool(body);
            sendJson(response, 200, result);
          } catch (error) {
            console.error("[channel-bot] tool-approval failed:", error instanceof Error ? error.message : String(error));
            sendJson(response, 500, { ok: false, error: "internal error" });
          }
        },
      },
      {
        kind: "exact",
        path: `${API_PREFIX}/wechat/login`,
        handler: async (_request, response) => {
          try {
            const res = await fetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(`get_bot_qrcode HTTP ${res.status}`);
            const data = await res.json();
            const url = data.qrcode_img_content;
            if (!data.qrcode || typeof url !== "string") throw new Error("unexpected qrcode response");
            wechatLogin = { qrcode: data.qrcode, url, expiresAt: Date.now() + 170000 };
            writeFileSync(join(homedir(), ".dsh", "wechat-login-url.txt"), url);
            try {
              execFileSync("qrencode", ["-s", "8", "-o", join(homedir(), ".dsh", "wechat-login-qr.png"), url], { timeout: 10000 });
            } catch { /* qrencode missing: client can fall back to the url */ }
            sendJson(response, 200, { ok: true, url, expiresAt: wechatLogin.expiresAt });
          } catch (error) {
            sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        kind: "exact",
        path: `${API_PREFIX}/wechat/login/status`,
        handler: async (_request, response) => {
          try {
            if (!wechatLogin) { sendJson(response, 200, { status: "idle" }); return; }
            if (Date.now() > wechatLogin.expiresAt) { wechatLogin = null; sendJson(response, 200, { status: "expired" }); return; }
            const res = await fetch(`${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(wechatLogin.qrcode)}`, { signal: AbortSignal.timeout(40000) });
            if (!res.ok) throw new Error(`get_qrcode_status HTTP ${res.status}`);
            const st = await res.json();
            if (st.status === "confirmed" && st.bot_token) {
              if (settingsUpdate) {
                await settingsUpdate({ wechat: { enabled: true, botToken: st.bot_token, allowedUserIds: [] } });
              }
              wechatLogin = null;
              sendJson(response, 200, { status: "confirmed" });
              return;
            }
            sendJson(response, 200, { status: st.status ?? "waiting" });
          } catch (error) {
            sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        kind: "exact",
        path: `${API_PREFIX}/wechat/qr`,
        handler: (_request, response) => {
          try {
            const buf = readFileSync(join(homedir(), ".dsh", "wechat-login-qr.png"));
            response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
            response.end(buf);
          } catch {
            sendJson(response, 404, { error: "no active wechat login QR" });
          }
        },
      },
      {
        kind: "exact",
        path: `${API_PREFIX}/status`,
        handler: (_request, response) => {
          const cfg = current();
          const channels = [];
          if (cfg.telegram?.enabled) channels.push("telegram");
          if (cfg.dingtalk?.enabled) channels.push("dingtalk");
          if (cfg.feishu?.enabled) channels.push("feishu");
          if (cfg.wecom?.enabled) channels.push("wecom");
          if (cfg.qq?.enabled) channels.push("qq");
          if (cfg.wechat?.enabled) channels.push("wechat");
          sendJson(response, 200, {
            ok: true,
            enabled: !!cfg.enabled,
            channels,
            version: harnessVersion(),
            pluginVersion: VERSION,
            compat: { testedCore: COMPAT.testedCore, minCore: COMPAT.minCore, core: harnessVersion() },
            uptimeSeconds: Math.floor(process.uptime()),
            pluginCount: pluginList().length,
            /* [v2.1.0] 四渠道双向健康账：轮询是否活着 / 最近入站 / 最近出站。
             * 面板「诊断 → 四渠道双向自检」直接渲染这张表，用户不用翻日志。 */
            health: channelHealthView(cfg, channelRuntimeInfo(cfg)),
            channelsMeta: CHANNELS.map((ch) => ({
              id: ch, label: CHANNEL_LABELS[ch],
              enabled: !!(cfg.enabled && cfg[ch]?.enabled),
              selfCheck: selfCheckEnabled(cfg, ch),
              scheme: cfg[ch]?.scheme ?? null,
            })),
            state: {
              wechatContexts: Object.keys(persistedState.wechatContexts).length,
              wechatContextIds: Object.keys(persistedState.wechatContexts),
              qqInbound: persistedState.qqInbound,
              qqMsgIdsCached: Object.keys(persistedState.qqMsgIds || {}).length,
              notifyTargets: planNotifyTargets(cfg, persistedState).map((t) => t.channel),
              notifySkipped: notifySkipReasons(cfg, persistedState),
            },
          });
        },
      },
      {
        /* [v2.2.0] 插件写入自身配置（分渠道方案切换 / 自检开关 / 目标 ID）。
         * POST {patch:{ dingtalk:{scheme:"2"}, feishu:{scheme:"2"} }} → 合并进 channel-bot 命名空间。
         * 用于：把钉钉/飞书切成「方案二」、批量设 selfCheck、脚本化配置，免手改 settings.yaml。 */
        kind: "exact",
        path: `${API_PREFIX}/config`,
        handler: async (request, response) => {
          try {
            if (request.method !== "POST") { sendJson(response, 405, { ok: false, error: "method not allowed" }); return; }
            const body = await readBody(request);
            const patch = body && typeof body.patch === "object" && body.patch ? body.patch : null;
            if (!patch) { sendJson(response, 400, { ok: false, error: "patch required" }); return; }
            const allowed = new Set([...CHANNELS, "enabled", "prefix", "commands", "chat", "approvals", "notifyEvents"]);
            const unknown = Object.keys(patch).filter((k) => !allowed.has(k));
            if (unknown.length) { sendJson(response, 400, { ok: false, error: "unknown keys: " + unknown.join(", ") }); return; }
            if (typeof settingsUpdate !== "function") { sendJson(response, 503, { ok: false, error: "settings 未就绪" }); return; }
            await settingsUpdate(patch);
            const now = current();
            sendJson(response, 200, {
              ok: true,
              applied: Object.keys(patch),
              schemes: Object.fromEntries(CHANNELS.map((ch) => [ch, now?.[ch]?.scheme ?? null])),
              selfCheck: Object.fromEntries(CHANNELS.map((ch) => [ch, selfCheckEnabled(now, ch)])),
            });
          } catch (error) {
            sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        kind: "exact",
        path: `${API_PREFIX}/test`,
        handler: async (request, response) => {
          try {
            const body = await readBody(request);
            const channel = typeof body?.channel === "string" ? body.channel.trim().toLowerCase() : "";
            if (!channel) { sendJson(response, 200, { ok: false, error: "channel is required" }); return; }
            const scheme = typeof body?.scheme === "string" ? String(body.scheme).trim() : "";
            const target = typeof body?.target === "string" ? String(body.target).trim() : "";
            const targetType = typeof body?.targetType === "string" ? String(body.targetType).trim() : "";
            const info = await testChannel(current(), channel, scheme, target, targetType);
            sendJson(response, 200, { ok: true, sent: channel, ...(typeof info === "string" ? { message: info } : {}) });
          } catch (error) {
            sendJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        /* [v2.3.0] 渠道修复：
         *   POST {channel:"telegram"} → 修单个渠道；
         *   POST {channel:"all"} 或省略 channel → 一键修复全部「已启用」渠道（未启用/凭据缺失如实列为待人工）。
         * 返回每个渠道的动作清单 + 仍需人工的事项 + 修复前后结论，以及修复后的完整健康表。 */
        kind: "exact",
        path: `${API_PREFIX}/repair`,
        handler: async (request, response) => {
          try {
            if (request.method !== "POST") { sendJson(response, 405, { ok: false, error: "method not allowed（请用 POST）" }); return; }
            const body = await readBody(request);
            const raw = typeof body?.channel === "string" ? body.channel.trim().toLowerCase() : "";
            const scope = (!raw || raw === "all" || raw === "*") ? "all" : raw;
            if (scope !== "all" && !CHANNELS.includes(scope)) {
              sendJson(response, 400, { ok: false, error: "unknown channel: " + raw + "（可用：" + CHANNELS.join(" / ") + " / all）" });
              return;
            }
            const cfg = current();
            if (!cfg?.enabled && scope === "all") {
              sendJson(response, 200, {
                ok: false, scope, error: "多渠道机器人总开关未开启：设置 → 多渠道机器人 → 打开顶部「启用」",
                summary: { total: CHANNELS.length, repaired: 0, healthy: 0, failed: 0, skipped: CHANNELS.length, actions: 0 },
                results: [], health: channelHealthView(cfg, channelRuntimeInfo(cfg)),
              });
              return;
            }
            const list = scope === "all" ? CHANNELS.slice() : [scope];
            const results = [];
            for (const ch of list) results.push(await repairChannel(cfg, ch));
            const fixed = results.filter((r) => !r.skipped);
            const after = current();
            sendJson(response, 200, {
              ok: fixed.length > 0 && fixed.every((r) => r.ok),
              scope,
              summary: {
                total: results.length,
                repaired: fixed.length,
                healthy: fixed.filter((r) => r.ok).length,
                failed: fixed.filter((r) => !r.ok).length,
                skipped: results.filter((r) => r.skipped).length,
                actions: results.reduce((n, r) => n + (r.actions || []).length, 0),
              },
              results,
              health: channelHealthView(after, channelRuntimeInfo(after)),
              channelsMeta: CHANNELS.map((ch) => ({
                id: ch, label: CHANNEL_LABELS[ch],
                enabled: !!(after.enabled && after[ch]?.enabled),
                selfCheck: selfCheckEnabled(after, ch),
                scheme: after[ch]?.scheme ?? null,
              })),
            });
          } catch (error) {
            console.error("[channel-bot] repair failed:", error instanceof Error ? error.message : String(error));
            sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        kind: "exact",
        path: `${API_PREFIX}/notify`,
        handler: async (request, response) => {
          try {
            const body = await readBody(request);
            const text = typeof body?.text === "string" ? body.text.trim() : "";
            if (!text) { sendJson(response, 400, { error: "text is required" }); return; }
            const result = await notifier.notify(text, { channel: typeof body?.channel === "string" ? body.channel : undefined });
            sendJson(response, 200, result);
          } catch (error) {
            console.error("[channel-bot] notify route failed:", error instanceof Error ? error.message : String(error));
            sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        kind: "prefix",
        path: `${API_PREFIX}/webhook`,
        handler: async (request, response) => {
          try {
            // URL pathname parsing: the query string carries base64 signs with
            // '/' characters that would corrupt naive split("/") channel extraction.
            const channel = new URL(request.url, "http://local").pathname.split("/").filter(Boolean).pop() ?? "";
            const cfg = current();
            if (!cfg.enabled) { sendJson(response, 404, { error: "bot disabled" }); return; }
            if (channel === "wecom") { sendJson(response, 400, { error: "wecom inbound requires AES decryption; outbound only in v0.1" }); return; }
            const parse = PARSERS[channel];
            if (!parse) { sendJson(response, 404, { error: "unknown channel" }); return; }
            /* [v2.2.0] 先读 body 再校验：飞书方案二用 Verification Token / Encrypt Key 校验、
             * 钉钉方案二用 appSecret 签名（都在 body/header 上）。 */
            let body = await readBody(request);
            const verify = VERIFIERS[channel];
            if (verify && !verify(request, cfg, body)) { sendJson(response, 403, { error: "bad signature" }); return; }
            if (channel === "feishu") {
              const fs = cfg?.feishu || {};
              if (body && typeof body.encrypt === "string" && fs.encryptKey) {
                const plain = feishuDecrypt(fs.encryptKey, body.encrypt);
                if (!plain) { sendJson(response, 403, { error: "feishu decrypt failed (检查 Encrypt Key)" }); return; }
                body = plain;
              }
              if (fs.scheme !== "1" && fs.verificationToken) {
                const tok = body?.token ?? body?.header?.token ?? "";
                if (tok && String(tok) !== String(fs.verificationToken)) {
                  sendJson(response, 403, { error: "bad verification token" }); return;
                }
              }
            }
            // QQ 回调地址验证(op=13): 期望返回 {plain_token, signature}
            if (channel === "qq" && body?.op === 13) {
              const d = body.d || {};
              const pt = String(d.plain_token ?? "");
              const et = String(d.event_ts ?? "");
              const signature = qqCallbackSignature(cfg.qq?.appSecret ?? "", pt, et);
              sendJson(response, 200, { plain_token: pt, signature });
              return;
            }
            const message = parse(body, cfg);
            if (message === null) {
              // Feishu URL verification challenge
              if (channel === "feishu" && typeof body?.challenge === "string") {
                sendJson(response, 200, { challenge: body.challenge });
                return;
              }
              sendJson(response, 200, { ok: true }); // non-text events: ack
              return;
            }
            if (channel === "qq" && message?.msgId && typeof message.msgId === "string") {
              const tid = String(message.target?.id ?? message.from);
              qqMsgIdMap.set(tid, message.msgId);
              /* [v2.1.0] 落盘「最近入站会话」：QQ 开放平台 v2 的通知只能推到 openid
               * （msg_id 只在短时间内可用于被动回复），重启后仍要能推 → 必须持久化。 */
              if (isQqOpenidLike(tid)) {
                persistedState.qqInbound = { id: tid, type: message.target?.type === "group" ? "group" : "private", at: new Date().toISOString() };
                rememberQqMsgId(tid, message.msgId);
              } else {
                markSkip("qq", "入站会话 id 不是合法 openid：" + tid);
              }
            }
            markInbound(channel === "qq" ? "qq" : channel, message.from, message.text);
            const reply = await handleInbound({
              platform: channel,
              chatId: channel === "qq" ? String(message.target?.id ?? message.from) : String(message.from),
              chatType: channel === "qq" ? (message.target?.type === "group" ? "group" : "private") : "private",
              text: message.text,
              msgId: message.msgId,
            });
            if (reply !== null) {
              const context = channel === "qq"
                ? { channel, target: message.target }
                : { channel, chatId: message.from };
              await answer(cfg, context, reply);
            }
            sendJson(response, 200, { ok: true });
          } catch (error) {
            console.error("[channel-bot] webhook failed:", error instanceof Error ? error.message : String(error));
            sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
    ];
    const disposers = routes.map((route) => ctx.webServer.register(route));
    // [hermes-ops 0.1.5-rc.1] migrated from installSettingsSection(settingsNamespace(NS), ...)
    // to the 0.1.5 service-level API: settingsCtx.settings.installSection(owner, ns, schema, entry, hooks).
    ctx.inject(["settings"], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, NS, schema, base, {
        setSource: (source) => { current = source; },
        onChange: () => { applyConfig(current()); },
      });
    });
    loadPersistedState();   // [v2.1.0] 微信 context_token / QQ 最近入站会话 跨重启恢复（必须在启动轮询前）
    applyConfig(current()); // start polling loops with persisted config at boot
    console.log("[channel-bot] 持久化状态已加载：微信 context_token " + Object.keys(persistedState.wechatContexts).length
      + " 个，QQ 最近入站 " + (persistedState.qqInbound ? persistedState.qqInbound.id : "无"));
    pollerWatchdog();
    return () => {
      for (const dispose of disposers) dispose();
      if (typeof disposeSessionEvents === "function") disposeSessionEvents();
      if (typeof disposeApprovals === "function") disposeApprovals();
        if (typeof planApprovals?.dispose === "function") planApprovals.dispose();

      void chatMap.dispose();
      if (watchdogTimer) clearInterval(watchdogTimer);
      unloading = true;   // [v2.3.0] 先标记「卸载中」：随后被主动中止的请求不再计入渠道错误
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (pollStop) { try { pollStop(); } catch { /* ignore */ } pollStop = null; }   // [v2.3.0] 一并中止在飞的 getUpdates
      wechatPolling = false;
      if (wechatAbort) { try { wechatAbort.abort(); } catch { /* ignore */ } wechatAbort = null; }
      if (wechatTimer) { clearTimeout(wechatTimer); wechatTimer = null; }
    };
  }, "channel-bot: routes+settings");
}
export { apply, inject, name };
