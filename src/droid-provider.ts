import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type AssistantMessage,
	type ToolResultMessage,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	DroidMessageType,
	createSession,
	type DroidSession,
} from "@factory/droid-sdk";
import { buildDroidPrompt, estimateDroidPromptInputTokens } from "./context.js";
import { getDiscoveryApiKey, getDroidModelMetadata, mapPiThinkingToReasoningEffort } from "./model-discovery.js";
import { handleDroidAskUserRequest } from "./droid-ask-user.js";
import { handleDroidPermissionRequest, resolveDroidAutonomyLevel } from "./droid-permissions.js";
import {
	getRegisteredDroidPiToolBridge,
	type DroidPiBridgeToolRequest,
	type DroidPiToolBridgeRun,
} from "./droid-pi-tool-bridge.js";
import { DROID_PI_BRIDGE_MCP_TOOL_PREFIX } from "./droid-bridge-contract.js";
import { getDroidSessionCwd } from "./droid-session-cwd.js";
import {
	deleteDroidNativeToolDisplay,
	getDroidNativeToolDisplayArguments,
	getDroidNativeToolDisplayToolName,
	recordDroidNativeToolDisplay,
	type DroidNativeToolDisplayItem,
} from "./droid-native-tool-display.js";

const MISSING_API_KEY_MESSAGE =
	"Factory API key required. Use /login (Use an API key -> Factory), set FACTORY_API_KEY, or pass --api-key.";
const GENERIC_DROID_SDK_ERROR_MESSAGE =
	"Factory Droid SDK request failed. The API key may be missing, invalid, or unauthorized. Run /login -> Use an API key -> Factory, verify FACTORY_API_KEY, or pass --api-key, then retry.";
const AUTH_DROID_SDK_ERROR_MESSAGE =
	"Factory Droid SDK request failed because the API key may be invalid or unauthorized. Run /login -> Use an API key -> Factory, verify FACTORY_API_KEY, or pass --api-key, then retry.";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

class DroidAbortError extends Error {
	constructor() {
		super("Droid stream aborted");
		this.name = "DroidAbortError";
	}
}

type DroidStreamMessage = Awaited<ReturnType<DroidSession["stream"]>> extends AsyncGenerator<infer T> ? T : never;

interface PendingDroidNativeToolUse {
	droidToolUseId: string;
	toolName: string;
	input: Record<string, unknown>;
	progress: string[];
}

interface DroidLiveRun {
	id: string;
	session: DroidSession;
	bridgeRun?: DroidPiToolBridgeRun;
	iterator?: AsyncIterator<DroidStreamMessage>;
	done: boolean;
	disposed: boolean;
	waitingForBridge: boolean;
	waitingForNativeDisplay: boolean;
	nativeToolCounter: number;
	nativePiToolCallIds: Set<string>;
	nativeToolsByDroidId: Map<string, PendingDroidNativeToolUse>;
	queuedNativeToolDisplays: DroidNativeToolDisplayItem[];
	finalText?: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
	};
	waiters: Set<() => void>;
}

const pendingLiveRuns = new Map<string, DroidLiveRun>();
let liveRunCounter = 0;

function makeInitialMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { ...ZERO_COST },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function resolveFactoryApiKey(optionsApiKey?: string): string | undefined {
	const trimmed = optionsApiKey?.trim();
	if (trimmed && trimmed !== "FACTORY_API_KEY") return trimmed;
	if (trimmed === "FACTORY_API_KEY") return process.env.FACTORY_API_KEY?.trim() || undefined;
	return undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrubSensitiveText(text: string, apiKey?: string): string {
	let scrubbed = text;
	const trimmedKey = apiKey?.trim();
	if (trimmedKey) scrubbed = scrubbed.replace(new RegExp(escapeRegExp(trimmedKey), "g"), "[redacted]");
	return scrubbed
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/((?:^|[\s,{])cookie["']?\s*[:=]\s*["']?)[^\n]+/gi, "$1[redacted]")
		.replace(
			/((?:authorization|api[_-]?key|apiKey|token|session(?:[_-]?id)?)['"]?\s*[:=]\s*['"]?)[^"'\s,;}]+/gi,
			"$1[redacted]",
		)
		.trim();
}

function isGenericErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized === "" || normalized === "error" || normalized === "unknown error";
}

function isLikelyAuthError(message: string): boolean {
	return /\b(unauthorized|unauthorised|forbidden|invalid api key|invalid key|authentication|auth|401|403)\b/i.test(message);
}

function sanitizeError(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message === MISSING_API_KEY_MESSAGE) return MISSING_API_KEY_MESSAGE;
	const scrubbed = scrubSensitiveText(message, apiKey);
	if (isGenericErrorMessage(scrubbed)) return GENERIC_DROID_SDK_ERROR_MESSAGE;
	if (isLikelyAuthError(scrubbed)) return AUTH_DROID_SDK_ERROR_MESSAGE;
	return scrubbed || GENERIC_DROID_SDK_ERROR_MESSAGE;
}

function getDroidPromptOptions(model: Model<Api>): { maxInputTokens?: number } {
	const metadata = getDroidModelMetadata(model.id);
	const contextWindow = metadata?.contextWindow ?? model.contextWindow;
	const maxTokens = metadata?.maxTokens ?? model.maxTokens ?? 0;
	if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return {};
	return { maxInputTokens: Math.max(1, contextWindow - Math.max(0, maxTokens)) };
}

function getPendingLiveRun(context: Context): DroidLiveRun | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role !== "toolResult") break;
		for (const run of pendingLiveRuns.values()) {
			if (run.bridgeRun?.hasPendingPiToolCallId(message.toolCallId)) return run;
			if (run.nativePiToolCallIds.has(message.toolCallId)) return run;
		}
	}
	return undefined;
}

function toJsonObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringifyDroidContent(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function isDroidPiBridgeToolName(toolName: string): boolean {
	return toolName.startsWith(DROID_PI_BRIDGE_MCP_TOOL_PREFIX);
}

function createNativeToolDisplayItem(run: DroidLiveRun, msg: Extract<DroidStreamMessage, { type: typeof DroidMessageType.ToolResult }>): DroidNativeToolDisplayItem {
	const pending = run.nativeToolsByDroidId.get(msg.toolUseId);
	run.nativeToolsByDroidId.delete(msg.toolUseId);
	run.nativeToolCounter += 1;
	const piToolCallId = `${run.id}-native-tool-${run.nativeToolCounter}`;
	return {
		piToolCallId,
		droidToolUseId: msg.toolUseId,
		toolName: pending?.toolName ?? msg.toolName,
		input: pending?.input ?? {},
		progress: pending?.progress ?? [],
		content: stringifyDroidContent(msg.content),
		isError: msg.isError,
	};
}

function notifyRun(run: DroidLiveRun): void {
	for (const waiter of run.waiters) waiter();
	run.waiters.clear();
}

function applyUsage(
	partial: AssistantMessage,
	model: Model<Api>,
	promptInputTokens: number,
	usage?: DroidLiveRun["usage"],
): void {
	const input = usage?.inputTokens ?? promptInputTokens;
	const output = usage?.outputTokens ?? 0;
	partial.usage = {
		input,
		output,
		cacheRead: usage?.cacheReadTokens ?? 0,
		cacheWrite: usage?.cacheCreationTokens ?? 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	partial.model = model.id;
	partial.provider = model.provider;
	partial.api = model.api;
}

async function disposeLiveRun(run: DroidLiveRun): Promise<void> {
	if (run.disposed) return;
	run.disposed = true;
	pendingLiveRuns.delete(run.id);
	run.bridgeRun?.cancel("Droid live run disposed");
	for (const piToolCallId of run.nativePiToolCallIds) deleteDroidNativeToolDisplay(piToolCallId);
	try {
		await run.bridgeRun?.dispose();
	} catch {
		// ignore
	}
	try {
		await run.session.close();
	} catch {
		// ignore
	}
	notifyRun(run);
}

function emitNativeToolDisplayTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	promptInputTokens: number,
	run: DroidLiveRun,
	items: DroidNativeToolDisplayItem[],
): void {
	for (const item of items) {
		recordDroidNativeToolDisplay(item);
		run.nativePiToolCallIds.add(item.piToolCallId);
		const contentIndex = partial.content.length;
		const toolCall: ToolCall = {
			type: "toolCall",
			id: item.piToolCallId,
			name: getDroidNativeToolDisplayToolName(item.toolName),
			arguments: getDroidNativeToolDisplayArguments(item),
		};
		partial.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex, partial });
		stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial });
		stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
	}
	run.waitingForNativeDisplay = true;
	applyUsage(partial, model, promptInputTokens, run.usage);
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
}

function emitBridgeToolUseTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	promptInputTokens: number,
	run: DroidLiveRun,
	requests: DroidPiBridgeToolRequest[],
): void {
	for (const request of requests) {
		const contentIndex = partial.content.length;
		partial.content.push({
			type: "toolCall",
			id: request.piToolCallId,
			name: request.piToolName,
			arguments: request.args,
		});
		stream.push({ type: "toolcall_start", contentIndex, partial });
		stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(request.args), partial });
		const block = partial.content[contentIndex];
		if (block.type === "toolCall") {
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
		}
	}
	run.waitingForBridge = true;
	applyUsage(partial, model, promptInputTokens, run.usage);
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
}

interface TurnEmitState {
	thinkingContentIndex: number;
	textContentIndex: number;
}

function createTurnEmitState(): TurnEmitState {
	return { thinkingContentIndex: -1, textContentIndex: -1 };
}

function closeOpenBlocks(stream: AssistantMessageEventStream, partial: AssistantMessage, state: TurnEmitState): void {
	if (state.thinkingContentIndex >= 0) {
		const block = partial.content[state.thinkingContentIndex];
		if (block.type === "thinking") {
			stream.push({ type: "thinking_end", contentIndex: state.thinkingContentIndex, content: block.thinking, partial });
		}
		state.thinkingContentIndex = -1;
	}
	if (state.textContentIndex >= 0) {
		const block = partial.content[state.textContentIndex];
		if (block.type === "text") {
			stream.push({ type: "text_end", contentIndex: state.textContentIndex, content: block.text, partial });
		}
		state.textContentIndex = -1;
	}
}

function processStreamEvent(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	run: DroidLiveRun,
	state: TurnEmitState,
	msg: DroidStreamMessage,
): "continue" | "done" | "nativeTool" | "error" {
	if (msg.type === DroidMessageType.ThinkingTextDelta) {
		if (state.textContentIndex >= 0) {
			const block = partial.content[state.textContentIndex];
			if (block.type === "text") {
				stream.push({ type: "text_end", contentIndex: state.textContentIndex, content: block.text, partial });
			}
			state.textContentIndex = -1;
		}
		if (state.thinkingContentIndex < 0) {
			state.thinkingContentIndex = partial.content.length;
			partial.content.push({ type: "thinking", thinking: "" });
			stream.push({ type: "thinking_start", contentIndex: state.thinkingContentIndex, partial });
		}
		const block = partial.content[state.thinkingContentIndex];
		if (block.type === "thinking") {
			block.thinking += msg.text;
			stream.push({ type: "thinking_delta", contentIndex: state.thinkingContentIndex, delta: msg.text, partial });
		}
		return "continue";
	}

	if (msg.type === DroidMessageType.AssistantTextDelta) {
		if (state.thinkingContentIndex >= 0) {
			const block = partial.content[state.thinkingContentIndex];
			if (block.type === "thinking") {
				stream.push({ type: "thinking_end", contentIndex: state.thinkingContentIndex, content: block.thinking, partial });
			}
			state.thinkingContentIndex = -1;
		}
		if (state.textContentIndex < 0) {
			state.textContentIndex = partial.content.length;
			partial.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: state.textContentIndex, partial });
		}
		const block = partial.content[state.textContentIndex];
		if (block.type === "text") {
			block.text += msg.text;
			run.finalText = block.text;
			stream.push({ type: "text_delta", contentIndex: state.textContentIndex, delta: msg.text, partial });
		}
		return "continue";
	}

	if (msg.type === DroidMessageType.ToolUse) {
		if (isDroidPiBridgeToolName(msg.toolName)) return "continue";
		run.nativeToolsByDroidId.set(msg.toolUseId, {
			droidToolUseId: msg.toolUseId,
			toolName: msg.toolName,
			input: toJsonObject(msg.toolInput),
			progress: [],
		});
		return "continue";
	}

	if (msg.type === DroidMessageType.ToolProgress) {
		const pending = run.nativeToolsByDroidId.get(msg.toolUseId);
		if (pending && msg.content.trim()) pending.progress.push(msg.content);
		return "continue";
	}

	if (msg.type === DroidMessageType.ToolResult) {
		if (!run.nativeToolsByDroidId.has(msg.toolUseId) && isDroidPiBridgeToolName(msg.toolName)) return "continue";
		run.queuedNativeToolDisplays.push(createNativeToolDisplayItem(run, msg));
		return "nativeTool";
	}

	if (msg.type === DroidMessageType.TokenUsageUpdate) {
		run.usage = {
			inputTokens: msg.inputTokens,
			outputTokens: msg.outputTokens,
			cacheReadTokens: msg.cacheReadTokens,
			cacheCreationTokens: msg.cacheCreationTokens,
		};
		return "continue";
	}

	if (msg.type === DroidMessageType.TurnComplete) {
		run.done = true;
		if (msg.tokenUsage) {
			run.usage = {
				inputTokens: msg.tokenUsage.inputTokens,
				outputTokens: msg.tokenUsage.outputTokens,
				cacheReadTokens: msg.tokenUsage.cacheReadTokens,
				cacheCreationTokens: msg.tokenUsage.cacheCreationTokens,
			};
		}
		return "done";
	}

	if (msg.type === DroidMessageType.Error) {
		throw new Error(msg.message);
	}

	return "continue";
}

async function pumpLiveRun(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	run: DroidLiveRun,
	promptInputTokens: number,
	signal?: AbortSignal,
): Promise<"toolUse" | "stop" | "pending"> {
	if (!run.iterator) return "stop";
	const state = createTurnEmitState();

	while (true) {
		if (signal?.aborted) throw new DroidAbortError();
		const next = await run.iterator.next();
		if (next.done) break;

		const status = processStreamEvent(stream, partial, run, state, next.value);
		if (status === "done") {
			closeOpenBlocks(stream, partial, state);
			applyUsage(partial, model, promptInputTokens, run.usage);
			partial.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: partial });
			await disposeLiveRun(run);
			return "stop";
		}

		if (status === "nativeTool") {
			closeOpenBlocks(stream, partial, state);
			const nativeItems = run.queuedNativeToolDisplays.splice(0);
			emitNativeToolDisplayTurn(stream, partial, model, promptInputTokens, run, nativeItems);
			return "toolUse";
		}

		const bridgeRequests = run.bridgeRun?.takeQueuedToolRequests() ?? [];
		if (bridgeRequests.length > 0) {
			emitBridgeToolUseTurn(stream, partial, model, promptInputTokens, run, bridgeRequests);
			return "toolUse";
		}
	}

	if (run.done) {
		applyUsage(partial, model, promptInputTokens, run.usage);
		partial.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: partial });
		await disposeLiveRun(run);
		return "stop";
	}

	void context;
	return "pending";
}

async function resumePendingLiveRun(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	signal?: AbortSignal,
): Promise<boolean> {
	const run = getPendingLiveRun(context);
	if (!run || run.disposed) return false;

	const toolResults = context.messages.filter((message): message is ToolResultMessage => {
		return message.role === "toolResult" && (run.bridgeRun?.hasPendingPiToolCallId(message.toolCallId) ?? false);
	});
	run.bridgeRun?.resolveToolResults(toolResults);
	for (const message of context.messages) {
		if (message.role === "toolResult" && run.nativePiToolCallIds.has(message.toolCallId)) {
			run.nativePiToolCallIds.delete(message.toolCallId);
		}
	}
	run.waitingForBridge = false;
	run.waitingForNativeDisplay = false;

	const promptInputTokens = estimateDroidPromptInputTokens(buildDroidPrompt(context, getDroidPromptOptions(model)));
	await pumpLiveRun(stream, partial, model, context, run, promptInputTokens, signal);
	return true;
}

function toDroidImages(images: Array<{ data: string; mimeType: string }>) {
	const allowed = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
	return images
		.filter((image) => allowed.has(image.mimeType))
		.map((image) => ({
			type: "base64" as const,
			mediaType: image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
			data: image.data,
		}));
}

export function streamDroid(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const partial = makeInitialMessage(model);
		let bridgeRun: DroidPiToolBridgeRun | undefined;
		let liveRun: DroidLiveRun | undefined;
		let runApiKey: string | undefined;

		try {
			const throwIfAborted = (): void => {
				if (options?.signal?.aborted) throw new DroidAbortError();
			};

			stream.push({ type: "start", partial });
			throwIfAborted();

			if (await resumePendingLiveRun(stream, partial, model, context, options?.signal)) {
				stream.end();
				return;
			}

			const cliApiKey = resolveFactoryApiKey(options?.apiKey);
			const apiKey = cliApiKey ?? await getDiscoveryApiKey();
			runApiKey = apiKey;
			if (!apiKey) throw new Error(MISSING_API_KEY_MESSAGE);

			const cwd = getDroidSessionCwd();
			const reasoningEffort = mapPiThinkingToReasoningEffort(model.id, options?.reasoning ?? "off");
			const prompt = buildDroidPrompt(context, getDroidPromptOptions(model));
			const promptInputTokens = estimateDroidPromptInputTokens(prompt);

			const registeredBridge = getRegisteredDroidPiToolBridge();
			let activeLiveRun: DroidLiveRun | undefined;
			bridgeRun = registeredBridge
				? await registeredBridge.createRun({
						onToolRequest: () => {
							if (activeLiveRun) notifyRun(activeLiveRun);
						},
					})
				: undefined;

			const session = await createSession({
				modelId: model.id,
				cwd,
				reasoningEffort,
				autonomyLevel: resolveDroidAutonomyLevel(),
				mcpServers: bridgeRun?.enabled ? bridgeRun.mcpServers : undefined,
				env: { ...process.env, FACTORY_API_KEY: apiKey },
				permissionHandler: handleDroidPermissionRequest,
				askUserHandler: handleDroidAskUserRequest,
				abortSignal: options?.signal,
			});

			liveRunCounter += 1;
			liveRun = {
				id: `droid-live-${Date.now()}-${liveRunCounter}`,
				session,
				bridgeRun,
				done: false,
				disposed: false,
				waitingForBridge: false,
				waitingForNativeDisplay: false,
				nativeToolCounter: 0,
				nativePiToolCallIds: new Set(),
				nativeToolsByDroidId: new Map(),
				queuedNativeToolDisplays: [],
				waiters: new Set(),
			};
			activeLiveRun = liveRun;
			pendingLiveRuns.set(liveRun.id, liveRun);

			const images = toDroidImages(prompt.images);
			const generator = session.stream(prompt.text, {
				images: images.length > 0 ? images : undefined,
				abortSignal: options?.signal,
			});
			liveRun.iterator = generator[Symbol.asyncIterator]();

			await pumpLiveRun(stream, partial, model, context, liveRun, promptInputTokens, options?.signal);
		} catch (error) {
			if (liveRun) await disposeLiveRun(liveRun);
			else await bridgeRun?.dispose();

			if (error instanceof DroidAbortError) {
				partial.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: partial });
			} else {
				const message = sanitizeError(error, runApiKey ?? resolveFactoryApiKey(options?.apiKey));
				partial.stopReason = "error";
				if (partial.content.length === 0) {
					partial.content.push({ type: "text", text: message });
				}
				stream.push({ type: "error", reason: "error", error: partial });
			}
		} finally {
			stream.end();
		}
	})();

	return stream;
}

export const __testUtils = {
	pendingLiveRuns,
	disposeLiveRun,
	resolveFactoryApiKey,
	sanitizeError,
	getDroidPromptOptions,
};
