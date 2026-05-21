import type { ChatRequestPayload, ChatResponsePayload, ToolCall } from '../agent/types';
import { buildMessages, parseToolCalls, normalizeFinalAnswer } from '../agent/prompts';
import { postJson, ProviderError } from './http';
import { rateLimitManager } from '../limits/rateLimitState';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

interface OllamaResponse {
	message?: { content?: string };
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

	const [messages, sources] = buildMessages(req);
	const body: Record<string, unknown> = { model: req.model, stream: false, messages };
	if (req.options.thinking_mode) body.think = true;

	const data = await postJson<OllamaResponse>(
		`${baseUrl}/api/chat`, body, {}, 300_000,
		(h) => rateLimitManager.updateFromHeaders(req.provider, req.model, h),
	);

	const answer = (data.message?.content ?? '').trim();

	if (req.options.vault_tools_enabled) {
		const calls = parseToolCalls(answer);
		if (calls) {
			const tool_calls: ToolCall[] = calls.map((tc, i) => ({
				id: tc.id ?? String(i + 1),
				tool: tc.tool,
				args: tc.args ?? {},
				reason: tc.reason,
			}));
			return { answer: null, tool_calls, provider: 'ollama', model: req.model, events, sources: [] };
		}
		return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'ollama', model: req.model, events, sources };
	}

	return { answer, tool_calls: [], provider: 'ollama', model: req.model, events, sources };
}
