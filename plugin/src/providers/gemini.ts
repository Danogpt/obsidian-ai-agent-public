import type { ChatRequestPayload, ChatResponsePayload, ToolCall } from '../agent/types';
import { buildSystemPrompt, buildUserContent, parseToolCalls, normalizeFinalAnswer } from '../agent/prompts';
import { postJson, ProviderError } from './http';
import { rateLimitManager } from '../limits/rateLimitState';
import { getAllowedToolSchemas, toGeminiFunctionDeclarations, TOOL_SCHEMA_BY_NAME } from '../tools/toolSchemas';
import type { VaultToolName } from '../tools/toolTypes';
import { extractGeminiUsage, withDuration } from './usage';

interface GeminiResponse {
	candidates?: Array<{
		content?: { parts?: GeminiPart[] };
	}>;
}

type GeminiPart = {
	text?: string;
	functionCall?: {
		name?: string;
		args?: Record<string, unknown>;
	};
	functionResponse?: {
		name: string;
		response: Record<string, unknown>;
	};
	thoughtSignature?: string;
	thought_signature?: string;
};

type GeminiContent = {
	role: 'user' | 'model';
	parts: GeminiPart[];
};

function stringifyToolResult(result: ChatRequestPayload['tool_results'][number]): Record<string, unknown> {
	if (result.ok) {
		return { result: result.result ?? 'ok' };
	}
	return { error: result.error ?? 'Tool failed.' };
}

function splitToolResults(results: ChatRequestPayload['tool_results']): {
	localResults: ChatRequestPayload['tool_results'];
	hostResults: ChatRequestPayload['tool_results'];
} {
	const localResults = results.filter(result => TOOL_SCHEMA_BY_NAME.has(result.tool as VaultToolName));
	const hostResults = results.filter(result => !TOOL_SCHEMA_BY_NAME.has(result.tool as VaultToolName));
	return { localResults, hostResults };
}

export function buildGeminiContents(req: ChatRequestPayload): [GeminiContent[], string[]] {
	const { localResults, hostResults } = splitToolResults(req.tool_results);
	const nativeToolRequest: ChatRequestPayload = {
		...req,
		tool_results: hostResults,
		options: {
			...req.options,
			native_tool_calling: req.options.vault_tools_enabled,
		},
	};
	const [userContent, sources] = buildUserContent(nativeToolRequest);
	const contents: GeminiContent[] = [];
	for (const h of req.history.slice(-24)) {
		contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] });
	}
	contents.push({ role: 'user', parts: [{ text: userContent }] });

	if (req.options.vault_tools_enabled && req.tool_results.length > 0) {
		if (localResults.length > 0) {
			contents.push({
				role: 'model',
				parts: localResults.map(result => ({
					functionCall: {
						name: result.tool,
						args: result.args ?? {},
					},
					...(result.thought_signature ? { thoughtSignature: result.thought_signature } : {}),
				})),
			});
			contents.push({
				role: 'user',
				parts: localResults.map(result => ({
					functionResponse: {
						name: result.tool,
						response: stringifyToolResult(result),
					},
				})),
			});
		}
	}

	return [contents, sources];
}

export function extractGeminiToolCalls(data: GeminiResponse): ToolCall[] {
	const parts = data.candidates?.[0]?.content?.parts ?? [];
	const calls: ToolCall[] = [];
	for (const [index, part] of parts.entries()) {
		const fc = part.functionCall;
		if (!fc?.name || !TOOL_SCHEMA_BY_NAME.has(fc.name as VaultToolName)) continue;
		calls.push({
			id: `${fc.name}_${index + 1}`,
			tool: fc.name,
			args: fc.args && typeof fc.args === 'object' ? fc.args : {},
			thought_signature: part.thoughtSignature ?? part.thought_signature,
		});
	}
	return calls;
}

export function geminiThinkingConfig(reqOrModel: ChatRequestPayload | string): Record<string, unknown> | null {
	const reasoning = typeof reqOrModel === 'string' ? undefined : reqOrModel.options.reasoning;
	if (reasoning?.provider === 'gemini') {
		if (reasoning.mode === 'level') {
			return { thinkingConfig: { thinkingLevel: reasoning.level.toUpperCase() } };
		}
		return { thinkingConfig: { thinkingBudget: reasoning.budget } };
	}
	const model = typeof reqOrModel === 'string' ? reqOrModel : reqOrModel.model;
	const normalized = model.toLowerCase();
	if (normalized.includes('gemini-3')) {
		return { thinkingConfig: { thinkingLevel: 'HIGH' } };
	}
	if (normalized.includes('gemini-2.5')) {
		return { thinkingConfig: { thinkingBudget: -1 } };
	}
	return null;
}

export function geminiToolConfig(): Record<string, unknown> {
	return {
		functionCallingConfig: {
			mode: 'AUTO',
		},
	};
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

export async function callGemini(req: ChatRequestPayload): Promise<ChatResponsePayload> {
	if (!req.auth.api_key) throw new ProviderError('gemini', 0, 'Gemini API key is missing.');

	const events = [
		{ type: 'status', text: 'Planning next moves' },
		{ type: 'status', text: 'Packing Obsidian context' },
	];
	if (req.options.web_search)          events.push({ type: 'status', text: 'Google Search grounding enabled' });
	if (req.options.thinking_mode)       events.push({ type: 'status', text: 'Gemini thinking enabled' });
	if (req.options.vault_tools_enabled) events.push({ type: 'status', text: 'Vault tools enabled' });
	events.push({ type: 'status', text: `Calling ${req.model}` });

	const nativeToolRequest: ChatRequestPayload = {
		...req,
		options: {
			...req.options,
			native_tool_calling: req.options.vault_tools_enabled,
		},
	};
	const system = buildSystemPrompt(nativeToolRequest);
	const [contents, sources] = buildGeminiContents(nativeToolRequest);

	const body: Record<string, unknown> = {
		contents,
		systemInstruction: { parts: [{ text: system }] },
	};
	const tools: unknown[] = [];
	if (req.options.web_search) tools.push({ googleSearch: {} });
	if (req.options.vault_tools_enabled) {
		const allowedTools = getAllowedToolSchemas({
			mode: req.options.ui_mode,
			phase: req.options.execution_phase,
			agentMode: req.options.agent_mode,
			allowedToolNames: req.options.allowed_tool_names,
		});
		tools.push({ functionDeclarations: toGeminiFunctionDeclarations(allowedTools) });
		body.toolConfig = geminiToolConfig();
		events.push({ type: 'status', text: `Native Gemini tools enabled (${allowedTools.length})` });
	}
	if (tools.length > 0) body.tools = tools;
	if (req.options.reasoning?.provider === 'gemini' || req.options.thinking_mode) {
		const config = geminiThinkingConfig(req);
		if (config) body.generationConfig = config;
	}

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent`;

	const startedAt = Date.now();
	const data = await postJson<GeminiResponse>(
		url, body, { 'x-goog-api-key': req.auth.api_key }, 180_000,
		(h) => rateLimitManager.updateFromHeaders(req.provider, req.model, h),
	);

	const nativeToolCalls = filterToolCallsForRequest(extractGeminiToolCalls(data), req);
	const baseUsage = withDuration(extractGeminiUsage(data, nativeToolCalls.length, req.options.web_search), startedAt);
	if (nativeToolCalls.length > 0) {
		return { answer: null, tool_calls: nativeToolCalls, provider: 'gemini', model: req.model, events, sources: [], usage: baseUsage };
	}

	const answer = (data.candidates?.[0]?.content?.parts ?? [])
		.map(p => p.text ?? '')
		.join('')
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
			if (tool_calls.length === 0) return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'gemini', model: req.model, events, sources, usage };
			return { answer: null, tool_calls, provider: 'gemini', model: req.model, events, sources: [], usage };
		}
		return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'gemini', model: req.model, events, sources, usage: baseUsage };
	}

	return { answer, tool_calls: [], provider: 'gemini', model: req.model, events, sources, usage: baseUsage };
}
