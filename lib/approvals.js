/**
 * dsh-channel-bot — remote approval over IM.
 *
 * Two seams, mirroring dsh-im's approvals.js:
 *
 *   1. `tools/pre-execute` waterfall — a RISK GATE. Returning `{kind:'ask'}`
 *      makes dsh-tools route the call through the approval service. We only
 *      gate calls whose risk is >= the configured minimum, so routine work
 *      (npm install, git pull) never asks — approval fatigue is what makes
 *      people switch approvals off entirely.
 *
 *   2. `approval/request` waterfall — the ANSWERER. dsh-user-approval hands
 *      each pending decision to the waterfall; we push a card to the IM
 *      channels and resolve with one of its outcome words:
 *        'allowed-once' | 'rejected' | 'unavailable' | 'cancelled'
 *      Anything else (or a throw) is normalised to 'unavailable' upstream,
 *      which fails CLOSED. `next()` delegates to the browser dialog, so the
 *      panel keeps working when IM approval is off or unconfigured.
 *
 * Timeout semantics: `timeoutSec` with nobody answering pushes a "task is
 * blocked" reminder and keeps waiting until `pendingMaxSec`, then rejects.
 * Deny-by-default at every exit.
 *
 * The decision log is local-only (`~/.dsh/channel-bot-approvals.log`, one JSON
 * object per line). Approval content never leaves through the log.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { argsSummary } from "./render.js";

/** Risk order used by both the gate and the `minRisk` threshold. */
const RISK_RANK = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Tools that actually execute a shell command. Command-shaped rules must be
 * scoped to these: matching every tool made the `memory` tool trip a `high`
 * rule because the note it was saving QUOTED `rm -rf` — the dangerous string was
 * data, not an instruction. (Verified live.) dsh-im avoids this by naming a
 * concrete tool per rule; this profile has several shell tools under different
 * names, so a name pattern replaces the literal.
 */
const SHELL_TOOL = /^(tool-)?(bash|sh|zsh|shell|terminal|console|execute_bash|executebash|run_command|runcommand|cmd|powershell|pwsh)$/i;

/** Rule scopes: `#shell` = any shell tool, `*` = any tool, else an exact name. */
function ruleMatchesTool(rule, tool) {
  if (rule.tool === "#shell") return SHELL_TOOL.test(String(tool ?? ""));
  if (rule.tool === "*") return true;
  return rule.tool === tool;
}

/**
 * @param {'none'|'low'|'medium'|'high'} a
 * @param {'none'|'low'|'medium'|'high'} b
 * @returns {boolean} true when a >= b
 */
export function riskAtLeast(a, b) {
  return (RISK_RANK[a] ?? 0) >= (RISK_RANK[b] ?? 0);
}

/**
 * Built-in risk rules, ordered — first match wins. Deliberately tuned so
 * everyday development work stays `low`: only genuinely destructive or
 * privilege-escalating commands climb to medium/high.
 * @returns {{tool: string, args?: string, risk: 'low'|'medium'|'high'}[]}
 */
export function defaultRiskRules() {
  return [
    // Routine, explicitly low so the generic patterns below cannot catch them.
    { tool: "#shell", args: "rm\\s+-rf\\s+[^|;&]*node_modules", risk: "low" },
    { tool: "#shell", args: "(npm|pnpm|yarn|bun)\\s+(install|ci|add|remove|update|run)", risk: "low" },
    { tool: "#shell", args: "pip3?\\s+(install|uninstall)", risk: "low" },
    { tool: "#shell", args: "git\\s+(status|diff|log|pull|clone|fetch|checkout|merge|add|commit)", risk: "low" },
    // High: unrecoverable or remote-code-execution shaped.
    /* Only the truly unrecoverable targets: `/`, `~`, `*`, `$HOME` themselves.
     * A path merely STARTING with them stays medium (`rm -rf /tmp/x`,
     * `rm -rf ~/projects/tmp`), which is what the generic `rm -rf` rule below
     * catches. The haystack is JSON, so the terminator is usually `"`. */
    { tool: "#shell", args: "rm\\s+-rf\\s+(/(?![\\w.-])|~(?![\\w.\\-/])|\\*(?![\\w.-])|\\$HOME(?![\\w.\\-/]))", risk: "high" },
    { tool: "#shell", args: "rm\\s+-rf\\s+/(etc|usr|var|boot|home|root|bin|lib)", risk: "high" },
    { tool: "#shell", args: "(mkfs|fdisk|dd\\s+if=|shred\\s)", risk: "high" },
    { tool: "#shell", args: "(curl|wget)[^|]*\\|\\s*(ba|z|d)?sh", risk: "high" },
    { tool: "#shell", args: "chmod\\s+-R\\s+777", risk: "high" },
    { tool: "#shell", args: "sudo\\s+(rm\\s+-rf|shutdown|reboot|poweroff|mkfs)", risk: "high" },
    { tool: "#shell", args: "(DROP\\s+(TABLE|DATABASE)|TRUNCATE\\s+TABLE)", risk: "high" },
    { tool: "#shell", args: "systemctl\\s+(stop|disable|mask)", risk: "high" },
    // Medium: reversible with effort, or shared-state changing.
    { tool: "#shell", args: "rm\\s+-rf", risk: "medium" },
    { tool: "#shell", args: "git\\s+(push\\s+.*(--force|-f\\b)|reset\\s+--hard|clean\\s+-[a-z]*f)", risk: "medium" },
    { tool: "#shell", args: "\\bsudo\\b", risk: "medium" },
    { tool: "#shell", args: "kill\\s+-9", risk: "medium" },
    { tool: "#shell", args: "docker\\s+(rm|rmi|system\\s+prune)", risk: "medium" },
  ];
}

/**
 * Evaluate one tool call's risk. The haystack is the tool's JSON arguments; the
 * tool NAME is matched separately by scope so a note that merely mentions
 * `rm -rf` does not become a high-risk call.
 * @param {string} tool
 * @param {string} argsJson
 * @param {ReturnType<typeof defaultRiskRules>} [rules]
 * @returns {'low'|'medium'|'high'}
 */
export function evaluateRisk(tool, argsJson, rules) {
  const list = Array.isArray(rules) && rules.length > 0 ? rules : defaultRiskRules();
  const haystack = argsJson ?? "";
  for (const rule of list) {
    if (!ruleMatchesTool(rule, tool)) continue;
    if (rule.args) {
      let re;
      try { re = new RegExp(rule.args, "i"); } catch { continue; }
      if (!re.test(haystack)) continue;
    }
    return rule.risk;
  }
  return "low";
}

/**
 * Parse operator-supplied extra rules, one per line:
 *   `<risk> <regex>`                    → applies to shell tools (the common case)
 *   `<risk> * <regex>`                  → applies to every tool
 *   `<risk> tool:<name> <regex>`        → applies to that exact tool
 * e.g. `high  terraform\s+destroy`, `high  * secrets/prod`, `medium tool:memory .`
 * Invalid lines are ignored.
 *
 * Note the scope prefix must be `*` or `tool:<name>`: a bare first word is NOT
 * treated as a tool name, otherwise `high rm -rf /` would silently become
 * "tool named rm" instead of the intended command pattern.
 * @param {string} raw
 * @returns {ReturnType<typeof defaultRiskRules>}
 */
export function parseRiskRules(raw) {
  const out = [];
  for (const line of String(raw ?? "").split(/\n/)) {
    const m = line.trim().match(/^(low|medium|high)\s+(.+)$/i);
    if (!m) continue;
    const risk = m[1].toLowerCase();
    const rest = m[2].trim();
    const scoped = rest.match(/^(\*|#shell|tool:[A-Za-z0-9_.-]+)\s+(.+)$/);
    if (scoped) {
      const scope = scoped[1].startsWith("tool:") ? scoped[1].slice(5) : scoped[1];
      out.push({ tool: scope, args: scoped[2].trim(), risk });
      continue;
    }
    out.push({ tool: "#shell", args: rest, risk });
  }
  return out;
}

export class ApprovalBridge {
  /**
   * @param {Object} deps
   * @param {import("@deepseek-ai/cordis").Context} deps.ctx
   * @param {() => any} deps.getConfig      current channel-bot settings
   * @param {(text: string) => Promise<any>} deps.notify  push to configured channels
   * @param {string} deps.logFile           local decision log path
   */
  constructor({ ctx, getConfig, notify, logFile }) {
    this.ctx = ctx;
    this.getConfig = getConfig;
    this.notify = notify;
    this.logFile = logFile;
    /** approvalId (8 hex) → record */
    this.records = new Map();
    /** callId → {tool, risk, args} captured by the gate for card rendering */
    this.callArgs = new Map();
    /** recently decided ids, so a late tap gets "already answered" not "unknown" */
    this.recent = new Map();
    this._disposers = [];
  }

  /** Approval-related slice of the settings namespace, with defaults. */
  cfg() {
    const c = this.getConfig() ?? {};
    const a = c.approvals ?? {};
    return {
      enabled: c.enabled !== false && a.enabled === true,
      minRisk: RISK_RANK[a.minRisk] !== undefined ? a.minRisk : "medium",
      timeoutSec: Number.isFinite(a.timeoutSec) && a.timeoutSec > 0 ? a.timeoutSec : 300,
      pendingMaxSec: Number.isFinite(a.pendingMaxSec) && a.pendingMaxSec > 0 ? a.pendingMaxSec : 3600,
      rules: [...parseRiskRules(a.riskRules), ...defaultRiskRules()],
    };
  }

  /** Mount both waterfall seams. Returns a disposer. */
  mount() {
    this._disposers.push(this.ctx.on("tools/pre-execute", (exec, next) => this.gate(exec, next)));
    this._disposers.push(this.ctx.on("approval/request", (req, next) => this.answer(req, next)));
    return () => this.dispose();
  }

  dispose() {
    for (const d of this._disposers) { try { d(); } catch { /* already gone */ } }
    this._disposers = [];
    for (const rec of this.records.values()) {
      clearTimeout(rec.timeoutTimer);
      clearTimeout(rec.pendingTimer);
      rec.settle("cancelled");
    }
    this.records.clear();
  }

  /**
   * Risk gate. Returns `{kind:'ask'}` to force the approval seam, otherwise
   * delegates with next() so other gates and the default allow still apply.
   */
  gate(exec, next) {
    const cfg = this.cfg();
    if (!cfg.enabled) return next();
    let argsJson = "";
    try { argsJson = JSON.stringify(exec?.arguments ?? {}); } catch { argsJson = ""; }
    const risk = evaluateRisk(exec?.name, argsJson, cfg.rules);
    if (!riskAtLeast(risk, cfg.minRisk)) return next();
    if (exec?.callId) {
      this.callArgs.set(exec.callId, { tool: exec.name, risk, args: argsSummary(argsJson) });
      if (this.callArgs.size > 200) this.callArgs.delete(this.callArgs.keys().next().value);
    }
    return { kind: "ask", reason: `工具 "${exec?.name}" 判定为 ${risk} 风险，需要远程审批（默认拒绝）` };
  }

  /**
   * Approval answerer. Delegates (next()) when remote approval is off so the
   * browser dialog stays authoritative; otherwise pushes a card and waits.
   */
  answer(req, next) {
    const cfg = this.cfg();
    if (!cfg.enabled) return next();
    return this.prompt(req, cfg);
  }

  /** Push the card and wait for a decision / timeout / abort. */
  async prompt(req, cfg) {
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    const info = req?.callId ? this.callArgs.get(req.callId) : null;
    const record = {
      id,
      toolName: req?.toolName ?? info?.tool ?? "unknown",
      args: info?.args ?? "",
      risk: info?.risk ?? "medium",
      reason: typeof req?.reason === "string" ? req.reason : "",
      sessionId: req?.agent?.id ?? "",
      createdAt: Date.now(),
      state: "waiting",
      responder: null,
      settle: null,
      timeoutTimer: null,
      pendingTimer: null,
    };
    const outcome = new Promise((resolve) => {
      record.settle = (value) => {
        if (record.state === "decided") return;
        record.state = "decided";
        clearTimeout(record.timeoutTimer);
        clearTimeout(record.pendingTimer);
        this.records.delete(id);
        this.recent.set(id, { outcome: value, at: Date.now() });
        if (this.recent.size > 100) this.recent.delete(this.recent.keys().next().value);
        void this.log({
          ts: new Date().toISOString(),
          approvalId: id,
          session: record.sessionId,
          tool: record.toolName,
          args: record.args,
          risk: record.risk,
          responder: record.responder,
          outcome: value,
          durationMs: Date.now() - record.createdAt,
        });
        resolve(value);
      };
    });
    this.records.set(id, record);

    const lines = [
      `🔐 审批请求 #${id}`,
      `工具: ${record.toolName}`,
    ];
    if (record.args) lines.push(`参数: ${record.args}`);
    lines.push(`风险: ${record.risk}`);
    if (record.reason) lines.push(`原因: ${record.reason}`);
    lines.push("", `回复「/approve ${id} yes」批准，或「/approve ${id} no」拒绝。`);

    const push = await this.notify(lines.join("\n")).catch(() => null);
    // Nobody could be reached → fail closed but let the panel dialog try first.
    if (push === null || (push && push.ok === true && Array.isArray(push.sent) && push.sent.length === 0)) {
      record.settle("unavailable");
      return "unavailable";
    }

    record.timeoutTimer = setTimeout(() => {
      if (record.state !== "waiting") return;
      record.state = "pending";
      void this.notify(`⏳ 审批 #${id} 仍在等待：任务已阻塞。回复「/approve ${id} yes|no」。`).catch(() => {});
      record.pendingTimer = setTimeout(() => {
        if (record.state !== "pending") return;
        record.settle("rejected");
        void this.notify(`❌ 审批 #${id} 超时未响应，已拒绝。`).catch(() => {});
      }, cfg.pendingMaxSec * 1000);
    }, cfg.timeoutSec * 1000);

    req?.signal?.addEventListener?.("abort", () => record.settle("cancelled"), { once: true });
    return outcome;
  }

  /**
   * Apply an inbound decision from `/approve <id> yes|no`. First responder wins.
   * @returns {'accepted'|'rejected'|'ignored'|'not-found'}
   */
  respond(id, answer, responder) {
    const record = this.records.get(String(id));
    if (!record) return this.recent.has(String(id)) ? "ignored" : "not-found";
    if (answer !== "yes" && answer !== "no") return "ignored";
    record.responder = responder ?? null;
    record.settle(answer === "yes" ? "allowed-once" : "rejected");
    return answer === "yes" ? "accepted" : "rejected";
  }

  /** Waiting/pending approvals, for `/status`. */
  pendingList() {
    return [...this.records.values()].map((r) => ({
      id: r.id,
      tool: r.toolName,
      risk: r.risk,
      state: r.state,
      ageSec: Math.round((Date.now() - r.createdAt) / 1000),
    }));
  }

  /** Append one JSON line to the local decision log; never throws. */
  async log(entry) {
    try {
      await mkdir(dirname(this.logFile), { recursive: true });
      await appendFile(this.logFile, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      console.warn("[channel-bot] approval log failed:", error instanceof Error ? error.message : String(error));
    }
  }
}
