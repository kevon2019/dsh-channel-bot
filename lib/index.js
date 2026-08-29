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
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "schemastery";
import AiBot from "@wecom/aibot-node-sdk";
import { createHmac, createPrivateKey, randomUUID, sign, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { markdownToText, splitLongText, inQuietHours } from "./render.js";
import { ChatSessionMap } from "./sessions.js";
import { dispatchTask } from "./dispatch.js";
import { ApprovalBridge } from "./approvals.js";

const NS = "channel-bot";
const API_PREFIX = "/api/channel-bot";
const POLL_INTERVAL_MS = 2000;
const PROFILE_DIR = join(homedir(), ".dsh", "profiles", process.env.DSH_PROFILE ?? "web");
const BALANCE_URL = "https://api.deepseek.com/user/balance";
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
  }),
  dingtalk: channelSchema,
  feishu: channelSchema,
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
  if (cmd === "version" && cmds.version !== false) return `DeepSeek Harness ${harnessVersion()}`;
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
async function sendDingTalk(cfg, text) {
  let url = cfg.dingtalk?.outWebhook;
  if (!url) return;
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
async function sendFeishu(cfg, text) {
  const url = cfg.feishu?.outWebhook;
  if (!url) return;
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
async function sendWecom(cfg, text, opts) {
  const wx = cfg.wecom || {};
  const forceS1 = !!(opts && opts.scheme === "1");
  const forceS2 = !!(opts && opts.scheme === "2");
  const touserOv = (opts && opts.touser) || "";
  // 方案二：企微智能机器人（botId+secret，Bot WebSocket）——可主动推送
  if (!forceS1 && wx.botId && wx.secret && wecomWs) {
    const chatId = touserOv || wx.touser || wecomChatId;
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
async function sendQqV2(q, target, text) {
  const token = await getQqToken(q);
  const isGroup = target?.type === "group";
  const id = String(target?.id ?? "");
  if (!id) return;
  const url = isGroup
    ? `https://api.sgroup.qq.com/v2/groups/${encodeURIComponent(id)}/messages`
    : `https://api.sgroup.qq.com/v2/users/${encodeURIComponent(id)}/messages`;
  const payload = { content: text, msg_type: 0 };
  const mid = qqMsgIdMap.get(id);
  console.log("[qq] v2 send type=", target?.type, "id=", id, "mid=", mid ? "YES" : "NO", "map=", qqMsgIdMap.size);
  if (mid) payload.msg_id = mid;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`qq v2 send HTTP ${res.status}: ${t.slice(0, 140)}`); }
}
async function sendQq(cfg, target, text) {
  const q = cfg?.qq || {};
  if (q.appId && q.appSecret) return sendQqV2(q, target, text);
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
const wechatCtxMap = new Map(); // chatId → iLink context_token (inbound 每条更新，回复必须带回)
async function sendWechat(cfg, target, text) {
  const token = cfg.wechat?.botToken;
  if (!token) return;
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
        ...(target.contextToken ? { context_token: target.contextToken } : {}),
        item_list: [{ type: 1, text_item: { text } }],
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`wechat send HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data && typeof data.ret === "number" && data.ret !== 0) {
    throw new Error(`wechat send ret ${data.ret}${data.err_msg ? `: ${data.err_msg}` : ""}`);
  }
}
async function dispatchReply(cfg, context, text) {
  switch (context.channel) {
    case "telegram": await sendTelegram(cfg, context.chatId, text); break;
    case "dingtalk": await sendDingTalk(cfg, text); break;
    case "feishu": await sendFeishu(cfg, text); break;
    case "wecom": await sendWecom(cfg, text); break;
    case "qq": await sendQq(cfg, context.target, text); break;
    case "wechat": await sendWechat(cfg, context, text); break;
  }
}
async function answer(cfg, context, text) {
  try { await dispatchReply(cfg, context, text); }
  catch (error) { console.error("[channel-bot] reply failed:", error instanceof Error ? error.message : String(error)); }
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
  const targets = [];
  if (cfg?.telegram?.enabled && cfg.telegram.notify) {
    const chatId = cfg.telegram.notifyChatId || cfg.telegram.allowedChatIds?.[0];
    if (chatId) targets.push({ channel: "telegram", chatId: String(chatId) });
  }
  if (cfg?.dingtalk?.enabled && cfg.dingtalk.notify && cfg.dingtalk.outWebhook) targets.push({ channel: "dingtalk" });
  if (cfg?.feishu?.enabled && cfg.feishu.notify && cfg.feishu.outWebhook) targets.push({ channel: "feishu" });
  const wecomAppMsg = (cfg?.wecom?.corpid && cfg.wecom.corpsecret && cfg.wecom.agentid && cfg.wecom.touser);
  if (cfg?.wecom?.enabled && cfg.wecom.notify && (cfg.wecom.outWebhook || wecomAppMsg)) targets.push({ channel: "wecom" });
  if (cfg?.qq?.enabled && cfg.qq.notify && cfg.qq.onebotUrl && cfg.qq.groupId) {
    targets.push({ channel: "qq", target: { type: "group", id: String(cfg.qq.groupId) } });
  }
  if (cfg?.wechat?.enabled && cfg.wechat.notify) {
    const uid = cfg.wechat.notifyUserId || cfg.wechat.allowedUserIds?.[0];
    if (uid) targets.push({ channel: "wechat", chatId: String(uid) });
  }
  return targets;
}
async function notifyTarget(cfg, target, text) {
  switch (target.channel) {
    case "telegram": await sendTelegram(cfg, target.chatId, text); break;
    case "dingtalk": await sendDingTalk(cfg, text); break;
    case "feishu": await sendFeishu(cfg, text); break;
    case "wecom": await sendWecom(cfg, text); break;
    case "qq": await sendQq(cfg, target.target, text); break;
    case "wechat": await sendWechat(cfg, { channel: "wechat", chatId: target.chatId }, text); break;
    default: throw new Error(`unknown notification channel "${target.channel}"`);
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
  switch (channel) {
    case "telegram": {
      const t = cfg?.telegram || {};
      const chatId = t.notifyChatId || t.allowedChatIds?.[0];
      if (!chatId) throw new Error("未配置 Telegram 接收 ID（通知 Chat ID 或允许的 Chat ID）");
      await sendTelegram(cfg, String(chatId), text);
      break;
    }
    case "dingtalk": {
      if (!cfg?.dingtalk?.outWebhook) throw new Error("未配置钉钉机器人 Webhook 地址");
      await sendDingTalk(cfg, text);
      break;
    }
    case "feishu": {
      if (!cfg?.feishu?.outWebhook) throw new Error("未配置飞书机器人 Webhook 地址");
      await sendFeishu(cfg, text);
      break;
    }
    case "wecom": {
      const wx = cfg?.wecom || {};
      const appMsg = wx.corpid && wx.corpsecret && wx.agentid && wx.touser;
      const t = (target || "").trim();
      if (scheme === "2") {
        /* 方案二：智能机器人长连接（botId+secret），目标 = 指定 target || touser || 最近会话 */
        if (!wx.botId || !wx.secret) throw new Error("未配置方案二（企微智能机器人 Bot ID+Secret）");
        if (!wecomWs) throw new Error("企业微信长连接客户端未连接（正在初始化/重连，请稍后重试）");
        const tgt = t || wx.touser || wecomChatId;
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
        const tgt = t || wx.touser || wecomChatId;
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
        const id = t || qqMsgIdMap.keys().next().value;
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
      const uid = t || w.notifyUserId || w.allowedUserIds?.[0];
      if (!uid) throw new Error("未配置微信接收用户 ID（通知用户 ID、允许的用户 ID、或填一个目标ID）");
      await sendWechat(cfg, { channel: "wechat", chatId: String(uid) }, text);
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
  const secret = cfg.dingtalk?.secret;
  if (!secret) return true; // no secret configured: skip verification (operator choice)
  const url = new URL(request.url, "http://local");
  const ts = url.searchParams.get("timestamp");
  const sign = url.searchParams.get("sign");
  if (!ts || !sign) return false;
  return safeEqual(decodeURIComponent(sign), hmacBase64(secret, `${ts}\n${secret}`));
}
function verifyFeishu(request, cfg) {
  const secret = cfg.feishu?.secret;
  if (!secret) return true;
  const ts = request.headers["x-lark-request-timestamp"];
  const sign = request.headers["x-lark-signature"];
  if (!ts || !sign) return false;
  return safeEqual(sign, hmacBase64(secret, `${ts}\n${secret}`));
}
function parseDingTalk(body) {
  const content = body?.text?.content;
  if (typeof content !== "string") return null;
  return { text: content, from: body.sender?.nick ?? "钉钉用户" };
}
function parseFeishu(body) {
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
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const token = cfg?.telegram?.botToken;
    if (!cfg?.enabled || !cfg?.telegram?.enabled || !token) return;
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset: pollOffset, timeout: 30 }),
          signal: AbortSignal.timeout(35000),
        });
        if (!res.ok) return;
        const data = await res.json();
        for (const update of data.result ?? []) {
          pollOffset = Math.max(pollOffset, (update.update_id ?? 0) + 1);
          const msg = update.message;
          if (!msg?.text) continue;
          const allow = cfg.telegram.allowedChatIds ?? [];
          if (allow.length > 0 && !allow.includes(String(msg.chat.id))) continue;
          const reply = await handleInbound({
            platform: "telegram",
            chatId: String(msg.chat.id),
            chatType: msg.chat.type === "private" ? "private" : "group",
            text: msg.text,
            msgId: msg.message_id,
          });
          if (reply !== null) await answer(current(), { channel: "telegram", chatId: msg.chat.id }, reply);
        }
      } catch (error) {
        console.warn("[channel-bot] telegram poll failed:", error instanceof Error ? error.message : String(error));
      }
    }, POLL_INTERVAL_MS);
  };

  /* 方案二：企微智能机器人（botId+secret，WebSocket 长连接）——开始/停止 Bot 客户端。
   * 收文本消息 → 调用面板命令工厂 handleCommand → 流式回复；同时记录会话 userid 供主动推送。 */
  const startWecomBot = (cfg) => {
    if (wecomWs) { try { wecomWs.disconnect(); } catch {} wecomWs = null; }
    const wx = (cfg || {}).wecom || {};
    if (wx.enabled && wx.botId && wx.secret) {
      try {
        wecomWs = new AiBot.WSClient({ botId: wx.botId, secret: wx.secret });
        wecomWs.on("authenticated", () => console.log("[channel-bot] wecom Bot authenticated"));
        wecomWs.on("message.text", (frame) => {
          try {
            const content = frame?.body?.text?.content;
            console.log("[wecom] message.text 触发 content=", JSON.stringify(content), "| chat.enabled=", (current().chat || {}).enabled, "| bodyKeys=", Object.keys(frame?.body || {}));
            if (typeof content !== "string") { console.log("[wecom] content 非字符串, 忽略"); return; }
            const chatId = frame?.body?.from?.userid || frame?.body?.sender?.userid || frame?.body?.receiver?.userid || frame?.body?.userid || "";
            if (chatId) wecomChatId = chatId;
            const msgId = frame?.header?.msg_seq ?? frame?.body?.seq ?? Date.now();
            (async () => {
              let out = null;
              try {
                const reply = await handleInbound({ platform: "wecom", chatId, chatType: "private", text: content, msgId });
                console.log("[wecom] handleInbound reply=", reply);
                if (reply !== null && reply !== undefined) out = String(reply);
              } catch (e) { console.warn("[wecom] handleInbound 异常:", e?.message || String(e)); out = "❌ " + (e?.message || String(e)); }
              if (out) { console.log("[wecom] 回发:", String(out).slice(0, 60)); try { await wecomWs.replyStream(frame, String(Date.now()), out, true); } catch (e2) { console.warn("[wecom] replyStream 失败:", e2?.message || String(e2)); } }
            })();
          } catch (e) { console.warn("[wecom] 外层异常:", e?.message || String(e)); }
        });
        wecomWs.connect();
      } catch (e) { console.warn("[channel-bot] wecom Bot start failed:", e?.message || String(e)); }
    }
  };
  const applyConfig = (cfg) => { startPolling(cfg); startWechatPolling(cfg); startWecomBot(cfg); };

  /* iLink (WeChat) long-polling: like Telegram getUpdates, cursor-based. */
  let wechatPolling = false;
  let wechatTimer = null;
  let wechatBuf = "";
  const startWechatPolling = (cfg) => {
    const token = cfg?.wechat?.botToken;
    if (!cfg?.enabled || !cfg?.wechat?.enabled || !token) return;
    if (wechatPolling) return; // loop self-reloads config via current()
    wechatPolling = true;
    wechatBuf = "";
    const loop = async () => {
      if (!wechatPolling) return;
      try {
        const cur = current();
        const tok = cur.wechat?.botToken;
        if (!cur.enabled || !cur.wechat?.enabled || !tok) { wechatPolling = false; return; }
        const res = await fetch(`${ILINK_BASE}/ilink/bot/getupdates`, {
          method: "POST",
          headers: ilinkHeaders(tok),
          body: JSON.stringify({ get_updates_buf: wechatBuf, base_info: { channel_version: "1.0.2" } }),
          signal: AbortSignal.timeout(45000),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data && Array.isArray(data.msgs)) {
            wechatBuf = data.get_updates_buf ?? wechatBuf;
            for (const msg of data.msgs) {
              if (!msg || msg.message_type !== 1) continue;
              const text = msg.item_list?.[0]?.text_item?.text;
              if (typeof text !== "string") continue;
              const allow = cur.wechat?.allowedUserIds ?? [];
              if (allow.length > 0 && !allow.includes(String(msg.from_user_id))) continue;
              if (typeof msg.context_token === "string" && msg.context_token !== "") wechatCtxMap.set(String(msg.from_user_id), msg.context_token);
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
          console.warn("[channel-bot] wechat getupdates HTTP", res.status);
        }
      } catch (error) {
        console.warn("[channel-bot] wechat poll failed:", error instanceof Error ? error.message : String(error));
      }
      if (wechatPolling) wechatTimer = setTimeout(loop, 1500);
    };
    loop();
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
            uptimeSeconds: Math.floor(process.uptime()),
            pluginCount: pluginList().length,
          });
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
            await testChannel(current(), channel, scheme, target, targetType);
            sendJson(response, 200, { ok: true, sent: channel });
          } catch (error) {
            sendJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
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
            const verify = VERIFIERS[channel];
            if (verify && !verify(request, cfg)) { sendJson(response, 403, { error: "bad signature" }); return; }
            const parse = PARSERS[channel];
            if (!parse) { sendJson(response, 404, { error: "unknown channel" }); return; }
            const body = await readBody(request);
            // QQ 回调地址验证(op=13): 期望返回 {plain_token, signature}
            if (channel === "qq" && body?.op === 13) {
              const d = body.d || {};
              const pt = String(d.plain_token ?? "");
              const et = String(d.event_ts ?? "");
              const signature = qqCallbackSignature(cfg.qq?.appSecret ?? "", pt, et);
              sendJson(response, 200, { plain_token: pt, signature });
              return;
            }
            const message = parse(body);
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
              qqMsgIdMap.set(String(message.target?.id ?? message.from), message.msgId);
            }
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
    installSettingsSection(ctx, settingsNamespace(NS), schema, base, {
      setSource: (source) => { current = source; },
      onChange: () => { applyConfig(current()); },
    });
    applyConfig(current()); // start polling loops with persisted config at boot
    return () => {
      for (const dispose of disposers) dispose();
      if (typeof disposeSessionEvents === "function") disposeSessionEvents();
      if (typeof disposeApprovals === "function") disposeApprovals();
        if (typeof planApprovals?.dispose === "function") planApprovals.dispose();

      void chatMap.dispose();
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      wechatPolling = false;
      if (wechatTimer) { clearTimeout(wechatTimer); wechatTimer = null; }
    };
  }, "channel-bot: routes+settings");
}
export { apply, inject, name };
