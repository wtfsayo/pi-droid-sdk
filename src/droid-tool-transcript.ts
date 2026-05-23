const DEFAULT_MAX_TRANSCRIPT_CHARS = 24000;

export interface DroidNativeToolTranscriptItem {
	toolName: string;
	input: Record<string, unknown>;
	progress: string[];
	content: string;
	isError: boolean;
}

function getString(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function stringifyUnknown(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function limitText(text: string, maxChars = DEFAULT_MAX_TRANSCRIPT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n... (${text.length - maxChars} more chars truncated)`;
}

export interface DroidTodoItem {
	index?: number;
	status: string;
	text: string;
}

function normalizeTodoStatus(status: string): string {
	const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (normalized === "inprogress") return "in_progress";
	if (normalized === "todo") return "pending";
	return normalized || "pending";
}

export function parseDroidTodos(value: unknown): DroidTodoItem[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry, index) => {
			if (typeof entry === "string") return parseDroidTodos(entry);
			if (!entry || typeof entry !== "object") return [];
			const record = entry as Record<string, unknown>;
			const text = getString(record, ["text", "content", "task", "todo", "title"]);
			if (!text) return [];
			return [{
				index: typeof record.index === "number" ? record.index : index + 1,
				status: normalizeTodoStatus(getString(record, ["status", "state"]) ?? "pending"),
				text,
			}];
		});
	}
	const text = stringifyUnknown(value).trim();
	if (!text) return [];
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			const match = /^(?:(\d+)\.\s*)?\[([^\]]+)\]\s*(.+)$/.exec(line) ?? /^(?:(\d+)\.\s*)?[-*]?\s*([^:]+):\s*(.+)$/.exec(line);
			if (!match) return { index: index + 1, status: "pending", text: line };
			return {
				index: match[1] ? Number(match[1]) : index + 1,
				status: normalizeTodoStatus(match[2] ?? "pending"),
				text: match[3]?.trim() ?? line,
			};
		});
}

export function getDroidTodoStatusIcon(status: string | undefined): string {
	if (status === "completed") return "✓";
	if (status === "in_progress") return "…";
	if (status === "pending") return "○";
	return "•";
}

export function formatDroidTodoStatusLabel(status: string | undefined): string {
	if (status === "in_progress") return "in progress";
	return status?.replace(/_/g, " ") || "todo";
}

export function formatDroidTodos(value: unknown): string {
	const todos = parseDroidTodos(value);
	if (todos.length === 0) return stringifyUnknown(value).trim();
	return todos
		.map((todo) => `${getDroidTodoStatusIcon(todo.status)} ${todo.text} (${formatDroidTodoStatusLabel(todo.status)})`)
		.join("\n");
}

export function summarizeDroidTodos(value: unknown): string {
	const todos = parseDroidTodos(value);
	if (todos.length === 0) return "";
	const total = todos.length;
	const completed = todos.filter((todo) => todo.status === "completed").length;
	const inProgress = todos.filter((todo) => todo.status === "in_progress").length;
	const pending = todos.filter((todo) => todo.status === "pending").length;
	const parts = [`${completed}/${total} completed`];
	if (inProgress > 0) parts.push(`${inProgress} in progress`);
	if (pending > 0) parts.push(`${pending} pending`);
	const otherCounts = new Map<string, number>();
	for (const todo of todos) {
		if (todo.status === "completed" || todo.status === "in_progress" || todo.status === "pending") continue;
		otherCounts.set(todo.status, (otherCounts.get(todo.status) ?? 0) + 1);
	}
	for (const [status, count] of otherCounts) parts.push(`${count} ${formatDroidTodoStatusLabel(status)}`);
	return parts.join(", ");
}

export interface DroidPatchSummary {
	paths: string[];
	operation: "add" | "update" | "delete" | "patch";
	addedLines: number;
	removedLines: number;
}

export function pluralizeDroidCount(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function getDroidPatchText(input: Record<string, unknown>): string | undefined {
	return getString(input, ["input", "patch", "diff", "content"]);
}

export function summarizeDroidPatch(input: Record<string, unknown>): DroidPatchSummary | undefined {
	const patch = getDroidPatchText(input);
	if (!patch) return undefined;
	const paths: string[] = [];
	let operation: DroidPatchSummary["operation"] = "patch";
	let addedLines = 0;
	let removedLines = 0;
	for (const line of patch.split(/\r?\n/)) {
		const fileMatch = /^\*\*\* (Add|Update|Delete) File:\s+(.+)$/.exec(line.trim());
		if (fileMatch) {
			const op = fileMatch[1]?.toLowerCase();
			if (op === "add" || op === "update" || op === "delete") operation = op;
			const path = fileMatch[2]?.trim();
			if (path && !paths.includes(path)) paths.push(path);
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
	}
	return { paths, operation, addedLines, removedLines };
}

export function formatDroidPatchSummary(input: Record<string, unknown>): string {
	const summary = summarizeDroidPatch(input);
	if (!summary) return "";
	const path = summary.paths.length === 0
		? "patch"
		: summary.paths.length === 1
			? summary.paths[0]
			: `${summary.paths[0]} (+${summary.paths.length - 1} files)`;
	const changes = [
		summary.addedLines > 0 ? `+${summary.addedLines}` : undefined,
		summary.removedLines > 0 ? `-${summary.removedLines}` : undefined,
	].filter(Boolean).join("/");
	return `${path}${changes ? ` ${changes}` : ""}`;
}

export function formatDroidPatchChangeSummary(input: Record<string, unknown>): string {
	const summary = summarizeDroidPatch(input);
	if (!summary) return "patch";
	if (summary.operation === "add" && summary.addedLines > 0) return `created ${pluralizeDroidCount(summary.addedLines, "line")}`;
	if (summary.operation === "delete" && summary.removedLines > 0) return `deleted ${pluralizeDroidCount(summary.removedLines, "line")}`;
	const parts = [
		summary.addedLines > 0 ? `added ${pluralizeDroidCount(summary.addedLines, "line")}` : undefined,
		summary.removedLines > 0 ? `removed ${pluralizeDroidCount(summary.removedLines, "line")}` : undefined,
	].filter((entry): entry is string => Boolean(entry));
	return parts.length > 0 ? parts.join(", ") : summary.operation === "patch" ? "patched" : `${summary.operation}d`;
}

export function normalizeDroidNativeToolName(toolName: string): string {
	const normalized = toolName.replace(/\s+/g, " ").trim();
	switch (normalized.toLowerCase()) {
		case "read":
		case "read_file":
		case "readfile":
			return "read";
		case "execute":
		case "bash":
		case "shell":
		case "run_command":
		case "run_terminal_cmd":
			return "bash";
		case "edit":
		case "edit_file":
		case "editfile":
		case "str_replace":
		case "strreplace":
		case "applypatch":
		case "apply_patch":
			return "edit";
		case "write":
		case "write_file":
		case "writefile":
			return "write";
		case "grep":
		case "grep_search":
		case "search":
			return "grep";
		case "glob":
		case "find":
		case "file_search":
			return "find";
		case "ls":
		case "list":
		case "list_dir":
		case "listdir":
			return "ls";
		case "todowrite":
		case "todo_write":
		case "todo":
		case "update_todo":
		case "update_todos":
			return "todo";
		default:
			return normalized || "native tool";
	}
}

export function summarizeDroidNativeToolInput(toolName: string, input: Record<string, unknown>): string {
	switch (normalizeDroidNativeToolName(toolName)) {
		case "read":
			return getString(input, ["path", "filePath", "file_path", "target_file"]) ?? "";
		case "bash":
			return getString(input, ["command", "cmd"]) ?? "";
		case "edit":
			return getString(input, ["path", "filePath", "file_path", "target_file"]) ?? formatDroidPatchSummary(input);
		case "write":
			return getString(input, ["path", "filePath", "file_path", "target_file"]) ?? "";
		case "grep": {
			const pattern = getString(input, ["pattern", "query", "search"]);
			const path = getString(input, ["path", "includePattern", "glob_pattern", "glob"]);
			return [pattern, path].filter(Boolean).join(" in ");
		}
		case "find": {
			const pattern = getString(input, ["pattern", "query", "glob_pattern", "glob"]);
			const path = getString(input, ["path", "folder", "directory"]);
			return [pattern, path].filter(Boolean).join(" in ");
		}
		case "ls":
			return getString(input, ["path", "directory", "directory_path"]) ?? "";
		case "todo":
			return summarizeDroidTodos(input.todos ?? input.todo ?? input.items ?? input);
		default:
			return "";
	}
}

export function formatDroidNativeToolTranscript(item: DroidNativeToolTranscriptItem): string {
	const label = normalizeDroidNativeToolName(item.toolName);
	const inputSummary = summarizeDroidNativeToolInput(item.toolName, item.input);
	const header = `Droid ${label}${inputSummary ? `: ${inputSummary}` : ""}`;
	const progress = item.progress.length > 0
		? `${item.progress.map((entry) => `[progress] ${entry}`).join("\n")}\n`
		: "";
	if (label === "todo") {
		const todos = formatDroidTodos(item.input.todos ?? item.input.todo ?? item.input.items ?? item.input);
		const content = item.content.trim() && item.content.trim() !== "TODO List Updated" ? `\n\n${item.content.trim()}` : "";
		return `${header}\n\n${progress}${todos || "TODO list updated."}${content}`;
	}
	const content = item.content.trim()
		|| (item.isError ? "Droid native tool failed without output." : "Droid native tool completed without output.");
	return `${header}\n\n${progress}${limitText(stringifyUnknown(content))}`;
}
