/**
 * dsh-channel-bot — outbound rendering helpers.
 *
 * IM channels are text pipes with per-message length caps, so agent output has
 * to be degraded before it leaves the panel:
 *   - Markdown loses its markers (tables/links/headings become readable text)
 *   - long text is split on paragraph boundaries instead of hard-truncated
 *   - tool-call arguments are summarised AND redacted before they ride an
 *     approval card through a third-party server
 *
 * Modelled on dsh-im's lib/renderer.js (the reference implementation in the
 * plugin market), adapted to this plugin's single-file-per-concern layout.
 */

/** Conservative single-message cap across Telegram / DingTalk / Feishu / WeCom / QQ / iLink. */
export const MAX_MESSAGE_CHARS = 3500;

/**
 * Markdown → plain text. Code fences keep their content, inline markers are
 * stripped, links become "title (url)", tables collapse to " | " rows, images
 * and raw HTML are dropped.
 * @param {string} md
 * @returns {string}
 */
export function markdownToText(md) {
  if (typeof md !== "string") return "";
  const out = [];
  let inFence = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*```+/.test(raw)) {
      inFence = !inFence;
      out.push("```");
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    let line = raw;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // Table row → " | " separated; the ---|--- separator row collapses to "".
      const cells = line.trim().replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      out.push(cells.join(" | "));
      continue;
    }
    line = line
      .replace(/^(#{1,6})\s+/, (_m, h) => `${"▍".repeat(h.length)} `)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
      .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/<[^>]+>/g, "");
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split long text on paragraph (then line) boundaries. Returns at most
 * `maxChunks` pieces; a truncation marker is appended when pieces are dropped.
 * @param {string} text
 * @param {{maxLen?: number, maxChunks?: number}} [opts]
 * @returns {string[]}
 */
export function splitLongText(text, { maxLen = MAX_MESSAGE_CHARS, maxChunks = 4 } = {}) {
  const src = typeof text === "string" ? text : "";
  if (src.length <= maxLen) return src === "" ? [] : [src];
  const chunks = [];
  let current = "";
  const push = () => { if (current !== "") { chunks.push(current); current = ""; } };
  for (const para of src.split(/\n{2,}/)) {
    if (para.length > maxLen) {
      push();
      let buf = "";
      for (const line of para.split("\n")) {
        if (buf !== "" && (buf.length + 1 + line.length) > maxLen) { chunks.push(buf); buf = line; }
        else buf = buf === "" ? line : `${buf}\n${line}`;
      }
      if (buf !== "") current = buf;
      continue;
    }
    if (current !== "" && (current.length + 2 + para.length) > maxLen) { push(); current = para; }
    else current = current === "" ? para : `${current}\n\n${para}`;
  }
  push();
  if (chunks.length <= maxChunks) return chunks;
  const kept = chunks.slice(0, maxChunks);
  kept[maxChunks - 1] += `\n\n…（还有 ${chunks.length - maxChunks} 段未发送，请到面板查看完整输出）`;
  return kept;
}

const REDACT_KEYS = /(token|secret|key|password|passwd|credential|authorization|cookie|api[_-]?key)/i;
const REDACT_PATTERN = /(Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9._-]{20,})/g;

/**
 * Summarise a tool call's arguments for an approval card, redacting anything
 * that looks like a credential. A remote approval card travels through a
 * third-party IM server, so this MUST never leak a secret.
 * @param {unknown} args  raw arguments object or JSON string
 * @returns {string}
 */
export function argsSummary(args) {
  if (args === null || args === undefined) return "";
  let obj = args;
  if (typeof args === "string") {
    if (args === "") return "";
    try { obj = JSON.parse(args); }
    catch { return args.replace(REDACT_PATTERN, "***").slice(0, 200); }
  }
  const walk = (value, depth = 0) => {
    if (depth > 4) return "…";
    if (value === null || value === undefined) return String(value);
    if (typeof value === "string") return value.replace(REDACT_PATTERN, "***").slice(0, 200);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      if (value.length > 6) return `[${value.slice(0, 6).map((v) => walk(v, depth + 1)).join(", ")}, …×${value.length - 6}]`;
      return `[${value.map((v) => walk(v, depth + 1)).join(", ")}]`;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value);
      const shown = entries.slice(0, 8).map(([k, v]) => {
        if (REDACT_KEYS.test(k)) return `${k}=***`;
        if (typeof v === "string" && REDACT_PATTERN.test(v)) return `${k}=***`;
        return `${k}=${walk(v, depth + 1)}`;
      });
      return `{${shown.join(", ")}${entries.length > 8 ? `, …+${entries.length - 8}` : ""}}`;
    }
    return "…";
  };
  return walk(obj).slice(0, 400);
}

/**
 * Quiet-hours check against ranges like "22:00-08:00" (wraps midnight).
 * @param {string[]|string} ranges
 * @param {Date} [now]
 * @returns {boolean}
 */
export function inQuietHours(ranges, now = new Date()) {
  const list = Array.isArray(ranges) ? ranges : String(ranges ?? "").split(/[,\n]/);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const range of list) {
    const m = String(range).trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (start <= end ? (nowMin >= start && nowMin < end) : (nowMin >= start || nowMin < end)) return true;
  }
  return false;
}
