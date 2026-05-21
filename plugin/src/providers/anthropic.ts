import type { ChatRequestPayload, ChatResponsePayload, ToolCall } from '../agent/types';
import { buildMessages, buildSystemPrompt, parseToolCalls, normalizeFinalAnswer } from '../agent/prompts';
import { postJson, ProviderError } from './http';
import { rateLimitManager } from '../limits/rateLimitState';

interface AnthropicResponse {
	content?: Array<{ type: string; text?: string }>;
}

export async function callAnthropic(req: ChatRequestPayload): Promise<ChatResponsePayload> {
	if (!req.auth.api_key) throw new ProviderError('anthropic', 0, 'Anthropic API key is missing.');

	const events = [
		{ type: 'status', text: 'Planning next moves' },
		{ type: 'status', text: 'Packing Obsidian context' },
	];
	if (req.options.thinking_mode)       events.push({ type: 'status', text: 'Extended thinking enabled' });
	if (req.options.web_search)          events.push({ type: 'status', text: 'Websearch enabled' });
	if (req.options.vault_tools_enabled) events.push({ type: 'status', text: 'Vault tools enabled' });
	events.push({ type: 'status', text: `Calling ${req.model}` });

	const [allMessages, sources] = buildMessages(req);
	const system = buildSystemPrompt(req);
	const convMessages = allMessages.filter(m => m.role !== 'system');

	const body: Record<string, unknown> = {
		model: req.model,
		max_tokens: req.options.thinking_mode ? 16000 : 8000,
		system,
		messages: convMessages,
	};
	if (req.options.thinking_mode) {
		body.thinking = { type: 'enabled', budget_tokens: 10000 };
	}
	if (req.options.web_search && !req.options.thinking_mode) {
		body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
	}

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

	const answer = (data.content ?? [])
		.filter(b => b.type === 'text')
		.map(b => b.text ?? '')
		.join('\n')
		.trim();

	if (req.options.vault_tools_enabled) {
		const calls = parseToolCalls(answer);
		if (calls) {
			const tool_calls: ToolCall[] = calls.map((tc, i) => ({
				id: tc.id ?? String(i + 1),
				tool: tc.tool,
				args: tc.args ?? {},
				reason: tc.reason,
			}));
			return { answer: null, tool_calls, provider: 'anthropic', model: req.model, events, sources: [] };
		}
		return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'anthropic', model: req.model, events, sources };
	}

	return { answer, tool_calls: [], provider: 'anthropic', model: req.model, events, sources };
}
