import { describe, it, expect } from "vitest";
import { __testUtils } from "../src/droid-pi-tool-bridge.js";
import { __testUtils as displayTestUtils } from "../src/droid-native-tool-display.js";
import { buildDroidPrompt } from "../src/context.js";
import type { Context } from "@earendil-works/pi-ai";

describe("droid-pi-tool-bridge", () => {
	it("is enabled by default", () => {
		expect(__testUtils.resolveDroidPiToolBridgeEnabled({})).toBe(true);
	});

	it("keeps bridge diagnostics opt-in", () => {
		expect(__testUtils.resolveBridgeDiagnosticsEnabled({})).toBe(false);
		expect(__testUtils.resolveBridgeDiagnosticsEnabled({ PI_DROID_PI_TOOL_BRIDGE_DEBUG: "1" })).toBe(true);
	});

	it("prefixes bridged tool names", () => {
		expect(__testUtils.toMcpToolName("grep")).toBe("pi__grep");
	});
});

describe("droid-native-tool-display", () => {
	it("summarizes native tool progress and result", () => {
		expect(displayTestUtils.summarizeResult({
			piToolCallId: "pi-1",
			droidToolUseId: "droid-1",
			toolName: "Read",
			input: { filePath: "README.md" },
			progress: ["opening README.md"],
			content: "done",
			isError: false,
		})).toContain("[progress] opening README.md\ndone");
	});

	it("renders native todo updates with status icons", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = displayTestUtils.renderDroidToolResult({
			piToolCallId: "pi-1",
			droidToolUseId: "droid-1",
			toolName: "TodoWrite",
			input: { todos: "1. [completed] Done\n2. [in_progress] Doing\n3. [pending] Later" },
			progress: [],
			content: "TODO List Updated",
			isError: false,
		}, "", false, theme).render(120).join("\n");
		expect(rendered).toContain("droid todo 1/3 completed, 1 in progress, 1 pending");
		expect(rendered).toContain("✓ Done (completed)");
		expect(rendered).toContain("… Doing (in progress)");
		expect(rendered).toContain("○ Later (pending)");
		expect(rendered).not.toContain("[in_progress]");
	});

	it("renders native tool calls only while partial to avoid duplicate final titles", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		expect(displayTestUtils.renderDroidToolCall("droid_read", { droidToolName: "Read", path: "README.md" }, true, theme).render(120).join("\n"))
			.toContain("droid read README.md");
		expect(displayTestUtils.renderDroidToolCall("droid_read", { droidToolName: "Read", path: "README.md" }, false, theme).render(120).join("\n"))
			.toBe("");
	});

	it("renders git diff bash output as colored numbered diff", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = displayTestUtils.renderDroidToolResult({
			piToolCallId: "pi-1",
			droidToolUseId: "droid-1",
			toolName: "Execute",
			input: { command: `git -C "${process.cwd()}" diff -- README.md` },
			progress: [],
			content: "diff --git a/README.md b/README.md\nindex 111..222 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,4 @@\n # title\n-old\n+new\n+extra",
			isError: false,
		}, "", false, theme).render(160).join("\n");
		expect(rendered).toContain('droid bash git -C "." diff -- README.md added 2 lines, removed 1 line');
		expect(rendered).toContain(" 1 # title");
		expect(rendered).toContain("-2 old");
		expect(rendered).toContain("+2 new");
		expect(rendered).toContain("+3 extra");
		expect(rendered).not.toContain(process.cwd());
	});

	it("renders Droid grep results as compact match lists", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = displayTestUtils.renderDroidToolResult({
			piToolCallId: "pi-1",
			droidToolUseId: "droid-1",
			toolName: "Grep",
			input: { pattern: "registerTool", path: `${process.cwd()}/src` },
			progress: [],
			content: `./droid-native-tool-display.ts:12:registerTool\n./droid-provider.ts:3:registerTool`,
			isError: false,
		}, "", false, theme).render(160).join("\n");
		expect(rendered).toContain('droid grep "registerTool" in src 2 matches');
		expect(rendered).toContain("droid-native-tool-display.ts:12:registerTool");
		expect(rendered).not.toContain(process.cwd());
	});

	it("renders Droid ApplyPatch result diffs like Cursor edit cards", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = displayTestUtils.renderDroidToolResult({
			piToolCallId: "pi-1",
			droidToolUseId: "droid-1",
			toolName: "ApplyPatch",
			input: { input: "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch" },
			progress: [],
			content: JSON.stringify({
				success: true,
				file_path: `${process.cwd()}/README.md`,
				display_operation: "update",
				diff: "--- previous\t\n+++ current\t\n@@ -10,3 +10,3 @@\n context\n-old\n+new",
			}),
			isError: false,
		}, "", false, theme).render(120).join("\n");
		expect(rendered).toContain("droid edit README.md added 1 line, removed 1 line");
		expect(rendered).toContain(" 10 context");
		expect(rendered).toContain("-11 old");
		expect(rendered).toContain("+11 new");
		expect(rendered).not.toContain("*** Begin Patch");
		expect(rendered).not.toContain('"diff"');
	});

	it("renders Droid edit JSON diff results like pi edit cards", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = displayTestUtils.renderDroidToolResult({
			piToolCallId: "pi-1",
			droidToolUseId: "droid-1",
			toolName: "Edit",
			input: {},
			progress: [],
			content: JSON.stringify({
				success: true,
				file_path: `${process.cwd()}/README.md`,
				diffLines: [
					{ type: "unchanged", content: "before", lineNumber: { old: 9, new: 9 } },
					{ type: "removed", content: "old", lineNumber: { old: 10 } },
					{ type: "added", content: "new", lineNumber: { new: 10 } },
				],
			}),
			isError: false,
		}, "", false, theme).render(120).join("\n");
		expect(rendered).toContain("droid edit README.md added 1 line, removed 1 line");
		expect(rendered).toContain("-10 old");
		expect(rendered).toContain("+10 new");
		expect(rendered).not.toContain('"diffLines"');
	});

	it("collapses long native tool result rendering", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = displayTestUtils.renderDroidToolResult({
			piToolCallId: "pi-1",
			droidToolUseId: "droid-1",
			toolName: "Read",
			input: { filePath: "README.md" },
			progress: [],
			content: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
			isError: false,
		}, "", false, theme).render(120).join("\n");
		expect(rendered).toContain("line 12");
		expect(rendered).not.toContain("line 13");
		expect(rendered).toContain("expand for full output");
	});
});

describe("buildDroidPrompt", () => {
	it("includes bridge contract and transcript", () => {
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		const prompt = buildDroidPrompt(context);
		expect(prompt.text).toContain("Droid pi bridge contract");
		expect(prompt.text).toContain("User: hello");
	});

	it("preserves image-only latest user turns with a placeholder", () => {
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [{ role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 }],
		};
		const prompt = buildDroidPrompt(context, { maxInputTokens: 10, charsPerToken: 1 });
		expect(prompt.text).toContain("User: [image omitted from transcript]");
		expect(prompt.text).toContain("Latest user turn includes 1 image");
		expect(prompt.images).toEqual([{ data: "abc", mimeType: "image/png" }]);
	});

	it("budgets older transcript while preserving latest user turn", () => {
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [
				{ role: "user", content: "old ".repeat(200), timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 2 },
				{ role: "user", content: "latest request", timestamp: 3 },
			],
		};
		const prompt = buildDroidPrompt(context, { maxInputTokens: 80, charsPerToken: 1 });
		expect(prompt.text).toContain("Earlier transcript omitted");
		expect(prompt.text).toContain("User: latest request");
		expect(prompt.text).not.toContain("old old old old old");
	});

	it("preserves trailing tool results under tight budget", () => {
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [
				{ role: "user", content: "latest request", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }], timestamp: 2 },
				{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "important tool output ".repeat(20) }], timestamp: 3 },
			],
		};
		const prompt = buildDroidPrompt(context, { maxInputTokens: 40, charsPerToken: 1 });
		expect(prompt.text).toContain("User: latest request");
		expect(prompt.text).toContain("Tool result (read, call call-1): important tool output");
	});
});
