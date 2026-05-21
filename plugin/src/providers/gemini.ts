import type { ChatRequestPayload, ChatResponsePayload, ToolCall } from '../agent/types';
import { buildSystemPrompt, buildUserContent, parseToolCalls, normalizeFinalAnswer } from '../agent/prompts';
import { postJson, ProviderError } from './http';
import { rateLimitManager } from '../limits/rateLimitState';

interface GeminiResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
	}>;
}

export async function callGemini(req: ChatRequestPayload): Promise<ChatResponsePayload> {
	if (!req.auth.api_key) throw new ProviderError('gemini', 0, 'Gemini API key is missing.');

	const events = [
		{ type: 'status', text: 'Planning next moves' },
		{ type: 'status', text: 'Packing Obsidian context' },
	];
	if (req.options.web_search)          events.push({ type: 'status', text: 'Google Search grounding enabled' });
	if (req.options.vault_tools_enabled) events.push({ type: 'status', text: 'Vault tools enabled' });
	events.push({ type: 'status', text: `Calling ${req.model}` });

	const system = buildSystemPrompt(req);
	const [userContent, sources] = buildUserContent(req);

	const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
	for (const h of req.history.slice(-24)) {
		contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] });
	}
	contents.push({ role: 'user', parts: [{ text: userContent }] });

	const body: Record<string, unknown> = {
		contents,
		systemInstruction: { parts: [{ text: system }] },
	};
	if (req.options.web_search) body.tools = [{ googleSearch: {} }];

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${req.auth.api_key}`;

	const data = await postJson<GeminiResponse>(
		url, body, {}, 180_000,
		(h) => rateLimitManager.updateFromHeaders(req.provider, req.model, h),
	);

	const answer = (data.candidates?.[0]?.content?.parts ?? [])
		.map(p => p.text ?? '')
		.join('')
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
			return { answer: null, tool_calls, provider: 'gemini', model: req.model, events, sources: [] };
		}
		return { answer: normalizeFinalAnswer(answer), tool_calls: [], provider: 'gemini', model: req.model, events, sources };
	}

	return { answer, tool_calls: [], provider: 'gemini', model: req.model, events, sources };
}
