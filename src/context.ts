import type { Context, Message, ToolCall } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { getDroidPiBridgeContractText } from "./droid-bridge-contract.js";

export interface DroidPrompt {
	text: string;
	images: Array<{ data: string; mimeType: string }>;
}

export interface DroidPromptOptions {
	maxInputTokens?: number;
	charsPerToken?: number;
	imageTokenEstimate?: number;
}

export const DROID_APPROX_CHARS_PER_TOKEN = 4;
export const DROID_IMAGE_TOKEN_ESTIMATE = 1200;
const SECTION_SEPARATOR = "\n\n";

function normalizePiContextMessages(messages: Context["messages"]): Message[] {
	return convertToLlm(messages as Parameters<typeof convertToLlm>[0]);
}

function isTextBlock(block: { type: string }): block is { type: "text"; text: string } {
	return block.type === "text";
}

function isImageBlock(block: { type: string }): block is { type: "image"; data: string; mimeType: string } {
	return block.type === "image";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function extractLatestImages(messages: Message[]): DroidPrompt["images"] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") return [];

		const images: DroidPrompt["images"] = [];
		for (const block of msg.content) {
			if (isImageBlock(block) && block.data && block.mimeType) {
				images.push({ data: block.data, mimeType: block.mimeType });
			}
		}
		return images;
	}
	return [];
}

function formatContentBlocks(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (isTextBlock(block)) return block.text;
			if (block.type === "image") return "[image omitted from transcript]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function formatToolCall(toolCall: ToolCall): string {
	const args = JSON.stringify(toolCall.arguments) ?? "";
	return `Tool call (${toolCall.name}, call ${toolCall.id}): ${args}`;
}

function sanitizeSystemPromptForDroid(systemPrompt: string): string {
	let sanitized = systemPrompt;
	sanitized = sanitized.replace(
		/Available tools:\n[\s\S]*?\n\nIn addition to the tools above, you may have access to other custom tools depending on the project\.\n\n/g,
		"Pi tool catalog omitted: Droid can call only Droid SDK / bridged MCP tools exposed in this run.\n\n",
	);
	sanitized = sanitized.replace(
		/\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/g,
		"",
	);
	return sanitized.trim();
}

function formatMessage(msg: Message): string | undefined {
	switch (msg.role) {
		case "user": {
			const text = formatContentBlocks(msg.content);
			return `User: ${text || "[non-text content]"}`;
		}
		case "assistant": {
			const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: String(msg.content) }];
			const textParts: string[] = [];
			for (const block of blocks) {
				if (isTextBlock(block)) textParts.push(block.text);
				else if (isToolCallBlock(block)) textParts.push(formatToolCall(block));
			}
			return textParts.length > 0 ? `Assistant: ${textParts.join("\n")}` : undefined;
		}
		case "toolResult": {
			const text = formatContentBlocks(msg.content);
			const label = msg.isError ? "Tool error" : "Tool result";
			return `${label} (${msg.toolName}, call ${msg.toolCallId}): ${text || "[no text content]"}`;
		}
	}
}

function getLatestUserMessageIndex(messages: Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user") return index;
	}
	return -1;
}

function getRequiredMessageIndexes(messages: Message[]): Set<number> {
	const required = new Set<number>();
	const latestUserIndex = getLatestUserMessageIndex(messages);
	if (latestUserIndex >= 0) required.add(latestUserIndex);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role !== "toolResult") break;
		required.add(index);
	}
	return required;
}

function getSectionCost(section: string): number {
	return section.length + SECTION_SEPARATOR.length;
}

function applyPromptBudget(
	sectionsBeforeMessages: string[],
	messageSections: Array<{ index: number; text: string }>,
	sectionsAfterMessages: string[],
	requiredMessageIndexes: Set<number>,
	options: DroidPromptOptions,
): string[] {
	const maxInputTokens = options.maxInputTokens;
	if (maxInputTokens === undefined || !Number.isFinite(maxInputTokens) || maxInputTokens <= 0) {
		return [...sectionsBeforeMessages, ...messageSections.map((section) => section.text), ...sectionsAfterMessages];
	}

	const charsPerToken = options.charsPerToken ?? DROID_APPROX_CHARS_PER_TOKEN;
	const imageTokenEstimate = options.imageTokenEstimate ?? DROID_IMAGE_TOKEN_ESTIMATE;
	const maxChars = Math.max(1, Math.floor(maxInputTokens * charsPerToken));
	const imageBudgetChars = Math.floor(extractLatestImageCountFromSections(messageSections) * imageTokenEstimate * charsPerToken);
	const effectiveMaxChars = Math.max(1, maxChars - imageBudgetChars);
	const requiredMessageSections = messageSections.filter((section) => requiredMessageIndexes.has(section.index));
	const requiredCost = [...sectionsBeforeMessages, ...requiredMessageSections.map((section) => section.text), ...sectionsAfterMessages].reduce(
		(total, section) => total + getSectionCost(section),
		0,
	);
	let remainingChars = effectiveMaxChars - requiredCost;
	const includedMessageIndexes = new Set(requiredMessageSections.map((section) => section.index));
	let omittedMessageCount = 0;

	for (let index = messageSections.length - 1; index >= 0; index -= 1) {
		const section = messageSections[index];
		if (includedMessageIndexes.has(section.index)) continue;
		const cost = getSectionCost(section.text);
		if (cost <= remainingChars) {
			includedMessageIndexes.add(section.index);
			remainingChars -= cost;
			continue;
		}
		omittedMessageCount += messageSections
			.slice(0, index + 1)
			.filter((candidate) => !includedMessageIndexes.has(candidate.index)).length;
		break;
	}

	const budgetNotice =
		omittedMessageCount > 0
			? [`[Earlier transcript omitted: ${omittedMessageCount} message${omittedMessageCount === 1 ? "" : "s"} to fit Droid context budget]`]
			: [];
	const includedMessages = messageSections
		.filter((section) => includedMessageIndexes.has(section.index))
		.map((section) => section.text);
	return [...sectionsBeforeMessages, ...budgetNotice, ...includedMessages, ...sectionsAfterMessages];
}

function extractLatestImageCountFromSections(messageSections: Array<{ text: string }>): number {
	const latestNotice = [...messageSections].reverse().find((section) => section.text.includes("[Latest user turn includes "))?.text;
	const match = latestNotice ? /\[Latest user turn includes (\d+) image\(s\) attached to this request\.\]/.exec(latestNotice) : undefined;
	return match ? Number(match[1]) : 0;
}

export function estimateDroidTextTokens(text: string, options: Pick<DroidPromptOptions, "charsPerToken"> = {}): number {
	const charsPerToken = options.charsPerToken ?? DROID_APPROX_CHARS_PER_TOKEN;
	return Math.ceil(text.length / charsPerToken);
}

export function estimateDroidPromptInputTokens(prompt: DroidPrompt, options: DroidPromptOptions = {}): number {
	const imageTokenEstimate = options.imageTokenEstimate ?? DROID_IMAGE_TOKEN_ESTIMATE;
	return estimateDroidTextTokens(prompt.text, options) + prompt.images.length * imageTokenEstimate;
}

export function estimateDroidPromptMessageTokens(message: Message, options: Pick<DroidPromptOptions, "charsPerToken"> = {}): number {
	const text = formatMessage(message);
	return text ? estimateDroidTextTokens(text, options) : 0;
}

export function estimateDroidContextTokens(context: Context, options: DroidPromptOptions = {}): number {
	return estimateDroidPromptInputTokens(buildDroidPrompt(context, options), options);
}

export function buildDroidPrompt(context: Context, options: DroidPromptOptions = {}): DroidPrompt {
	const messages = normalizePiContextMessages(context.messages);
	const images = extractLatestImages(messages);
	const sectionsBeforeMessages: string[] = [];

	if (context.systemPrompt?.trim()) {
		sectionsBeforeMessages.push(sanitizeSystemPromptForDroid(context.systemPrompt.trim()));
	}

	sectionsBeforeMessages.push(getDroidPiBridgeContractText());

	const messageSections: Array<{ index: number; text: string }> = [];
	const latestUserIndex = getLatestUserMessageIndex(messages);
	for (let index = 0; index < messages.length; index += 1) {
		const formatted = formatMessage(messages[index]);
		if (!formatted) continue;
		messageSections.push({
			index,
			text: index === latestUserIndex && images.length > 0
				? `${formatted}\n[Latest user turn includes ${images.length} image(s) attached to this request.]`
				: formatted,
		});
	}

	const sections = applyPromptBudget(sectionsBeforeMessages, messageSections, [], getRequiredMessageIndexes(messages), options);
	const text = sections.join(SECTION_SEPARATOR);
	return { text, images };
}
