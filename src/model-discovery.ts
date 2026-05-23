import { createSession } from "@factory/droid-sdk";
import type { AvailableModelConfig } from "@factory/droid-sdk";
import { AuthStorage, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { ReasoningEffort } from "@factory/droid-sdk";
import { FALLBACK_MODEL_ITEMS } from "./droid-fallback-models.generated.js";
import { scrubSensitiveText } from "./redaction.js";

const FACTORY_PROVIDER_ID = "factory";
const FACTORY_API_KEY_ENV_VAR = "FACTORY_API_KEY";
const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const AUTH_SETUP_HINT = "/login (Use an API key -> Factory), FACTORY_API_KEY, or --api-key";
const CATALOG_REFRESH_HINT =
	"After adding auth to an already-started pi session, run /droid-refresh-models to refresh the live Factory model catalog without restarting pi.";

export type DroidModelFallbackReason = "missing-api-key" | "discovery-failed" | "empty-model-list" | "droid-missing";

export interface DroidModelFallbackIssue {
	reason: DroidModelFallbackReason;
	message: string;
	errorMessage?: string;
}

export interface DiscoverModelsOptions {
	onFallback?: (issue: DroidModelFallbackIssue) => void;
}

export interface DroidModelMetadata {
	piModelId: string;
	baseModelId: string;
	displayName: string;
	supportsReasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	defaultReasoningEffort: ReasoningEffort;
	supportedReasoningEfforts: ReasoningEffort[];
	contextWindow: number;
	maxTokens: number;
	noImageSupport: boolean;
	isCustom: boolean;
	tokenMultiplier?: number;
}

const metadataByPiModelId = new Map<string, DroidModelMetadata>();

function getCliApiKeyFromArgv(argv: string[] = process.argv): string | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--api-key") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) return undefined;
			const trimmed = value.trim();
			return trimmed || undefined;
		}
		const prefix = "--api-key=";
		if (arg.startsWith(prefix)) {
			const trimmed = arg.slice(prefix.length).trim();
			return trimmed || undefined;
		}
	}
	return undefined;
}

function normalizeApiKey(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (trimmed === FACTORY_API_KEY_ENV_VAR) return process.env.FACTORY_API_KEY?.trim() || undefined;
	return trimmed;
}

async function getStoredFactoryApiKey(): Promise<string | undefined> {
	try {
		return normalizeApiKey(await AuthStorage.create().getApiKey(FACTORY_PROVIDER_ID, { includeFallback: false }));
	} catch {
		return undefined;
	}
}

export async function getDiscoveryApiKey(): Promise<string | undefined> {
	const cliApiKey = normalizeApiKey(getCliApiKeyFromArgv());
	if (cliApiKey) return cliApiKey;

	const storedApiKey = await getStoredFactoryApiKey();
	if (storedApiKey) return storedApiKey;

	return normalizeApiKey(process.env.FACTORY_API_KEY);
}

function mapReasoningEffortToPiLevel(effort: ReasoningEffort): ModelThinkingLevel | null {
	switch (effort) {
		case ReasoningEffort.Off:
		case ReasoningEffort.None:
			return "off";
		case ReasoningEffort.Minimal:
			return "minimal";
		case ReasoningEffort.Low:
			return "low";
		case ReasoningEffort.Medium:
			return "medium";
		case ReasoningEffort.High:
			return "high";
		case ReasoningEffort.ExtraHigh:
			return "xhigh";
		case ReasoningEffort.Max:
			return "xhigh";
		default:
			return null;
	}
}

function buildThinkingLevelMap(supported: ReasoningEffort[]): ThinkingLevelMap | undefined {
	const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
	for (const effort of supported) {
		const level = mapReasoningEffortToPiLevel(effort);
		if (level) map[level] = effort;
	}
	if (Object.keys(map).length === 0) return undefined;
	return {
		off: map.off ?? null,
		minimal: map.minimal ?? null,
		low: map.low ?? null,
		medium: map.medium ?? null,
		high: map.high ?? null,
		xhigh: map.xhigh ?? null,
	};
}

function getNumericField(item: object, fieldNames: string[]): number | undefined {
	const record = item as Record<string, unknown>;
	for (const fieldName of fieldNames) {
		const value = record[fieldName];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
		if (typeof value === "string") {
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
		}
	}
	return undefined;
}

function getStringField(item: object, fieldNames: string[]): string | undefined {
	const record = item as Record<string, unknown>;
	for (const fieldName of fieldNames) {
		const value = record[fieldName];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function toMetadata(item: AvailableModelConfig): DroidModelMetadata {
	const baseModelId = item.modelId ?? item.id;
	const thinkingLevelMap = buildThinkingLevelMap(item.supportedReasoningEfforts);
	const contextWindow = getNumericField(item, ["contextWindow", "context_window", "maxInputTokens", "max_input_tokens"])
		?? FALLBACK_CONTEXT_WINDOW;
	const maxTokens = getNumericField(item, ["maxTokens", "maxOutputTokens", "max_output_tokens"])
		?? FALLBACK_MAX_TOKENS;
	return {
		piModelId: baseModelId,
		baseModelId,
		displayName: item.displayName || getStringField(item, ["shortDisplayName", "name"]) || baseModelId,
		supportsReasoning: thinkingLevelMap !== undefined,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		defaultReasoningEffort: item.defaultReasoningEffort,
		supportedReasoningEfforts: item.supportedReasoningEfforts,
		contextWindow,
		maxTokens,
		noImageSupport: item.noImageSupport === true,
		isCustom: item.isCustom === true,
		...(item.tokenMultiplier !== undefined ? { tokenMultiplier: item.tokenMultiplier } : {}),
	};
}

function toProviderModelConfig(metadata: DroidModelMetadata): ProviderModelConfig {
	const input: ProviderModelConfig["input"] = metadata.noImageSupport ? ["text"] : ["text", "image"];
	return {
		id: metadata.piModelId,
		name: metadata.displayName,
		api: "droid-sdk",
		reasoning: metadata.supportsReasoning,
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: metadata.thinkingLevelMap } : {}),
		input,
		cost: ZERO_COST,
		contextWindow: metadata.contextWindow,
		maxTokens: metadata.maxTokens,
	};
}

function registerMetadata(entries: DroidModelMetadata[]): ProviderModelConfig[] {
	metadataByPiModelId.clear();
	const models: ProviderModelConfig[] = [];
	const usedIds = new Set<string>();
	for (const entry of entries) {
		if (!entry.piModelId || usedIds.has(entry.piModelId)) continue;
		usedIds.add(entry.piModelId);
		metadataByPiModelId.set(entry.piModelId, entry);
		models.push(toProviderModelConfig(entry));
	}
	models.sort((a, b) => a.name.localeCompare(b.name));
	return models;
}

function fallbackMetadataFromSnapshot(): DroidModelMetadata[] {
	return FALLBACK_MODEL_ITEMS.map((item) => ({
		piModelId: item.id,
		baseModelId: item.id,
		displayName: item.displayName,
		supportsReasoning: item.supportsReasoning,
		...(item.thinkingLevelMap ? { thinkingLevelMap: item.thinkingLevelMap } : {}),
		defaultReasoningEffort: item.defaultReasoningEffort,
		supportedReasoningEfforts: item.supportedReasoningEfforts,
		contextWindow: FALLBACK_CONTEXT_WINDOW,
		maxTokens: FALLBACK_MAX_TOKENS,
		noImageSupport: item.noImageSupport === true,
		isCustom: item.isCustom === true,
		...(item.tokenMultiplier !== undefined ? { tokenMultiplier: item.tokenMultiplier } : {}),
	}));
}

export function getDroidModelMetadata(modelId: string): DroidModelMetadata | undefined {
	return metadataByPiModelId.get(modelId);
}

export function getDroidModelMetadataEntries(): DroidModelMetadata[] {
	return [...metadataByPiModelId.values()];
}

export function mapPiThinkingToReasoningEffort(modelId: string, level: ModelThinkingLevel): ReasoningEffort {
	const metadata = getDroidModelMetadata(modelId);
	if (!metadata?.thinkingLevelMap) return ReasoningEffort.Off;
	const mapped = metadata.thinkingLevelMap[level];
	if (mapped && Object.values(ReasoningEffort).includes(mapped as ReasoningEffort)) {
		return mapped as ReasoningEffort;
	}
	if (level === "off") {
		return metadata.supportedReasoningEfforts.includes(ReasoningEffort.Off)
			? ReasoningEffort.Off
			: metadata.supportedReasoningEfforts.includes(ReasoningEffort.None)
				? ReasoningEffort.None
				: metadata.defaultReasoningEffort;
	}
	return metadata.defaultReasoningEffort;
}

function missingApiKeyIssue(): DroidModelFallbackIssue {
	return {
		reason: "missing-api-key",
		message: [
			`Factory model catalog unavailable: set auth via ${AUTH_SETUP_HINT}.`,
			"Using bundled fallback models until auth is configured.",
			CATALOG_REFRESH_HINT,
		].join(" "),
	};
}

function scrubDiscoveryErrorText(text: string, apiKey?: string): string {
	return scrubSensitiveText(text, apiKey);
}

function discoveryFailedIssue(error: unknown, apiKey?: string): DroidModelFallbackIssue {
	const rawErrorMessage = error instanceof Error ? error.message : String(error);
	const errorMessage = scrubDiscoveryErrorText(rawErrorMessage, apiKey) || "unknown error";
	const reason: DroidModelFallbackReason = rawErrorMessage.includes("ENOENT") || rawErrorMessage.includes("spawn")
		? "droid-missing"
		: "discovery-failed";
	return {
		reason,
		message: [
			reason === "droid-missing"
				? "Factory model catalog unavailable: `droid` CLI not found on PATH. Install from https://docs.factory.ai/cli/getting-started/quickstart"
				: "Factory model catalog discovery failed; using bundled fallback models.",
			CATALOG_REFRESH_HINT,
		].join(" "),
		errorMessage,
	};
}

export async function discoverModels(options: DiscoverModelsOptions = {}): Promise<ProviderModelConfig[]> {
	const apiKey = await getDiscoveryApiKey();
	if (!apiKey) {
		options.onFallback?.(missingApiKeyIssue());
		return registerMetadata(fallbackMetadataFromSnapshot());
	}

	try {
		const session = await createSession({
			modelId: FALLBACK_MODEL_ITEMS[0]?.id ?? "kimi-k2.5",
			cwd: process.cwd(),
			env: { ...process.env, FACTORY_API_KEY: apiKey },
		});
		try {
			const available = session.initResult.availableModels ?? [];
			if (available.length === 0) {
				options.onFallback?.({
					reason: "empty-model-list",
					message: `Factory returned an empty model list. Using bundled fallback models. ${CATALOG_REFRESH_HINT}`,
				});
				return registerMetadata(fallbackMetadataFromSnapshot());
			}
			return registerMetadata(available.map(toMetadata));
		} finally {
			await session.close();
		}
	} catch (error) {
		options.onFallback?.(discoveryFailedIssue(error, apiKey));
		return registerMetadata(fallbackMetadataFromSnapshot());
	}
}

export const __testUtils = {
	registerMetadata,
	clearMetadata: () => metadataByPiModelId.clear(),
	scrubDiscoveryErrorText,
};
