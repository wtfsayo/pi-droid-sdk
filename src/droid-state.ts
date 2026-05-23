import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
	formatDroidAutonomyLevel,
	parseDroidAutonomyLevel,
	resolveDroidAutonomyLevel,
	setDroidAutonomyLevelOverride,
} from "./droid-permissions.js";

const DROID_PROVIDER = "factory";

type DroidControlsModel =
	| Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider" | "api">
	| undefined;

type DroidControlsContext = {
	model: DroidControlsModel;
	ui: Pick<ExtensionContext["ui"], "notify" | "select" | "setStatus">;
};

interface DroidControlsExtensionApi {
	registerCommand(name: string, options: {
		description?: string;
		handler: (args: string, ctx: DroidControlsContext) => Promise<void> | void;
	}): void;
	on(event: "session_start", handler: (event: SessionStartEvent, ctx: DroidControlsContext) => Promise<void> | void): void;
	on(event: "model_select", handler: (event: { model: ExtensionContext["model"] }, ctx: DroidControlsContext) => Promise<void> | void): void;
	on(event: "turn_start", handler: (event: unknown, ctx: DroidControlsContext) => Promise<void> | void): void;
}

function isDroidModel(model: DroidControlsModel): boolean {
	return model?.provider === DROID_PROVIDER || model?.api === "droid-sdk";
}

function updateDroidStatus(ctx: { model: DroidControlsModel; ui: Pick<ExtensionContext["ui"], "setStatus"> }, model = ctx.model): void {
	if (!isDroidModel(model)) {
		ctx.ui.setStatus("droid", undefined);
		return;
	}
	ctx.ui.setStatus("droid", `droid autonomy ${formatDroidAutonomyLevel(resolveDroidAutonomyLevel())}`);
}

function parseAutonomyArg(args: string): ReturnType<typeof parseDroidAutonomyLevel> {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	return parseDroidAutonomyLevel(trimmed.split(/\s+/)[0]);
}

export function registerDroidControls(pi: DroidControlsExtensionApi): void {
	pi.registerCommand("droid-autonomy", {
		description: "Show or set Factory Droid native-tool autonomy for this pi process",
		handler: async (args, ctx) => {
			const requested = parseAutonomyArg(args);
			if (requested !== undefined) {
				setDroidAutonomyLevelOverride(requested);
				updateDroidStatus(ctx);
				ctx.ui.notify(`Droid autonomy set to ${formatDroidAutonomyLevel(requested)}.`, "info");
				return;
			}

			const current = resolveDroidAutonomyLevel();
			const choice = await ctx.ui.select(
				`Droid autonomy is ${formatDroidAutonomyLevel(current)}. Choose a new level:`,
				["off", "low", "medium", "high", "leave unchanged"],
			);
			const next = parseDroidAutonomyLevel(choice);
			if (next === undefined) {
				ctx.ui.notify(`Droid autonomy remains ${formatDroidAutonomyLevel(current)}.`, "info");
				return;
			}
			setDroidAutonomyLevelOverride(next);
			updateDroidStatus(ctx);
			ctx.ui.notify(`Droid autonomy set to ${formatDroidAutonomyLevel(next)}.`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateDroidStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		updateDroidStatus(ctx, event.model);
	});

	pi.on("turn_start", async (_event, ctx) => {
		updateDroidStatus(ctx);
	});
}

export const __testUtils = {
	isDroidModel,
	parseAutonomyArg,
};
