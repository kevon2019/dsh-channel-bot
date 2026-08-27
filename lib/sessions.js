/**
 * dsh-channel-bot — chat ⇄ DSH session binding.
 *
 * A chat (platform + chatId) maps to exactly one DSH session id, generated
 * DETERMINISTICALLY from the pair so the same chat lands on the same session
 * across restarts even if the mapping file is lost. The file additionally
 * records last-activity (used to decide whether the human is "present" and
 * should receive streaming replies) and the per-chat allowlist added at runtime.
 *
 * Modelled on dsh-im's lib/session-map.js. Persistence is atomic
 * (tmp + rename) and debounced, so a burst of messages writes once.
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const STORE_VERSION = 1;

/** `${platform}:${chatId}` */
export function chatKey(platform, chatId) {
  return `${platform}:${chatId}`;
}

/**
 * Deterministic session id for a chat. `session-` prefix + 32 hex chars keeps
 * the shape DSH uses elsewhere (`session-<uuid>`), so nothing downstream has to
 * special-case bot sessions.
 * @param {string} platform
 * @param {string|number} chatId
 * @returns {string}
 */
export function sessionIdFor(platform, chatId) {
  const hex = createHash("sha256").update(`dsh-channel-bot:${platform}:${chatId}`).digest("hex");
  return `session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class ChatSessionMap {
  /** @param {string} file  absolute path of the mapping json */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, {platform:string, chatId:string, chatType:string, sessionId:string, createdAt:number, lastActivityAt:number}>} */
    this.chats = new Map();
    /** @type {Map<string, string>} sessionId → chatKey */
    this.bySession = new Map();
    /** runtime-added allowlist entries (`platform:userId`) */
    this.allowlist = new Set();
    /** processed inbound message ids, LRU-ish dedupe */
    this.seen = new Map();
    this._saveTimer = null;
    this._saving = null;
  }

  /** Load; a missing or corrupt file starts empty rather than blocking boot. */
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data?.version !== STORE_VERSION) return;
      for (const entry of data.chats ?? []) {
        if (typeof entry?.platform !== "string" || entry?.chatId === undefined) continue;
        const binding = {
          platform: entry.platform,
          chatId: String(entry.chatId),
          chatType: entry.chatType ?? "private",
          sessionId: typeof entry.sessionId === "string" ? entry.sessionId : sessionIdFor(entry.platform, entry.chatId),
          createdAt: Number(entry.createdAt) || Date.now(),
          lastActivityAt: Number(entry.lastActivityAt) || 0,
        };
        const key = chatKey(binding.platform, binding.chatId);
        this.chats.set(key, binding);
        this.bySession.set(binding.sessionId, key);
      }
      for (const u of data.allowlist ?? []) this.allowlist.add(String(u));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[channel-bot] session map load failed (starting empty):", error instanceof Error ? error.message : String(error));
      }
    }
  }

  get(platform, chatId) {
    return this.chats.get(chatKey(platform, chatId)) ?? null;
  }

  bySessionId(sessionId) {
    const key = this.bySession.get(sessionId);
    return key ? this.chats.get(key) ?? null : null;
  }

  /** Create (or return existing) binding for a chat. */
  create(platform, chatId, { chatType = "private" } = {}) {
    const key = chatKey(platform, chatId);
    const existing = this.chats.get(key);
    if (existing) return existing;
    const binding = {
      platform,
      chatId: String(chatId),
      chatType,
      sessionId: sessionIdFor(platform, chatId),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.chats.set(key, binding);
    this.bySession.set(binding.sessionId, key);
    this._scheduleSave();
    return binding;
  }

  remove(platform, chatId) {
    const key = chatKey(platform, chatId);
    const binding = this.chats.get(key);
    if (!binding) return null;
    this.chats.delete(key);
    this.bySession.delete(binding.sessionId);
    this._scheduleSave();
    return binding;
  }

  /** Mark activity (drives the presence window). */
  touch(platform, chatId) {
    const binding = this.get(platform, chatId);
    if (!binding) return null;
    binding.lastActivityAt = Date.now();
    this._scheduleSave();
    return binding;
  }

  /** Was this chat active within `windowMs`? Streaming replies depend on it. */
  isOnline(platform, chatId, windowMs) {
    const binding = this.get(platform, chatId);
    if (!binding) return false;
    return Date.now() - binding.lastActivityAt <= windowMs;
  }

  get size() {
    return this.chats.size;
  }

  /** False when this message id was already handled (retry / duplicate push). */
  dedupe(platform, msgId, limit = 500) {
    if (msgId === undefined || msgId === null || msgId === "") return true;
    const key = `${platform}:${msgId}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now());
    if (this.seen.size > limit) this.seen.delete(this.seen.keys().next().value);
    return true;
  }

  isAllowed(platform, userId) {
    return this.allowlist.has(chatKey(platform, userId));
  }

  addToAllowlist(platform, userId) {
    this.allowlist.add(chatKey(platform, userId));
    this._scheduleSave();
  }

  removeFromAllowlist(platform, userId) {
    this.allowlist.delete(chatKey(platform, userId));
    this._scheduleSave();
  }

  list() {
    return [...this.chats.values()].map((b) => ({
      platform: b.platform,
      chatId: b.chatId,
      chatType: b.chatType,
      sessionId: b.sessionId,
      lastActivityAt: b.lastActivityAt,
    }));
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; void this.save(); }, 500);
  }

  /** Atomic write: tmp + rename (rename also works on filesystems without hardlinks). */
  async save() {
    if (this._saving) return this._saving;
    this._saving = (async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const payload = {
        version: STORE_VERSION,
        chats: [...this.chats.values()],
        allowlist: [...this.allowlist],
      };
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmp, this.file);
    })().finally(() => { this._saving = null; });
    return this._saving;
  }

  async dispose() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try { await this.save(); } catch { /* best effort on shutdown */ }
  }
}
