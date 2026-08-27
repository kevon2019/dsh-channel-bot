#!/usr/bin/env node
/* wechat-login.mjs — QR login for the official Tencent iLink personal-WeChat bot.
 *
 * Flow: get_bot_qrcode -> save QR PNG -> poll get_qrcode_status until the user
 * scans -> write channel-bot.wechat.{enabled,botToken} into settings.yaml.
 *
 * Usage (from the dsh-channel-bot dir):
 *   node scripts/wechat-login.mjs
 * Then restart the panel service:  systemctl restart deepseek-harness
 *
 * Protocol reference: https://github.com/hao-ji-xing/cc-weixin/blob/main/weixin-bot-api.md
 */
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://ilinkai.weixin.qq.com";
const SETTINGS = "/root/.dsh/settings.yaml";
const QR_FILE = "/root/.dsh/wechat-login-qr.png";

const j = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json();
};

console.log("[wechat-login] 请求 iLink 登录二维码 …");
const qr = await j(`/ilink/bot/get_bot_qrcode?bot_type=3`);
const qrcode = qr.qrcode;
if (!qrcode) throw new Error(`get_bot_qrcode 响应异常: ${JSON.stringify(qr).slice(0, 300)}`);
const img = qr.qrcode_img_content;
if (typeof img === "string" && img.startsWith("http")) {
  /* 实际响应里 qrcode_img_content 是 liteapp 登录 URL（不是 base64 图片） */
  writeFileSync("/root/.dsh/wechat-login-url.txt", img);
  console.log(`[wechat-login] 登录 URL: ${img}`);
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("qrencode", ["-s", "8", "-o", QR_FILE, img]);
    console.log(`[wechat-login] 二维码已渲染: ${QR_FILE}`);
  } catch {
    console.log("[wechat-login] 提示: qrencode 不可用，请直接用上面的 URL 登录");
  }
} else if (img) {
  writeFileSync(QR_FILE, Buffer.from(img, "base64"));
  console.log(`[wechat-login] 二维码已保存: ${QR_FILE}`);
}
console.log("[wechat-login] 请用手机微信扫码授权（3 分钟内）…");

const deadline = Date.now() + 180000;
let token = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  const st = await j(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
  if (st.status === "confirmed" && st.bot_token) { token = st.bot_token; break; }
  if (st.status === "expired") throw new Error("二维码已过期，请重跑脚本");
  if (st.status && st.status !== "waiting" && st.status !== "confirmed") {
    console.log(`[wechat-login] 扫码状态: ${st.status}`);
  }
}
if (!token) throw new Error("扫码超时（180s），请重跑脚本");

console.log("[wechat-login] 登录成功，写入 settings.yaml …");
let yaml = readFileSync(SETTINGS, "utf8");
const block = `  wechat:\n    enabled: true\n    botToken: "${token}"\n    allowedUserIds: []\n`;
if (/^  wechat:/m.test(yaml)) {
  yaml = yaml.replace(/  wechat:\n(?:    .*\n)*?(?=  [a-z])/, block);
} else {
  yaml = yaml.replace(/(\n  commands:)/, `\n${block}$1`);
}
writeFileSync(SETTINGS, yaml);
console.log("[wechat-login] 完成：channel-bot.wechat 已启用并写入 botToken");
console.log("[wechat-login] 下一步：systemctl restart deepseek-harness 使面板轮询生效");
