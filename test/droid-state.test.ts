import { afterEach, describe, expect, it, vi } from "vitest";
import { AutonomyLevel } from "@factory/droid-sdk";
import { getDroidAutonomyLevelOverride, setDroidAutonomyLevelOverride } from "../src/droid-permissions.js";
import { __testUtils, registerDroidControls } from "../src/droid-state.js";

function createControlsHarness(selectValue = "leave unchanged") {
	let commandHandler: ((args: string, ctx: any) => Promise<void> | void) | undefined;
	const pi = {
		registerCommand: vi.fn((_name: string, options: { handler: typeof commandHandler }) => {
			commandHandler = options.handler;
		}),
		on: vi.fn(),
	};
	const ctx = {
		model: { id: "kimi-k2.5", provider: "factory", api: "droid-sdk" },
		ui: {
			notify: vi.fn(),
			select: vi.fn(async () => selectValue),
			setStatus: vi.fn(),
		},
	};
	registerDroidControls(pi as never);
	if (!commandHandler) throw new Error("droid-autonomy command was not registered");
	return { pi, ctx, commandHandler };
}

describe("droid controls", () => {
	afterEach(() => {
		setDroidAutonomyLevelOverride(undefined);
	});

	it("parses autonomy command arguments", () => {
		expect(__testUtils.parseAutonomyArg("medium now")).toBe(AutonomyLevel.Medium);
		expect(__testUtils.parseAutonomyArg("unknown")).toBeUndefined();
		expect(__testUtils.parseAutonomyArg("")).toBeUndefined();
	});

	it("sets autonomy directly from command args", async () => {
		const { ctx, commandHandler } = createControlsHarness();

		await commandHandler("low", ctx);

		expect(getDroidAutonomyLevelOverride()).toBe(AutonomyLevel.Low);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("droid", "droid autonomy low");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Droid autonomy set to low.", "info");
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("leaves autonomy unchanged from the UI select path", async () => {
		setDroidAutonomyLevelOverride(AutonomyLevel.High);
		const { ctx, commandHandler } = createControlsHarness("leave unchanged");

		await commandHandler("", ctx);

		expect(getDroidAutonomyLevelOverride()).toBe(AutonomyLevel.High);
		expect(ctx.ui.select).toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Droid autonomy remains high.", "info");
	});

	it("sets autonomy from the UI select path", async () => {
		const { ctx, commandHandler } = createControlsHarness("medium");

		await commandHandler("", ctx);

		expect(getDroidAutonomyLevelOverride()).toBe(AutonomyLevel.Medium);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("droid", "droid autonomy medium");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Droid autonomy set to medium.", "info");
	});
});
