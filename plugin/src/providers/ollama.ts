import type { ChatRequestPayload, ChatResponsePayload, ToolCall } from '../agent/types';
import { buildMessages, parseToolCalls, normalizeFinalAnswer } from '../agent/prompts';
import { postJson, ProviderError } from './http';
import { rateLimitManager } from '../limits/rateLimitState';
import { getAllowedToolSchemas, toOllamaTools, TOOL_SCHEMA_BY_NAME } from '../tools/toolSchemas';
import type { VaultToolName } from '../tools/toolTypes';
import { extractOllamaUsage, withDuration } from './usage';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

interface OllamaToolCall {
	type?: 'function';
	function?: {
		name?: string;
		arguments?: string | Record<string, unknown>;
	};
}

interface OllamaMessage {
	role?: 'system' | 'user' | 'assistant' | 'tool';
	content?: string;
	thinking?: string;
	tool_calls?: OllamaToolCall[];
	tool_name?: string;
}

interface OllamaResponse {
	message?: OllamaMessage;
}

function normalizeOllamaArguments(value: string | Record<string, unknown> | undefined): Record<string, unknown> {
	if (!value) return {};
	if (typeof value !== 'string') return value;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

export function extractOllamaToolCalls(message: OllamaMessage): ToolCall[] {
	if (!message.tool_calls?.length) return [];
	const calls: ToolCall[] = [];
	for (const [index, tc] of message.tool_calls.entries()) {
		const name = tc.function?.name;
		if (!name || !TOOL_SCHEMA_BY_NAME.has(name as VaultToolName)) continue;
		calls.push({
			id: `${name}_${index + 1}`,
			tool: name,
			args: normalizeOllamaArguments(tc.function?.arguments),
		});
	}
	return calls;
}

function isGptOssModel(model: string): boolean {
	return model.toLowerCase().includes('gpt-oss');
}

function stringifyToolResult(result: ChatRequestPayload['tool_results'][number]): string {
	if (result.ok) {
		if (typeof result.result === 'string') return result.result;
		if (result.result !== undefined) return JSON.stringify(result.result);
		return 'ok';
	}
	return result.error ?? 'Tool failed.';
}

function splitToolResults(results: ChatRequestPayload['tool_results']): {
	localResults: ChatRequestPayload['tool_results'];
	hostResults: ChatRequestPayload['tool_results'];
} {
	const localResults = results.filter(result => TOOL_SCHEMA_BY_NAME.has(result.tool as VaultToolName));
	const hostResults = results.filter(result => !TOOL_SCHEMA_BY_NAME.has(result.tool as VaultToolName));
	return { localResults, hostResults };
}

export function buildOllamaMessages(req: ChatRequestPayload): [OllamaMessage[], string[]] {
	const { localResults, hostResults } = splitToolResults(req.tool_results);
	const nativeToolRequest: ChatRequestPayload = {
		...req,
		tool_results: hostResults,
		options: {
			...req.options,
			native_tool_calling: req.options.vault_tools_enabled,
		},
	};
	const [messages, sources] = buildMessages(nativeToolRequest);
	const ollamaMessages: OllamaMessage[] = messages.map(message => ({
		role: message.role,
		content: message.content,
	}));

	if (req.options.vault_tools_enabled && req.tool_results.length > 0) {
		if (localResults.length > 0) {
			ollamaMessages.push({
				role: 'assistant',
				content: '',
				tool_calls: localResults.map(result => ({
					type: 'function',
					function: {
						name: result.tool,
						arguments: result.args ?? {},
					},
				})),
			});
			for (const result of localResults) {
				ollamaMessages.push({
					role: 'tool',
					tool_name: result.tool,
					content: stringifyToolResult(result),
				});
			}
		}
	}

	return [ollamaMessages, sources];
}

function allowedToolNamesForRequest(req: ChatRequestPayload): Set<string> | null {
	if (!req.options.vault_tools_enabled) return null;
	return new Set(getAllowedToolSchemas({
		mode: req.options.ui_mode,
		phase: req.options.execution_phase,
		agentMode: req.options.agent_mode,
		allowedToolNames: req.options.allowed_tool_names,
	}).map(tool => tool.name));
}

function filterToolCallsForRequest(calls: ToolCall[], req: ChatRequestPayload): ToolCall[] {
	const allowed = allowedToolNamesForRequest(req);
	if (!allowed) return calls;
	return calls.filter(call => allowed.has(call.tool));
}

export async function callOllama(req: ChatRequestPayload): Promise<ChatResponsePayload> {
	const baseUrl = (req.auth.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, '');

	const events = [
		{ type: 'status', text: 'Planning next moves' },
		{ type: 'status', text: 'Packing Obsidian context' },
		{ type: 'status', text: `Calling local Ollama model ${req.model}` },
	];
	if (req.options.thinking_mode)       events.push({ type: 'status', text: 'Thinking mode enabled' });
	if (req.options.vault_tools_enabled) events.push({ type: 'status', text: 'Vault tools enabled' });

	if (!req.auth.base_url && !baseUrl) {
		throw new ProviderError('ollama', 0, 'Ollama base URL is not configured.');
	}

	const [messages, sources] = buildOllamaMessages(req);

	const body: Record<string, unknown> = { model: req.model, stream: false, messages };

	if (req.options.reasoning?.provider === 'ollama') {
		body.think = req.options.reasoning.think;
	} else if (req.options.thinking_mode) {
		body.think = isGptOssModel(req.model) ? 'high' : true;
	}

	if (req.options.vault_tools_enabled) {
		const allowedTools = getAllowedToolSchemas({
			mode: req.options.ui_mode,
			phase: req.options.execution_phase,
			agentMode: req.options.agent_mode,
			allowedToolNames: req.options.allowed_tool_names,
		});
		if (allowedTools.length > 0) {
			body.tools = toOllamaTools(allowedTools);
		}
	}

	const startedAt = Date.now();
	const data = await postJson<OllamaResponse>(
		`${baseUrl}/api/chat`, body, {}, 300_000,
		(h) => rateLimitManager.updateFromHeaders(req.provider, req.model, h),
	);

	const msg = data.message ?? {};
	const content = (msg.content ?? '').trim();

	if (req.options.vault_tools_enabled) {
		// Native tool calls take priority
		const nativeCalls = filterToolCallsForRequest(extractOllamaToolCalls(msg), req);
		const baseUsage = withDuration(extractOllamaUsage(data, nativeCalls.length), startedAt);
		if (nativeCalls.length > 0) {
			return { answer: null, tool_calls: nativeCalls, provider: 'ollama', model: req.model, events, sources: [], usage: baseUsage };
		}

		// Text-JSON fallback for models without native tool support
		const parsedCalls = parseToolCalls(content);
		if (parsedCalls) {
			const tool_calls: ToolCall[] = filterToolCallsForRequest(parsedCalls.map((tc, i) => ({
				id: tc.id ?? String(i + 1),
				tool: tc.tool,
				args: tc.args ?? {},
				reason: tc.reason,
			})), req);
			const usage = { ...baseUsage, toolCallCount: tool_calls.length };
			if (tool_calls.length === 0) return { answer: normalizeFinalAnswer(content), tool_calls: [], provider: 'ollama', model: req.model, events, sources, usage };
			return { answer: null, tool_calls, provider: 'ollama', model: req.model, events, sources: [], usage };
		}
		return { answer: normalizeFinalAnswer(content), tool_calls: [], provider: 'ollama', model: req.model, events, sources, usage: baseUsage };
	}

	return { answer: content, tool_calls: [], provider: 'ollama', model: req.model, events, sources, usage: withDuration(extractOllamaUsage(data, 0), startedAt) };
}
