# AGENTS.md

## Purpose

pi provider extension that registers Factory Droid models under the `factory` provider via `@factory/droid-sdk`. Agent work succeeds when changes preserve pi-native model/thinking/session behavior, keep Factory API keys out of repo state and logs, and pass local validation.

## Repository map

- `src/index.ts` — registers the pi extension, provider, fallback warnings, bridge hooks, question tool, and session cwd.
- `src/model-discovery.ts` — discovers Factory models via ephemeral Droid session init, builds pi model metadata, fallback catalog.
- `src/droid-provider.ts` — streams through local `@factory/droid-sdk` sessions, bridges pi tools, maps stream events to pi assistant events.
- `src/droid-pi-tool-bridge.ts` — exposes active pi tools to Droid through `createSdkMcpServer`.
- `src/droid-question-tool.ts` — bridge-exposed `droid_ask_question` pi UI tool.
- `src/droid-ask-user.ts` — Droid SDK `askUserHandler` wiring for pi UI select/input.
- `src/droid-permissions.ts` — `permissionHandler` wiring for Droid tool confirmations.
- `src/droid-state.ts` — `/droid-autonomy` command, autonomy level management, and footer status.
- `src/droid-session-cwd.ts` — session cwd tracking for Droid runs.
- `src/droid-bridge-contract.ts` — bridge contract text and MCP tool description builder for `pi__*` names.
- `src/droid-native-tool-display.ts` — display-only replay for Droid-native tool calls as `droid_read`/`droid_bash`/etc. mapped tool-use turns.
- `src/droid-tool-transcript.ts` — Droid tool name normalization, input/output summarization, todo formatting, and transcript rendering.
- `src/droid-fallback-models.generated.ts` — bundled Factory model catalog snapshot used when discovery fails.
- `src/context.ts` — pi message → Droid prompt conversion with context budgeting.
- `test/**/*.test.ts` — Vitest coverage.

## Validation

```bash
npm run typecheck
npm test
```

## Auth

Factory auth uses pi-native API-key resolution for provider `factory`: CLI `--api-key`, stored `~/.pi/agent/auth.json` from `/login`, then `FACTORY_API_KEY`. Requires `droid` on PATH (SDK spawns it).

## Env

- `PI_DROID_PI_TOOL_BRIDGE` — enable/disable pi tool bridge (default: enabled)
- `PI_DROID_EXPOSE_BUILTIN_TOOLS` — expose overlapping builtins through bridge
- `PI_DROID_PI_TOOL_BRIDGE_DEBUG` — scrubbed bridge diagnostics to stderr (default: off)
- `PI_DROID_AUTONOMY_LEVEL` — `off|low|medium|high` for Droid native tool autonomy (default: `high`)
- `PI_DROID_PERMISSION_PROMPTS` — route Droid-native permission requests through pi UI before autonomy fallback (default: off)
