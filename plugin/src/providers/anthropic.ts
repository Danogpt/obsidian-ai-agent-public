import type { ChatRequestPayload, ChatResponsePayload, ToolCall } from '../agent/types';
import { buildMessages, buildSystemPrompt, parseToolCalls, normalizeFinalAnswer } from '../agent/prompts';
import { postJson, ProviderError } from './http';
import { rateLimitManager } from '../limits/rateLimitState';
import { getAllowedToolSchemas, toAnthropicTools, TOOL_SCHEMA_BY_NAME } from '../tools/toolSchemas';
import type { VaultToolName } from '../tools/toolTypes';
import type { ModelReasoningConfig, ReasoningEffort } from '../models/modelRegistry';
import { extractAnthropicUsage, withDuration } from './usage';

interface AnthropicResponse {
	content?: AnthropicContentBlock[];
}

type AnthropicContentBlock =
	| { type: 'text'; text?: string }
	| { type: 'thinking'; thinking?: string; signature?: string }
	| { type: 'redacted_thinking'; data?: string }
	| { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
	| { type: 'server_tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
	| { type: string; text?: string; thinking?: string; signature?: string; data?: string; id?: string; name?: string; input?: Record<string, unknown> };

type AnthropicMessage = {
	role: 'user' | 'assistant';
	content: string | AnthropicContentBlock[] | Array<{
		type: 'tool_result';
		tool_use_id: string;
		content: string;
		is_error?: boolean;
	}>;
};

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

function anthropicThinkingBlocks(result: ChatRequestPayload['tool_results'][number]): AnthropicContentBlock[] {
	const raw = result.provider_context?.['anthropic_thinking_blocks'];
	return Array.isArray(raw) ? raw.filter((block): block is AnthropicContentBlock => Boolean(block) && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string') : [];
}

function dedupeAnthropicThinkingBlocks(blocks: AnthropicContentBlock[]): AnthropicContentBlock[] {
	const seen = new Set<string>();
	const deduped: AnthropicContentBlock[] = [];
	for (const block of blocks) {
		const redactedData = 'data' in block && typeof block.data === 'string' ? block.data : '';
		const key = block.type === 'thinking'
			? `${block.type}:${block.signature ?? ''}:${block.thinking ?? ''}`
			: `${block.type}:${redactedData}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(block);
	}
	return deduped;
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

export function buildAnthropicThinkingConfig(
	reasoning: ModelReasoningConfig | undefined,
	thinkingMode: boolean,
): {
	thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
	outputConfig?: { effort: Exclude<ReasoningEffort, 'none' | 'minimal'> };
	budgetTokens?: number;
} {
	const anthropicReasoning = reasoning?.provider === 'anthropic' ? reasoning : undefined;
	if (anthropicReasoning?.mode === 'off') return {};
	if (anthropicReasoning?.mode === 'manual') {
		return {
			thinking: { type: 'enabled', budget_tokens: anthropicReasoning.budgetTokens },
			outputConfig: anthropicReasoning.effort ? { effort: anthropicReasoning.effort } : undefined,
			budgetTokens: anthropicReasoning.budgetTokens,
		};
	}
	if (anthropicReasoning?.mode === 'adaptive') {
		return {
			thinking: { type: 'adaptive' },
			outputConfig: { effort: anthropicReasoning.effort },
		};
	}
	if (thinkingMode) {
		return {
			thinking: { type: 'adaptive' },
			outputConfig: { effort: 'high' },
		};
	}
	return {};
}

export function buildAnthropicMessages(req: ChatRequestPayload): [AnthropicMessage[], string[]] {
	const { localResults, hostResults } = splitToolResults(req.tool_results);
	const nativeToolRequest: ChatRequestPayload = {
		...req,
		tool_results: hostResults,
		options: {
			...req.options,
			native_tool_calling: req.options.vault_tools_enabled,
		},
	};
	const [allMessages, sources] = buildMessages(nativeToolRequest);
	const convMessages: AnthropicMessage[] = allMessages
		.filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
		.map(m => ({ role: m.role, content: m.content }));

	if (req.options.vault_tools_enabled && req.tool_results.length > 0) {
		if (localResults.length > 0) {
			const thinkingBlocks = dedupeAnthropicThinkingBlocks(localResults.flatMap(anthropicThinkingBlocks));
			convMessages.push({
				role: 'assistant',
				content: [
					...thinkingBlocks,
					...localResults.map(result => ({
						type: 'tool_use',
						id: result.id,
						name: result.tool,
						input: result.args ?? {},
					})),
				],
			});
			convMessages.push({
				role: 'user',
				content: localResults.map(result => ({
					type: 'tool_result',
					tool_use_id: result.id,
					content: stringifyToolResult(result),
					is_error: !result.ok,
				})),
			});
		}
	}

	return [convMessages, sources];
}

export function extractAnthropicToolCalls(data: AnthropicResponse): ToolCall[] {
	const calls: ToolCall[] = [];
	const thinkingBlocks = (data.content ?? []).filter(block => block.type === 'thinking' || block.type === 'redacted_thinking');
	for (const [index, block] of (data.content ?? []).entries()) {
		if (block.type !== 'tool_use') continue;
		if (!block.name || !TOOL_SCHEMA_BY_NAME.has(block.name as VaultToolName)) continue;
		calls.push({
			id: block.id ?? String(index + 1),
			tool: block.name,
			args: block.input && typeof block.input === 'object' ? block.input : {},
			provider_context: thinkingBlocks.length > 0 ? { anthropic_thinking_blocks: thinkingBlocks } : undefined,
		});
	}
	return calls;
}

export async function callAnthropic(req: ChatRequestPayload): Promise<ChatResponsePayload> {
	if (!req.auth.api_key) throw new ProviderError('anthropic', 0, 'Anthropic API key is missing.');

	const events = [
		{ type: 'status', text: 'Planning next moves' },
		{ type: 'status', text: 'Packing Obsidian context' },
	];
	if (req.options.thinking_mode)       events.push({ type: 'status', text: 'Extended thinking enabled' });
	const canSendWebSearch = req.options.web_search && !req.options.thinking_mode;
	if (canSendWebSearch)               events.push({ type: 'status', text: 'Websearch enabled' });
	else if (req.options.web_search)     events.push({ type: 'status', text: 'Websearch disabled for Claude thinking mode' });
	if (req.options.vault_tools_enabled) events.push({ type: 'status', text: 'Vault tools enabled' });
	events.push({ type: 'status', text: `Calling ${req.model}` });

	const nativeToolRequest: ChatRequestPayload = {
		...req,
		options: {
			...req.options,
			native_tool_calling: req.options.vault_tools_enabled,
		},
	};
	const [convMessages, sources] = buildAnthropicMessages(nativeToolRequest);
	const system = buildSystemPrompt(nativeToolRequest);

	const thinkingConfig = buildAnthropicThinkingConfig(req.options.reasoning, req.options.thinking_mode);
	const requestedMaxTokens = req.options.max_output_tokens ?? 8000;
	const maxTokens = thinkingConfig.budgetTokens
		? Math.max(requestedMaxTokens, thinkingConfig.budgetTokens + 1024)
		: requestedMaxTokens;
	const body: Record<string, unknown> = {
		model: req.model,
		max_tokens: maxTokens,
		system,
		messages: convMessages,
	};
	if (thinkingConfig.thinking) body.thinking = thinkingConfig.thinking;
	if (thinkingConfig.outputConfig) body.output_config = thinkingConfig.outputConfig;
	const tools: unknown[] = [];
	if (canSendWebSearch) {
		tools.push({ type: 'web_search_20250305', name: 'web_search' });
	}
	if (req.options.vault_tools_enabled) {
		const allowedTools = getAllowedToolSchemas({
			mode: req.options.ui_mode,
			phase: req.options.execution_phase,
			agentMode: req.options.agent_mode,
			allowedToolNames: req.options.allowed_tool_names,
		});
		tools.push(...toAnthropicTools(allowedTools));
		events.push({ type: 'status', text: `Native Anthropic tools enabled (${allowedTools.length})` });
	}
	if (tools.length > 0) {
		body.tools = tools;
	}

	const startedAt = Date.now();
	const data = await postJson<AnthropicResponse>(
		'https://api.anthropic.com/v1/messages',
		body,
		{
			'x-api-key': req.auth.api_key,
			'anthropic-version': '2023-06-01',
		},
		180_000,
		(h) => rateLimitManager.updateFromHeaders(req.provider, req.model, h),
	);

	const nativeToolCalls = filterToolCallsForRequest(extractAnthropicToolCalls(data), req);
	const baseUsage = withDuration(extractAnthropicUsage(data, nativeToolCalls.length), startedAt);
	if (nativeToolCalls.length > 0) {
		return { answer: null, tool_calls: nativeToolCalls, provider: 'anthropic', model: req.model, events, sources: [], usage: baseUsage };
	}

	const answer = (data.content ?? [])
		.filter((b): b is { type: 'text'; text?: string } => b.type === 'text')
		.map(b => b.text ?? '')
		.join('\n')
		.trim();

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
			if (tool_calls.length === 0) return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'anthropic', model: req.model, events, sources, usage };
			return { answer: null, tool_calls, provider: 'anthropic', model: req.model, events, sources: [], usage };
		}
		return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'anthropic', model: req.model, events, sources, usage: baseUsage };
	}

	return { answer, tool_calls: [], provider: 'anthropic', model: req.model, events, sources, usage: baseUsage };
}
