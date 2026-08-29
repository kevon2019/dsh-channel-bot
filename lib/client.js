/* dsh-channel-bot client half — native settings.section (Settings → 多渠道机器人).
 * Renders with the same primitives as the Models / Vision Router settings pages:
 * Toggle / Row / SettingsGroup / Field over the dsw-alias design tokens, bound to
 * the channel-bot namespace through ctx.settingsScope.bind({ namespace }).
 */
window.__ModuleLoader__.load({ id: "dsh-channel-bot", factory: (require) => {
  "use strict";
  var module = { exports: {} };
  var exports = module.exports;
  var React = require("react");
  var NS = "channel-bot";

  /* ---------- settingsScope binding (mirrors dsh-chinese-mode) ---------- */
  var PENDING = Object.freeze({ status: "loading", value: undefined });
  var binding = null;
  var unsub = null;
  var listeners = [];
  function readScopeSnapshot(scope) {
    try {
      var s = scope.getSnapshot();
      return s !== null && s !== undefined ? s : PENDING;
    } catch { return PENDING; }
  }
  var store = {
    getSnapshot() { return binding; },
    subscribe(listener) {
      listeners.push(listener);
      return () => { var i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    },
    _set(scope) {
      if (unsub !== null) { unsub(); unsub = null; }
      binding = scope === null ? null : { scope, snapshot: readScopeSnapshot(scope) };
      if (scope !== null && typeof scope.subscribe === "function") {
        try {
          unsub = scope.subscribe(() => {
            binding = { scope, snapshot: readScopeSnapshot(scope) };
            for (var l of listeners.slice()) l();
          });
        } catch { /* keep static display */ }
      }
      for (var l2 of listeners.slice()) l2();
    }
  };
  function useBound() { return React.useSyncExternalStore(store.subscribe, store.getSnapshot); }
  function readValue(bound) {
    if (bound === null) return null;
    try {
      var snap = bound.scope.getSnapshot();
      if (snap !== null && snap.status === "ready" && snap.value !== null && typeof snap.value === "object") return snap.value;
    } catch { /* ignore */ }
    return null;
  }
  function write(bound, field, value) {
    if (bound !== null && bound.scope !== null && typeof bound.scope.set === "function") void bound.scope.set(field, value);
  }
  /* scope.set writes a single-segment path, so nested channel fields are written
   * as the whole channel object: writeChannel(bound, value, "telegram", { botToken: v }) */
  function writeChannel(bound, value, ch, patch) {
    write(bound, ch, Object.assign({}, value[ch] || {}, patch));
  }
  function parseList(raw) {
    return String(raw || "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  }

  /* ---------- native primitives (dsw-alias tokens) ---------- */
  function Toggle({ value, onChange, disabled, ariaLabel }) {
    var on = value === true;
    var [focused, setFocused] = React.useState(false);
    return React.createElement("button", {
      type: "button", "aria-label": ariaLabel, "aria-pressed": on,
      disabled: disabled === true,
      onClick: () => { if (disabled !== true && typeof onChange === "function") onChange(!on); },
      onFocus: () => setFocused(true), onBlur: () => setFocused(false),
      style: {
        position: "relative", width: 40, height: 23, borderRadius: 999, flex: "none",
        border: on ? "1px solid rgba(49,94,251,0.56)" : "1px solid rgba(127,127,127,0.28)",
        cursor: disabled ? "not-allowed" : "pointer", padding: 0,
        transition: "background 0.16s, border-color 0.16s, box-shadow 0.16s",
        background: on ? "var(--dsw-alias-brand-primary, #315efb)" : "rgba(127,127,127,0.25)",
        boxShadow: focused ? "0 0 0 3px rgba(49,94,251,0.24)" : "inset 0 1px 1px rgba(20,37,70,0.12)",
        opacity: disabled ? 0.5 : 1
      }
    }, React.createElement("span", {
      "aria-hidden": true,
      style: {
        position: "absolute", top: 3, left: 3, width: 15, height: 15, borderRadius: 999,
        background: "#ffffff", boxShadow: "0 1px 3px rgba(20,37,70,0.25)",
        transition: "transform 0.16s", transform: on ? "translateX(17px)" : "translateX(0px)"
      }
    }));
  }
  function Row({ label, hint, children }) {
    return React.createElement("div", {
      style: {
        display: "flex", alignItems: "center", gap: 16, minHeight: 52, padding: "10px 0",
        borderBottom: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.16))",
        justifyContent: "space-between"
      }
    },
      React.createElement("div", { style: { flex: 1, minWidth: 0 } },
        React.createElement("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-text-primary, inherit)", lineHeight: 1.4 } }, label),
        hint ? React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-text-tertiary, #888)", marginTop: 3, lineHeight: 1.45 } }, hint) : null),
      children);
  }
  var FoldContext = React.createContext({ allOpen: true, rev: 0, toggleAll: function () {} });
  function SettingsGroup({ title, hint, children, group, global }) {
    var [open, setOpen] = React.useState(true);
    var fold = React.useContext(FoldContext);
    /* 全局「全部收起/展开」信号变化时，同步本块状态 */
    React.useEffect(() => { setOpen(fold.allOpen); }, [fold.rev]);
    var isGlobal = global === true;
    var expanded = isGlobal ? fold.allOpen : open;
    var onToggle = isGlobal ? fold.toggleAll : () => setOpen(!open);
    return React.createElement("section", {
      ...(group ? { "data-save-group": group } : {}),
      style: { marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.18))" }
    },
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        React.createElement("div", { style: { flex: 1, fontSize: 13, fontWeight: 700, color: "var(--dsw-alias-text-primary, inherit)", lineHeight: 1.4, cursor: "pointer" }, onClick: onToggle, title: isGlobal ? "一键全部收起/展开" : "点击折叠/展开" },
          title),
        React.createElement("button", {
          type: "button", "aria-label": isGlobal ? "全部收起/展开" : "折叠" + title, "aria-expanded": expanded,
          onClick: onToggle,
          style: { background: "transparent", border: "1px solid var(--dsw-alias-border-l2, #333)", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 11, color: "inherit", flex: "none", lineHeight: 1.3 }
        }, expanded ? (isGlobal ? "▲ 全部收起" : "▲ 收起") : (isGlobal ? "▼ 全部展开" : "▼ 展开"))),
      React.createElement("div", { style: { display: expanded ? "block" : "none" } },
        hint ? React.createElement("div", { style: { marginTop: 3, fontSize: 12, color: "var(--dsw-alias-text-tertiary, #888)", lineHeight: 1.45 } }, hint) : null,
        React.createElement("div", { style: { marginTop: 8 } }, children)));
  }
  function Field({ value, onCommit, placeholder, ariaLabel, type, field, fieldType }) {
    var [local, setLocal] = React.useState(value);
    var [focused, setFocused] = React.useState(false);
    React.useEffect(() => { setLocal(value); }, [value]);
    return React.createElement("input", {
      "aria-label": ariaLabel,
      ...(field ? { "data-field": field, "data-ftype": fieldType || "text" } : {}),
      value: local,
      type: type || "text",
      placeholder: placeholder || "",
      spellCheck: false,
      onChange: (e) => setLocal(e.target.value),
      onFocus: () => setFocused(true),
      onBlur: () => { setFocused(false); if (typeof onCommit === "function") onCommit(local); },
      style: {
        width: "100%", boxSizing: "border-box",
        background: "var(--dsw-alias-background-input, rgba(127,127,127,0.08))",
        color: "inherit",
        border: focused ? "1px solid var(--dsw-alias-brand-primary, #315efb)" : "1px solid rgba(127,127,127,0.22)",
        borderRadius: 6, boxShadow: focused ? "0 0 0 3px rgba(49,94,251,0.18)" : "none",
        padding: "8px 10px", fontSize: 13, transition: "border-color 0.16s, box-shadow 0.16s"
      }
    });
  }
  function SectionField({ label, hint, children }) {
    return React.createElement("div", { style: { padding: "8px 0 12px" } },
      React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-text-secondary, #7f8a99)", marginBottom: 6, lineHeight: 1.4 } }, label),
      hint ? React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-text-tertiary, #888)", marginBottom: 6, lineHeight: 1.4 } }, hint) : null,
      children);
  }
  function TextArea({ value, onCommit, placeholder, ariaLabel, rows, field, fieldType }) {
    var [local, setLocal] = React.useState(value);
    var [focused, setFocused] = React.useState(false);
    React.useEffect(() => { setLocal(value); }, [value]);
    return React.createElement("textarea", {
      "aria-label": ariaLabel,
      ...(field ? { "data-field": field, "data-ftype": fieldType || "text" } : {}),
      value: local,
      rows: rows || 3,
      placeholder: placeholder || "",
      spellCheck: false,
      onChange: (e) => setLocal(e.target.value),
      onFocus: () => setFocused(true),
      onBlur: () => { setFocused(false); if (typeof onCommit === "function") onCommit(local); },
      style: {
        width: "100%", boxSizing: "border-box", resize: "vertical",
        background: "var(--dsw-alias-background-input, rgba(127,127,127,0.08))",
        color: "inherit", fontFamily: "inherit",
        border: focused ? "1px solid var(--dsw-alias-brand-primary, #315efb)" : "1px solid rgba(127,127,127,0.22)",
        borderRadius: 6, boxShadow: focused ? "0 0 0 3px rgba(49,94,251,0.18)" : "none",
        padding: "8px 10px", fontSize: 13, lineHeight: 1.5, transition: "border-color 0.16s, box-shadow 0.16s"
      }
    });
  }

  function readTypedValue(inp) {
    var ft = inp.getAttribute("data-ftype");
    var v = inp.value;
    if (ft === "number") { var n = Number(v); return Number.isFinite(n) ? n : 0; }
    if (ft === "list") return parseList(v);
    return v;
  }
  var actionBtnStyle = {
    padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
    background: "var(--dsw-alias-brand-primary, #315efb)", color: "#fff", fontWeight: 600, fontSize: 12,
    lineHeight: 1.3, whiteSpace: "nowrap"
  };
  var testBtnStyle = {
    padding: "6px 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #333)",
    background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12, lineHeight: 1.3, whiteSpace: "nowrap"
  };
  /* 每个渠道 / 重要功能块的「保存」+「测试验证」按钮。保存按钮读取本块内所有
   * [data-field] 输入的当前值（含正在编辑未失焦的），一次性写回 scope 并生效；
   * 测试按钮对指定渠道发一条真实测试消息验证凭据连通。 */
  function ChannelActions({ group, channel, top, bound, value, testable, hint }) {
    var [saveText, setSaveText] = React.useState("");
    var [testText, setTestText] = React.useState("");
    var doSave = () => {
      var el = document.querySelector('[data-save-group="' + group + '"]');
      if (!el) { setSaveText("⚠️ 定位失败"); setTimeout(() => setSaveText(""), 3000); return; }
      var inputs = el.querySelectorAll("[data-field]");
      var patch = {};
      for (var i = 0; i < inputs.length; i++) {
        var key = inputs[i].getAttribute("data-field");
        if (!key) continue;
        patch[key] = readTypedValue(inputs[i]);
      }
      try {
        if (channel) { writeChannel(bound, value, channel, patch); }
        else if (top) { write(bound, top, Object.assign({}, value[top] || {}, patch)); }
        else { for (var f in patch) write(bound, f, patch[f]); }
        setSaveText("✅ 已保存并生效");
      } catch (e) { setSaveText("❌ 保存失败: " + (e && e.message ? e.message : String(e))); }
      setTimeout(() => setSaveText(""), 3000);
    };
    var doTest = () => {
      setTestText("测试中…");
      fetch("/api/channel-bot/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel }), cache: "no-store" })
        .then((r) => r.json())
        .then((b) => setTestText(b && b.ok ? "✅ 已发出，请到「" + channel + "」确认收到" : "❌ " + (b && b.error || "发送失败")))
        .catch((e) => setTestText("❌ " + (e && e.message ? e.message : String(e))));
    };
    return React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "8px 0 4px" } },
      React.createElement("button", { type: "button", onClick: doSave, style: actionBtnStyle, "aria-label": "保存" + (channel ? " " + channel : group) }, "💾 保存"),
      testable && channel ? React.createElement("button", { type: "button", onClick: doTest, style: testBtnStyle, "aria-label": "测试验证 " + channel }, "🧪 测试验证") : null,
      hint && !testText ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-text-tertiary, #888)" } }, hint) : null,
      saveText ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-text-secondary, #7f8a99)" } }, saveText) : null,
      testText ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-text-secondary, #7f8a99)" } }, testText) : null);
  }

  /* ---------- 微信扫码登录 ---------- */
  function WechatLoginArea({ value, bound }) {
    var [qr, setQr] = React.useState(null);
    var [qrMsg, setQrMsg] = React.useState("");
    var timerRef = React.useRef(null);
    React.useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);
    var start = () => {
      setQrMsg("正在获取登录二维码…");
      fetch("/api/channel-bot/wechat/login", { method: "POST", cache: "no-store" })
        .then((r) => r.json())
        .then((b) => {
          if (!b.ok) { setQr(null); setQrMsg("获取二维码失败: " + (b.error || "")); return; }
          setQr("/api/channel-bot/wechat/qr?t=" + Date.now());
          setQrMsg("请用手机微信扫码授权（3 分钟内有效）");
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = setInterval(() => {
            fetch("/api/channel-bot/wechat/login/status", { cache: "no-store" })
              .then((r) => r.json())
              .then((s) => {
                if (s.status === "confirmed") {
                  clearInterval(timerRef.current); timerRef.current = null;
                  setQr(null); setQrMsg("登录成功，Token 已保存");
                } else if (s.status === "expired") {
                  clearInterval(timerRef.current); timerRef.current = null;
                  setQr(null); setQrMsg("二维码已过期，请重新点击登录");
                } else if (s.status === "idle") {
                  clearInterval(timerRef.current); timerRef.current = null;
                }
              }).catch(() => {});
          }, 2000);
        })
        .catch((e) => { setQr(null); setQrMsg("登录请求失败: " + (e && e.message ? e.message : String(e))); });
    };
    return React.createElement("div", null,
      React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 0" } },
        React.createElement("button", {
          type: "button", onClick: start,
          style: {
            padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer",
            background: "var(--dsw-alias-brand-primary, #315efb)", color: "#fff", fontWeight: 600, fontSize: 13
          }
        }, "微信扫码登录"),
        qr ? React.createElement("img", { src: qr, style: { width: 132, height: 132, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #333)" }, alt: "wechat qr" }) : null,
        qrMsg ? React.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-text-secondary, #7f8a99)" } }, qrMsg) : null),
      value && value.botToken ? React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-text-tertiary, #888)" } }, "当前已登录（botToken 已保存，可直接在下方字段查看/修改）") : null);
  }

  /* ---------- 设置区主体 ---------- */
  function ChannelBotSection() {
    var bound = useBound();
    var value = readValue(bound);
    var [statusText, setStatusText] = React.useState("");
    var [notifyText, setNotifyText] = React.useState("");
    if (value === null) {
      return React.createElement("div", { style: { color: "var(--dsw-alias-text-tertiary, #888)", fontSize: 13, padding: 12 } }, "多渠道机器人设置加载中…");
    }
    var testStatus = () => {
      fetch("/api/channel-bot/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((b) => setStatusText(JSON.stringify(b, null, 1)))
        .catch((e) => setStatusText(String(e)));
    };
    var testNotify = () => {
      setNotifyText("发送中…");
      fetch("/api/channel-bot/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "✅ DSH 通知渠道测试：这条消息来自你的 DSH 面板。" }),
        cache: "no-store"
      })
        .then((r) => r.json())
        .then((b) => setNotifyText(JSON.stringify(b, null, 1)))
        .catch((e) => setNotifyText(String(e)));
    };
    /* 每个块底部的「保存 / 测试验证」操作条：channel 指定则显示测试按钮并可写渠道对象，
     * top 指定则整块写入该顶层字段（chat/approvals/notifyEvents），否则按顶层字段逐个写。 */
    var CA = (group, channel, top, hint) => React.createElement(ChannelActions, { group, channel, top, testable: !!channel, bound, value, hint });
    var [allOpen, setAllOpen] = React.useState(true);
    var [foldRev, setFoldRev] = React.useState(0);
    var toggleAll = () => { setAllOpen(!allOpen); setFoldRev((r) => r + 1); };
    var foldValue = { allOpen, rev: foldRev, toggleAll };
    return React.createElement(FoldContext.Provider, { value: foldValue },
      React.createElement("div", { style: { maxWidth: 640, padding: "14px 4px 24px" } },
      React.createElement("div", { style: { fontSize: 15, fontWeight: 700, color: "var(--dsw-alias-text-primary, inherit)", lineHeight: 1.4 } }, "多渠道机器人"),
      React.createElement("div", { style: { marginTop: 4, fontSize: 12, color: "var(--dsw-alias-text-tertiary, #888)", lineHeight: 1.5 } },
        "把面板功能（/balance /status /plugins /version）接到 Telegram / 钉钉 / 飞书 / 企业微信 / QQ / 微信。微信走腾讯官方 iLink Bot API，无需公网回调。除了机器人命令，各渠道还可作为通知渠道——agent 完成任务或需要你注意时会主动推送消息（由各渠道的「通知」开关控制）。"),
      React.createElement(SettingsGroup, { title: "总开关", hint: "关闭后所有渠道停止响应。点击标题旁「全部收起/全部展开」可一键折叠/展开下方所有渠道与功能区。", group: "cb-sw", global: true },
        React.createElement(Row, { label: "启用机器人", hint: "总开关，控制所有渠道的入站命令处理。" },
          React.createElement(Toggle, { value: value.enabled === true, onChange: (v) => write(bound, "enabled", v), ariaLabel: "启用机器人" })),
        React.createElement(SectionField, { label: "命令前缀" },
          React.createElement(Field, { value: value.prefix || "/", onCommit: (v) => write(bound, "prefix", v || "/"), ariaLabel: "命令前缀", field: "prefix" }))),
      CA("cb-sw"),
      React.createElement(SettingsGroup, { title: "Telegram", hint: "Bot Token 轮询收消息，无需公网。", group: "cb-tg" },
        React.createElement(Row, { label: "启用", hint: "开启后服务端每 2 秒轮询一次 getUpdates。" },
          React.createElement(Toggle, { value: value.telegram && value.telegram.enabled === true, onChange: (v) => writeChannel(bound, value, "telegram", { enabled: v }), ariaLabel: "启用 Telegram" })),
        React.createElement(SectionField, { label: "Bot Token", hint: "@BotFather 创建机器人后获得的 token。" },
          React.createElement(Field, { value: (value.telegram && value.telegram.botToken) || "", onCommit: (v) => writeChannel(bound, value, "telegram", { botToken: v }), ariaLabel: "Telegram Bot Token", field: "botToken" })),
        React.createElement(SectionField, { label: "允许的 Chat ID", hint: "逗号分隔，留空=所有会话。" },
          React.createElement(Field, { value: (value.telegram && value.telegram.allowedChatIds || []).join(", "), onCommit: (v) => writeChannel(bound, value, "telegram", { allowedChatIds: parseList(v) }), ariaLabel: "Telegram 允许的 Chat ID", field: "allowedChatIds", fieldType: "list" })),
        React.createElement(Row, { label: "通知", hint: "允许向该会话推送通知（任务完成、需要关注等）。" },
          React.createElement(Toggle, { value: value.telegram && value.telegram.notify === true, onChange: (v) => writeChannel(bound, value, "telegram", { notify: v }), ariaLabel: "Telegram 通知" })),
        React.createElement(SectionField, { label: "通知 Chat ID", hint: "通知推送目标，留空=取允许的 Chat ID 第一个。" },
          React.createElement(Field, { value: (value.telegram && value.telegram.notifyChatId) || "", onCommit: (v) => writeChannel(bound, value, "telegram", { notifyChatId: v }), ariaLabel: "Telegram 通知 Chat ID", field: "notifyChatId" }))),
      CA("cb-tg", "telegram"),
      React.createElement(SettingsGroup, { title: "钉钉", hint: "群机器人 Webhook + 加签，入站回调走公网地址。", group: "cb-dd" },
        React.createElement(Row, { label: "启用" },
          React.createElement(Toggle, { value: value.dingtalk && value.dingtalk.enabled === true, onChange: (v) => writeChannel(bound, value, "dingtalk", { enabled: v }), ariaLabel: "启用钉钉" })),
        React.createElement(Row, { label: "通知", hint: "允许向该群推送通知。" },
          React.createElement(Toggle, { value: value.dingtalk && value.dingtalk.notify === true, onChange: (v) => writeChannel(bound, value, "dingtalk", { notify: v }), ariaLabel: "钉钉通知" })),
        React.createElement(SectionField, { label: "机器人 Webhook 地址" },
          React.createElement(Field, { value: (value.dingtalk && value.dingtalk.outWebhook) || "", onCommit: (v) => writeChannel(bound, value, "dingtalk", { outWebhook: v }), ariaLabel: "钉钉 Webhook", field: "outWebhook" })),
        React.createElement(SectionField, { label: "加签密钥 (Secret)", hint: "入站回调地址: https://your-domain.example.com/api/channel-bot/webhook/dingtalk" },
          React.createElement(Field, { value: (value.dingtalk && value.dingtalk.secret) || "", onCommit: (v) => writeChannel(bound, value, "dingtalk", { secret: v }), ariaLabel: "钉钉 Secret", field: "secret" }))),
      CA("cb-dd", "dingtalk"),
      React.createElement(SettingsGroup, { title: "飞书", hint: "群机器人 Webhook + 加签，支持事件订阅回调。", group: "cb-fs" },
        React.createElement(Row, { label: "启用" },
          React.createElement(Toggle, { value: value.feishu && value.feishu.enabled === true, onChange: (v) => writeChannel(bound, value, "feishu", { enabled: v }), ariaLabel: "启用飞书" })),
        React.createElement(Row, { label: "通知", hint: "允许向该群推送通知。" },
          React.createElement(Toggle, { value: value.feishu && value.feishu.notify === true, onChange: (v) => writeChannel(bound, value, "feishu", { notify: v }), ariaLabel: "飞书通知" })),
        React.createElement(SectionField, { label: "机器人 Webhook 地址" },
          React.createElement(Field, { value: (value.feishu && value.feishu.outWebhook) || "", onCommit: (v) => writeChannel(bound, value, "feishu", { outWebhook: v }), ariaLabel: "飞书 Webhook", field: "outWebhook" })),
        React.createElement(SectionField, { label: "加签密钥 (Secret)", hint: "入站回调地址: https://your-domain.example.com/api/channel-bot/webhook/feishu" },
          React.createElement(Field, { value: (value.feishu && value.feishu.secret) || "", onCommit: (v) => writeChannel(bound, value, "feishu", { secret: v }), ariaLabel: "飞书 Secret", field: "secret" }))),
      CA("cb-fs", "feishu"),
      React.createElement(SettingsGroup, { title: "企业微信", hint: "群机器人 Webhook；填 4 项应用消息参数则发给指定成员个人。", group: "cb-wx" },
        React.createElement(Row, { label: "启用" },
          React.createElement(Toggle, { value: value.wecom && value.wecom.enabled === true, onChange: (v) => writeChannel(bound, value, "wecom", { enabled: v }), ariaLabel: "启用企业微信" })),
        React.createElement(Row, { label: "通知", hint: "允许向该群/个人推送通知。" },
          React.createElement(Toggle, { value: value.wecom && value.wecom.notify === true, onChange: (v) => writeChannel(bound, value, "wecom", { notify: v }), ariaLabel: "企业微信通知" })),
        React.createElement(SectionField, { label: "机器人 Webhook 地址" },
          React.createElement(Field, { value: (value.wecom && value.wecom.outWebhook) || "", onCommit: (v) => writeChannel(bound, value, "wecom", { outWebhook: v }), ariaLabel: "企业微信 Webhook", field: "outWebhook" })),
        React.createElement(SectionField, { label: "企业微信应用消息（个人，填了优先于上面 Webhook）" },
          React.createElement(Field, { value: (value.wecom && value.wecom.corpid) || "", onCommit: (v) => writeChannel(bound, value, "wecom", { corpid: v }), ariaLabel: "企业 ID (corpid)", field: "corpid" }),
          React.createElement(Field, { value: (value.wecom && value.wecom.corpsecret) || "", onCommit: (v) => writeChannel(bound, value, "wecom", { corpsecret: v }), ariaLabel: "应用 Secret (corpsecret)", field: "corpsecret" }),
          React.createElement(Field, { value: (value.wecom && value.wecom.agentid) || "", onCommit: (v) => writeChannel(bound, value, "wecom", { agentid: v }), ariaLabel: "应用 AgentId", field: "agentid" }),
          React.createElement(Field, { value: (value.wecom && value.wecom.touser) || "", onCommit: (v) => writeChannel(bound, value, "wecom", { touser: v }), ariaLabel: "接收成员ID (touser)", field: "touser" })),
        React.createElement(SectionField, { label: "方案二 · 企业微信智能机器人 · 长连接（填入 Bot ID+Secret 后本插件直接收发）", hint: "在企微管理后台「安全与合规 → 管理工具 → 智能机器人」创建 API 模式机器人并选「长连接」，生成 Bot ID + Secret 填入。本插件以此直接长连接收发企微机器人消息（@wecom/aibot-node-sdk），无需公网回调、无需再装 OpenClaw。填了后优先于上方方案一（应用消息 / Webhook）。" },
          React.createElement(Field, { value: (value.wecom && value.wecom.botId) || "", onCommit: (v) => writeChannel(bound, value, "wecom", { botId: v }), ariaLabel: "OpenClaw Bot ID", field: "botId", fieldType: "text" }),
          React.createElement(Field, { value: (value.wecom && value.wecom.secret) || "", onCommit: (v) => writeChannel(bound, value, "wecom", { secret: v }), ariaLabel: "OpenClaw Secret", field: "secret", fieldType: "text" }))),
      CA("cb-wx", "wecom"),
      React.createElement(SettingsGroup, { title: "QQ (OneBot)", hint: "OneBot HTTP 上报 + 出站。", group: "cb-qq" },
        React.createElement(Row, { label: "启用" },
          React.createElement(Toggle, { value: value.qq && value.qq.enabled === true, onChange: (v) => writeChannel(bound, value, "qq", { enabled: v }), ariaLabel: "启用 QQ" })),
        React.createElement(Row, { label: "通知", hint: "允许推送通知，目标为下方群号。" },
          React.createElement(Toggle, { value: value.qq && value.qq.notify === true, onChange: (v) => writeChannel(bound, value, "qq", { notify: v }), ariaLabel: "QQ 通知" })),
        React.createElement(SectionField, { label: "OneBot HTTP 地址", hint: "入站上报地址: https://your-domain.example.com/api/channel-bot/webhook/qq" },
          React.createElement(Field, { value: (value.qq && value.qq.onebotUrl) || "", onCommit: (v) => writeChannel(bound, value, "qq", { onebotUrl: v }), ariaLabel: "QQ OneBot 地址", field: "onebotUrl" })),
        React.createElement(SectionField, { label: "Access Token" },
          React.createElement(Field, { value: (value.qq && value.qq.accessToken) || "", onCommit: (v) => writeChannel(bound, value, "qq", { accessToken: v }), ariaLabel: "QQ Access Token", field: "accessToken" })),
        React.createElement(SectionField, { label: "群号", hint: "留空=私聊。" },
          React.createElement(Field, { value: (value.qq && value.qq.groupId) || "", onCommit: (v) => writeChannel(bound, value, "qq", { groupId: v }), ariaLabel: "QQ 群号", field: "groupId" })),
        React.createElement(SectionField, { label: "方案二 · QQ 开放平台 v2（填入 AppID+AppSecret 后本插件直接收发）", hint: "官方 QQ 开放平台机器人：AppID + AppSecret 调用 getAppAccessToken 换取 access_token（v2 OpenAPI），被动回复自动带收到的 msg_id。填了后优先于上方方案一 OneBot。管理端「开发基础设置」取 AppID/AppSecret；收消息用事件订阅 webhook（回调地址=上方 OneBot HTTP 地址）。群消息用机器人所在群的 group_openid，单聊需在管理端申请「主动消息/单聊发送」权限。下方两个 Bot ID+Secret 仅为 OpenClaw/其他生态记录展示，本插件不参与。" },
          React.createElement(Field, { value: (value.qq && value.qq.appId) || "", onCommit: (v) => writeChannel(bound, value, "qq", { appId: v }), ariaLabel: "QQ 开放平台 AppID", field: "appId", fieldType: "text" }),
          React.createElement(Field, { value: (value.qq && value.qq.appSecret) || "", onCommit: (v) => writeChannel(bound, value, "qq", { appSecret: v }), ariaLabel: "QQ 开放平台 AppSecret", field: "appSecret", fieldType: "text" }),
          React.createElement(Field, { value: (value.qq && value.qq.botId) || "", onCommit: (v) => writeChannel(bound, value, "qq", { botId: v }), ariaLabel: "OpenClaw QQ Bot ID", field: "botId", fieldType: "text" }),
          React.createElement(Field, { value: (value.qq && value.qq.secret) || "", onCommit: (v) => writeChannel(bound, value, "qq", { secret: v }), ariaLabel: "OpenClaw QQ Secret", field: "secret", fieldType: "text" }))),
      CA("cb-qq", "qq"),
      React.createElement(SettingsGroup, { title: "微信（个人号 · 官方 iLink）", hint: "腾讯官方 iLink Bot API，扫码登录，长轮询收消息，无封号风险。", group: "cb-wc" },
        React.createElement(Row, { label: "启用" },
          React.createElement(Toggle, { value: value.wechat && value.wechat.enabled === true, onChange: (v) => writeChannel(bound, value, "wechat", { enabled: v }), ariaLabel: "启用微信" })),
        React.createElement(WechatLoginArea, { value: value.wechat || {}, bound: bound }),
        React.createElement(SectionField, { label: "Bot Token", hint: "扫码登录后自动写入；也可手动粘贴。" },
          React.createElement(Field, { value: (value.wechat && value.wechat.botToken) || "", onCommit: (v) => writeChannel(bound, value, "wechat", { botToken: v }), ariaLabel: "微信 Bot Token", field: "botToken" })),
        React.createElement(SectionField, { label: "允许的用户 ID", hint: "逗号分隔的 xxx@im.wechat，留空=所有用户。" },
          React.createElement(Field, { value: (value.wechat && value.wechat.allowedUserIds || []).join(", "), onCommit: (v) => writeChannel(bound, value, "wechat", { allowedUserIds: parseList(v) }), ariaLabel: "微信允许的用户 ID", field: "allowedUserIds", fieldType: "list" })),
        React.createElement(Row, { label: "通知", hint: "允许向该用户推送通知。" },
          React.createElement(Toggle, { value: value.wechat && value.wechat.notify === true, onChange: (v) => writeChannel(bound, value, "wechat", { notify: v }), ariaLabel: "微信通知" })),
        React.createElement(SectionField, { label: "通知用户 ID", hint: "通知推送目标，留空=取允许的用户 ID 第一个。" },
          React.createElement(Field, { value: (value.wechat && value.wechat.notifyUserId) || "", onCommit: (v) => writeChannel(bound, value, "wechat", { notifyUserId: v }), ariaLabel: "微信通知用户 ID", field: "notifyUserId" })),
        React.createElement(SectionField, { label: "方案二 · OpenClaw / 第三方机器人模式（仅记录展示）", hint: "若你的微信另有第三方机器人（如 ClawBot / iLink 网关）需在别处使用同一组 Bot ID + Secret，可在此记录展示。本插件的微信收发由上方方案一 iLink 直接承担，不以本区字段为准。" },
          React.createElement(Field, { value: (value.wechat && value.wechat.botId) || "", onCommit: (v) => writeChannel(bound, value, "wechat", { botId: v }), ariaLabel: "OpenClaw 微信 Bot ID", field: "botId", fieldType: "text" }),
          React.createElement(Field, { value: (value.wechat && value.wechat.secret) || "", onCommit: (v) => writeChannel(bound, value, "wechat", { secret: v }), ariaLabel: "OpenClaw 微信 Secret", field: "secret", fieldType: "text" }))),
      CA("cb-wc", "wechat"),
      React.createElement(SettingsGroup, { title: "命令", hint: "各渠道可用的命令开关。" },
        React.createElement(Row, { label: "/help" },
          React.createElement(Toggle, { value: !value.commands || value.commands.help !== false, onChange: (v) => write(bound, "commands", Object.assign({}, value.commands || {}, { help: v })), ariaLabel: "help 命令" })),
        React.createElement(Row, { label: "/balance", hint: "查询 DeepSeek 余额。" },
          React.createElement(Toggle, { value: !value.commands || value.commands.balance !== false, onChange: (v) => write(bound, "commands", Object.assign({}, value.commands || {}, { balance: v })), ariaLabel: "balance 命令" })),
        React.createElement(Row, { label: "/spending", hint: "会话花销（今日/本周/本月/今年）。" },
          React.createElement(Toggle, { value: !value.commands || value.commands.spending !== false, onChange: (v) => write(bound, "commands", Object.assign({}, value.commands || {}, { spending: v })), ariaLabel: "spending 命令" })),
        React.createElement(Row, { label: "/status" },
          React.createElement(Toggle, { value: !value.commands || value.commands.status !== false, onChange: (v) => write(bound, "commands", Object.assign({}, value.commands || {}, { status: v })), ariaLabel: "status 命令" })),
        React.createElement(Row, { label: "/plugins" },
          React.createElement(Toggle, { value: !value.commands || value.commands.plugins !== false, onChange: (v) => write(bound, "commands", Object.assign({}, value.commands || {}, { plugins: v })), ariaLabel: "plugins 命令" })),
        React.createElement(Row, { label: "/version" },
          React.createElement(Toggle, { value: !value.commands || value.commands.version !== false, onChange: (v) => write(bound, "commands", Object.assign({}, value.commands || {}, { version: v })), ariaLabel: "version 命令" }))),
      React.createElement(SettingsGroup, { title: "远程对话", hint: "开启后，直接在 IM 里发普通消息（不带命令前缀）就会作为任务提交给 agent，回复原路发回该聊天。每个聊天绑定一个独立的 DSH 会话，重启后自动恢复。⚠️ 这等于把面板输入框开放给能给机器人发消息的人，务必先配好各渠道的「允许的 ID」白名单。", group: "cb-chat" },
        React.createElement(Row, { label: "启用远程对话", hint: "关闭时机器人只回答 /命令。" },
          React.createElement(Toggle, { value: value.chat && value.chat.enabled === true, onChange: (v) => write(bound, "chat", Object.assign({}, value.chat || {}, { enabled: v })), ariaLabel: "启用远程对话" })),
        React.createElement(Row, { label: "流式回复", hint: "你在最近活跃窗口内发过消息时，边生成边分段推送；否则只推最终结果。" },
          React.createElement(Toggle, { value: !value.chat || value.chat.stream !== false, onChange: (v) => write(bound, "chat", Object.assign({}, value.chat || {}, { stream: v })), ariaLabel: "流式回复" })),
        React.createElement(SectionField, { label: "活跃窗口（分钟）", hint: "最近多少分钟内发过消息算「人在」，默认 10。" },
          React.createElement(Field, { type: "number", value: value.chat && value.chat.presenceWindowMin != null ? String(value.chat.presenceWindowMin) : "10", onCommit: (v) => { const n = Number(v); write(bound, "chat", Object.assign({}, value.chat || {}, { presenceWindowMin: Number.isFinite(n) ? n : 10 })); }, ariaLabel: "活跃窗口", field: "presenceWindowMin", fieldType: "number" })),
        React.createElement(SectionField, { label: "工作目录", hint: "新建会话的 cwd，留空=进程当前目录。" },
          React.createElement(Field, { value: (value.chat && value.chat.workspace) || "", onCommit: (v) => write(bound, "chat", Object.assign({}, value.chat || {}, { workspace: v })), ariaLabel: "工作目录", field: "workspace" })),
        React.createElement(SectionField, { label: "模型 provider", hint: "留空=跟随面板默认模型。" },
          React.createElement(Field, { value: (value.chat && value.chat.provider) || "", onCommit: (v) => write(bound, "chat", Object.assign({}, value.chat || {}, { provider: v })), ariaLabel: "模型 provider", field: "provider" })),
        React.createElement(SectionField, { label: "模型 model", hint: "留空=跟随面板默认模型。" },
          React.createElement(Field, { value: (value.chat && value.chat.model) || "", onCommit: (v) => write(bound, "chat", Object.assign({}, value.chat || {}, { model: v })), ariaLabel: "模型 model", field: "model" })),
        React.createElement(SectionField, { label: "最大会话数", hint: "已绑定聊天数量上限，默认 20。用 /end 解绑。" },
          React.createElement(Field, { type: "number", value: value.chat && value.chat.maxSessions != null ? String(value.chat.maxSessions) : "20", onCommit: (v) => { const n = Number(v); write(bound, "chat", Object.assign({}, value.chat || {}, { maxSessions: Number.isFinite(n) ? n : 20 })); }, ariaLabel: "最大会话数", field: "maxSessions", fieldType: "number" }))),
      CA("cb-chat", null, "chat"),
      React.createElement(SettingsGroup, { title: "远程审批", hint: "高风险工具调用先推一张审批卡片到 IM，回复「/approve <id> yes|no」放行或拒绝。超时不响应=拒绝。关闭时审批仍走面板弹窗。", group: "cb-appr" },
        React.createElement(Row, { label: "启用远程审批", hint: "只拦截达到风险阈值的调用，日常操作（npm install / git pull）不打扰。" },
          React.createElement(Toggle, { value: value.approvals && value.approvals.enabled === true, onChange: (v) => write(bound, "approvals", Object.assign({}, value.approvals || {}, { enabled: v })), ariaLabel: "启用远程审批" })),
        React.createElement(SectionField, { label: "风险阈值", hint: "low / medium / high，达到或超过该级别才要审批，默认 medium。" },
          React.createElement(Field, { value: (value.approvals && value.approvals.minRisk) || "medium", onCommit: (v) => write(bound, "approvals", Object.assign({}, value.approvals || {}, { minRisk: String(v).trim().toLowerCase() })), ariaLabel: "风险阈值", field: "minRisk" })),
        React.createElement(SectionField, { label: "首次提醒超时（秒）", hint: "无人响应多久后推「任务已阻塞」提醒，默认 300。" },
          React.createElement(Field, { type: "number", value: value.approvals && value.approvals.timeoutSec != null ? String(value.approvals.timeoutSec) : "300", onCommit: (v) => { const n = Number(v); write(bound, "approvals", Object.assign({}, value.approvals || {}, { timeoutSec: Number.isFinite(n) ? n : 300 })); }, ariaLabel: "首次提醒超时", field: "timeoutSec", fieldType: "number" })),
        React.createElement(SectionField, { label: "最终拒绝超时（秒）", hint: "阻塞后再等多久判定为拒绝，默认 3600。" },
          React.createElement(Field, { type: "number", value: value.approvals && value.approvals.pendingMaxSec != null ? String(value.approvals.pendingMaxSec) : "3600", onCommit: (v) => { const n = Number(v); write(bound, "approvals", Object.assign({}, value.approvals || {}, { pendingMaxSec: Number.isFinite(n) ? n : 3600 })); }, ariaLabel: "最终拒绝超时", field: "pendingMaxSec", fieldType: "number" })),
        React.createElement(SectionField, { label: "自定义风险规则", hint: "一行一条：「风险级别 正则」，例如「high  terraform\\s+destroy」。先匹配自定义规则，再落内置规则。" },
          React.createElement(TextArea, { value: (value.approvals && value.approvals.riskRules) || "", onCommit: (v) => write(bound, "approvals", Object.assign({}, value.approvals || {}, { riskRules: v })), ariaLabel: "自定义风险规则", field: "riskRules" }))),
      CA("cb-appr", null, "approvals"),
      React.createElement(SettingsGroup, { title: "通知", hint: "除了机器人命令，面板还可作为通知渠道：agent 完成任务、需要你注意或等待操作时，会向所有开启「通知」的渠道主动推送消息。" },
        React.createElement(Row, { label: "测试通知", hint: "向所有已开启「通知」的渠道发送一条测试消息。" },
          React.createElement("button", {
            type: "button", onClick: testNotify,
            style: {
              padding: "7px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #333)",
              background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13
            }
          }, "发送测试通知")),
        notifyText ? React.createElement("pre", { style: { fontSize: 11, margin: "8px 0 0", whiteSpace: "pre-wrap", color: "var(--dsw-alias-text-secondary, #7f8a99)" } }, notifyText) : null),
      React.createElement(SettingsGroup, { title: "通知事件", hint: "哪些情况触发推送，与桌面通知插件 (dsh-notification) 的通知类型一致。", group: "cb-ev" },
        React.createElement(Row, { label: "正常完成", hint: "一轮任务正常结束。" },
          React.createElement(Toggle, { value: !value.notifyEvents || value.notifyEvents.completed !== false, onChange: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { completed: v })), ariaLabel: "正常完成通知" })),
        React.createElement(Row, { label: "出错", hint: "任务执行出错。" },
          React.createElement(Toggle, { value: !value.notifyEvents || value.notifyEvents.error !== false, onChange: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { error: v })), ariaLabel: "出错通知" })),
        React.createElement(Row, { label: "中止", hint: "任务被中止/打断。" },
          React.createElement(Toggle, { value: value.notifyEvents && value.notifyEvents.aborted === true, onChange: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { aborted: v })), ariaLabel: "中止通知" })),
        React.createElement(Row, { label: "阻塞", hint: "任务陷入阻塞。" },
          React.createElement(Toggle, { value: value.notifyEvents && value.notifyEvents.blocked === true, onChange: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { blocked: v })), ariaLabel: "阻塞通知" })),
        React.createElement(Row, { label: "达 Token 上限", hint: "一轮因 Token 用尽而结束。" },
          React.createElement(Toggle, { value: value.notifyEvents && value.notifyEvents.maxTokens === true, onChange: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { maxTokens: v })), ariaLabel: "Token 上限通知" })),
        React.createElement(Row, { label: "等待审批", hint: "agent 请求你批准/拒绝操作时立即推送。" },
          React.createElement(Toggle, { value: !value.notifyEvents || value.notifyEvents.approval !== false, onChange: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { approval: v })), ariaLabel: "等待审批通知" })),
        React.createElement(Row, { label: "余额不足", hint: "余额低于阈值时推送提醒（30 分钟最多查一次余额）。" },
          React.createElement(Toggle, { value: value.notifyEvents && value.notifyEvents.lowBalance === true, onChange: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { lowBalance: v })), ariaLabel: "余额不足通知" })),
        React.createElement(SectionField, { label: "余额阈值 (¥)", hint: "余额低于该值触发提醒，默认 5。" },
          React.createElement(Field, { type: "number", value: value.notifyEvents && value.notifyEvents.lowBalanceThreshold != null ? String(value.notifyEvents.lowBalanceThreshold) : "5", onCommit: (v) => { const n = Number(v); write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { lowBalanceThreshold: Number.isFinite(n) ? n : 5 })); }, ariaLabel: "余额阈值", field: "lowBalanceThreshold", fieldType: "number" })),
        React.createElement(SectionField, { label: "关键词包含", hint: "一行一个或逗号分隔；至少命中一条才推送。支持 /正则/ 语法。" },
          React.createElement(TextArea, { value: (value.notifyEvents && value.notifyEvents.keywordInclude) || "", onCommit: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { keywordInclude: v })), ariaLabel: "关键词包含", field: "keywordInclude" })),
        React.createElement(SectionField, { label: "关键词排除", hint: "命中任一即不推送。同样支持 /正则/。" },
          React.createElement(TextArea, { value: (value.notifyEvents && value.notifyEvents.keywordExclude) || "", onCommit: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { keywordExclude: v })), ariaLabel: "关键词排除", field: "keywordExclude" })),
        React.createElement(SectionField, { label: "静默时段", hint: "例如「22:00-08:00」，逗号或换行分隔多段。时段内不推送（任务照常执行，只是不打扰）。" },
          React.createElement(Field, { value: (value.notifyEvents && value.notifyEvents.quietHours) || "", onCommit: (v) => write(bound, "notifyEvents", Object.assign({}, value.notifyEvents || {}, { quietHours: v })), ariaLabel: "静默时段", field: "quietHours" }))),
      CA("cb-ev", null, "notifyEvents"),
      React.createElement(SettingsGroup, { title: "诊断" },
        React.createElement(Row, { label: "服务端状态", hint: "查看面板侧实际启用的渠道与运行信息。" },
          React.createElement("button", {
            type: "button", onClick: testStatus,
            style: {
              padding: "7px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #333)",
              background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13
            }
          }, "测试状态")),
        statusText ? React.createElement("pre", { style: { fontSize: 11, margin: "8px 0 0", whiteSpace: "pre-wrap", color: "var(--dsw-alias-text-secondary, #7f8a99)" } }, statusText) : null)));
  }

  /* ---------- 主侧边栏入口（sidebar.footer.action） ---------- */
  function ChannelBotSidebarEntry({ wide }) {
    var openSettings = () => {
      try {
        window.dispatchEvent(new CustomEvent("dsh:open-settings-section", { detail: { id: "channel-bot" } }));
      } catch (e) { /* ignore */ }
    };
    return React.createElement("button", {
      type: "button",
      onClick: openSettings,
      "aria-label": "多渠道机器人",
      title: "多渠道机器人设置",
      style: {
        display: "flex", alignItems: "center", gap: 8, width: "100%", boxSizing: "border-box",
        padding: "7px 12px", background: "transparent", border: "none", borderRadius: 6,
        color: "inherit", cursor: "pointer", fontSize: 13, textAlign: "left"
      }
    },
      React.createElement("span", { style: { fontSize: 14, flex: "none" } }, "📣"),
      wide ? React.createElement("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "多渠道机器人") : null);
  }

  /* ---------- 注册到原生设置页 ---------- */
  function apply(ctx) {
    if (ctx !== null && typeof ctx.slots?.inject === "function" && typeof ctx.slots.register === "function") {
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        {
          name: "settings.section",
          id: "channel-bot",
          order: 750,
          label: () => "多渠道机器人"
        },
        ChannelBotSection
      ));
      /* 主侧边栏独立入口（与 Bot Mode 同槽位 sidebar.footer.action）：
       * 点击通过 window 事件打开设置页并选中多渠道机器人分区。 */
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
        {
          name: "sidebar.footer.action",
          id: "channel-bot",
          key: "channel-bot",
          order: 1,
        },
        ChannelBotSidebarEntry
      ));
    }
    if (ctx !== null && typeof ctx.settingsScope?.bind === "function") {
      const scope = ctx.settingsScope.bind({ namespace: NS });
      store._set(scope);
      ctx.effect(() => () => {
        const current = store.getSnapshot();
        if (current !== null && current.scope === scope) store._set(null);
      }, "channel-bot: settings scope");
    }
  }
  const inject = ["slots", "settingsScope", "connection", "remote"];
  module.exports = { apply, inject };
  return module.exports;
}});
