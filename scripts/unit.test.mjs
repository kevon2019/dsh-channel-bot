// dsh-channel-bot 单元测试（无网络、无 DSH 运行时）：
//   node --test scripts/unit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToText, splitLongText, argsSummary, inQuietHours, MAX_MESSAGE_CHARS } from "../lib/render.js";
import { evaluateRisk, riskAtLeast, parseRiskRules, defaultRiskRules, ApprovalBridge } from "../lib/approvals.js";
import { ChatSessionMap, sessionIdFor, chatKey } from "../lib/sessions.js";
import { userMessage } from "../lib/dispatch.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ── render ─────────────────────────────────────────────────────────── */

test("markdownToText 剥离标记但保留代码块", () => {
  const md = "# 标题\n\n**粗体** 和 `代码` 与 [链接](https://x.dev)\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
  const out = markdownToText(md);
  assert.match(out, /▍ 标题/);
  assert.match(out, /粗体 和 代码 与 链接 \(https:\/\/x\.dev\)/);
  assert.match(out, /const a = 1;/);
  assert.match(out, /a \| b/);
  assert.match(out, /1 \| 2/);
  assert.doesNotMatch(out, /---/);        // 表格分隔行被丢弃
  assert.doesNotMatch(out, /\*\*/);
});

test("markdownToText 丢弃图片与 HTML", () => {
  assert.equal(markdownToText("![图](a.png)"), "图");
  assert.equal(markdownToText("<b>x</b>y"), "xy");
});

test("markdownToText 非字符串安全", () => {
  assert.equal(markdownToText(null), "");
  assert.equal(markdownToText(undefined), "");
  assert.equal(markdownToText(123), "");
});

test("splitLongText 短文本原样、空文本空数组", () => {
  assert.deepEqual(splitLongText("hi"), ["hi"]);
  assert.deepEqual(splitLongText(""), []);
});

test("splitLongText 在段落边界切分且每段不超限", () => {
  const para = "x".repeat(1000);
  const text = Array.from({ length: 10 }, () => para).join("\n\n");
  const chunks = splitLongText(text, { maxLen: 2500, maxChunks: 10 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 2500 + 40, `chunk ${c.length}`);
});

test("splitLongText 超长单段按行切分", () => {
  const line = "y".repeat(100);
  const text = Array.from({ length: 60 }, () => line).join("\n"); // 单段 ~6KB
  const chunks = splitLongText(text, { maxLen: 1000, maxChunks: 20 });
  assert.ok(chunks.length >= 6);
  for (const c of chunks) assert.ok(c.length <= 1000);
});

test("splitLongText 超出 maxChunks 时给出截断提示", () => {
  const text = Array.from({ length: 30 }, (_v, i) => `段落${i}`.repeat(400)).join("\n\n");
  const chunks = splitLongText(text, { maxLen: 1000, maxChunks: 3 });
  assert.equal(chunks.length, 3);
  assert.match(chunks[2], /未发送/);
});

test("MAX_MESSAGE_CHARS 是保守值", () => {
  assert.ok(MAX_MESSAGE_CHARS <= 4000 && MAX_MESSAGE_CHARS >= 1000);
});

/* ── argsSummary 脱敏（审批卡片要经过第三方 IM 服务器） ────────────── */

test("argsSummary 按 key 脱敏", () => {
  const s = argsSummary({ apiKey: "abcdefghijk", password: "hunter2", token: "t", safe: "ok" });
  assert.match(s, /apiKey=\*\*\*/);
  assert.match(s, /password=\*\*\*/);
  assert.match(s, /token=\*\*\*/);
  assert.match(s, /safe=ok/);
  assert.doesNotMatch(s, /hunter2/);
});

test("argsSummary 按值模式脱敏（sk- / ghp_ / Bearer / JWT）", () => {
  for (const secret of [
    "sk-TEST-PLACEHOLDER",
    "ghp_TEST-PLACEHOLDER",
    "Bearer abc.def-ghi_jkl",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  ]) {
    const s = argsSummary({ cmd: `curl -H "${secret}" https://x` });
    assert.match(s, /\*\*\*/, secret);
    assert.ok(!s.includes(secret), `未脱敏: ${secret}`);
  }
});

test("argsSummary 接受 JSON 字符串与坏 JSON", () => {
  assert.match(argsSummary('{"a":1}'), /a=1/);
  assert.equal(argsSummary("not json"), "not json");
  assert.equal(argsSummary(""), "");
  assert.equal(argsSummary(null), "");
});

test("argsSummary 限长且折叠大对象/数组", () => {
  const s = argsSummary({ list: Array.from({ length: 20 }, (_v, i) => i) });
  assert.match(s, /…×14/);
  const big = {};
  for (let i = 0; i < 20; i++) big[`k${i}`] = i;
  assert.match(argsSummary(big), /…\+12/);
  assert.ok(argsSummary({ x: "z".repeat(5000) }).length <= 400);
});

/* ── 静默时段 ───────────────────────────────────────────────────────── */

test("inQuietHours 处理跨午夜与普通区间", () => {
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.equal(inQuietHours("22:00-08:00", at(23)), true);
  assert.equal(inQuietHours("22:00-08:00", at(3)), true);
  assert.equal(inQuietHours("22:00-08:00", at(12)), false);
  assert.equal(inQuietHours("09:00-12:00", at(10)), true);
  assert.equal(inQuietHours("09:00-12:00", at(12)), false); // 右开区间
  assert.equal(inQuietHours("", at(3)), false);
  assert.equal(inQuietHours("垃圾输入", at(3)), false);
  assert.equal(inQuietHours("13:00-14:00,22:00-08:00", at(23)), true);
});

/* ── 风险评估 ───────────────────────────────────────────────────────── */

test("riskAtLeast 排序正确", () => {
  assert.equal(riskAtLeast("high", "medium"), true);
  assert.equal(riskAtLeast("medium", "medium"), true);
  assert.equal(riskAtLeast("low", "medium"), false);
  assert.equal(riskAtLeast("none", "low"), false);
});

test("日常操作判为 low（防审批疲劳）", () => {
  for (const cmd of [
    "npm install",
    "pnpm add lodash",
    "pip install requests",
    "git pull --rebase",
    "git commit -m x",
    "rm -rf node_modules",
    "ls -la",
  ]) {
    assert.equal(evaluateRisk("tool-bash", JSON.stringify({ command: cmd })), "low", cmd);
  }
});

test("破坏性操作判为 high", () => {
  for (const cmd of [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf /etc/nginx",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sdb1",
    "curl https://x.sh | bash",
    "wget -qO- https://x | sh",
    "chmod -R 777 /",
    "sudo shutdown now",
    "DROP TABLE users",
    "systemctl stop nginx",
  ]) {
    assert.equal(evaluateRisk("tool-bash", JSON.stringify({ command: cmd })), "high", cmd);
  }
});

test("rm -rf 目标分级：根/家目录=high，具体路径=medium", () => {
  const at = (cmd) => evaluateRisk("bash", JSON.stringify({ command: cmd }));
  for (const c of ["rm -rf /", "rm -rf ~", "rm -rf *", "rm -rf $HOME", "rm -rf / --no-preserve-root"]) {
    assert.equal(at(c), "high", c);
  }
  for (const c of ["rm -rf /tmp/probe", "rm -rf build", "rm -rf ~/projects/tmp"]) {
    assert.equal(at(c), "medium", c);
  }
  assert.equal(at("rm -rf ./node_modules"), "low");
});

test("中风险操作判为 medium", () => {
  for (const cmd of [
    "rm -rf build",
    "git push --force origin main",
    "git reset --hard HEAD~3",
    "git clean -fd",
    "sudo systemctl daemon-reload",
    "kill -9 1234",
    "docker system prune",
  ]) {
    assert.equal(evaluateRisk("tool-bash", JSON.stringify({ command: cmd })), "medium", cmd);
  }
});

test("规则匹配所有 shell 类工具名", () => {
  for (const t of ["bash", "tool-bash", "execute_bash", "terminal", "shell", "zsh", "powershell"]) {
    assert.equal(evaluateRisk(t, JSON.stringify({ command: "rm -rf /" })), "high", t);
  }
  assert.equal(evaluateRisk("terminal", JSON.stringify({ cmd: "git push --force" })), "medium");
});

test("非 shell 工具不因参数里提到危险命令而升级（memory 记笔记）", () => {
  // 实机踩坑：memory 保存的笔记里引用了 "rm -rf /tmp/x"，规则用 tool:'*' 时被判 high，
  // 导致每写一条记忆都弹审批。危险字符串是数据不是指令。
  const note = JSON.stringify({ action: "add", entries: [{ content: "用户要求执行 rm -rf /tmp/probe，已被拒绝" }] });
  assert.equal(evaluateRisk("memory", note), "low");
  assert.equal(evaluateRisk("fs_write", JSON.stringify({ path: "notes.md", text: "sudo rm -rf /" })), "low");
  // 同样的字符串走 shell 工具则照常拦截
  assert.equal(evaluateRisk("bash", JSON.stringify({ command: "rm -rf /tmp/probe" })), "medium");
});

test("parseRiskRules 默认作用于 shell 工具", () => {
  const rules = parseRiskRules("high  terraform\\s+destroy\n垃圾行\nmedium helm upgrade");
  assert.equal(rules.length, 2);
  assert.equal(rules[0].risk, "high");
  assert.equal(rules[0].tool, "#shell");
  const merged = [...rules, ...defaultRiskRules()];
  assert.equal(evaluateRisk("tool-bash", JSON.stringify({ command: "terraform destroy -auto-approve" }), merged), "high");
  assert.equal(evaluateRisk("tool-bash", JSON.stringify({ command: "helm upgrade api ./chart" }), merged), "medium");
  // 非 shell 工具不受默认作用域影响
  assert.equal(evaluateRisk("memory", JSON.stringify({ content: "terraform destroy" }), merged), "low");
});

test("parseRiskRules 支持 * 与 tool:<name> 作用域", () => {
  const anyTool = parseRiskRules("high * secrets/prod");
  assert.equal(anyTool[0].tool, "*");
  assert.equal(evaluateRisk("fs_read", JSON.stringify({ path: "/etc/secrets/prod.env" }), [...anyTool, ...defaultRiskRules()]), "high");
  const named = parseRiskRules("medium tool:memory .");
  assert.equal(named[0].tool, "memory");
  assert.equal(evaluateRisk("memory", JSON.stringify({ x: 1 }), [...named, ...defaultRiskRules()]), "medium");
  assert.equal(evaluateRisk("bash", JSON.stringify({ command: "echo hi" }), [...named, ...defaultRiskRules()]), "low");
});

test("parseRiskRules 不把命令首词误当工具名", () => {
  const rules = parseRiskRules("high rm -rf /");
  assert.equal(rules[0].tool, "#shell");
  assert.equal(rules[0].args, "rm -rf /");
});

test("非法正则的自定义规则被跳过而不抛错", () => {
  const merged = [{ tool: "*", args: "([", risk: "high" }, ...defaultRiskRules()];
  assert.equal(evaluateRisk("tool-bash", JSON.stringify({ command: "echo hi" }), merged), "low");
});

/* ── 审批桥 ─────────────────────────────────────────────────────────── */

function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(event, fn) { handlers.set(event, fn); return () => handlers.delete(event); },
  };
}

test("审批关闭时 gate 直接委托 next()", () => {
  const bridge = new ApprovalBridge({ ctx: fakeCtx(), getConfig: () => ({ enabled: true, approvals: { enabled: false } }), notify: async () => ({ ok: true, sent: ["telegram"] }), logFile: "/dev/null" });
  let called = false;
  bridge.gate({ name: "tool-bash", arguments: { command: "rm -rf /" } }, () => { called = true; return { kind: "allow" }; });
  assert.equal(called, true);
});

test("低风险调用不触发审批；高风险返回 ask", () => {
  const cfg = { enabled: true, approvals: { enabled: true, minRisk: "medium" } };
  const bridge = new ApprovalBridge({ ctx: fakeCtx(), getConfig: () => cfg, notify: async () => ({ ok: true, sent: ["telegram"] }), logFile: "/dev/null" });
  let nexted = 0;
  const low = bridge.gate({ name: "tool-bash", callId: "c1", arguments: { command: "npm install" } }, () => { nexted++; return { kind: "allow" }; });
  assert.equal(nexted, 1);
  assert.equal(low.kind, "allow");
  const high = bridge.gate({ name: "tool-bash", callId: "c2", arguments: { command: "rm -rf /etc" } }, () => { nexted++; return { kind: "allow" }; });
  assert.equal(nexted, 1);
  assert.equal(high.kind, "ask");
  assert.match(high.reason, /high/);
});

test("推送不到任何渠道时 fail closed（unavailable）", async () => {
  const bridge = new ApprovalBridge({
    ctx: fakeCtx(),
    getConfig: () => ({ enabled: true, approvals: { enabled: true } }),
    notify: async () => ({ ok: true, sent: [], failed: [] }),
    logFile: join(tmpdir(), "cb-approve-test.log"),
  });
  const outcome = await bridge.prompt({ toolName: "tool-bash", agent: { id: "s1" } }, bridge.cfg());
  assert.equal(outcome, "unavailable");
});

test("/approve yes → allowed-once，并写审计日志；重复响应 ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cb-approvals-"));
  const logFile = join(dir, "approvals.log");
  const sent = [];
  const bridge = new ApprovalBridge({
    ctx: fakeCtx(),
    getConfig: () => ({ enabled: true, approvals: { enabled: true, timeoutSec: 999, pendingMaxSec: 999 } }),
    notify: async (text) => { sent.push(text); return { ok: true, sent: ["telegram"], failed: [] }; },
    logFile,
  });
  bridge.callArgs.set("call-1", { tool: "tool-bash", risk: "high", args: "{command=rm -rf /etc}" });
  const pending = bridge.prompt({ toolName: "tool-bash", callId: "call-1", agent: { id: "sess-a" }, reason: "危险" }, bridge.cfg());
  await new Promise((r) => setTimeout(r, 20));
  const card = sent[0];
  assert.match(card, /🔐 审批请求 #/);
  assert.match(card, /风险: high/);
  assert.match(card, /\/approve/);
  const id = card.match(/#([0-9a-f]{8})/)[1];
  assert.equal(bridge.pendingList().length, 1);
  assert.equal(bridge.respond(id, "yes", "telegram:42"), "accepted");
  assert.equal(await pending, "allowed-once");
  assert.equal(bridge.respond(id, "yes", "telegram:42"), "ignored");
  assert.equal(bridge.respond("deadbeef", "yes", "telegram:42"), "not-found");
  await new Promise((r) => setTimeout(r, 30));
  const log = JSON.parse((await readFile(logFile, "utf8")).trim());
  assert.equal(log.outcome, "allowed-once");
  assert.equal(log.responder, "telegram:42");
  assert.equal(log.tool, "tool-bash");
  await rm(dir, { recursive: true, force: true });
});

test("/approve no → rejected", async () => {
  const bridge = new ApprovalBridge({
    ctx: fakeCtx(),
    getConfig: () => ({ enabled: true, approvals: { enabled: true, timeoutSec: 999, pendingMaxSec: 999 } }),
    notify: async () => ({ ok: true, sent: ["telegram"], failed: [] }),
    logFile: join(tmpdir(), "cb-approve-no.log"),
  });
  const pending = bridge.prompt({ toolName: "tool-fs", agent: { id: "s" } }, bridge.cfg());
  await new Promise((r) => setTimeout(r, 20));
  const id = bridge.pendingList()[0].id;
  assert.equal(bridge.respond(id, "no", "qq:1"), "rejected");
  assert.equal(await pending, "rejected");
});

test("超时未响应最终 rejected（deny by default）", async () => {
  const notices = [];
  const bridge = new ApprovalBridge({
    ctx: fakeCtx(),
    getConfig: () => ({ enabled: true, approvals: { enabled: true, timeoutSec: 0.05, pendingMaxSec: 0.05 } }),
    notify: async (t) => { notices.push(t); return { ok: true, sent: ["telegram"], failed: [] }; },
    logFile: join(tmpdir(), "cb-approve-timeout.log"),
  });
  const outcome = await bridge.prompt({ toolName: "tool-bash", agent: { id: "s" } }, bridge.cfg());
  assert.equal(outcome, "rejected");
  assert.ok(notices.some((t) => /仍在等待/.test(t)), "应推送阻塞提醒");
  assert.ok(notices.some((t) => /超时未响应/.test(t)), "应推送超时拒绝");
});

test("会话中止 → cancelled", async () => {
  const ac = new AbortController();
  const bridge = new ApprovalBridge({
    ctx: fakeCtx(),
    getConfig: () => ({ enabled: true, approvals: { enabled: true, timeoutSec: 999, pendingMaxSec: 999 } }),
    notify: async () => ({ ok: true, sent: ["telegram"], failed: [] }),
    logFile: join(tmpdir(), "cb-approve-cancel.log"),
  });
  const pending = bridge.prompt({ toolName: "tool-bash", agent: { id: "s" }, signal: ac.signal }, bridge.cfg());
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  assert.equal(await pending, "cancelled");
});

test("mount/dispose 注册并清理两个 seam", () => {
  const ctx = fakeCtx();
  const bridge = new ApprovalBridge({ ctx, getConfig: () => ({ enabled: true, approvals: { enabled: true } }), notify: async () => ({ ok: true, sent: [] }), logFile: "/dev/null" });
  const dispose = bridge.mount();
  assert.ok(ctx.handlers.has("tools/pre-execute"));
  assert.ok(ctx.handlers.has("approval/request"));
  dispose();
  assert.equal(ctx.handlers.size, 0);
});

/* ── 会话映射 ───────────────────────────────────────────────────────── */

test("sessionIdFor 确定性且形状合法", () => {
  const a = sessionIdFor("telegram", "42");
  assert.equal(a, sessionIdFor("telegram", "42"));
  assert.notEqual(a, sessionIdFor("telegram", "43"));
  assert.notEqual(a, sessionIdFor("qq", "42"));
  assert.match(a, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(chatKey("telegram", 42), "telegram:42");
});

test("绑定 创建/反查/删除", () => {
  const map = new ChatSessionMap(join(tmpdir(), "cb-map-none.json"));
  const b = map.create("telegram", 42, { chatType: "private" });
  assert.equal(map.size, 1);
  assert.equal(map.get("telegram", "42").sessionId, b.sessionId);
  assert.equal(map.bySessionId(b.sessionId).chatId, "42");
  assert.equal(map.create("telegram", 42).sessionId, b.sessionId); // 幂等
  assert.equal(map.remove("telegram", "42").sessionId, b.sessionId);
  assert.equal(map.size, 0);
  assert.equal(map.bySessionId(b.sessionId), null);
  assert.equal(map.remove("telegram", "42"), null);
});

test("dedupe 拦截重复 msgId，空 id 放行", () => {
  const map = new ChatSessionMap(join(tmpdir(), "cb-map-none2.json"));
  assert.equal(map.dedupe("telegram", 1), true);
  assert.equal(map.dedupe("telegram", 1), false);
  assert.equal(map.dedupe("qq", 1), true);      // 平台隔离
  assert.equal(map.dedupe("telegram", undefined), true);
  assert.equal(map.dedupe("telegram", ""), true);
});

test("isOnline 依据最近活跃", () => {
  const map = new ChatSessionMap(join(tmpdir(), "cb-map-none3.json"));
  map.create("telegram", 7);
  assert.equal(map.isOnline("telegram", 7, 60_000), true);
  map.get("telegram", "7").lastActivityAt = Date.now() - 120_000;
  assert.equal(map.isOnline("telegram", 7, 60_000), false);
  map.touch("telegram", 7);
  assert.equal(map.isOnline("telegram", 7, 60_000), true);
  assert.equal(map.isOnline("telegram", 999, 60_000), false);
});

test("allowlist 增删查", () => {
  const map = new ChatSessionMap(join(tmpdir(), "cb-map-none4.json"));
  assert.equal(map.isAllowed("telegram", "u1"), false);
  map.addToAllowlist("telegram", "u1");
  assert.equal(map.isAllowed("telegram", "u1"), true);
  map.removeFromAllowlist("telegram", "u1");
  assert.equal(map.isAllowed("telegram", "u1"), false);
});

test("持久化：原子写 + 重载还原（含 allowlist）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cb-map-"));
  const file = join(dir, "sessions.json");
  const a = new ChatSessionMap(file);
  const b1 = a.create("telegram", 42, { chatType: "private" });
  a.create("qq", 100, { chatType: "group" });
  a.addToAllowlist("telegram", "u9");
  await a.dispose();
  const b = new ChatSessionMap(file);
  await b.load();
  assert.equal(b.size, 2);
  assert.equal(b.get("telegram", "42").sessionId, b1.sessionId);
  assert.equal(b.get("qq", "100").chatType, "group");
  assert.equal(b.bySessionId(b1.sessionId).platform, "telegram");
  assert.equal(b.isAllowed("telegram", "u9"), true);
  assert.equal(b.list().length, 2);
  await rm(dir, { recursive: true, force: true });
});

test("载入缺失/损坏文件不抛错", async () => {
  const missing = new ChatSessionMap(join(tmpdir(), `cb-missing-${Date.now()}.json`));
  await missing.load();
  assert.equal(missing.size, 0);
  const dir = await mkdtemp(join(tmpdir(), "cb-bad-"));
  const bad = join(dir, "bad.json");
  await (await import("node:fs/promises")).writeFile(bad, "{ not json", "utf8");
  const m = new ChatSessionMap(bad);
  await m.load();
  assert.equal(m.size, 0);
  await rm(dir, { recursive: true, force: true });
});

/* ── dispatch ───────────────────────────────────────────────────────── */

test("userMessage 形状符合 dsh-llm UserMessage", () => {
  const m = userMessage("你好");
  assert.equal(m.role, "user");
  assert.equal(m.content[0].type, "text");
  assert.equal(m.content[0].text, "你好");
  assert.equal(m.source.kind, "user");
  assert.match(m.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(userMessage("a").id, userMessage("a").id); // 每条独立 id
});
