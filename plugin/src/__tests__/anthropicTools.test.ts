import { describe, expect, it } from 'vitest';
import { buildAnthropicMessages, buildAnthropicThinkingConfig, extractAnthropicToolCalls } from '../providers/anthropic';
import type { ChatRequestPayload } from '../agent/types';

function basePayload(overrides: Partial<ChatRequestPayload> = {}): ChatRequestPayload {
	return {
		provider: 'anthropic',
		model: 'claude-sonnet-4-5',
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

describe('Anthropic native tool calls', () => {
	it('maps adaptive Claude thinking variants to adaptive thinking plus effort', () => {
		expect(buildAnthropicThinkingConfig({ provider: 'anthropic', mode: 'adaptive', effort: 'low' }, true)).toEqual({
			thinking: { type: 'adaptive' },
			outputConfig: { effort: 'low' },
		});
		expect(buildAnthropicThinkingConfig({ provider: 'anthropic', mode: 'adaptive', effort: 'xhigh' }, true)).toEqual({
			thinking: { type: 'adaptive' },
			outputConfig: { effort: 'xhigh' },
		});
		expect(buildAnthropicThinkingConfig({ provider: 'anthropic', mode: 'off' }, true)).toEqual({});
	});

	it('normalizes tool_use blocks into internal ToolCalls', () => {
		const calls = extractAnthropicToolCalls({
			content: [
				{ type: 'text', text: 'Ich lese kurz nach.' },
				{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'A.md', maxChars: 1000 } },
			],
		});

		expect(calls).toEqual([
			{
				id: 'toolu_1',
				tool: 'read_file',
				args: { path: 'A.md', maxChars: 1000 },
			},
		]);
	});

	it('keeps multiple tool_use blocks in provider order', () => {
		const calls = extractAnthropicToolCalls({
			content: [
				{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'A.md' } },
				{ type: 'tool_use', id: 'toolu_2', name: 'search_vault', input: { query: 'Budget', limit: 3 } },
			],
		});

		expect(calls.map(call => call.id)).toEqual(['toolu_1', 'toolu_2']);
		expect(calls.map(call => call.tool)).toEqual(['read_file', 'search_vault']);
	});

	it('ignores server and unknown tools', () => {
		const calls = extractAnthropicToolCalls({
			content: [
				{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'docs' } },
				{ type: 'tool_use', id: 'toolu_1', name: 'unknown_tool', input: {} },
				{ type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'A.md' } },
			],
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.tool).toBe('read_file');
	});

	it('returns tool_result blocks immediately after synthetic tool_use blocks', () => {
		const [messages] = buildAnthropicMessages(basePayload({
			tool_results: [
				{
					id: 'toolu_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: { path: 'A.md', content: 'Hallo' },
				},
				{
					id: 'toolu_2',
					tool: 'search_vault',
					args: { query: 'Budget' },
					ok: false,
					error: 'Keine Treffer.',
				},
			],
		}));

		expect(messages.at(-2)).toMatchObject({
			role: 'assistant',
			content: [
				{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'A.md' } },
				{ type: 'tool_use', id: 'toolu_2', name: 'search_vault', input: { query: 'Budget' } },
			],
		});
		expect(messages.at(-1)).toMatchObject({
			role: 'user',
			content: [
				{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false },
				{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true },
			],
		});
	});

	it('returns failed local tool results with the original tool_use_id', () => {
		const [messages] = buildAnthropicMessages(basePayload({
			tool_results: [
				{
					id: 'toolu_missing',
					tool: 'read_file',
					args: { path: 'missing.md' },
					ok: false,
					error: 'File not found: missing.md',
				},
			],
		}));

		expect(messages.at(-2)).toMatchObject({
			role: 'assistant',
			content: [
				{ type: 'tool_use', id: 'toolu_missing', name: 'read_file', input: { path: 'missing.md' } },
			],
		});
		expect(messages.at(-1)).toMatchObject({
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_missing',
					content: 'File not found: missing.md',
					is_error: true,
				},
			],
		});
	});

	it('preserves thinking blocks before synthetic tool_use blocks', () => {
		const calls = extractAnthropicToolCalls({
			content: [
				{ type: 'thinking', thinking: 'plan', signature: 'sig-1' },
				{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'A.md' } },
			],
		});
		expect(calls[0]?.provider_context).toEqual({
			anthropic_thinking_blocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig-1' }],
		});

		const [messages] = buildAnthropicMessages(basePayload({
			tool_results: [
				{
					id: 'toolu_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: { path: 'A.md', content: 'Hallo' },
					provider_context: calls[0]?.provider_context,
				},
			],
		}));

		expect(messages.at(-2)).toMatchObject({
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'plan', signature: 'sig-1' },
				{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'A.md' } },
			],
		});
	});

	it('does not duplicate shared thinking blocks for parallel tool results', () => {
		const thinkingContext = {
			anthropic_thinking_blocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig-1' }],
		};
		const [messages] = buildAnthropicMessages(basePayload({
			tool_results: [
				{
					id: 'toolu_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: 'A',
					provider_context: thinkingContext,
				},
				{
					id: 'toolu_2',
					tool: 'read_file',
					args: { path: 'B.md' },
					ok: true,
					result: 'B',
					provider_context: thinkingContext,
				},
			],
		}));

		const assistant = messages.at(-2);
		expect(assistant?.role).toBe('assistant');
		const content = Array.isArray(assistant?.content) ? assistant.content : [];
		expect(content.filter(block => block.type === 'thinking')).toHaveLength(1);
		expect(content.filter(block => block.type === 'tool_use')).toHaveLength(2);
	});

	it('keeps host feedback visible while local tool results stay native', () => {
		const [messages] = buildAnthropicMessages(basePayload({
			tool_results: [
				{ id: 'loop_guard_1', tool: 'loop_guard', ok: false, error: 'Nicht nochmal lesen.' },
				{
					id: 'toolu_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: { path: 'A.md', content: 'Hallo' },
				},
			],
		}));
		expect(JSON.stringify(messages)).toContain('<tool_results>');
		expect(JSON.stringify(messages)).toContain('Nicht nochmal lesen.');
		expect(messages.at(-2)).toMatchObject({
			role: 'assistant',
			content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file' }],
		});
	});
});
