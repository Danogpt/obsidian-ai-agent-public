import type { ChatRequestPayload, ChatResponsePayload, ToolCall } from '../agent/types';
import type { ApiMessage } from '../agent/prompts';
import { buildMessages, parseToolCalls, normalizeFinalAnswer } from '../agent/prompts';
import { postJson, bearerHeaders, ProviderError } from './http';
import { rateLimitManager } from '../limits/rateLimitState';
import { getAllowedToolSchemas, toOpenAITools, TOOL_SCHEMA_BY_NAME } from '../tools/toolSchemas';
import type { VaultToolName } from '../tools/toolTypes';
import { extractOpenAIUsage, withDuration } from './usage';

interface ResponsesOutput {
	id?: string;
	output_text?: string;
	output?: Array<{
		type: string;
		content?: Array<{ type: string; text?: string }>;
		call_id?: string;
		id?: string;
		name?: string;
		arguments?: string | Record<string, unknown>;
	}>;
}

type OpenAIInputItem =
	| ApiMessage
	| {
		type: 'function_call';
		call_id: string;
		name: string;
		arguments: string;
	}
	| {
		type: 'function_call_output';
		call_id: string;
		output: string;
	};

function extractText(data: ResponsesOutput): string {
	if (data.output_text) return data.output_text.trim();
	for (const item of data.output ?? []) {
		for (const block of item.content ?? []) {
			if ((block.type === 'output_text' || block.type === 'text') && block.text) {
				return block.text.trim();
			}
		}
	}
	return '';
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

function openAIResponseId(result: ChatRequestPayload['tool_results'][number]): string | undefined {
	const value = result.provider_context?.['openai_response_id'];
	return typeof value === 'string' && value ? value : undefined;
}

function formatHostFeedback(results: ChatRequestPayload['tool_results']): string {
	return [
		'Host feedback for the next step:',
		...results.map(result => {
			const status = result.ok ? 'ok' : 'error';
			const detail = result.ok
				? stringifyToolResult(result)
				: result.error ?? 'Tool failed.';
			return `- ${result.tool} (${status}): ${detail}`;
		}),
	].join('\n');
}

export function buildOpenAIInput(req: ChatRequestPayload): [OpenAIInputItem[], string[]] {
	const { localResults, hostResults } = splitToolResults(req.tool_results);
	const previousResponseId = previousOpenAIResponseId(req.tool_results);
	if (previousResponseId) {
		const input: OpenAIInputItem[] = [];
		for (const result of localResults) {
			if (openAIResponseId(result) !== previousResponseId) continue;
			input.push({
				type: 'function_call_output',
				call_id: result.id,
				output: stringifyToolResult(result),
			});
		}
		if (hostResults.length > 0) {
			input.push({ role: 'user', content: formatHostFeedback(hostResults) });
		}
		return [input, []];
	}
	const nativeToolRequest: ChatRequestPayload = {
		...req,
		tool_results: hostResults,
		options: {
			...req.options,
			native_tool_calling: req.options.vault_tools_enabled,
		},
	};
	const [messages, sources] = buildMessages(nativeToolRequest);
	const input: OpenAIInputItem[] = [...messages];

	if (req.options.vault_tools_enabled && localResults.length > 0) {
		for (const result of localResults) {
			input.push({
				type: 'function_call',
				call_id: result.id,
				name: result.tool,
				arguments: JSON.stringify(result.args ?? {}),
			});
			input.push({
				type: 'function_call_output',
				call_id: result.id,
				output: stringifyToolResult(result),
			});
		}
	}

	return [input, sources];
}

function parseNativeToolArguments(value: string | Record<string, unknown> | undefined): Record<string, unknown> {
	if (!value) return {};
	if (typeof value !== 'string') return value;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

export function extractNativeToolCalls(data: ResponsesOutput): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const [index, item] of (data.output ?? []).entries()) {
		if (item.type !== 'function_call') continue;
		if (!item.name || !TOOL_SCHEMA_BY_NAME.has(item.name as VaultToolName)) continue;
		calls.push({
			id: item.call_id ?? item.id ?? String(index + 1),
			tool: item.name,
			args: parseNativeToolArguments(item.arguments),
			provider_context: data.id ? { openai_response_id: data.id } : undefined,
		});
	}
	return calls;
}

function previousOpenAIResponseId(results: ChatRequestPayload['tool_results']): string | undefined {
	for (let index = results.length - 1; index >= 0; index--) {
		const result = results[index];
		if (!result) continue;
		const value = openAIResponseId(result);
		if (value) return value;
	}
	return undefined;
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

export async function callOpenAI(req: ChatRequestPayload): Promise<ChatResponsePayload> {
	if (!req.auth.api_key) throw new ProviderError('openai', 0, 'OpenAI API key is missing.');

	const events = [
		{ type: 'status', text: 'Planning next moves' },
		{ type: 'status', text: 'Packing Obsidian context' },
	];
	if (req.options.web_search)     events.push({ type: 'status', text: 'Websearch enabled' });
	if (req.options.thinking_mode)  events.push({ type: 'status', text: 'Reasoning enabled' });
	if (req.options.vault_tools_enabled) events.push({ type: 'status', text: 'Vault tools enabled' });
	events.push({ type: 'status', text: `Calling ${req.model}` });

	const nativeToolRequest: ChatRequestPayload = {
		...req,
		options: {
			...req.options,
			native_tool_calling: req.options.vault_tools_enabled,
		},
	};
	const [input, sources] = buildOpenAIInput(nativeToolRequest);

	const body: Record<string, unknown> = { model: req.model, input };
	const previousResponseId = previousOpenAIResponseId(req.tool_results);
	if (previousResponseId) body.previous_response_id = previousResponseId;
	const tools: unknown[] = [];
	if (req.options.web_search) tools.push({ type: 'web_search_preview' });
	if (req.options.vault_tools_enabled) {
		const allowedTools = getAllowedToolSchemas({
			mode: req.options.ui_mode,
			phase: req.options.execution_phase,
			agentMode: req.options.agent_mode,
			allowedToolNames: req.options.allowed_tool_names,
		});
		tools.push(...toOpenAITools(allowedTools));
		events.push({ type: 'status', text: `Native OpenAI tools enabled (${allowedTools.length})` });
	}
	if (tools.length > 0) {
		body.tools = tools;
		body.tool_choice = 'auto';
	}
	if (req.options.reasoning?.provider === 'openai' && req.options.reasoning.effort !== 'none') {
		body.reasoning = { effort: req.options.reasoning.effort };
	} else if (req.options.thinking_mode) {
		body.reasoning = { effort: 'high' };
	}

	const startedAt = Date.now();
	const data = await postJson<ResponsesOutput>(
		'https://api.openai.com/v1/responses',
		body,
		bearerHeaders(req.auth.api_key),
		180_000,
		(h) => rateLimitManager.updateFromHeaders(req.provider, req.model, h),
	);

	const nativeToolCalls = filterToolCallsForRequest(extractNativeToolCalls(data), req);
	const baseUsage = withDuration(extractOpenAIUsage(data, nativeToolCalls.length), startedAt);
	if (nativeToolCalls.length > 0) {
		return { answer: null, tool_calls: nativeToolCalls, provider: 'openai', model: req.model, events, sources: [], response_id: data.id, usage: baseUsage };
	}

	const answer = extractText(data);

	if (req.options.vault_tools_enabled) {
		const calls = parseToolCalls(answer);
		if (calls) {
			const tool_calls: ToolCall[] = filterToolCallsForRequest(calls.map((tc, i) => ({
				id: tc.id ?? String(i + 1),
				tool: tc.tool,
				args: tc.args ?? {},
				reason: tc.reason,
			})), req);
			const usage = { ...baseUsage, toolCallCount: tool_calls.length };
			if (tool_calls.length === 0) return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'openai', model: req.model, events, sources, response_id: data.id, usage };
			return { answer: null, tool_calls, provider: 'openai', model: req.model, events, sources: [], response_id: data.id, usage };
		}
		return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'openai', model: req.model, events, sources, response_id: data.id, usage: baseUsage };
	}

	return { answer, tool_calls: [], provider: 'openai', model: req.model, events, sources, response_id: data.id, usage: baseUsage };
}
