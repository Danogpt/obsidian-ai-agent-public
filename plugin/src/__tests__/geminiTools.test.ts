import { describe, expect, it } from 'vitest';
import { buildGeminiContents, extractGeminiToolCalls, geminiThinkingConfig, geminiToolConfig } from '../providers/gemini';
import type { ChatRequestPayload } from '../agent/types';

function basePayload(overrides: Partial<ChatRequestPayload> = {}): ChatRequestPayload {
	return {
		provider: 'gemini',
		model: 'gemini-3-flash-preview',
		auth: { api_key: 'test' },
		message: 'Lies die Datei.',
		history: [],
		context: [],
		tool_results: [],
		options: {
			thinking_mode: false,
			web_search: false,
			vault_tools_enabled: true,
			stream: false,
			max_context_chars: 8000,
			agent_mode: 'agent',
			execution_phase: 'normal',
			ui_mode: 'agent',
		},
		...overrides,
	};
}

describe('Gemini native tool calls', () => {
	it('normalizes functionCall parts into internal ToolCalls', () => {
		const calls = extractGeminiToolCalls({
			candidates: [{
				content: {
					parts: [
						{ text: 'Ich lese nach.' },
						{ functionCall: { name: 'read_file', args: { path: 'A.md', maxChars: 1000 } }, thoughtSignature: 'sig-a' },
					],
				},
			}],
		});

		expect(calls).toEqual([
			{
				id: 'read_file_2',
				tool: 'read_file',
				args: { path: 'A.md', maxChars: 1000 },
				thought_signature: 'sig-a',
			},
		]);
	});

	it('keeps multiple functionCall parts in provider order', () => {
		const calls = extractGeminiToolCalls({
			candidates: [{
				content: {
					parts: [
						{ functionCall: { name: 'read_file', args: { path: 'A.md' } }, thoughtSignature: 'sig-a' },
						{ functionCall: { name: 'search_vault', args: { query: 'Budget' } } },
					],
				},
			}],
		});

		expect(calls.map(call => call.tool)).toEqual(['read_file', 'search_vault']);
		expect(calls[0]?.thought_signature).toBe('sig-a');
		expect(calls[1]?.thought_signature).toBeUndefined();
	});

	it('ignores unknown functionCall names', () => {
		const calls = extractGeminiToolCalls({
			candidates: [{
				content: {
					parts: [
						{ functionCall: { name: 'unknown_tool', args: {} } },
						{ functionCall: { name: 'read_file', args: { path: 'A.md' } } },
					],
				},
			}],
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.tool).toBe('read_file');
	});

	it('returns functionResponse parts after preserving model functionCall parts', () => {
		const [contents] = buildGeminiContents(basePayload({
			tool_results: [
				{
					id: 'read_file_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					thought_signature: 'sig-a',
					ok: true,
					result: { path: 'A.md', content: 'Hallo' },
				},
			],
		}));

		expect(contents.at(-2)).toMatchObject({
			role: 'model',
			parts: [
				{
					functionCall: { name: 'read_file', args: { path: 'A.md' } },
					thoughtSignature: 'sig-a',
				},
			],
		});
		expect(contents.at(-1)).toMatchObject({
			role: 'user',
			parts: [
				{
					functionResponse: {
						name: 'read_file',
						response: { result: { path: 'A.md', content: 'Hallo' } },
					},
				},
			],
		});
	});

	it('returns failed local tool results as functionResponse errors', () => {
		const [contents] = buildGeminiContents(basePayload({
			tool_results: [
				{
					id: 'read_file_1',
					tool: 'read_file',
					args: { path: 'missing.md' },
					ok: false,
					error: 'File not found: missing.md',
				},
			],
		}));

		expect(contents.at(-2)).toMatchObject({
			role: 'model',
			parts: [
				{ functionCall: { name: 'read_file', args: { path: 'missing.md' } } },
			],
		});
		expect(contents.at(-1)).toMatchObject({
			role: 'user',
			parts: [
				{
					functionResponse: {
						name: 'read_file',
						response: { error: 'File not found: missing.md' },
					},
				},
			],
		});
	});

	it('keeps host feedback in user content while local results stay functionResponse parts', () => {
		const [contents] = buildGeminiContents(basePayload({
			tool_results: [
				{ id: 'loop_guard_1', tool: 'loop_guard', ok: false, error: 'Nicht erneut lesen.' },
				{
					id: 'read_file_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: { path: 'A.md', content: 'Hallo' },
				},
			],
		}));

		expect(JSON.stringify(contents)).toContain('<tool_results>');
		expect(JSON.stringify(contents)).toContain('Nicht erneut lesen.');
		expect(contents.at(-1)).toMatchObject({
			role: 'user',
			parts: [
				{
					functionResponse: {
						name: 'read_file',
						response: { result: { path: 'A.md', content: 'Hallo' } },
					},
				},
			],
		});
	});

	it('uses model-family specific thinking config', () => {
		expect(geminiThinkingConfig('gemini-3-flash-preview')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH' } });
		expect(geminiThinkingConfig('gemini-2.5-pro')).toEqual({ thinkingConfig: { thinkingBudget: -1 } });
		expect(geminiThinkingConfig('gemini-2.0-flash')).toBeNull();
	});

	it('does not set allowedFunctionNames in AUTO mode', () => {
		expect(geminiToolConfig()).toEqual({
			functionCallingConfig: {
				mode: 'AUTO',
			},
		});
		expect(JSON.stringify(geminiToolConfig())).not.toContain('allowedFunctionNames');
	});
});
