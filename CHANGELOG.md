# Changelog

## 2.0.0-alpha.1 (2026-09-02) — DSH alpha.3 适配

- **settings API 迁移**：`@deepseek-ai/dsh-settings` 在 alpha.3 移除了 `installSettingsSection` / `settingsNamespace`，本插件改为通过 `ctx.inject(["settings"])` 拿到 settings 服务，调用 `settingsCtx.settings.installSection(ctx, NS, schema, base, { setSource, onChange })`。
- **目标核心**：`@deepseek-ai/dsh >= 0.1.2-alpha.1`。**不再兼容 `< 0.1.2-alpha.1` 旧核心**（因 alpha.3 删除了 installSettingsSection）。
- **其余核心 API**（`defineTool` / `ctx.tools.register` / `sessionQuery` / `settings.update` / client `settings.section` slot）在 alpha.3 均保留，无需改动。
- 说明：本版本为 alpha.3 适配候选版，运行时时序细节将随 alpha.3 核心稳定后精调。

## 1.0.9 — 2026-08-29

- 多渠道路由（QQ/企微/钉钉/飞书/Telegram/微信 iLink）、面板命令、事件通知、远程对话、远程审批。
