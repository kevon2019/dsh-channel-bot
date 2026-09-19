// dsh-channel-bot client half 单测（v2.3.0）：渠道修复结果文案的纯函数
//   node --test scripts/client.test.mjs
// 不需要浏览器：用假的 __ModuleLoader__ + 假 react 把 lib/client.js 加载进来，
// 取 apply.__repair 逐类断言（覆盖「修复成功 / 部分修复 / 跳过 / 无返回」四种形态）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const code = fs.readFileSync(path.join(dir, "..", "lib", "client.js"), "utf8");

const fakeReact = {
  createElement: () => null,
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useCallback: (f) => f,
  useEffect: () => {},
  useMemo: (f) => f(),
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: () => null,
  createContext: () => ({ Provider: null, Consumer: null }),
};
let mod = null;
const fakeWindow = { __ModuleLoader__: { load: (m) => { mod = m.factory((n) => (n === "react" ? fakeReact : null)); } } };
globalThis.window = fakeWindow;
if (typeof globalThis.document === "undefined") {
  globalThis.document = { createElement: () => ({ style: {} }), head: { appendChild: () => {} }, body: {} };
}
new Function("window", code)(fakeWindow);

const R = mod && mod.apply && mod.apply.__repair;
const D = mod && mod.apply && mod.apply.__diag;

test("client 半可加载且导出修复纯函数", () => {
  assert.ok(mod && typeof mod.apply === "function");
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes("slots"));
  assert.equal(typeof R, "object");
  assert.equal(typeof R.repairSummary, "function");
  assert.equal(typeof R.repairAllSummary, "function");
});

test("repairSummary：完全修复 → ✅ 且带上第一条动作", () => {
  const s = R.repairSummary({
    channel: "telegram", ok: true, skipped: false,
    actions: ["✔ 已重启 Telegram getUpdates 轮询", "✔ 已清除历史错误计数与最近错误"],
    manual: [],
  });
  assert.equal(s.ok, true);
  assert.match(s.text, /✅ 修复完成/);
  assert.match(s.text, /已重启 Telegram getUpdates 轮询/);
  assert.doesNotMatch(s.text, /仍需人工/);
  assert.match(s.full, /已清除历史错误计数/);
});

test("repairSummary：部分修复 → ⚠ + 仍需人工原因（含凭据提示）", () => {
  const s = R.repairSummary({
    channel: "wecom", ok: false, skipped: false,
    actions: ["✔ 已重连企业微信智能机器人长连接"],
    manual: ["凭据校验未通过：企业微信未配置可用凭据"],
  });
  assert.equal(s.ok, false);
  assert.match(s.text, /⚠ 已执行修复/);
  assert.match(s.text, /仍需人工/);
  assert.match(s.text, /企业微信未配置可用凭据/);
  assert.match(s.full, /❗ 凭据校验未通过/);
});

test("repairSummary：未启用渠道 → ⏭ 跳过", () => {
  const s = R.repairSummary({ channel: "qq", skipped: true, ok: false, manual: ["渠道未启用：在「QQ」分组里打开开关后再点修复"] });
  assert.equal(s.ok, false);
  assert.match(s.text, /⏭ 已跳过/);
  assert.match(s.text, /渠道未启用/);
});

test("repairSummary：无返回 / null 不崩", () => {
  assert.match(R.repairSummary(null).text, /无返回/);
  assert.match(R.repairSummary(undefined).text, /无返回/);
  assert.equal(R.repairSummary({ skipped: true }).ok, false);
});

test("repairAllSummary：汇总成功/待人工/跳过/动作数", () => {
  const text = R.repairAllSummary({ ok: false, summary: { total: 6, repaired: 3, healthy: 2, failed: 1, skipped: 3, actions: 7 } });
  assert.match(text, /修复并通过 2 个/);
  assert.match(text, /仍需人工 1 个/);
  assert.match(text, /跳过 3 个/);
  assert.match(text, /共执行 7 项动作/);
});

test("repairAllSummary：服务端整体报错 → 带上 error 文案", () => {
  const text = R.repairAllSummary({ ok: false, error: "多渠道机器人总开关未开启", summary: { total: 6, repaired: 0, healthy: 0, failed: 0, skipped: 6, actions: 0 } });
  assert.match(text, /总开关未开启/);
  assert.match(text, /跳过 6 个/);
});

test("repairAllSummary：无返回兜底", () => {
  assert.match(R.repairAllSummary(null), /无返回/);
  assert.match(R.repairAllSummary({}), /无返回/);
});

/* ---------- v2.3.0：诊断表自动刷新间隔固定 6 小时（禁止退回秒级） ---------- */
test("诊断刷新间隔 = 6 小时（21600000ms）", () => {
  assert.equal(typeof D, "object");
  assert.equal(D.REFRESH_MS, 6 * 60 * 60 * 1000);
  assert.equal(D.REFRESH_MS, 21600000);
});

test("诊断刷新文案说明 6 小时 + 打开即刷新，且不再出现「秒」级刷新", () => {
  assert.match(D.refreshText(""), /每 6 小时自动刷新/);
  assert.match(D.refreshText(""), /打开诊断页会立即刷新一次/);
  assert.doesNotMatch(D.refreshText(""), /每 \d+ 秒自动刷新/);
  assert.match(D.refreshText("12:00:00"), /最近 12:00:00/);
});
