# Changelog

## Unreleased

### Added

- Add `/droid-autonomy` and footer status for Factory model autonomy.
- Add opt-in pi UI permission prompts with `PI_DROID_PERMISSION_PROMPTS=1`.
- Add bounded Droid prompt construction that budgets older transcript turns while preserving the latest user request and latest-turn images.
- Add scrubbed Droid bridge diagnostics via `PI_DROID_PI_TOOL_BRIDGE_DEBUG=1`.
- Replay Droid-native SDK tool calls into pi TUI as display-only mapped `droid_read`/`droid_bash`/`droid_edit`/`droid_write`/`droid_grep`/`droid_find`/`droid_ls`/`droid_todo` tool-use turns, with generic `droid_tool` fallback for Droid-only tools.
- Render Droid todo updates as readable status lists with compact status summaries.
- Render long Droid-native tool outputs through custom collapsed result views instead of dumping the full transcript into pi TUI.
- Improve Droid `ApplyPatch`/edit replay by extracting patch paths, operation, and diff text for `droid_edit` display.

### Changed

- Preserve live Factory model `contextWindow`/`maxTokens` metadata when available and deduplicate duplicate model IDs.
- Redact API keys and auth material from model-discovery and stream error messages.
- Normalize pi context through pi's LLM transcript conversion before building Droid prompts.

## 0.1.0

- Initial scaffold: Factory provider via `@factory/droid-sdk`
- Live model discovery from `availableModels` (all Factory models)
- Pi tool bridge via `createSdkMcpServer`
- Reasoning effort mapping to pi thinking controls
- Permission handler + ask-user UI wiring
- Fallback model catalog and `/droid-refresh-models`
