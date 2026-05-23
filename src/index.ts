import type { ExtensionAPI, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { discoverModels, type DroidModelFallbackIssue } from "./model-discovery.js";
import { registerDroidPiToolBridge } from "./droid-pi-tool-bridge.js";
import { registerDroidNativeToolDisplay } from "./droid-native-tool-display.js";
import { registerDroidQuestionTool } from "./droid-question-tool.js";
import { registerDroidSessionCwd } from "./droid-session-cwd.js";
import { setDroidAskUserUiContext } from "./droid-ask-user.js";
import { setDroidPermissionUiContext } from "./droid-permissions.js";
import { registerDroidControls } from "./droid-state.js";
import { streamDroid } from "./droid-provider.js";

type DroidExtensionApi =
	& Pick<ExtensionAPI, "registerProvider">
	& {
		registerCommand(name: string, options: {
			description?: string;
			handler: (args: string, ctx: Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionContext["ui"], "notify"> }) => Promise<void> | void;
		}): void;
		on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	}
	& Parameters<typeof registerDroidSessionCwd>[0]
	& Parameters<typeof registerDroidControls>[0]
	& Parameters<typeof registerDroidNativeToolDisplay>[0]
	& Parameters<typeof registerDroidQuestionTool>[0]
	& Parameters<typeof registerDroidPiToolBridge>[0];

function createDroidProviderConfig(models: ProviderModelConfig[]): ProviderConfig {
	return {
		name: "Factory",
		baseUrl: "https://factory.ai",
		apiKey: "FACTORY_API_KEY",
		api: "droid-sdk",
		models,
		streamSimple: streamDroid,
	};
}

function registerDroidProvider(pi: Pick<ExtensionAPI, "registerProvider">, models: ProviderModelConfig[]): void {
	pi.registerProvider("factory", createDroidProviderConfig(models));
}

export default async function (pi: DroidExtensionApi) {
	registerDroidSessionCwd(pi);
	registerDroidControls(pi);
	registerDroidNativeToolDisplay(pi);
	registerDroidQuestionTool(pi);
	registerDroidPiToolBridge(pi);

	pi.on("session_start", (_event, ctx) => {
		setDroidAskUserUiContext({ hasUI: ctx.hasUI, ui: ctx.ui });
		setDroidPermissionUiContext({ hasUI: ctx.hasUI, ui: ctx.ui });
	});

	let fallbackIssue: DroidModelFallbackIssue | undefined;
	const models = await discoverModels({
		onFallback: (issue) => {
			fallbackIssue = issue;
		},
	});

	if (fallbackIssue) {
		const issue = fallbackIssue;
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(issue.message, "warning");
		});
	}

	pi.registerCommand("droid-refresh-models", {
		description: "Refresh the live Factory model catalog without restarting pi",
		handler: async (_args, ctx) => {
			let refreshFallbackIssue: DroidModelFallbackIssue | undefined;
			const refreshedModels = await discoverModels({
				onFallback: (issue) => {
					refreshFallbackIssue = issue;
				},
			});
			registerDroidProvider(pi, refreshedModels);
			if (!ctx.hasUI) return;
			if (refreshFallbackIssue) {
				ctx.ui.notify(`Factory model catalog refresh still using fallback models: ${refreshFallbackIssue.message}`, "warning");
			} else {
				ctx.ui.notify(`Factory model catalog refreshed with ${refreshedModels.length} model${refreshedModels.length === 1 ? "" : "s"}.`, "info");
			}
		},
	});

	registerDroidProvider(pi, models);
}
