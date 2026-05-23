import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DroidMessageType, ReasoningEffort, createSession } from "@factory/droid-sdk";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { streamDroid, __testUtils as providerTestUtils } from "../src/droid-provider.js";
import { __testUtils as bridgeTestUtils } from "../src/droid-pi-tool-bridge.js";
import { getDroidNativeToolDisplayToolName } from "../src/droid-native-tool-display.js";

vi.mock("@factory/droid-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@factory/droid-sdk")>();
	return {
		...actual,
		createSession: vi.fn(),
	};
});

const mockedCreateSession = vi.mocked(createSession);

function makeModel(): Model<"droid-sdk"> {
	return {
		id: "kimi-k2.5",
		name: "Kimi K2.5",
		api: "droid-sdk",
		provider: "factory",
		baseUrl: "https://factory.ai",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "Be helpful.",
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	};
}

async function collectEvents(stream: ReturnType<typeof streamDroid>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("streamDroid", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		await bridgeTestUtils.resetRegisteredBridgeForTests();
	});

	afterEach(async () => {
		await Promise.all([...providerTestUtils.pendingLiveRuns.values()].map((run) => providerTestUtils.disposeLiveRun(run)));
		await bridgeTestUtils.resetRegisteredBridgeForTests();
	});

	it("emits text deltas and applies Droid token usage", async () => {
		mockedCreateSession.mockResolvedValue({
			stream: vi.fn(async function* () {
				yield { type: DroidMessageType.AssistantTextDelta, text: "Hello " };
				yield { type: DroidMessageType.AssistantTextDelta, text: "world" };
				yield {
					type: DroidMessageType.TurnComplete,
					tokenUsage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheCreationTokens: 2 },
				};
			}),
			close: vi.fn(),
		} as never);

		const events = await collectEvents(streamDroid(makeModel(), makeContext(), { apiKey: "factory-test-key" }));

		expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("")).toBe("Hello world");
		const done = events.find((event) => event.type === "done");
		expect(done?.message.usage).toEqual(expect.objectContaining({
			input: 11,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 18,
		}));
		expect(mockedCreateSession).toHaveBeenCalledWith(expect.objectContaining({
			modelId: "kimi-k2.5",
			reasoningEffort: ReasoningEffort.Off,
			env: expect.objectContaining({ FACTORY_API_KEY: "factory-test-key" }),
		}));
	});

	it("emits Droid-native tool calls as display-only pi tool turns", async () => {
		mockedCreateSession.mockResolvedValue({
			stream: vi.fn(async function* () {
				yield {
					type: DroidMessageType.ToolUse,
					toolUseId: "tool-1",
					toolName: "Read",
					toolInput: { filePath: "README.md" },
				};
				yield { type: DroidMessageType.ToolProgress, toolUseId: "tool-1", content: "opening README.md" };
				yield {
					type: DroidMessageType.ToolResult,
					toolUseId: "tool-1",
					toolName: "Read",
					content: "file content",
					isError: false,
				};
			}),
			close: vi.fn(),
		} as never);

		const events = await collectEvents(streamDroid(makeModel(), makeContext(), { apiKey: "factory-test-key" }));
		const toolCallEnd = events.find((event) => event.type === "toolcall_end");

		expect(toolCallEnd?.toolCall.name).toBe(getDroidNativeToolDisplayToolName("Read"));
		expect(toolCallEnd?.toolCall.arguments).toEqual({
			path: "README.md",
			offset: undefined,
			limit: undefined,
			droidToolName: "Read",
			droidToolUseId: "tool-1",
		});
		expect(events.find((event) => event.type === "done")?.reason).toBe("toolUse");
	});

	it("scrubs sensitive values from provider errors", () => {
		const authorizationError = providerTestUtils.sanitizeError("Authorization: Bearer secret-token", "factory-test-key");
		expect(authorizationError).toContain("[redacted]");
		expect(authorizationError).not.toContain("secret-token");
		expect(providerTestUtils.sanitizeError("bad factory-test-key", "factory-test-key")).toBe("bad [redacted]");
	});
});
