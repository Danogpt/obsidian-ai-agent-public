import type { ChatRequestPayload, ChatResponsePayload, ToolCall } from '../agent/types';
import { buildMessages, parseToolCalls, normalizeFinalAnswer } from '../agent/prompts';
import { postJson, bearerHeaders, ProviderError } from './http';
import { rateLimitManager } from '../limits/rateLimitState';

interface ResponsesOutput {
	output_text?: string;
	output?: Array<{
		type: string;
		content?: Array<{ type: string; text?: string }>;
	}>;
}

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

	const [messages, sources] = buildMessages(req);

	const body: Record<string, unknown> = { model: req.model, input: messages };
	if (req.options.web_search)    body.tools    = [{ type: 'web_search_preview' }];
	if (req.options.thinking_mode) body.reasoning = { effort: 'high' };

	const data = await postJson<ResponsesOutput>(
		'https://api.openai.com/v1/responses',
		body,
		bearerHeaders(req.auth.api_key),
		180_000,
		(h) => rateLimitManager.updateFromHeaders(req.provider, req.model, h),
	);

	const answer = extractText(data);

	if (req.options.vault_tools_enabled) {
		const calls = parseToolCalls(answer);
		if (calls) {
			const tool_calls: ToolCall[] = calls.map((tc, i) => ({
				id: tc.id ?? String(i + 1),
				tool: tc.tool,
				args: tc.args ?? {},
				reason: tc.reason,
			}));
			return { answer: null, tool_calls, provider: 'openai', model: req.model, events, sources: [] };
		}
		return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'openai', model: req.model, events, sources };
	}

	return { answer, tool_calls: [], provider: 'openai', model: req.model, events, sources };
}
