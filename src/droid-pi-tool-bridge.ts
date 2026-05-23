import { createHash, randomUUID } from "node:crypto";
import {
	createSdkMcpServer,
	tool,
	type DroidMcpServerConfig,
	type SdkMcpServer,
} from "@factory/droid-sdk";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionHandler,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolInfo,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { buildDroidPiBridgeMcpToolDescription, DROID_PI_BRIDGE_MCP_TOOL_PREFIX } from "./droid-bridge-contract.js";
import { isDroidNativeToolDisplayToolName } from "./droid-native-tool-display.js";

const DROID_PI_TOOL_BRIDGE_ENV = "PI_DROID_PI_TOOL_BRIDGE";
const DROID_PI_TOOL_BRIDGE_BUILTINS_ENV = "PI_DROID_EXPOSE_BUILTIN_TOOLS";
const DROID_PI_TOOL_BRIDGE_DEBUG_ENV = "PI_DROID_PI_TOOL_BRIDGE_DEBUG";
const DROID_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX = "[pi-droid-sdk:bridge]";
const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "none", "no", "disabled"]);
const ENABLED_ENV_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);
const OVERLAPPING_DROID_NATIVE_PI_BUILTIN_TOOL_NAMES = new Set(["read", "bash", "write", "edit", "grep", "find", "ls"]);

export interface DroidPiBridgeToolRequest {
	runId: string;
	bridgeCallId: string;
	piToolCallId: string;
	piToolName: string;
	mcpToolName: string;
	args: Record<string, unknown>;
}

export interface DroidPiToolBridgeRun {
	id: string;
	enabled: boolean;
	surfaceSignature: string;
	mcpServers: DroidMcpServerConfig[];
	sdkServer: SdkMcpServer;
	takeQueuedToolRequests(): DroidPiBridgeToolRequest[];
	resolveToolResults(toolResults: readonly ToolResultMessage[]): void;
	resolveToolResultsFromContext(context: Context): void;
	hasPendingPiToolCallId(piToolCallId: string): boolean;
	cancel(reason: string): void;
	dispose(): Promise<void>;
}

export interface DroidPiToolBridgeRunOptions {
	onToolRequest?: (request: DroidPiBridgeToolRequest) => void;
}

export interface DroidPiToolBridgeSnapshotEntry {
	piToolName: string;
	mcpToolName: string;
	description: string;
	inputSchema: unknown;
	toolInfo: ToolInfo;
}

export interface DroidPiToolBridgeSnapshot {
	tools: DroidPiToolBridgeSnapshotEntry[];
	mcpToolNameToPiToolName: Map<string, string>;
	piToolNameToMcpToolName: Map<string, string>;
}

export interface DroidPiToolBridge {
	isEnabled(): boolean;
	createRun(options?: DroidPiToolBridgeRunOptions): Promise<DroidPiToolBridgeRun>;
	disposeAll(reason?: string): Promise<void>;
}

type DroidPiToolBridgeSnapshotApi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools">;

interface DroidPiToolBridgeExtensionApi extends DroidPiToolBridgeSnapshotApi {
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
}

interface PendingBridgeCall {
	request: DroidPiBridgeToolRequest;
	resolve: (result: string) => void;
	reject: (error: Error) => void;
	settled: boolean;
}

function resolveEnvFlag(value: string | undefined, defaultEnabled: boolean): boolean {
	if (!value) return defaultEnabled;
	const normalized = value.trim().toLowerCase();
	if (DISABLED_ENV_VALUES.has(normalized)) return false;
	if (ENABLED_ENV_VALUES.has(normalized)) return true;
	return defaultEnabled;
}

export function resolveDroidPiToolBridgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return resolveEnvFlag(env[DROID_PI_TOOL_BRIDGE_ENV], true);
}

function resolveExposeOverlappingBuiltins(env: Record<string, string | undefined> = process.env): boolean {
	return resolveEnvFlag(env[DROID_PI_TOOL_BRIDGE_BUILTINS_ENV], false);
}

function resolveBridgeDiagnosticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return resolveEnvFlag(env[DROID_PI_TOOL_BRIDGE_DEBUG_ENV], false);
}

function emitBridgeDiagnostic(env: Record<string, string | undefined>, event: Record<string, unknown>): void {
	if (!resolveBridgeDiagnosticsEnabled(env)) return;
	const safeEvent = Object.fromEntries(
		Object.entries(event).filter(([, value]) => value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)),
	);
	process.stderr.write(`${DROID_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX} ${JSON.stringify(safeEvent)}\n`);
}

function stableNameSuffix(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function toMcpToolName(piToolName: string): string {
	const sanitized = piToolName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "tool";
	return `${DROID_PI_BRIDGE_MCP_TOOL_PREFIX}${sanitized}`;
}

function dedupeMcpToolName(baseName: string, piToolName: string, usedNames: Set<string>): string {
	if (!usedNames.has(baseName)) {
		usedNames.add(baseName);
		return baseName;
	}
	const suffix = stableNameSuffix(piToolName);
	let candidate = `${baseName}__${suffix}`;
	let counter = 2;
	while (usedNames.has(candidate)) {
		candidate = `${baseName}__${suffix}_${counter}`;
		counter += 1;
	}
	usedNames.add(candidate);
	return candidate;
}

function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
	const properties = schema.properties;
	if (!properties || typeof properties !== "object") return {};
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
		shape[key] = z.any().describe(typeof value === "object" && value && "description" in value ? String((value as { description?: string }).description ?? key) : key);
	}
	return shape;
}

function toolResultToText(toolResult: ToolResultMessage): string {
	return typeof toolResult.content === "string"
		? toolResult.content
		: toolResult.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
}

function toolResultEventToMessage(event: ToolResultEvent): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		content: event.content,
		isError: event.isError,
		timestamp: Date.now(),
	};
}

export function buildDroidPiToolBridgeSnapshot(
	pi: DroidPiToolBridgeSnapshotApi,
	options: { exposeOverlappingBuiltins?: boolean } = {},
): DroidPiToolBridgeSnapshot {
	const active = new Set(pi.getActiveTools());
	const exposeBuiltins = options.exposeOverlappingBuiltins ?? resolveExposeOverlappingBuiltins();
	const usedMcpToolNames = new Set<string>();
	const mcpToolNameToPiToolName = new Map<string, string>();
	const piToolNameToMcpToolName = new Map<string, string>();
	const tools: DroidPiToolBridgeSnapshotEntry[] = [];

	for (const toolInfo of pi.getAllTools()) {
		if (!active.has(toolInfo.name)) continue;
		if (isDroidNativeToolDisplayToolName(toolInfo.name)) continue;
		if (toolInfo.name.startsWith(DROID_PI_BRIDGE_MCP_TOOL_PREFIX)) continue;
		if (!exposeBuiltins && OVERLAPPING_DROID_NATIVE_PI_BUILTIN_TOOL_NAMES.has(toolInfo.name)) continue;

		const mcpToolName = dedupeMcpToolName(toMcpToolName(toolInfo.name), toolInfo.name, usedMcpToolNames);
		mcpToolNameToPiToolName.set(mcpToolName, toolInfo.name);
		piToolNameToMcpToolName.set(toolInfo.name, mcpToolName);
		tools.push({
			piToolName: toolInfo.name,
			mcpToolName,
			description: toolInfo.description,
			inputSchema: toolInfo.parameters,
			toolInfo,
		});
	}

	return { tools, mcpToolNameToPiToolName, piToolNameToMcpToolName };
}

export function buildDroidPiToolBridgeSurfaceSignature(snapshot: DroidPiToolBridgeSnapshot): string {
	const material = snapshot.tools.map((entry) => ({
		piToolName: entry.piToolName,
		mcpToolName: entry.mcpToolName,
		description: entry.description,
		inputSchema: entry.inputSchema,
	}));
	return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

class DroidPiToolBridgeRunImpl implements DroidPiToolBridgeRun {
	readonly id = randomUUID();
	readonly enabled: boolean;
	readonly surfaceSignature: string;
	readonly sdkServer: SdkMcpServer;
	readonly mcpServers: DroidMcpServerConfig[];
	private readonly onToolRequest?: (request: DroidPiBridgeToolRequest) => void;
	private readonly env: Record<string, string | undefined>;
	private readonly pendingByPiToolCallId = new Map<string, PendingBridgeCall>();
	private readonly queuedRequests: DroidPiBridgeToolRequest[] = [];
	private readonly mcpToolNameToPiToolName = new Map<string, string>();
	private disposed = false;
	private toolCallCounter = 0;

	constructor(options: {
		enabled: boolean;
		snapshot: DroidPiToolBridgeSnapshot;
		env: Record<string, string | undefined>;
		onToolRequest?: (request: DroidPiBridgeToolRequest) => void;
	}) {
		this.enabled = options.enabled;
		this.surfaceSignature = buildDroidPiToolBridgeSurfaceSignature(options.snapshot);
		this.onToolRequest = options.onToolRequest;
		this.env = options.env;

		const droidTools = options.snapshot.tools.map((snapshotTool) => {
			this.mcpToolNameToPiToolName.set(snapshotTool.mcpToolName, snapshotTool.piToolName);
			const inputSchema = jsonSchemaToZodShape(snapshotTool.inputSchema as Record<string, unknown>);
			return tool(
				snapshotTool.mcpToolName,
				buildDroidPiBridgeMcpToolDescription({
					piToolName: snapshotTool.piToolName,
					mcpToolName: snapshotTool.mcpToolName,
					piToolDescription: snapshotTool.description,
				}),
				inputSchema,
				(input) => this.enqueueToolRequest(snapshotTool.mcpToolName, snapshotTool.piToolName, input),
			);
		});

		this.sdkServer = createSdkMcpServer({ name: "pi_tools", tools: droidTools });
		this.mcpServers = [this.sdkServer];
		emitBridgeDiagnostic(this.env, {
			event: "run_created",
			runId: this.id,
			enabled: this.enabled,
			exposedToolCount: droidTools.length,
			surfaceSignature: this.surfaceSignature,
		});
	}

	takeQueuedToolRequests(): DroidPiBridgeToolRequest[] {
		const requests = [...this.queuedRequests];
		this.queuedRequests.length = 0;
		return requests;
	}

	resolveToolResults(toolResults: readonly ToolResultMessage[]): void {
		for (const toolResult of toolResults) {
			const pending = this.pendingByPiToolCallId.get(toolResult.toolCallId);
			if (!pending || pending.settled) continue;
			pending.settled = true;
			this.pendingByPiToolCallId.delete(toolResult.toolCallId);
			emitBridgeDiagnostic(this.env, {
				event: "request_resolved",
				runId: this.id,
				piToolCallId: toolResult.toolCallId,
				piToolName: toolResult.toolName,
				isError: toolResult.isError === true,
				pendingCount: this.pendingByPiToolCallId.size,
			});
			pending.resolve(toolResultToText(toolResult));
		}
	}

	resolveToolResultsFromContext(context: Context): void {
		const pendingIds = new Set(this.pendingByPiToolCallId.keys());
		if (pendingIds.size === 0) return;
		const toolResults = context.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && pendingIds.has(message.toolCallId),
		);
		this.resolveToolResults(toolResults);
	}

	hasPendingPiToolCallId(piToolCallId: string): boolean {
		return this.pendingByPiToolCallId.has(piToolCallId);
	}

	cancel(reason: string): void {
		const error = new Error(reason);
		this.queuedRequests.length = 0;
		for (const pending of [...this.pendingByPiToolCallId.values()]) {
			if (pending.settled) continue;
			pending.settled = true;
			pending.reject(error);
		}
		this.pendingByPiToolCallId.clear();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel("Droid pi tool bridge run disposed");
		await this.sdkServer.close();
		emitBridgeDiagnostic(this.env, {
			event: "run_disposed",
			runId: this.id,
			enabled: this.enabled,
			pendingCount: this.pendingByPiToolCallId.size,
		});
	}

	private enqueueToolRequest(mcpToolName: string, piToolName: string, args: Record<string, unknown>): Promise<string> {
		if (this.disposed) return Promise.reject(new Error("Droid pi tool bridge run is disposed"));

		this.toolCallCounter += 1;
		const request: DroidPiBridgeToolRequest = {
			runId: this.id,
			bridgeCallId: `${this.id}-bridge-${this.toolCallCounter}`,
			piToolCallId: `${this.id}-tool-${this.toolCallCounter}`,
			piToolName,
			mcpToolName,
			args,
		};

		return new Promise<string>((resolve, reject) => {
			const pending: PendingBridgeCall = { request, resolve, reject, settled: false };
			this.pendingByPiToolCallId.set(request.piToolCallId, pending);
			emitBridgeDiagnostic(this.env, {
				event: "request_queued",
				runId: this.id,
				bridgeCallId: request.bridgeCallId,
				piToolCallId: request.piToolCallId,
				mcpToolName,
				piToolName,
				pendingCount: this.pendingByPiToolCallId.size,
			});
			if (this.onToolRequest) {
				this.onToolRequest(request);
			} else {
				this.queuedRequests.push(request);
			}
		});
	}
}

class DroidPiToolBridgeRegistry implements DroidPiToolBridge {
	private readonly pi: DroidPiToolBridgeSnapshotApi;
	private readonly env: Record<string, string | undefined>;
	private readonly runs = new Set<DroidPiToolBridgeRunImpl>();

	constructor(pi: DroidPiToolBridgeExtensionApi, env: Record<string, string | undefined> = process.env) {
		this.pi = pi;
		this.env = env;

		pi.on("tool_result", async (event) => {
			const toolResult = toolResultEventToMessage(event);
			for (const run of this.runs) {
				run.resolveToolResults([toolResult]);
			}
		});

		pi.on("session_shutdown", async () => {
			await this.disposeAll("pi session shutdown");
		});
	}

	isEnabled(): boolean {
		return resolveDroidPiToolBridgeEnabled(this.env);
	}

	private buildSnapshot(): DroidPiToolBridgeSnapshot {
		return buildDroidPiToolBridgeSnapshot(this.pi, {
			exposeOverlappingBuiltins: resolveExposeOverlappingBuiltins(this.env),
		});
	}

	async createRun(options: DroidPiToolBridgeRunOptions = {}): Promise<DroidPiToolBridgeRun> {
		const enabled = this.isEnabled();
		const snapshot = enabled
			? this.buildSnapshot()
			: { tools: [], mcpToolNameToPiToolName: new Map(), piToolNameToMcpToolName: new Map() };
		const run = new DroidPiToolBridgeRunImpl({
			enabled: enabled && snapshot.tools.length > 0,
			snapshot,
			env: this.env,
			onToolRequest: options.onToolRequest,
		});
		this.runs.add(run);
		return run;
	}

	async disposeAll(reason = "dispose all"): Promise<void> {
		await Promise.all([...this.runs].map((run) => run.dispose()));
		this.runs.clear();
	}
}

let registeredBridge: DroidPiToolBridge | undefined;

export function getRegisteredDroidPiToolBridge(): DroidPiToolBridge | undefined {
	return registeredBridge;
}

export function registerDroidPiToolBridge(pi: DroidPiToolBridgeExtensionApi): void {
	registeredBridge = new DroidPiToolBridgeRegistry(pi);
}

export const __testUtils = {
	DROID_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX,
	resolveDroidPiToolBridgeEnabled,
	resolveExposeOverlappingBuiltins,
	resolveBridgeDiagnosticsEnabled,
	toMcpToolName,
	createRegistry(pi: DroidPiToolBridgeExtensionApi, env: Record<string, string | undefined> = process.env): DroidPiToolBridge {
		return new DroidPiToolBridgeRegistry(pi, env);
	},
	async resetRegisteredBridgeForTests(): Promise<void> {
		await registeredBridge?.disposeAll("test reset");
		registeredBridge = undefined;
	},
};
