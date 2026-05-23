import {
	AutonomyLevel,
	ToolConfirmationOutcome,
	ToolConfirmationType,
	type RequestPermissionRequestParams,
} from "@factory/droid-sdk";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DROID_AUTONOMY_LEVEL_ENV = "PI_DROID_AUTONOMY_LEVEL";
const DROID_PERMISSION_PROMPTS_ENV = "PI_DROID_PERMISSION_PROMPTS";
const ENABLED_ENV_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);

type DroidPermissionUiContext = {
	hasUI: boolean;
	ui: Pick<ExtensionContext["ui"], "select">;
};

let permissionPromptHandler: ((params: RequestPermissionRequestParams) => Promise<ToolConfirmationOutcome>) | undefined;
let permissionUiContext: DroidPermissionUiContext | undefined;
let autonomyOverride: AutonomyLevel | undefined;

export function setDroidPermissionPromptHandler(
	handler: ((params: RequestPermissionRequestParams) => Promise<ToolConfirmationOutcome>) | undefined,
): void {
	permissionPromptHandler = handler;
}

export function setDroidPermissionUiContext(ctx: DroidPermissionUiContext | undefined): void {
	permissionUiContext = ctx;
}

export function setDroidAutonomyLevelOverride(level: AutonomyLevel | undefined): void {
	autonomyOverride = level;
}

export function getDroidAutonomyLevelOverride(): AutonomyLevel | undefined {
	return autonomyOverride;
}

export function parseDroidAutonomyLevel(value: string | undefined): AutonomyLevel | undefined {
	const raw = value?.trim().toLowerCase();
	switch (raw) {
		case "off":
			return AutonomyLevel.Off;
		case "low":
			return AutonomyLevel.Low;
		case "medium":
			return AutonomyLevel.Medium;
		case "high":
			return AutonomyLevel.High;
		default:
			return undefined;
	}
}

export function formatDroidAutonomyLevel(level: AutonomyLevel): string {
	if (level === AutonomyLevel.Off) return "off";
	if (level === AutonomyLevel.Low) return "low";
	if (level === AutonomyLevel.Medium) return "medium";
	return "high";
}

export function resolveDroidAutonomyLevel(): AutonomyLevel {
	if (autonomyOverride !== undefined) return autonomyOverride;
	return parseDroidAutonomyLevel(process.env[DROID_AUTONOMY_LEVEL_ENV]) ?? AutonomyLevel.High;
}

function isBridgeMcpTool(params: RequestPermissionRequestParams): boolean {
	return params.toolUses.some((item) => item.details.type === ToolConfirmationType.McpTool);
}

function summarizePermissionRequest(params: RequestPermissionRequestParams): string {
	return params.toolUses
		.map((item) => {
			const type = item.details.type;
			if (type === ToolConfirmationType.Execute) return `Execute: ${item.details.command ?? "command"}`;
			if (type === ToolConfirmationType.Create) return `Create: ${item.details.filePath ?? "file"}`;
			if (type === ToolConfirmationType.Edit) return `Edit: ${item.details.filePath ?? "file"}`;
			if (type === ToolConfirmationType.McpTool) return `MCP tool: ${item.toolName ?? "tool"}`;
			return `${type}: ${item.toolName ?? "tool"}`;
		})
		.join("; ");
}

function shouldPromptForPermission(): boolean {
	return ENABLED_ENV_VALUES.has(process.env[DROID_PERMISSION_PROMPTS_ENV]?.trim().toLowerCase() ?? "");
}

async function promptForPermission(params: RequestPermissionRequestParams): Promise<ToolConfirmationOutcome | undefined> {
	if (!permissionUiContext?.hasUI || !shouldPromptForPermission()) return undefined;
	const summary = summarizePermissionRequest(params) || "Droid wants to use a tool.";
	const proceedOnce = "Proceed once";
	const autoHigh = "Proceed and allow high autonomy";
	const autoMedium = "Proceed and allow medium autonomy";
	const autoLow = "Proceed and allow low autonomy";
	const cancel = "Cancel";
	const selected = await permissionUiContext.ui.select(`Droid permission request: ${summary}`, [
		proceedOnce,
		autoHigh,
		autoMedium,
		autoLow,
		cancel,
	]);
	if (selected === proceedOnce) return ToolConfirmationOutcome.ProceedOnce;
	if (selected === autoHigh) return ToolConfirmationOutcome.ProceedAutoRunHigh;
	if (selected === autoMedium) return ToolConfirmationOutcome.ProceedAutoRunMedium;
	if (selected === autoLow) return ToolConfirmationOutcome.ProceedAutoRunLow;
	return ToolConfirmationOutcome.Cancel;
}

export async function handleDroidPermissionRequest(
	params: RequestPermissionRequestParams,
): Promise<ToolConfirmationOutcome> {
	if (isBridgeMcpTool(params)) {
		return ToolConfirmationOutcome.ProceedOnce;
	}

	if (permissionPromptHandler) {
		return permissionPromptHandler(params);
	}

	const prompted = await promptForPermission(params);
	if (prompted !== undefined) return prompted;

	const autonomy = resolveDroidAutonomyLevel();
	switch (autonomy) {
		case AutonomyLevel.High:
			return ToolConfirmationOutcome.ProceedAutoRunHigh;
		case AutonomyLevel.Medium:
			return ToolConfirmationOutcome.ProceedAutoRunMedium;
		case AutonomyLevel.Low:
			return ToolConfirmationOutcome.ProceedAutoRunLow;
		case AutonomyLevel.Off:
		default:
			return ToolConfirmationOutcome.Cancel;
	}
}

export function formatPermissionRequestForUi(params: RequestPermissionRequestParams): string {
	return summarizePermissionRequest(params);
}
