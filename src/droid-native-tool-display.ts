import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionHandler, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatDroidNativeToolTranscript,
	formatDroidPatchChangeSummary,
	formatDroidPatchSummary,
	formatDroidTodoStatusLabel,
	formatDroidTodos,
	getDroidPatchText,
	getDroidTodoStatusIcon,
	normalizeDroidNativeToolName,
	parseDroidTodos,
	summarizeDroidNativeToolInput,
	summarizeDroidPatch,
} from "./droid-tool-transcript.js";
import { getDroidSessionCwd } from "./droid-session-cwd.js";

export const DROID_NATIVE_TOOL_DISPLAY_TOOL_NAME = "droid_tool";
export const DROID_NATIVE_TOOL_DISPLAY_MAPPED_TOOL_NAMES = [
	"droid_read",
	"droid_bash",
	"droid_edit",
	"droid_write",
	"droid_grep",
	"droid_find",
	"droid_ls",
	"droid_todo",
] as const;
export const DROID_NATIVE_TOOL_DISPLAY_TOOL_NAMES = [
	DROID_NATIVE_TOOL_DISPLAY_TOOL_NAME,
	...DROID_NATIVE_TOOL_DISPLAY_MAPPED_TOOL_NAMES,
] as const;

export type DroidNativeToolDisplayToolName = (typeof DROID_NATIVE_TOOL_DISPLAY_TOOL_NAMES)[number];

export interface DroidNativeToolDisplayItem {
	piToolCallId: string;
	droidToolUseId: string;
	toolName: string;
	input: Record<string, unknown>;
	progress: string[];
	content: string;
	isError: boolean;
}

type DroidNativeToolDisplayContext = {
	model: ExtensionContext["model"];
};

interface DroidNativeToolDisplayExtensionApi extends Pick<ExtensionAPI, "getActiveTools" | "registerTool" | "setActiveTools"> {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "model_select", handler: (event: { model: ExtensionContext["model"] }, ctx: DroidNativeToolDisplayContext) => Promise<void> | void): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
}

const displayItemsByPiToolCallId = new Map<string, DroidNativeToolDisplayItem>();
const mappedNormalizedToolNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "todo"]);

function isFactoryModel(model: ExtensionContext["model"]): boolean {
	return model?.provider === "factory" || model?.api === "droid-sdk";
}

export function isDroidNativeToolDisplayToolName(toolName: string): toolName is DroidNativeToolDisplayToolName {
	return DROID_NATIVE_TOOL_DISPLAY_TOOL_NAMES.some((candidate) => candidate === toolName);
}

export function getDroidNativeToolDisplayToolName(droidToolName: string): DroidNativeToolDisplayToolName {
	const normalized = normalizeDroidNativeToolName(droidToolName);
	return mappedNormalizedToolNames.has(normalized)
		? `droid_${normalized}` as DroidNativeToolDisplayToolName
		: DROID_NATIVE_TOOL_DISPLAY_TOOL_NAME;
}

function getString(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function getNumber(input: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function getBoolean(input: Record<string, unknown>, keys: string[]): boolean | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function formatDisplayPath(path: string | undefined): string | undefined {
	const trimmed = path?.trim();
	if (!trimmed) return undefined;
	if (!isAbsolute(trimmed)) return trimmed;
	const cwd = getDroidSessionCwd();
	const relativePath = relative(cwd, trimmed);
	if (!relativePath) return ".";
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) return trimmed;
	return relativePath;
}

function formatDisplayCommand(command: string): string {
	return command.replace(/\/[^\s"']+/g, (path) => formatDisplayPath(path) ?? path);
}

export function getDroidNativeToolDisplayArguments(item: DroidNativeToolDisplayItem): Record<string, unknown> {
	const normalized = normalizeDroidNativeToolName(item.toolName);
	const input = item.input;
	const droid = { droidToolName: item.toolName, droidToolUseId: item.droidToolUseId };
	switch (normalized) {
		case "read":
			return {
				path: formatDisplayPath(getString(input, ["path", "filePath", "file_path", "target_file"])) ?? "unknown",
				offset: getNumber(input, ["offset", "startLine", "start_line"]),
				limit: getNumber(input, ["limit", "numLines", "num_lines"]),
				...droid,
			};
		case "bash": {
			const command = getString(input, ["command", "cmd"]) ?? (summarizeDroidNativeToolInput(item.toolName, input) || item.toolName);
			return {
				command: formatDisplayCommand(command),
				timeout: getNumber(input, ["timeout", "timeoutSeconds", "timeout_seconds"]),
				...droid,
			};
		}
		case "edit": {
			const patchSummary = summarizeDroidPatch(input);
			const patchText = getDroidPatchText(input);
			return {
				path: formatDisplayPath(getString(input, ["path", "filePath", "file_path", "target_file"]) ?? patchSummary?.paths[0]) ?? "patch",
				edits: patchText ? undefined : getDroidEditArguments(input),
				patch: patchText,
				patchOperation: patchSummary?.operation,
				paths: patchSummary?.paths,
				...droid,
			};
		}
		case "write":
			return {
				path: formatDisplayPath(getString(input, ["path", "filePath", "file_path", "target_file"])) ?? "unknown",
				content: getString(input, ["content", "fileContent", "file_content", "text"]) ?? "",
				...droid,
			};
		case "grep":
			return {
				pattern: getString(input, ["pattern", "query", "search"]) ?? "",
				path: formatDisplayPath(getString(input, ["path", "folder", "directory"])),
				glob: getString(input, ["glob", "includePattern", "glob_pattern"]),
				ignoreCase: getBoolean(input, ["ignoreCase", "ignore_case"]),
				...droid,
			};
		case "find":
			return {
				pattern: getString(input, ["pattern", "query", "glob", "glob_pattern"]) ?? "*",
				path: formatDisplayPath(getString(input, ["path", "folder", "directory"])),
				limit: getNumber(input, ["limit"]),
				...droid,
			};
		case "ls":
			return {
				path: formatDisplayPath(getString(input, ["path", "directory", "directory_path"])),
				limit: getNumber(input, ["limit"]),
				...droid,
			};
		case "todo":
			return {
				todos: formatDroidTodos(input.todos ?? input.todo ?? input.items ?? input),
				...droid,
			};
		default:
			return { toolName: item.toolName, input, ...droid };
	}
}

function getDroidEditArguments(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
	const edits = input.edits;
	if (Array.isArray(edits)) {
		const normalized = edits
			.map((entry) => entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined)
			.filter((entry): entry is Record<string, unknown> => entry !== undefined)
			.map((entry) => ({
				oldText: getString(entry, ["oldText", "old_text", "old_string"]) ?? "",
				newText: getString(entry, ["newText", "new_text", "new_string"]) ?? "",
			}));
		if (normalized.length > 0) return normalized;
	}
	return [{
		oldText: getString(input, ["oldText", "old_text", "old_string"]) ?? "",
		newText: getString(input, ["newText", "new_text", "new_string", "content"]) ?? "",
	}];
}

function syncDroidNativeToolDisplayForModel(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	model: ExtensionContext["model"],
): void {
	const activeToolNames = new Set(pi.getActiveTools());
	const shouldBeActive = isFactoryModel(model);
	let changed = false;
	for (const toolName of DROID_NATIVE_TOOL_DISPLAY_TOOL_NAMES) {
		const alreadyActive = activeToolNames.has(toolName);
		if (shouldBeActive === alreadyActive) continue;
		if (shouldBeActive) activeToolNames.add(toolName);
		else activeToolNames.delete(toolName);
		changed = true;
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

function stringifyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function summarizeResult(item: DroidNativeToolDisplayItem): string {
	return formatDroidNativeToolTranscript(item);
}

function getFirstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content
		?.filter((entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string")
		.map((entry) => entry.text)
		.join("\n") ?? "";
}

function getDisplayItemFromDetails(details: unknown): DroidNativeToolDisplayItem | undefined {
	if (!details || typeof details !== "object") return undefined;
	const data = details as Partial<DroidNativeToolDisplayItem>;
	if (typeof data.toolName !== "string" || typeof data.content !== "string") return undefined;
	return {
		piToolCallId: typeof data.piToolCallId === "string" ? data.piToolCallId : "",
		droidToolUseId: typeof data.droidToolUseId === "string" ? data.droidToolUseId : "",
		toolName: data.toolName,
		input: data.input && typeof data.input === "object" && !Array.isArray(data.input) ? data.input : {},
		progress: Array.isArray(data.progress) ? data.progress.filter((entry): entry is string => typeof entry === "string") : [],
		content: data.content,
		isError: data.isError === true,
	};
}

function limitOutputLines(text: string, expanded: boolean, collapsedLines = 12, expandedLines = 200): string {
	const lines = text.trimEnd().split("\n");
	const limit = expanded ? expandedLines : collapsedLines;
	if (lines.length <= limit) return lines.join("\n");
	return `${lines.slice(0, limit).join("\n")}\n... (${lines.length - limit} more lines; ${expanded ? "truncated" : "expand for full output"})`;
}

function renderMutedBlock(text: string, theme: { fg(name: string, text: string): string }): string {
	return text.split("\n").map((line) => theme.fg("muted", line)).join("\n");
}

function getDroidTodoStatusColor(status: string): string {
	if (status === "completed") return "success";
	if (status === "in_progress") return "warning";
	if (status === "pending") return "muted";
	return "accent";
}

function renderDroidTodoList(value: unknown, theme: { fg(name: string, text: string): string; bold(text: string): string }, maxItems = 20): string {
	const todos = parseDroidTodos(value);
	if (todos.length === 0) return renderMutedBlock(formatDroidTodos(value), theme);
	const visible = todos.slice(0, maxItems).map((todo) => {
		const icon = theme.fg(getDroidTodoStatusColor(todo.status), getDroidTodoStatusIcon(todo.status));
		const text = todo.status === "completed" ? theme.fg("muted", todo.text) : todo.status === "in_progress" ? theme.fg("accent", todo.text) : todo.text;
		const status = theme.fg("muted", `(${formatDroidTodoStatusLabel(todo.status)})`);
		return `${icon} ${text} ${status}`;
	});
	if (todos.length > maxItems) visible.push(theme.fg("muted", `... (${todos.length - maxItems} more todos)`));
	return visible.join("\n");
}

function summarizeDroidDisplayInput(toolName: string, input: Record<string, unknown>): string {
	switch (normalizeDroidNativeToolName(toolName)) {
		case "read":
			return formatDisplayPath(getString(input, ["path", "filePath", "file_path", "target_file"])) ?? "";
		case "bash": {
			const command = getString(input, ["command", "cmd"]);
			return command ? formatDisplayCommand(command) : "";
		}
		case "edit":
			return formatDisplayPath(getString(input, ["path", "filePath", "file_path", "target_file"])) ?? formatDroidPatchSummary(input);
		case "write":
			return formatDisplayPath(getString(input, ["path", "filePath", "file_path", "target_file"])) ?? "";
		case "grep": {
			const pattern = getString(input, ["pattern", "query", "search"]);
			const path = formatDisplayPath(getString(input, ["path", "folder", "directory", "includePattern", "glob_pattern", "glob"]));
			return [pattern ? JSON.stringify(pattern) : undefined, path ? `in ${path}` : undefined].filter(Boolean).join(" ");
		}
		case "find": {
			const pattern = getString(input, ["pattern", "query", "glob_pattern", "glob"]);
			const path = formatDisplayPath(getString(input, ["path", "folder", "directory"]));
			return [pattern, path ? `in ${path}` : undefined].filter(Boolean).join(" ");
		}
		case "ls":
			return formatDisplayPath(getString(input, ["path", "directory", "directory_path"])) ?? "";
		case "todo":
			return summarizeDroidNativeToolInput(toolName, input);
		default:
			return summarizeDroidNativeToolInput(toolName, input);
	}
}

function renderDroidPatchLine(line: string, theme: { fg(name: string, text: string): string }): string {
	if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
	if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
	if (line.startsWith("@@")) return theme.fg("accent", line);
	return theme.fg("muted", line);
}

function renderDroidPatchPreview(patch: string, expanded: boolean, theme: { fg(name: string, text: string): string }): string {
	const lines = patch.trimEnd().split("\n");
	const maxLines = expanded ? 80 : 14;
	const visible = lines.slice(0, maxLines).map((line) => renderDroidPatchLine(line, theme));
	if (lines.length > maxLines) visible.push(theme.fg("muted", `... (${lines.length - maxLines} more patch lines; ${expanded ? "truncated" : "expand for full diff"})`));
	return visible.join("\n");
}

type DroidEditDiffLine = {
	type: "added" | "removed" | "unchanged" | string;
	content: string;
	lineNumber?: { old?: number; new?: number };
	oldLineNumber?: number;
	newLineNumber?: number;
};

type DroidEditResult = {
	path?: string;
	diffLines: DroidEditDiffLine[];
	addedLines: number;
	removedLines: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(text.trim()));
	} catch {
		return undefined;
	}
}

function getDroidEditLineNumber(line: DroidEditDiffLine): number | undefined {
	if (line.type === "removed") return line.lineNumber?.old ?? line.oldLineNumber ?? line.lineNumber?.new ?? line.newLineNumber;
	return line.lineNumber?.new ?? line.newLineNumber ?? line.lineNumber?.old ?? line.oldLineNumber;
}

function parseDroidEditResultContent(content: string): DroidEditResult | undefined {
	const record = parseJsonRecord(content);
	if (!record) return undefined;
	const rawDiffLines = Array.isArray(record.diffLines) ? record.diffLines : undefined;
	if (!rawDiffLines) return undefined;
	const diffLines: DroidEditDiffLine[] = [];
	for (const entry of rawDiffLines) {
		const line = asRecord(entry);
		if (!line) continue;
		const type = typeof line.type === "string" ? line.type : "unchanged";
		const lineNumber = asRecord(line.lineNumber);
		diffLines.push({
			type,
			content: typeof line.content === "string" ? line.content : "",
			lineNumber: lineNumber ? {
				old: typeof lineNumber.old === "number" ? lineNumber.old : undefined,
				new: typeof lineNumber.new === "number" ? lineNumber.new : undefined,
			} : undefined,
			oldLineNumber: typeof line.oldLineNumber === "number" ? line.oldLineNumber : undefined,
			newLineNumber: typeof line.newLineNumber === "number" ? line.newLineNumber : undefined,
		});
	}
	if (diffLines.length === 0) return undefined;
	return {
		path: getString(record, ["file_path", "filePath", "path"]),
		diffLines,
		addedLines: diffLines.filter((line) => line.type === "added").length,
		removedLines: diffLines.filter((line) => line.type === "removed").length,
	};
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDroidEditResultSummary(result: DroidEditResult): string {
	const parts = [
		result.addedLines > 0 ? `added ${pluralize(result.addedLines, "line")}` : undefined,
		result.removedLines > 0 ? `removed ${pluralize(result.removedLines, "line")}` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(", ") : "no changes needed";
}

function replaceDroidDiffTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function renderDroidEditDiffLine(line: DroidEditDiffLine, theme: { fg(name: string, text: string): string }): string {
	const lineNumber = getDroidEditLineNumber(line);
	const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
	const rendered = `${prefix}${lineNumber ?? ""} ${replaceDroidDiffTabs(line.content)}`;
	if (line.type === "added") return theme.fg("toolDiffAdded", rendered);
	if (line.type === "removed") return theme.fg("toolDiffRemoved", rendered);
	return theme.fg("toolDiffContext", rendered);
}

function renderDroidEditDiff(result: DroidEditResult, expanded: boolean, theme: { fg(name: string, text: string): string }): string {
	const rendered = result.diffLines.map((line) => renderDroidEditDiffLine(line, theme));
	const maxLines = expanded ? 40 : 8;
	const visible = rendered.slice(0, maxLines);
	if (rendered.length > maxLines) visible.push(theme.fg("muted", `... (${rendered.length - maxLines} more diff lines; expand for full diff)`));
	return visible.join("\n");
}

type DroidPatchResult = {
	path?: string;
	operation?: string;
	diff?: string;
	content?: string;
	addedLines: number;
	removedLines: number;
};

function countUnifiedDiffChanges(diff: string): { addedLines: number; removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
	}
	return { addedLines, removedLines };
}

function isDroidUnifiedDiffOutput(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("diff --git ") || (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(trimmed) && /^[+-]/m.test(trimmed));
}

function formatDroidChangeSummary(addedLines: number, removedLines: number): string {
	const parts = [
		addedLines > 0 ? `added ${pluralize(addedLines, "line")}` : undefined,
		removedLines > 0 ? `removed ${pluralize(removedLines, "line")}` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(", ") : "no changes";
}

function parseDroidPatchResultContent(content: string): DroidPatchResult | undefined {
	const record = parseJsonRecord(content);
	if (!record) return undefined;
	const diff = getString(record, ["diff", "diffString", "unifiedDiff"]);
	const fileContent = getString(record, ["content", "fileContent", "file_content"]);
	const operation = getString(record, ["display_operation", "operation"]);
	if (!diff && !fileContent) return undefined;
	const counts = diff ? countUnifiedDiffChanges(diff) : { addedLines: fileContent ? fileContent.split("\n").filter((_, index, lines) => index < lines.length - 1 || lines[index] !== "").length : 0, removedLines: 0 };
	return {
		path: getString(record, ["file_path", "filePath", "path"]),
		operation,
		diff,
		content: fileContent,
		...counts,
	};
}

function parseUnifiedDiffHunkHeader(line: string): { oldLine: number; newLine: number } | undefined {
	const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
	if (!match) return undefined;
	return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function renderDroidUnifiedDiffLine(prefix: string, lineNumber: number, content: string, theme: { fg(name: string, text: string): string }): string {
	const rendered = `${prefix}${lineNumber} ${replaceDroidDiffTabs(content)}`;
	if (prefix === "+") return theme.fg("toolDiffAdded", rendered);
	if (prefix === "-") return theme.fg("toolDiffRemoved", rendered);
	return theme.fg("toolDiffContext", rendered);
}

function renderDroidUnifiedDiff(diff: string, expanded: boolean, theme: { fg(name: string, text: string): string }): string {
	const lines = diff.split("\n");
	const oldFileIsNull = lines.some((line) => line === "--- /dev/null");
	const newFileIsNull = lines.some((line) => line === "+++ /dev/null");
	const rendered: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (const line of lines) {
		if (!line || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		const hunk = parseUnifiedDiffHunkHeader(line);
		if (hunk) {
			oldLine = hunk.oldLine;
			newLine = hunk.newLine;
			continue;
		}
		if (line.startsWith("+")) {
			if (newFileIsNull) continue;
			rendered.push(renderDroidUnifiedDiffLine("+", newLine, line.slice(1), theme));
			newLine += 1;
		} else if (line.startsWith("-")) {
			if (oldFileIsNull && line === "-") continue;
			rendered.push(renderDroidUnifiedDiffLine("-", oldLine, line.slice(1), theme));
			oldLine += 1;
		} else if (line.startsWith(" ")) {
			rendered.push(renderDroidUnifiedDiffLine(" ", newLine, line.slice(1), theme));
			oldLine += 1;
			newLine += 1;
		} else {
			rendered.push(theme.fg("toolDiffContext", replaceDroidDiffTabs(line)));
		}
	}
	const maxLines = expanded ? 40 : 8;
	const visible = rendered.slice(0, maxLines);
	if (rendered.length > maxLines) visible.push(theme.fg("muted", `... (${rendered.length - maxLines} more diff lines; expand for full diff)`));
	return visible.join("\n");
}

function renderDroidCreatedContent(content: string, expanded: boolean, theme: { fg(name: string, text: string): string }): string {
	const lines = content.trimEnd().split("\n");
	const rendered = lines.map((line, index) => renderDroidUnifiedDiffLine("+", index + 1, line, theme));
	const maxLines = expanded ? 40 : 8;
	const visible = rendered.slice(0, maxLines);
	if (rendered.length > maxLines) visible.push(theme.fg("muted", `... (${rendered.length - maxLines} more lines; expand for full file preview)`));
	return visible.join("\n");
}

function formatDroidPatchResultSummary(result: DroidPatchResult): string {
	if (result.operation === "create" && result.addedLines > 0) return `created ${pluralize(result.addedLines, "line")}`;
	if (result.operation === "delete" && result.removedLines > 0) return `deleted ${pluralize(result.removedLines, "line")}`;
	const parts = [
		result.addedLines > 0 ? `added ${pluralize(result.addedLines, "line")}` : undefined,
		result.removedLines > 0 ? `removed ${pluralize(result.removedLines, "line")}` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(", ") : "no changes needed";
}

function renderDroidPatchResult(result: DroidPatchResult, expanded: boolean, theme: { fg(name: string, text: string): string }): string {
	if (result.diff) return renderDroidUnifiedDiff(result.diff, expanded, theme);
	if (result.content) return renderDroidCreatedContent(result.content, expanded, theme);
	return "";
}

type DroidGrepResult = {
	lines: string[];
	matchCount: number;
};

function formatDroidGrepPath(path: string): string {
	const withoutTrailingColon = path.endsWith(":") ? path.slice(0, -1) : path;
	const withoutDotSlash = withoutTrailingColon.startsWith("./") ? withoutTrailingColon.slice(2) : withoutTrailingColon;
	return formatDisplayPath(withoutDotSlash) ?? withoutDotSlash;
}

function formatDroidGrepLine(line: string): string {
	const lineMatch = /^(.+?):(\d+):(.*)$/.exec(line);
	if (lineMatch) return `${formatDroidGrepPath(lineMatch[1] ?? "")}:${lineMatch[2]}:${lineMatch[3] ?? ""}`;
	const fileMatch = /^(.+?):(\d+)$/.exec(line);
	if (fileMatch) return `${formatDroidGrepPath(fileMatch[1] ?? "")}:${fileMatch[2]}`;
	if (line.startsWith("./") || line.startsWith("/") || /^[^\s]+\.[^\s]+$/.test(line)) return formatDroidGrepPath(line);
	return line;
}

function collectDroidGrepJsonLines(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap((entry) => typeof entry === "string" ? [entry] : collectDroidGrepJsonLines(entry));
	const record = asRecord(value);
	if (!record) return [];
	const matches = Array.isArray(record.matches) ? record.matches : Array.isArray(record.results) ? record.results : undefined;
	if (matches) {
		return matches.flatMap((entry) => {
			if (typeof entry === "string") return [entry];
			const match = asRecord(entry);
			if (!match) return [];
			const file = getString(match, ["file", "path", "filePath", "file_path"]);
			const lineNumber = typeof match.lineNumber === "number" ? match.lineNumber : typeof match.line_number === "number" ? match.line_number : undefined;
			const text = typeof match.line === "string" ? match.line : typeof match.content === "string" ? match.content : undefined;
			if (!file) return text ? [text] : [];
			return [`${file}${lineNumber !== undefined ? `:${lineNumber}` : ""}${text !== undefined ? `:${text}` : ""}`];
		});
	}
	const totalMatches = typeof record.totalMatches === "number" ? record.totalMatches : typeof record.total_matches === "number" ? record.total_matches : undefined;
	if (totalMatches === 0) return ["(no matches)"];
	return [];
}

function parseDroidGrepResult(content: string): DroidGrepResult {
	const json = parseJsonRecord(content);
	const rawLines = json ? collectDroidGrepJsonLines(json) : [];
	const lines = (rawLines.length > 0 ? rawLines : content.trimEnd().split("\n"))
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map(formatDroidGrepLine);
	const matchCount = lines.filter((line) => line !== "(no matches)").length;
	return { lines: lines.length > 0 ? lines : ["(no matches)"], matchCount };
}

function renderDroidGrepResult(result: DroidGrepResult, expanded: boolean, theme: { fg(name: string, text: string): string }): string {
	const maxLines = expanded ? 200 : 12;
	const visible = result.lines.slice(0, maxLines).map((line) => theme.fg("muted", line));
	if (result.lines.length > maxLines) visible.push(theme.fg("muted", `... (${result.lines.length - maxLines} more matches; ${expanded ? "truncated" : "expand for full output"})`));
	return visible.join("\n");
}

function renderDroidToolCall(
	toolName: DroidNativeToolDisplayToolName,
	args: unknown,
	isPartial: boolean,
	theme: { fg(name: string, text: string): string; bold(text: string): string },
): Text {
	if (!isPartial) return new Text("", 0, 0);
	const data = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const droidToolName = typeof data.droidToolName === "string" ? data.droidToolName : toolName.replace(/^droid_/, "");
	const mapped = normalizeDroidNativeToolName(droidToolName);
	const title = toolName === DROID_NATIVE_TOOL_DISPLAY_TOOL_NAME ? `droid ${mapped}` : toolName.replace("_", " ");
	if (mapped === "todo") {
		const todoValue = data.todos ?? data.todo ?? data.items ?? data.input;
		const renderedTodos = renderDroidTodoList(todoValue, theme, 8);
		return new Text(`${theme.fg("toolTitle", theme.bold(title))}${renderedTodos ? `\n${renderedTodos}` : ""}`, 0, 0);
	}
	const inputSummary = summarizeDroidNativeToolInput(droidToolName, data)
		|| (data.input === undefined ? "" : stringifyJson(data.input).replace(/\s+/g, " ").slice(0, 160));
	const input = inputSummary ? ` ${theme.fg("muted", inputSummary)}` : "";
	return new Text(theme.fg("toolTitle", theme.bold(title)) + input, 0, 0);
}

function renderDroidToolResult(
	item: DroidNativeToolDisplayItem | undefined,
	fallbackText: string,
	expanded: boolean,
	theme: { fg(name: string, text: string): string; bold(text: string): string },
): Text {
	if (!item) return new Text(renderMutedBlock(limitOutputLines(fallbackText, expanded), theme), 0, 0);
	const normalized = normalizeDroidNativeToolName(item.toolName);
	const inputSummary = summarizeDroidDisplayInput(item.toolName, item.input);
	const title = `droid ${normalized}${inputSummary ? ` ${inputSummary}` : ""}`;
	if (normalized === "todo") {
		const todoValue = item.input.todos ?? item.input.todo ?? item.input.items ?? item.input;
		const todos = renderDroidTodoList(todoValue, theme);
		return new Text(`${theme.fg("toolTitle", theme.bold(title))}${todos ? `\n${todos}` : ""}`, 0, 0);
	}
	if (normalized === "bash") {
		const text = item.content.trim() || fallbackText;
		if (isDroidUnifiedDiffOutput(text)) {
			const changes = countUnifiedDiffChanges(text);
			const rendered = `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg(item.isError ? "error" : "success", formatDroidChangeSummary(changes.addedLines, changes.removedLines))}\n${renderDroidUnifiedDiff(text, expanded, theme)}`;
			return new Text(rendered, 0, 0);
		}
	}
	if (normalized === "grep") {
		const text = item.content.trim() || fallbackText;
		const grepResult = parseDroidGrepResult(text);
		const summary = grepResult.matchCount === 1 ? "1 match" : grepResult.matchCount === 0 ? "no matches" : `${grepResult.matchCount} matches`;
		return new Text(`${theme.fg("toolTitle", theme.bold(title))} ${theme.fg(item.isError ? "error" : "success", summary)}\n${renderDroidGrepResult(grepResult, expanded, theme)}`, 0, 0);
	}
	if (normalized === "edit") {
		const editResult = parseDroidEditResultContent(item.content);
		if (editResult) {
			const path = formatDisplayPath(editResult.path) ?? formatDisplayPath(getString(item.input, ["path", "filePath", "file_path", "target_file"])) ?? inputSummary ?? "unknown";
			const rendered = `${theme.fg("toolTitle", theme.bold("droid edit"))} ${theme.fg("accent", path)} ${theme.fg(item.isError ? "error" : "success", formatDroidEditResultSummary(editResult))}\n${renderDroidEditDiff(editResult, expanded, theme)}`;
			return new Text(rendered, 0, 0);
		}
		const patchResult = parseDroidPatchResultContent(item.content);
		if (patchResult) {
			const path = formatDisplayPath(patchResult.path) ?? (inputSummary || "patch");
			const rendered = `${theme.fg("toolTitle", theme.bold("droid edit"))} ${theme.fg("accent", path)} ${theme.fg(item.isError ? "error" : "success", formatDroidPatchResultSummary(patchResult))}\n${renderDroidPatchResult(patchResult, expanded, theme)}`;
			return new Text(rendered, 0, 0);
		}
		const patch = getDroidPatchText(item.input);
		if (patch) {
			const patchTitle = `droid edit ${formatDroidPatchSummary(item.input) || inputSummary || "patch"}`;
			const changeSummary = formatDroidPatchChangeSummary(item.input);
			const rendered = `${theme.fg("toolTitle", theme.bold(patchTitle))} ${theme.fg(item.isError ? "error" : "success", changeSummary)}\n${renderDroidPatchPreview(patch, expanded, theme)}`;
			return new Text(rendered, 0, 0);
		}
	}
	const text = item.content.trim() || fallbackText || (item.isError ? "Droid native tool failed without output." : "Droid native tool completed without output.");
	return new Text(`${theme.fg("toolTitle", theme.bold(title))}\n${renderMutedBlock(limitOutputLines(text, expanded), theme)}`, 0, 0);
}

export function recordDroidNativeToolDisplay(item: DroidNativeToolDisplayItem): void {
	displayItemsByPiToolCallId.set(item.piToolCallId, item);
}

export function deleteDroidNativeToolDisplay(piToolCallId: string): void {
	displayItemsByPiToolCallId.delete(piToolCallId);
}

function createDisplayToolDefinition(toolName: DroidNativeToolDisplayToolName) {
	const label = toolName === DROID_NATIVE_TOOL_DISPLAY_TOOL_NAME ? "Droid tool" : toolName.replace(/^droid_/, "droid ");
	return {
		name: toolName,
		label,
		description: `Display-only replay for a Droid-native ${label.replace(/^droid /, "")} call that already ran inside the Factory Droid SDK.`,
		parameters: Type.Object({}, { additionalProperties: true }),
		async execute(toolCallId: string, params: Record<string, unknown>) {
			const item = displayItemsByPiToolCallId.get(toolCallId);
			if (!item) {
				return {
					content: [{ type: "text" as const, text: "Droid native tool result is unavailable or already consumed." }],
					details: { toolCallId, params, displayOnly: true, missing: true },
					isError: true,
				};
			}
			displayItemsByPiToolCallId.delete(toolCallId);
			return {
				content: [{ type: "text" as const, text: summarizeResult(item) }],
				details: { toolCallId, params, ...item, mappedToolName: getDroidNativeToolDisplayToolName(item.toolName), displayOnly: true, missing: false },
				isError: item.isError,
			};
		},
		renderCall(args: unknown, theme: Parameters<NonNullable<ExtensionAPI["registerTool"]>>[0] extends never ? never : any, context?: { isPartial?: boolean }) {
			return renderDroidToolCall(toolName, args, context?.isPartial === true, theme);
		},
		renderResult(result: { content?: Array<{ type: string; text?: string }>; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: Parameters<NonNullable<ExtensionAPI["registerTool"]>>[0] extends never ? never : any) {
			if (options.isPartial) return new Text(theme.fg("warning", "Replaying Droid tool result..."), 0, 0);
			return renderDroidToolResult(getDisplayItemFromDetails(result.details), getFirstTextContent(result), options.expanded, theme);
		},
	};
}

export function registerDroidNativeToolDisplay(pi: DroidNativeToolDisplayExtensionApi): void {
	for (const toolName of DROID_NATIVE_TOOL_DISPLAY_TOOL_NAMES) {
		pi.registerTool(createDisplayToolDefinition(toolName));
	}

	pi.on("session_start", (_event, ctx) => {
		syncDroidNativeToolDisplayForModel(pi, ctx.model);
	});
	pi.on("model_select", (event) => {
		syncDroidNativeToolDisplayForModel(pi, event.model);
	});
	pi.on("session_shutdown", () => {
		displayItemsByPiToolCallId.clear();
	});
}

export const __testUtils = {
	displayItemsByPiToolCallId,
	getDroidEditArguments,
	renderDroidToolCall,
	renderDroidToolResult,
	summarizeResult,
};
