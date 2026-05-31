import { describe, expect, it } from 'vitest';
import { buildOllamaMessages, extractOllamaToolCalls } from '../providers/ollama';
import { toOllamaTools, getAllowedToolSchemas } from '../tools/toolSchemas';
import type { ChatRequestPayload } from '../agent/types';

function basePayload(overrides: Partial<ChatRequestPayload> = {}): ChatRequestPayload {
	return {
		provider: 'ollama',
		model: 'qwen3',
		auth: { base_url: 'http://127.0.0.1:11434' },
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

describe('Ollama native tool calls', () => {
	it('normalizes tool_calls with object arguments', () => {
		const calls = extractOllamaToolCalls({
			tool_calls: [
				{ function: { name: 'read_file', arguments: { path: 'Notes.md', maxChars: 2000 } } },
			],
		});
		expect(calls).toEqual([
			{ id: 'read_file_1', tool: 'read_file', args: { path: 'Notes.md', maxChars: 2000 } },
		]);
	});

	it('normalizes tool_calls with JSON-string arguments', () => {
		const calls = extractOllamaToolCalls({
			tool_calls: [
				{ function: { name: 'search_vault', arguments: JSON.stringify({ query: 'Budget 2025' }) } },
			],
		});
		expect(calls).toEqual([
			{ id: 'search_vault_1', tool: 'search_vault', args: { query: 'Budget 2025' } },
		]);
	});

	it('keeps multiple tool calls in order', () => {
		const calls = extractOllamaToolCalls({
			tool_calls: [
				{ function: { name: 'read_file', arguments: { path: 'A.md' } } },
				{ function: { name: 'search_vault', arguments: { query: 'test' } } },
			],
		});
		expect(calls).toHaveLength(2);
		expect(calls[0].tool).toBe('read_file');
		expect(calls[1].tool).toBe('search_vault');
	});

	it('drops unknown tool names', () => {
		const calls = extractOllamaToolCalls({
			tool_calls: [
				{ function: { name: 'unknown_tool', arguments: {} } },
				{ function: { name: 'read_file', arguments: { path: 'B.md' } } },
			],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].tool).toBe('read_file');
	});

	it('returns empty array when tool_calls is absent', () => {
		expect(extractOllamaToolCalls({})).toEqual([]);
		expect(extractOllamaToolCalls({ content: 'no tools here' })).toEqual([]);
	});

	it('handles malformed JSON string arguments gracefully', () => {
		const calls = extractOllamaToolCalls({
			tool_calls: [
				{ function: { name: 'read_file', arguments: '{bad json' } },
			],
		});
		expect(calls).toEqual([
			{ id: 'read_file_1', tool: 'read_file', args: {} },
		]);
	});

	it('returns native tool-role messages after assistant tool_calls', () => {
		const [messages] = buildOllamaMessages(basePayload({
			tool_results: [
				{
					id: 'read_file_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: { path: 'A.md', content: 'Hallo' },
				},
			],
		}));

		expect(messages.at(-2)).toMatchObject({
			role: 'assistant',
			content: '',
			tool_calls: [
				{
					type: 'function',
					function: { name: 'read_file', arguments: { path: 'A.md' } },
				},
			],
		});
		expect(messages.at(-1)).toMatchObject({
			role: 'tool',
			tool_name: 'read_file',
			content: JSON.stringify({ path: 'A.md', content: 'Hallo' }),
		});
	});

	it('returns failed local tool results as tool-role error messages', () => {
		const [messages] = buildOllamaMessages(basePayload({
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

		expect(messages.at(-2)).toMatchObject({
			role: 'assistant',
			content: '',
			tool_calls: [
				{
					type: 'function',
					function: { name: 'read_file', arguments: { path: 'missing.md' } },
				},
			],
		});
		expect(messages.at(-1)).toMatchObject({
			role: 'tool',
			tool_name: 'read_file',
			content: 'File not found: missing.md',
		});
	});

	it('does not duplicate compacted tool_results as text in the newest user message', () => {
		const [messages] = buildOllamaMessages(basePayload({
			tool_results: [
				{
					id: 'read_file_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: 'Hallo',
				},
			],
		}));
		const userMessages = messages.filter(message => message.role === 'user');
		expect(userMessages.at(-1)?.content).not.toContain('<tool_results>');
	});

	it('keeps host feedback in prompt text while local results stay native tool messages', () => {
		const [messages] = buildOllamaMessages(basePayload({
			tool_results: [
				{ id: 'loop_guard_1', tool: 'loop_guard', ok: false, error: 'Nicht erneut lesen.' },
				{
					id: 'read_file_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: 'Hallo',
				},
			],
		}));

		expect(JSON.stringify(messages)).toContain('<tool_results>');
		expect(JSON.stringify(messages)).toContain('Nicht erneut lesen.');
		expect(messages.at(-1)).toMatchObject({
			role: 'tool',
			tool_name: 'read_file',
			content: 'Hallo',
		});
	});
});

describe('toOllamaTools', () => {
	it('wraps schemas in Ollama function format', () => {
		const schemas = getAllowedToolSchemas({ mode: 'ask', phase: 'normal' });
		const tools = toOllamaTools(schemas);
		for (const tool of tools) {
			expect(tool.type).toBe('function');
			expect(tool.function.name).toBeTruthy();
			expect(tool.function.description).toBeTruthy();
			expect(tool.function.parameters.type).toBe('object');
		}
	});

	it('excludes write tools in ask mode', () => {
		const schemas = getAllowedToolSchemas({ mode: 'ask', phase: 'normal' });
		const tools = toOllamaTools(schemas);
		const names = tools.map(t => t.function.name);
		expect(names).not.toContain('write_file');
		expect(names).not.toContain('patch_file');
		expect(names).not.toContain('delete_file');
	});

	it('includes write tools in agent execute phase', () => {
		const schemas = getAllowedToolSchemas({ mode: 'agent', phase: 'execute', agentMode: 'agent' });
		const tools = toOllamaTools(schemas);
		const names = tools.map(t => t.function.name);
		expect(names).toContain('write_file');
		expect(names).toContain('patch_file');
	});
});
