/**
 * dsh-channel-bot — task dispatch: inbound chat text → a real DSH agent turn.
 *
 * This is what turns the bot from "a notifier that answers /commands" into a
 * remote control: a non-command message is delivered to the agent bound to that
 * chat, and the agent's reply comes back through the same channel.
 *
 * Lifecycle (mirrors dsh-im's index.js dispatchTask, using the same official
 * services api-proxy uses for the browser path):
 *   1. resolve the chat's binding (deterministic session id)
 *   2. `ctx.agents.get(sessionId)` — live agent in this process?
 *   3. else `ctx.agents.resume({resumeSessionId})` — restart recovery
 *   4. else `ctx.agents.create({sessionId, meta:{cwd}})` — first contact
 *   5. `agent.followup(userMessage)`
 *
 * Agent presets are mounted through the `setup` callback exactly like
 * api-proxy's composeAgent does; without it a bot-created session would have no
 * official tools at all.
 */
import { randomUUID } from "node:crypto";

/** UserMessage shaped like dsh-llm's createUserMessage output. */
export function userMessage(text) {
  return {
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text: String(text) }],
    source: { kind: "user" },
  };
}

/**
 * Resolve the agent-preset mount for a new/resumed session, or null when the
 * preset service is absent. Failure to resolve degrades to "no preset" rather
 * than failing the dispatch.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {string} [presetId]
 */
async function resolvePresetSetup(ctx, presetId) {
  try {
    const presets = ctx.get?.("agentPresets");
    if (!presets || typeof presets.resolve !== "function" || typeof presets.mount !== "function") return null;
    /* An empty string is NOT a preset id: `resolve("")` throws
     * `preset "" not found`. Pass undefined so the service picks its default. */
    const wanted = typeof presetId === "string" && presetId.trim() !== "" ? presetId.trim() : undefined;
    const resolved = await presets.resolve(wanted);
    const id = String(resolved?.id ?? "").trim() || wanted;
    if (!id) return null;
    return { id, setup: async (agentCtx) => { await presets.mount(agentCtx, id); } };
  } catch (error) {
    console.warn("[channel-bot] agentPresets resolve failed (dispatch without preset):", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Model options for a new agent. Explicit config wins, else the panel's default
 * model service.
 *
 * ⚠️ These MUST resolve to a real provider+model: without them the agent's
 * options stay empty and turn assembly fails with
 * `prompt variable "{{model}}" has no value for this assembly
 * (section "deployment:persona")` — the turn dies before reaching the model.
 * The service exposes `currentSelection()` (NOT `get()`).
 */
async function agentOptions(ctx, cfg) {
  const provider = typeof cfg?.provider === "string" ? cfg.provider.trim() : "";
  const model = typeof cfg?.model === "string" ? cfg.model.trim() : "";
  if (provider && model) return { provider, model };
  try {
    const def = ctx.get?.("agentDefaultModel");
    const sel = def && typeof def.currentSelection === "function" ? def.currentSelection() : null;
    if (sel?.provider && sel?.model) {
      return { provider: provider || sel.provider, model: model || sel.model };
    }
  } catch (error) {
    console.warn("[channel-bot] agentDefaultModel read failed:", error instanceof Error ? error.message : String(error));
  }
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

/**
 * Model options for RESUMING a session: prefer what that session itself last
 * used (its persisted `request/header` config, including a model changed in the
 * panel), falling back to the configured/default selection. Resuming without
 * options leaves `agent.options` empty and the first turn fails on `{{model}}`.
 */
async function resumeOptions(ctx, sessionId, cfg) {
  try {
    const persistence = ctx.get?.("sessionPersistence");
    if (persistence && typeof persistence.inspect === "function") {
      const inspected = await persistence.inspect(sessionId);
      const headers = (inspected?.events ?? []).filter((e) => e?.type === "request/header");
      const own = headers[headers.length - 1]?.data?.header?.config;
      if (own?.provider && own?.model) return { provider: own.provider, model: own.model };
    }
  } catch { /* unreadable history → fall back to the default selection */ }
  return await agentOptions(ctx, cfg);
}

/**
 * Get (or bring back) the agent for a bound session.
 * @returns {Promise<{agent: any}|{error: string}>}
 */
export async function ensureAgent(ctx, sessionId, cfg) {
  const live = ctx.agents.get(sessionId);
  if (live !== undefined) return { agent: live };

  const preset = await resolvePresetSetup(ctx, cfg?.agentPreset);

  // Resume first: the session may exist on disk from a previous process.
  try {
    const resumed = await resumeOptions(ctx, sessionId, cfg);
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      ...(Object.keys(resumed).length > 0 ? { agentOptions: resumed } : {}),
      ...(preset ? { setup: preset.setup } : {}),
    });
    if (handle?.agent) return { agent: handle.agent };
  } catch {
    // Not persisted yet (or persistence unavailable) — fall through to create.
  }

  try {
    const options = await agentOptions(ctx, cfg);
    const handle = await ctx.agents.create({
      sessionId,
      ...(Object.keys(options).length > 0 ? { agentOptions: options } : {}),
      meta: {
        ...(cfg?.workspace ? { cwd: cfg.workspace } : {}),
        ...(preset ? { agentPreset: preset.id } : {}),
      },
      ...(preset ? { setup: preset.setup } : {}),
    });
    if (handle?.agent) return { agent: handle.agent };
    return { error: "agents.create returned no agent" };
  } catch (error) {
    // Race: another path may have published the same identity meanwhile.
    const raced = ctx.agents.get(sessionId);
    if (raced !== undefined) return { agent: raced };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Deliver one inbound chat message to its agent.
 * @param {Object} deps
 * @param {import("@deepseek-ai/cordis").Context} deps.ctx
 * @param {import("./sessions.js").ChatSessionMap} deps.map
 * @param {any} deps.cfg          full channel-bot config
 * @param {string} deps.platform
 * @param {string} deps.chatId
 * @param {string} deps.text
 * @param {string} [deps.chatType]
 * @returns {Promise<{ok: true, sessionId: string, mode: 'steer'|'followup'} | {ok: false, message: string}>}
 */
export async function dispatchTask({ ctx, map, cfg, platform, chatId, text, chatType }) {
  const chat = cfg?.chat ?? {};
  if (chat.enabled !== true) {
    return { ok: false, message: "远程对话未启用（设置 → 多渠道机器人 → 远程对话）。" };
  }
  const clean = typeof text === "string" ? text.trim() : "";
  if (clean === "") return { ok: false, message: "消息为空。" };

  let binding = map.get(platform, chatId);
  if (!binding) {
    const maxSessions = Number.isFinite(chat.maxSessions) && chat.maxSessions > 0 ? chat.maxSessions : 20;
    if (map.size >= maxSessions) {
      return { ok: false, message: `会话数已达上限（${maxSessions}），请用 /end 结束一个会话。` };
    }
    binding = map.create(platform, chatId, { chatType: chatType ?? "private" });
  }
  map.touch(platform, chatId);

  const resolved = await ensureAgent(ctx, binding.sessionId, chat);
  if ("error" in resolved) {
    return { ok: false, message: `无法启动会话：${resolved.error}` };
  }
  const agent = resolved.agent;

  // A message arriving while the agent is mid-turn STEERS that turn instead of
  // queueing a second one — matches the panel composer's behaviour.
  try {
    const busy = typeof agent.busy === "boolean" ? agent.busy
      : typeof agent.running === "boolean" ? agent.running
        : false;
    if (busy && typeof agent.steer === "function") {
      agent.steer(userMessage(clean));
      return { ok: true, sessionId: binding.sessionId, mode: "steer" };
    }
    agent.followup(userMessage(clean));
    return { ok: true, sessionId: binding.sessionId, mode: "followup" };
  } catch (error) {
    return { ok: false, message: `提交消息失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
