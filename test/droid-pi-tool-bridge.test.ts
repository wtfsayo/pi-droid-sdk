import { describe, expect, it, vi } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	__testUtils,
	buildDroidPiToolBridgeSnapshot,
	buildDroidPiToolBridgeSurfaceSignature,
} from "../src/droid-pi-tool-bridge.js";
import { DROID_NATIVE_TOOL_DISPLAY_TOOL_NAME } from "../src/droid-native-tool-display.js";

function createToolInfo(name: string, description = `${name} description`, parameters = Type.Object({})): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "test", path: `test:${name}`, scope: "temporary", origin: "top-level" },
	};
}

function createMockPi(options: { active: string[]; tools: ToolInfo[] }) {
	return {
		getActiveTools: vi.fn(() => [...options.active]),
		getAllTools: vi.fn(() => [...options.tools]),
		on: vi.fn(),
	};
}

describe("droid pi tool bridge snapshots", () => {
	it("maps active extension tools and excludes internal/overlapping native tools by default", () => {
		const tools = [
			createToolInfo("read"),
			createToolInfo("sem_reindex", "Reindex semantic cache", Type.Object({ path: Type.String() })),
			createToolInfo(DROID_NATIVE_TOOL_DISPLAY_TOOL_NAME),
			createToolInfo("pi__already_bridge"),
			createToolInfo("inactive"),
		];
		const pi = createMockPi({
			active: ["read", "sem_reindex", DROID_NATIVE_TOOL_DISPLAY_TOOL_NAME, "pi__already_bridge"],
			tools,
		});

		const snapshot = buildDroidPiToolBridgeSnapshot(pi);

		expect(snapshot.tools.map((tool) => tool.piToolName)).toEqual(["sem_reindex"]);
		expect(snapshot.tools.map((tool) => tool.mcpToolName)).toEqual(["pi__sem_reindex"]);
		expect(snapshot.mcpToolNameToPiToolName.get("pi__sem_reindex")).toBe("sem_reindex");
		expect(snapshot.piToolNameToMcpToolName.get("sem_reindex")).toBe("pi__sem_reindex");
	});

	it("can opt in to overlapping builtins", () => {
		const pi = createMockPi({
			active: ["read", "bash", "custom"],
			tools: [createToolInfo("read"), createToolInfo("bash"), createToolInfo("custom")],
		});

		const snapshot = buildDroidPiToolBridgeSnapshot(pi, { exposeOverlappingBuiltins: true });

		expect(snapshot.tools.map((tool) => tool.piToolName)).toEqual(["read", "bash", "custom"]);
		expect(snapshot.tools.map((tool) => tool.mcpToolName)).toEqual(["pi__read", "pi__bash", "pi__custom"]);
	});

	it("uses stable collision-safe MCP names", () => {
		const pi = createMockPi({
			active: ["tool one", "tool_one"],
			tools: [createToolInfo("tool one"), createToolInfo("tool_one")],
		});

		const snapshot = buildDroidPiToolBridgeSnapshot(pi);

		expect(snapshot.tools).toHaveLength(2);
		expect(snapshot.tools[0].mcpToolName).toBe("pi__tool_one");
		expect(snapshot.tools[1].mcpToolName).toMatch(/^pi__tool_one__[a-f0-9]{8}$/);
		expect(new Set(snapshot.tools.map((tool) => tool.mcpToolName)).size).toBe(2);
	});

	it("builds stable surface signatures for session compatibility checks", () => {
		const pi = createMockPi({
			active: ["custom"],
			tools: [createToolInfo("custom", "Custom tool", Type.Object({ value: Type.String() }))],
		});
		const first = buildDroidPiToolBridgeSnapshot(pi);
		const second = buildDroidPiToolBridgeSnapshot(pi);

		expect(buildDroidPiToolBridgeSurfaceSignature(first)).toBe(buildDroidPiToolBridgeSurfaceSignature(second));
		expect(buildDroidPiToolBridgeSurfaceSignature(first)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("attaches the surface signature to bridge runs", async () => {
		const pi = createMockPi({
			active: ["custom"],
			tools: [createToolInfo("custom")],
		});
		const registry = __testUtils.createRegistry(pi, {});
		const run = await registry.createRun();

		expect(run.enabled).toBe(true);
		expect(run.surfaceSignature).toMatch(/^[a-f0-9]{64}$/);

		await registry.disposeAll("test cleanup");
	});
});
