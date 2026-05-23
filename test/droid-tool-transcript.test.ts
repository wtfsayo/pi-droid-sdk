import { describe, expect, it } from "vitest";
import {
	formatDroidNativeToolTranscript,
	formatDroidPatchSummary,
	normalizeDroidNativeToolName,
	summarizeDroidNativeToolInput,
} from "../src/droid-tool-transcript.js";

describe("droid native tool transcript formatting", () => {
	it("normalizes common Droid tool names to pi-like labels", () => {
		expect(normalizeDroidNativeToolName("read_file")).toBe("read");
		expect(normalizeDroidNativeToolName("run_terminal_cmd")).toBe("bash");
		expect(normalizeDroidNativeToolName("str_replace")).toBe("edit");
		expect(normalizeDroidNativeToolName("list_dir")).toBe("ls");
		expect(normalizeDroidNativeToolName("TodoWrite")).toBe("todo");
	});

	it("summarizes common tool inputs", () => {
		expect(summarizeDroidNativeToolInput("Read", { filePath: "src/index.ts" })).toBe("src/index.ts");
		expect(summarizeDroidNativeToolInput("Execute", { command: "npm test" })).toBe("npm test");
		expect(summarizeDroidNativeToolInput("Grep", { pattern: "streamDroid", path: "src" })).toBe("streamDroid in src");
		expect(summarizeDroidNativeToolInput("TodoWrite", { todos: "1. [in_progress] Wire display\n2. [pending] Test" })).toBe("0/2 completed, 1 in progress, 1 pending");
	});

	it("formats todo updates as readable lists", () => {
		const transcript = formatDroidNativeToolTranscript({
			toolName: "TodoWrite",
			input: { todos: "1. [in_progress] Wire display\n2. [pending] Test" },
			progress: [],
			content: "TODO List Updated",
			isError: false,
		});

		expect(transcript).toBe("Droid todo: 0/2 completed, 1 in progress, 1 pending\n\n… Wire display (in progress)\n○ Test (pending)");
	});

	it("summarizes Droid patch payloads", () => {
		expect(formatDroidPatchSummary({
			input: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch",
		})).toBe("src/index.ts +1/-1");
	});

	it("formats progress and output with a stable header", () => {
		const transcript = formatDroidNativeToolTranscript({
			toolName: "Read",
			input: { filePath: "README.md" },
			progress: ["opening README.md"],
			content: "done",
			isError: false,
		});

		expect(transcript).toBe("Droid read: README.md\n\n[progress] opening README.md\ndone");
	});
});
